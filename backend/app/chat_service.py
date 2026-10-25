import hashlib
import time
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import HTTPException

from . import repository as repo
from .analytics import summarize
from .content_search import select_contents
from .generation import validate_reply
from .growth_service import growth_context


def request_status(db, uid, request_id):
    rid = repo.identity(uid, str(request_id))

    def reconcile(tx):
        record = repo.owned(tx, "requests", rid, uid)
        conv = (
            tx.get("conversations", record["conversation_id"])
            if record.get("conversation_id")
            else None
        )
        if record["status"] == "pending" and record.get("expires_at", float("inf")) <= time.time():
            record |= {"status": "failed", "error": "lease_expired"}
            tx.set("requests", rid, record)
            if conv and conv.get("active_request") == rid:
                if conv.get("message_count", 0) == 0:
                    tx.delete("conversations", conv["id"])
                else:
                    tx.set(
                        "conversations",
                        conv["id"],
                        conv | {"active_request": None, "busy_until": 0},
                    )
        return {
            "status": record["status"],
            "response": record.get("response") if record["status"] == "done" else None,
        }

    return db.atomic(reconcile)


def run_chat(db, generator, settings, uid, request):
    rid = repo.identity(uid, str(request.request_id))
    fingerprint = hashlib.sha256(request.model_dump_json().encode()).hexdigest()

    def replay(record):
        if record["fingerprint"] != fingerprint:
            raise HTTPException(409, "같은 요청 ID에 다른 내용을 사용할 수 없습니다.")
        if record["status"] == "deleted":
            raise HTTPException(410, "삭제된 대화의 요청입니다.")
        if record["status"] == "done":
            repo.owned(db, "conversations", record["conversation_id"], uid)
            return record["response"]
        raise HTTPException(
            409,
            "처리 중이거나 중단된 요청입니다. 완료 후 불러오거나 새 요청으로 명시적으로 재시도하세요.",
        )

    existing = db.get("requests", rid)
    if existing:
        return replay(existing)
    all_sources = db.list("contents", uid)
    selected = request.selected_content_ids
    if request.selected_idea:
        selected = list(dict.fromkeys(selected + request.selected_idea.source_ids))
        if len(selected) > 5:
            raise HTTPException(422, "참고 원고는 최대 5개입니다.")
    sources = select_contents(request.message, all_sources, selected)
    profile = db.get("profiles", repo.identity(uid, "profile"))
    series = repo.owned(db, "series", request.series_id, uid) if request.series_id else None
    context = {
        "summary": summarize(db.list("data", uid), request.start, request.end),
        "profile": profile if profile and profile.get("confirmed") else None,
        "series": series if series and series.get("confirmed") else None,
        "sources": [
            dict(s, text=s["text"][:12000], truncated=len(s["text"]) > 12000) for s in sources
        ],
    }
    context["summary"].pop("daily", None)
    if request.mode == "growth":
        growth = growth_context(db, settings, uid, request.growth_options, request.message)
        sources = growth["evidence"]
        context |= {"growth": growth, "sources": sources}
    cid = request.conversation_id or uuid4().hex
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    qid = repo.identity(uid, day)
    stamp = time.time()

    def reserve(tx):
        prior = tx.get("requests", rid)
        if prior:
            return prior
        conversation = (
            repo.owned(tx, "conversations", cid, uid) if request.conversation_id else None
        )
        quota = tx.get("quotas", qid) or {"count": 0}
        if conversation and conversation.get("busy_until", 0) > stamp:
            raise HTTPException(409, "이 대화에서 답변을 생성 중입니다.")
        if conversation and conversation["message_count"] + 2 > 100:
            raise HTTPException(409, "대화가 길어졌습니다. 새 대화를 시작하세요.")
        if quota["count"] >= settings.daily_request_limit:
            raise HTTPException(429, "오늘의 AI 요청 한도를 사용했습니다. UTC 자정에 초기화됩니다.")
        conversation = conversation or {
            "id": cid,
            "owner_uid": uid,
            "title": request.message[:80],
            "created_at": repo.now(),
            "message_count": 0,
            "version": 0,
            "pending": True,
        }
        conversation.update(active_request=rid, busy_until=stamp + 180, updated_at=repo.now())
        tx.set("conversations", cid, conversation)
        tx.set("quotas", qid, {"owner_uid": uid, "count": quota["count"] + 1, "day": day})
        tx.set(
            "requests",
            rid,
            {
                "id": rid,
                "owner_uid": uid,
                "fingerprint": fingerprint,
                "status": "pending",
                "conversation_id": cid,
                "expires_at": stamp + 180,
            },
        )
        return None

    prior = db.atomic(reserve)
    if prior:
        return replay(prior)
    try:
        history = sorted(
            db.list(f"conversations/{cid}/messages", uid), key=lambda m: m["sequence"]
        )[-8:]
        source_ids = [s["id"] for s in sources]
        if request.mode == "growth":
            source_ids += [s["id"] for s in context["growth"]["content_history"]]
        result = validate_reply(
            generator.generate(
                request,
                context,
                [{"role": m["role"], "content": m["content"]} for m in history],
            ),
            request,
            source_ids,
        )
        if request.mode == "growth":
            result["growth"] = context["growth"] | {"request_id": str(request.request_id)}
        did = uuid4().hex if result["draft"] else None

        def finish(tx):
            reservation = tx.get("requests", rid)
            conv = repo.owned(tx, "conversations", cid, uid)
            if (
                not reservation
                or reservation["status"] != "pending"
                or conv.get("active_request") != rid
            ):
                raise HTTPException(409, "생성 예약이 변경되었습니다. 대화를 다시 불러오세요.")
            if time.time() > reservation["expires_at"]:
                raise HTTPException(409, "생성 예약이 만료되었습니다.")
            seq = conv["message_count"]
            assistant = {
                "id": rid + "a",
                "owner_uid": uid,
                "role": "assistant",
                "content": result["answer"],
                "sequence": seq + 1,
                "created_at": repo.now(),
                "result": result,
                "draft_id": did,
                "source_ids": result["source_ids"],
            }
            user = {
                "id": rid + "u",
                "owner_uid": uid,
                "role": "user",
                "content": request.message,
                "sequence": seq,
                "created_at": repo.now(),
            }
            response = {
                "conversation_id": cid,
                "request_id": str(request.request_id),
                "assistant": assistant,
                "draft_id": did,
                "result": result,
            }
            tx.set(f"conversations/{cid}/messages", user["id"], user)
            tx.set(f"conversations/{cid}/messages", assistant["id"], assistant)
            tx.set(
                "conversations",
                cid,
                conv
                | {
                    "message_count": seq + 2,
                    "version": conv["version"] + 1,
                    "pending": False,
                    "busy_until": 0,
                    "active_request": None,
                    "updated_at": repo.now(),
                },
            )
            if did:
                tx.set(
                    "drafts",
                    did,
                    {
                        "id": did,
                        "owner_uid": uid,
                        "draft": result["draft"],
                        "version": 1,
                        "status": "draft",
                        "created_at": repo.now(),
                        "updated_at": repo.now(),
                        "conversation_id": cid,
                        "selected_idea": request.selected_idea.model_dump(),
                        "source_ids": [s["id"] for s in sources],
                    },
                )
            tx.set("requests", rid, reservation | {"status": "done", "response": response})
            if request.mode == "growth":
                key = repo.identity(uid, "growth_" + str(request.request_id))
                tx.set(
                    "growth_recommendations",
                    key,
                    {
                        "id": key,
                        "owner_uid": uid,
                        "result": result["growth"],
                        "fingerprint": hashlib.sha256(
                            request.growth_options.model_dump_json().encode()
                        ).hexdigest(),
                    },
                )
            return response

        return db.atomic(finish)
    except Exception as error:
        # A commit can succeed even when its acknowledgment is lost.
        # Recover the saved result before claiming failure or permitting a new attempt.
        try:
            completed = db.get("requests", rid)
        except Exception:
            raise HTTPException(
                503, "저장 결과를 확인할 수 없습니다. 입력을 유지하고 같은 요청으로 재시도하세요."
            ) from None
        if completed and completed["status"] == "done":
            return completed["response"]

        def fail(tx):
            reservation = tx.get("requests", rid)
            conv = tx.get("conversations", cid)
            if reservation and reservation["status"] == "pending":
                tx.set("requests", rid, reservation | {"status": "failed"})
            if conv and conv.get("active_request") == rid:
                if conv["message_count"] == 0:
                    tx.delete("conversations", cid)
                else:
                    tx.set(
                        "conversations",
                        cid,
                        conv | {"busy_until": 0, "active_request": None},
                    )

        try:
            db.atomic(fail)
        except Exception:
            raise HTTPException(
                503, "저장 결과를 확인할 수 없습니다. 입력을 유지하고 같은 요청으로 재시도하세요."
            ) from None
        if isinstance(error, HTTPException):
            raise
        raise HTTPException(
            502,
            "AI 응답 생성·검증에 실패했습니다. 내용은 저장되지 않았습니다. 새 요청으로 재시도할 수 있습니다.",
        ) from None
