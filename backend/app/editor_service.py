"""Versioned, owner-scoped card edits. A model never controls the write mask."""

import hashlib
import json
import time
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import HTTPException

from . import repository as repo
from .models import CardReviewReply


def check_version(doc, version):
    if doc["version"] != version:
        raise HTTPException(409, "원고가 변경되었습니다. 최신 원고에서 다시 검토하세요.")


def check_size(payload):
    if len(json.dumps(payload, ensure_ascii=False).encode()) > 150000:
        raise HTTPException(422, "원고가 너무 큽니다.")


def save_revision(tx, old, payload, note, style=None):
    check_size(payload)
    result = old | {
        "draft": payload,
        "version": old["version"] + 1,
        "status": "draft",
        "updated_at": repo.now(),
    }
    if style is not None:
        result["style"] = style
    fid = uuid4().hex
    tx.set(
        "feedback",
        fid,
        {
            "id": fid,
            "owner_uid": old["owner_uid"],
            "draft_id": old["id"],
            "before": old["draft"],
            "after": payload,
            "note": note,
            "before_version": old["version"],
            "after_version": result["version"],
            "preference_applied": False,
            "created_at": repo.now(),
        },
    )
    tx.set("drafts", old["id"], result)
    return result


def propose(db, generator, settings, uid, did, request):
    pid = repo.identity(uid, "card-review:" + str(request.request_id))
    fingerprint = hashlib.sha256((did + request.model_dump_json()).encode()).hexdigest()
    qid = repo.identity(uid, datetime.now(timezone.utc).strftime("%Y-%m-%d"))

    def replay(prior):
        if prior["fingerprint"] != fingerprint:
            raise HTTPException(409, "같은 요청 ID의 내용이 다릅니다.")
        if prior["status"] in ("ready", "applied"):
            return prior
        raise HTTPException(409, "처리 중이거나 중단된 요청입니다. 검토 이력을 확인하세요.")

    def reserve(tx):
        doc = repo.owned(tx, "drafts", did, uid)
        prior = tx.get("card_proposals", pid)
        if prior:
            return None, replay(prior)
        check_version(doc, request.version)
        if any(i >= len(doc["draft"]["cards"]) for i in request.card_indices):
            raise HTTPException(422, "원고에 없는 카드입니다.")
        quota = tx.get("quotas", qid) or {"count": 0}
        if quota["count"] >= settings.daily_request_limit:
            raise HTTPException(429, "오늘의 AI 요청 한도를 사용했습니다.")
        tx.set("quotas", qid, quota | {"owner_uid": uid, "count": quota["count"] + 1})
        tx.set(
            "card_proposals",
            pid,
            {
                "id": pid,
                "owner_uid": uid,
                "draft_id": did,
                "version": request.version,
                "fingerprint": fingerprint,
                "status": "pending",
                "fields": request.fields,
                "card_indices": request.card_indices,
                "instruction": request.instruction,
                "created_at": repo.now(),
                "expires_at": time.time() + 180,
            },
        )
        return doc, None

    doc, prior = db.atomic(reserve)
    if prior:
        return prior
    try:
        raw = generator.revise(request, {"draft": doc["draft"]})
        result = CardReviewReply.model_validate(raw).model_dump(exclude_unset=True)
        indices = [c["card_index"] for c in result["cards"]]
        if sorted(indices) != sorted(request.card_indices):
            raise ValueError("Model changed the selected cards")
        patches = []
        for card in result["cards"]:
            i = card["card_index"]
            before = doc["draft"]["cards"][i]
            after = deepcopy(before)
            for field in request.fields:
                after[field] = card["card"][field]
                if field == "diagram":
                    after["artwork"] = card["card"].get("artwork", [])
            patches.append(
                {"card_index": i, "before": before, "after": after, "findings": card["findings"]}
            )
        check_size(patches)

        def finish(tx):
            current = repo.owned(tx, "drafts", did, uid)
            p = repo.owned(tx, "card_proposals", pid, uid)
            check_version(current, request.version)
            if p["status"] != "pending" or time.time() > p["expires_at"]:
                raise HTTPException(409, "검토 요청이 만료되었습니다.")
            p.update(status="ready", summary=result["summary"], patches=patches)
            tx.set("card_proposals", pid, p)
            return p

        return db.atomic(finish)
    except Exception as exc:
        # Recover a successful write if its acknowledgement was lost.
        try:
            completed = db.get("card_proposals", pid)
            if completed and completed["status"] in ("ready", "applied"):
                return completed

            def fail(tx):
                p = repo.owned(tx, "card_proposals", pid, uid)
                if p["status"] == "pending":
                    tx.set("card_proposals", pid, p | {"status": "failed"})

            db.atomic(fail)
        except Exception:
            raise HTTPException(
                503, "저장 결과를 확인할 수 없습니다. 같은 요청으로 재시도하세요."
            ) from None
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(
            502, "검토 제안 생성에 실패했습니다. 원고는 변경되지 않았습니다."
        ) from None


def apply_proposal(db, uid, did, pid, request):
    def apply(tx):
        old = repo.owned(tx, "drafts", did, uid)
        p = repo.owned(tx, "card_proposals", pid, uid)
        if p["draft_id"] != did:
            raise HTTPException(404, "이 원고의 제안이 아닙니다.")
        selected = sorted(request.card_indices)
        if p["status"] == "applied":
            if p["applied_indices"] == selected and p["version"] == request.version:
                # Return the latest document so a retry cannot replace newer local state.
                return old
            raise HTTPException(409, "이미 적용한 제안입니다.")
        check_version(old, request.version)
        if p["status"] != "ready" or p["version"] != request.version:
            raise HTTPException(409, "최신 원고로 다시 검토하세요.")
        if not set(selected).issubset(set(p["card_indices"])):
            raise HTTPException(422, "제안에 없는 카드는 적용할 수 없습니다.")
        payload = deepcopy(old["draft"])
        for patch in p["patches"]:
            if patch["card_index"] in selected:
                payload["cards"][patch["card_index"]] = patch["after"]
        result = save_revision(tx, old, payload, p["instruction"])
        tx.set("card_proposals", pid, p | {"status": "applied", "applied_indices": selected})
        return result

    return db.atomic(apply)
