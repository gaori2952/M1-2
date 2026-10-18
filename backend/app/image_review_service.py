"""Owner-scoped reviews. Image bytes are transient; only hashes and findings persist."""

import hashlib
import time
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import HTTPException

from . import repository as repo
from .image_assets import decode_asset
from .image_review_models import ReviewReply

REVIEWS = "image_reviews"
VERSIONS = "image_review_versions"
REQUESTS = "image_review_requests"


def version_id(rid, cid, version):
    return repo.identity(rid, f"{cid}:{version}")


def current_results(db, doc, uid):
    return {
        c["card_id"]: repo.owned(
            db, VERSIONS, version_id(doc["id"], c["card_id"], c["version"]), uid
        )
        for c in doc["cards"]
        if c["version"]
    }


def detail(db, rid, uid):
    doc = repo.owned(db, REVIEWS, rid, uid)
    results = current_results(db, doc, uid)
    return doc | {
        "cards": [c | {"result": results.get(c["card_id"], {}).get("result")} for c in doc["cards"]]
    }


def create(db, uid, body):
    rid = repo.identity(uid, "image-review:" + str(body.request_id))
    payload = body.model_dump(mode="json")

    def save(tx):
        prior = tx.get(REVIEWS, rid)
        if prior:
            if prior["create_payload"] != payload:
                raise HTTPException(409, "같은 요청 ID의 내용이 다릅니다.")
            return prior
        doc = {
            "id": rid,
            "owner_uid": uid,
            "title": body.title,
            "criteria": body.criteria,
            "cards": [c.model_dump() | {"version": 0} for c in body.cards],
            "version": 0,
            "connections": [],
            "connections_stale": True,
            "created_at": repo.now(),
            "updated_at": repo.now(),
            "create_payload": payload,
        }
        tx.set(REVIEWS, rid, doc)
        return doc

    return db.atomic(save)


def request_status(db, rid, uid, request_id):
    repo.owned(db, REVIEWS, rid, uid)
    doc = repo.owned(db, REQUESTS, repo.identity(uid, f"image-run:{rid}:{request_id}"), uid)
    if doc["review_id"] != rid:
        raise HTTPException(404, "검토 요청이 없습니다.")
    if doc["status"] == "pending" and time.time() > doc["expires_at"]:
        return doc | {"status": "interrupted"}
    return doc


def run(db, reviewer, settings, uid, rid, body):
    key = repo.identity(uid, f"image-run:{rid}:{body.request_id}")
    fingerprint = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
    quota_id = repo.identity(uid, datetime.now(timezone.utc).strftime("%Y-%m-%d"))

    def replay(prior):
        if prior["fingerprint"] != fingerprint:
            raise HTTPException(409, "같은 요청 ID의 내용이 다릅니다.")
        if prior["status"] == "ready":
            return prior
        raise HTTPException(409, "처리 중이거나 중단된 검토입니다. 요청 상태를 확인하세요.")

    repo.owned(db, REVIEWS, rid, uid)
    prior = db.get(REQUESTS, key)
    if prior:
        return replay(prior)
    images = [decode_asset(a) for a in body.images]
    previous = decode_asset(body.previous_image) if body.previous_image else None

    def reserve(tx):
        doc = repo.owned(tx, REVIEWS, rid, uid)
        prior = tx.get(REQUESTS, key)
        if prior:
            return None, None, replay(prior)
        if doc["version"] != body.version or doc.get("busy_until", 0) > time.time():
            raise HTTPException(409, "검토가 진행 중이거나 변경되었습니다. 최신 결과를 불러오세요.")
        ids = [c["card_id"] for c in doc["cards"]]
        if sorted(a["card_id"] for a in images) != sorted(ids):
            raise HTTPException(422, "작업의 모든 카드 이미지를 중복 없이 전달하세요.")
        if body.target_card_id is not None and body.target_card_id not in ids:
            raise HTTPException(422, "작업에 없는 카드입니다.")
        if body.target_card_id and not doc["version"]:
            raise HTTPException(422, "먼저 전체 검토를 실행하세요.")
        if not body.target_card_id and previous:
            raise HTTPException(422, "전체 검토에는 이전 이미지를 별도로 전달하지 않습니다.")
        image_map = {a["card_id"]: a for a in images}
        if body.target_card_id:
            for c in doc["cards"]:
                if (
                    c["card_id"] != body.target_card_id
                    and image_map[c["card_id"]]["sha256"] != c["sha256"]
                ):
                    raise HTTPException(
                        422, "다른 카드의 이미지가 변경되었습니다. 전체 검토를 실행하세요."
                    )
            old = next(c for c in doc["cards"] if c["card_id"] == body.target_card_id)
            if (
                not previous
                or previous["card_id"] != old["card_id"]
                or previous["sha256"] != old["sha256"]
            ):
                raise HTTPException(422, "직전 버전 이미지가 일치하지 않습니다.")
        elif doc["version"] == 0 and any(
            image_map[c["card_id"]]["sha256"] != c["sha256"] for c in doc["cards"]
        ):
            raise HTTPException(422, "처음 등록한 이미지와 다릅니다.")
        results = current_results(tx, doc, uid)
        quota = tx.get("quotas", quota_id) or {"count": 0}
        if quota["count"] >= settings.daily_request_limit:
            raise HTTPException(429, "오늘의 AI 요청 한도를 사용했습니다.")
        pending = {
            "id": key,
            "request_id": str(body.request_id),
            "owner_uid": uid,
            "review_id": rid,
            "fingerprint": fingerprint,
            "status": "pending",
            "expires_at": time.time() + 180,
            "created_at": repo.now(),
        }
        tx.set("quotas", quota_id, quota | {"owner_uid": uid, "count": quota["count"] + 1})
        tx.set(REQUESTS, key, pending)
        tx.set(REVIEWS, rid, doc | {"busy_until": pending["expires_at"], "active_request": key})
        return doc, results, None

    doc, previous_results, prior = db.atomic(reserve)
    if prior:
        return prior
    target_ids = (
        [body.target_card_id] if body.target_card_id else [c["card_id"] for c in doc["cards"]]
    )
    prior_findings = {
        cid: previous_results.get(cid, {}).get("result", {}).get("findings", [])
        for cid in target_ids
    }
    try:
        context = {
            "criteria": doc["criteria"],
            "target_card_ids": target_ids,
            "single_card": bool(body.target_card_id),
            "previous_findings": prior_findings,
            "card_order": [c["card_id"] for c in doc["cards"]],
        }
        model_images = images + (
            [previous | {"label": "previous version of target"}] if previous else []
        )
        result = ReviewReply.model_validate(reviewer.review(model_images, context)).model_dump()
        if sorted(c["card_id"] for c in result["cards"]) != sorted(target_ids):
            raise ValueError("Missing or duplicate card result")
        for card in result["cards"]:
            expected = sorted(f["id"] for f in prior_findings[card["card_id"]])
            if sorted(r["finding_id"] for r in card["resolutions"]) != expected:
                raise ValueError("Invalid finding resolution")
        all_ids = {c["card_id"] for c in doc["cards"]}
        for connection in result["connections"]:
            if (
                len(set(connection["card_ids"])) != len(connection["card_ids"])
                or not set(connection["card_ids"]) <= all_ids
            ):
                raise ValueError("Unknown connection card")
        if body.target_card_id and result["connections"]:
            raise ValueError("Single card cannot replace connection review")
        for finding in [f for c in result["cards"] for f in c["findings"]] + result["connections"]:
            finding.update(id=uuid4().hex, checked=False)

        def finish(tx):
            current = repo.owned(tx, REVIEWS, rid, uid)
            pending = repo.owned(tx, REQUESTS, key, uid)
            if (
                current["version"] != body.version
                or current.get("active_request") != key
                or pending["status"] != "pending"
                or time.time() > pending["expires_at"]
            ):
                raise HTTPException(409, "검토 기준이 변경되었거나 요청이 만료되었습니다.")
            by_id = {c["card_id"]: c for c in result["cards"]}
            image_map = {a["card_id"]: a for a in images}
            cards = []
            for card in current["cards"]:
                if card["card_id"] not in by_id:
                    cards.append(card)
                    continue
                cid = card["card_id"]
                updated = card | {
                    "version": card["version"] + 1,
                    "sha256": image_map[cid]["sha256"],
                    "name": image_map[cid]["name"],
                }
                vid = version_id(rid, cid, updated["version"])
                tx.set(
                    VERSIONS,
                    vid,
                    updated
                    | {
                        "id": vid,
                        "owner_uid": uid,
                        "review_id": rid,
                        "result": by_id[cid],
                        "created_at": repo.now(),
                    },
                )
                cards.append(updated)
            updated_doc = current | {
                "cards": cards,
                "version": current["version"] + 1,
                "updated_at": repo.now(),
                "busy_until": 0,
                "active_request": None,
                "connections_stale": bool(body.target_card_id),
            }
            if not body.target_card_id:
                updated_doc["connections"] = result["connections"]
            completed = pending | {
                "status": "ready",
                "review_version": updated_doc["version"],
                "completed_at": repo.now(),
            }
            tx.set(REVIEWS, rid, updated_doc)
            tx.set(REQUESTS, key, completed)
            return completed

        return db.atomic(finish)
    except Exception as exc:
        try:
            saved = db.get(REQUESTS, key)
            if saved and saved["status"] == "ready":
                return saved

            def fail(tx):
                pending = repo.owned(tx, REQUESTS, key, uid)
                current = repo.owned(tx, REVIEWS, rid, uid)
                if pending["status"] == "pending":
                    tx.set(REQUESTS, key, pending | {"status": "failed"})
                if current.get("active_request") == key:
                    tx.set(REVIEWS, rid, current | {"busy_until": 0, "active_request": None})

            db.atomic(fail)
        except Exception:
            raise HTTPException(
                503, "저장 상태 확인이 필요합니다. 같은 요청의 상태를 조회하세요."
            ) from None
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(
            502,
            "이미지 검토에 실패했습니다. 모델의 이미지 입력 지원·출력 한도·연결을 확인하세요. 직전 결과는 유지됩니다.",
        ) from None


def check(db, uid, rid, fid, checked):
    def save(tx):
        doc = repo.owned(tx, REVIEWS, rid, uid)
        versions = [v for v in tx.list(VERSIONS, uid) if v["review_id"] == rid]
        for v in versions:
            for f in v["result"]["findings"]:
                if f["id"] == fid:
                    f["checked"] = checked
                    tx.set(VERSIONS, v["id"], v)
                    return {"id": fid, "checked": checked}
        for f in doc["connections"]:
            if f["id"] == fid:
                f["checked"] = checked
                tx.set(REVIEWS, rid, doc)
                return {"id": fid, "checked": checked}
        raise HTTPException(404, "검토 지적을 찾을 수 없습니다.")

    return db.atomic(save)
