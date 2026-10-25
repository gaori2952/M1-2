import time
from collections import Counter
from datetime import datetime, timezone

from fastapi import HTTPException

from . import repository as repo
from .buffer_client import BufferError


def require_buffer_owner(settings, uid):
    if not settings.buffer_owner_uid or not settings.buffer_channel_id:
        raise HTTPException(503, "BUFFER_OWNER_UID와 BUFFER_CHANNEL_ID 서버 설정이 필요합니다.")
    if settings.buffer_owner_uid != uid:
        raise HTTPException(403, "이 Buffer 계정의 소유자만 사용할 수 있습니다.")


def connection(db, settings, uid):
    require_buffer_owner(settings, uid)
    return db.get("buffer_connections", repo.identity(uid, "buffer")) or {"owner_uid": uid}


def current_posts(db, settings, uid):
    c = connection(db, settings, uid)
    if c.get("channel", {}).get("id") != settings.buffer_channel_id:
        return []
    return db.list(f"buffer_syncs/{c['sync_id']}/posts", uid) if c.get("sync_id") else []


def buffer_status(db, settings, uid):
    c = connection(db, settings, uid)
    posts = current_posts(db, settings, uid)
    dates = [p["sent_at"] for p in posts if p.get("sent_at")]
    return {
        "configured": bool(settings.buffer_api_key),
        "channel": c.get("channel"),
        "sync_id": c.get("sync_id"),
        "last_success_at": c.get("last_success_at"),
        "last_error": c.get("last_error"),
        "status": c.get("status", "not_synced"),
        "count": len(posts),
        "formats": dict(Counter(p["format"] for p in posts)),
        "follows_count": sum(p["metrics"].get("follows") is not None for p in posts),
        "period": {"start": min(dates), "end": max(dates)} if dates else None,
        "gpt_configured": bool(settings.openai_api_key),
        "chat_configured": settings.generator_configured,
        "assistant_provider": settings.llm_provider,
        "assistant_model": settings.anthropic_model
        if settings.llm_provider == "anthropic"
        else settings.openai_model,
    }


def sync_buffer(db, client, settings, uid, request_id, *, now=None):
    connection(db, settings, uid)
    stamp = time.time() if now is None else now
    rid = repo.identity(uid, "buffer_" + str(request_id))
    cid = repo.identity(uid, "buffer")
    day = datetime.fromtimestamp(stamp, timezone.utc).strftime("%Y-%m-%d")
    qid = repo.identity(uid, "buffer_" + day)

    def reserve(tx):
        prior = tx.get("buffer_syncs", rid)
        current = tx.get("buffer_connections", cid) or {"id": cid, "owner_uid": uid}
        quota = tx.get("buffer_quotas", qid) or {"count": 0}
        if prior:
            if prior["status"] == "done":
                return prior
            raise HTTPException(
                409, "동기화 상태를 확인하세요. 실패한 요청은 새로 불러오기로 다시 시작하세요."
            )
        if (
            current.get("channel", {}).get("id") == settings.buffer_channel_id
            and current.get("last_success_epoch") is not None
            and stamp - current["last_success_epoch"] < 3600
        ):
            return {
                "status": "done",
                "cached": True,
                "sync_id": current["sync_id"],
                "count": current["count"],
            }
        if current.get("busy_until", 0) > stamp:
            raise HTTPException(409, "동기화가 진행 중입니다. 잠시 후 상태를 확인하세요.")
        if quota["count"] >= 5:
            raise HTTPException(
                429, "오늘의 Buffer 동기화 5회를 사용했습니다. UTC 자정에 초기화됩니다."
            )
        record = {
            "id": rid,
            "owner_uid": uid,
            "channel_id": settings.buffer_channel_id,
            "status": "pending",
            "request_id": str(request_id),
            "started_at": repo.now(),
            "expires_at": stamp + 600,
        }
        tx.set("buffer_syncs", rid, record)
        tx.set(
            "buffer_connections",
            cid,
            current | {"status": "syncing", "active_request": rid, "busy_until": stamp + 600},
        )
        tx.set("buffer_quotas", qid, {"owner_uid": uid, "count": quota["count"] + 1})
        return None

    prior = db.atomic(reserve)
    if prior:
        return prior
    try:
        result = client.fetch()
        if result["channel"]["id"] != settings.buffer_channel_id:
            raise BufferError("channel_mismatch")
        for post in result["posts"]:
            db.atomic(
                lambda tx: tx.set(
                    f"buffer_syncs/{rid}/posts",
                    repo.identity(uid, post["id"]),
                    post | {"owner_uid": uid, "observed_at": repo.now()},
                )
            )

        def finish(tx):
            active = tx.get("buffer_connections", cid)
            record = tx.get("buffer_syncs", rid)
            if (
                not active
                or active.get("active_request") != rid
                or active.get("busy_until", 0) < (time.time() if now is None else now)
            ):
                raise BufferError("lease_expired")
            record |= {
                "status": "done",
                "sync_id": rid,
                "count": len(result["posts"]),
                "complete": True,
                "completed_at": repo.now(),
            }
            tx.set("buffer_syncs", rid, record)
            tx.set(
                "buffer_connections",
                cid,
                active
                | {
                    "status": "ready",
                    "sync_id": rid,
                    "channel": result["channel"],
                    "count": record["count"],
                    "last_success_at": repo.now(),
                    "last_success_epoch": stamp,
                    "busy_until": 0,
                    "active_request": None,
                    "last_error": None,
                },
            )
            return record

        return db.atomic(finish)
    except Exception as error:
        saved = db.get("buffer_syncs", rid)
        if saved and saved["status"] == "done":
            return saved
        code = error.code if isinstance(error, BufferError) else "storage_or_service_error"

        def fail(tx):
            active = tx.get("buffer_connections", cid)
            record = tx.get("buffer_syncs", rid)
            if record:
                tx.set("buffer_syncs", rid, record | {"status": "failed", "error": code})
            if active and active.get("active_request") == rid:
                tx.set(
                    "buffer_connections",
                    cid,
                    active
                    | {
                        "status": "failed",
                        "last_error": code,
                        "busy_until": 0,
                        "active_request": None,
                    },
                )

        db.atomic(fail)
        raise HTTPException(
            503,
            "Buffer 동기화에 실패했습니다. 이전 성공 자료를 유지합니다. 상태에서 설정·권한·요청 제한을 확인하세요.",
        ) from None


def sync_request_status(db, settings, uid, request_id):
    require_buffer_owner(settings, uid)
    rid = repo.identity(uid, "buffer_" + str(request_id))
    cid = repo.identity(uid, "buffer")

    def reconcile(tx):
        record = repo.owned(tx, "buffer_syncs", rid, uid)
        active = tx.get("buffer_connections", cid)
        if record["status"] == "pending" and record.get("expires_at", float("inf")) <= time.time():
            record |= {"status": "failed", "error": "lease_expired"}
            tx.set("buffer_syncs", rid, record)
            if active and active.get("active_request") == rid:
                tx.set(
                    "buffer_connections",
                    cid,
                    active
                    | {
                        "status": "failed",
                        "last_error": "lease_expired",
                        "active_request": None,
                        "busy_until": 0,
                    },
                )
        return record

    return db.atomic(reconcile)
