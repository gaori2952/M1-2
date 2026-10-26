"""Owner-scoped post readings, source-matched caches and idempotent paid requests."""

import time
import unicodedata
from datetime import datetime, timezone

from fastapi import HTTPException
from pydantic import ValidationError

from . import repository as repo
from .buffer_service import current_posts, require_buffer_owner
from .content_search import query_terms
from .post_media import download_post_images, image_sources, source_signature, validate_media_url
from .post_reading_models import PostReadingReply

READINGS = "post_readings"
REQUESTS = "post_reading_requests"


def _reading_key(uid, post_id):
    return repo.identity(uid, "post-reading:" + post_id)


def _request_key(uid, request_id):
    return repo.identity(uid, "post-read:" + str(request_id))


def _envelope(doc, *, cached):
    return {
        "status": "ready",
        "post_id": doc["post_id"],
        "reading": doc["reading"],
        "covered_count": doc["covered_count"],
        "total_count": doc["total_count"],
        "cached": cached,
        "read_at": doc["read_at"],
    }


def _valid_reading(doc, uid, post):
    if (
        not doc
        or doc.get("owner_uid") != uid
        or doc.get("post_id") != post.get("id")
        or doc.get("source_signature") != source_signature(post)
        or not doc.get("reading")
    ):
        return None
    try:
        reading = PostReadingReply.model_validate(doc["reading"]).model_dump()
        expected = [f"page-{i}" for i, _ in image_sources(post)[:10]]
        if (
            [p["card_id"] for p in reading["pages"]] != expected
            or doc["covered_count"] != len(expected)
            or doc["total_count"] != len(post.get("assets", []))
            or not isinstance(doc["read_at"], str)
        ):
            return None
        return _envelope(doc | {"reading": reading}, cached=True)
    except (ValidationError, KeyError, TypeError):
        return None


def post_memory(db, uid, posts):
    result = {}
    readings = {doc.get("post_id"): doc for doc in db.list(READINGS, uid)}
    for post in posts:
        if post.get("owner_uid") != uid:
            continue
        doc = readings.get(post["id"])
        memory = _valid_reading(doc, uid, post)
        if memory:
            result[post["id"]] = memory
    return result


def _eligible(post):
    sources = image_sources(post)
    if post.get("status") != "sent" or not sources:
        return False
    try:
        for _, asset in sources[:10]:
            validate_media_url(asset["source"])
        return True
    except HTTPException:
        return False


def select_posts(db, settings, uid, query, post_ids=None):
    require_buffer_owner(settings, uid)
    posts = current_posts(db, settings, uid)
    by_id = {p["id"]: p for p in posts}
    if post_ids and any(pid not in by_id for pid in post_ids):
        raise HTTPException(404, "선택한 게시물을 찾을 수 없습니다.")
    memory = post_memory(db, uid, posts)

    def normalize(text):
        return unicodedata.normalize("NFKC", text).casefold()

    words = query_terms(query)

    def score(post):
        reading = memory.get(post["id"], {}).get("reading", {})
        text = normalize(post.get("text", "") + " " + " ".join(post.get("tags", [])))
        observed = normalize(
            " ".join(reading.get("topics", []))
            + " "
            + reading.get("title", "")
            + " "
            + reading.get("summary", "")
            + " "
            + " ".join(
                page["text"] + " " + page["description"] for page in reading.get("pages", [])
            )
        )
        return sum((word in text) + 2 * (word in observed) for word in words)

    if post_ids:
        candidates = [by_id[pid] for pid in dict.fromkeys(post_ids) if _eligible(by_id[pid])]
    else:
        attempted = {
            (r.get("post_id"), r.get("source_signature"))
            for r in db.list(REQUESTS, uid)
            if r.get("status") in {"pending", "failed"}
        }
        candidates = sorted(
            [
                p
                for p in posts
                if _eligible(p)
                and score(p) > 0
                and (p["id"] in memory or (p["id"], source_signature(p)) not in attempted)
            ],
            key=lambda p: (-score(p), p["id"] not in memory, p["id"]),
        )
    selected, unread = [], False
    for post in candidates:
        cached = post["id"] in memory
        if not cached and unread:
            continue
        selected.append(
            {
                "post_id": post["id"],
                "title": memory.get(post["id"], {}).get("reading", {}).get("title")
                or post.get("text", "").split("\n", 1)[0][:160]
                or "이미지 게시물",
                "cached": cached,
                "image_count": len(image_sources(post)),
            }
        )
        unread = unread or not cached
        if len(selected) == 3:
            break
    return selected


def reading_status(db, uid, request_id):
    key = _request_key(uid, request_id)

    def reconcile(tx):
        request = repo.owned(tx, REQUESTS, key, uid)
        reading_key = _reading_key(uid, request["post_id"])
        current = tx.get(READINGS, reading_key)
        if request["status"] == "pending" and request["expires_at"] <= time.time():
            request = request | {"status": "failed", "error": "lease_expired"}
            tx.set(REQUESTS, key, request)
            if current and current.get("active_request") == key:
                tx.set(READINGS, reading_key, current | {"busy_until": 0, "active_request": None})
        if request["status"] == "ready":
            return request["result"]
        return {
            "status": request["status"],
            "request_id": request["request_id"],
            "post_id": request["post_id"],
        }

    return db.atomic(reconcile)


def read_post(db, reader, settings, uid, body, downloader=download_post_images):
    require_buffer_owner(settings, uid)
    key = _request_key(uid, body.request_id)
    rid = _reading_key(uid, body.post_id)

    def replay(request):
        if request.get("owner_uid") != uid or request["post_id"] != body.post_id:
            raise HTTPException(409, "같은 요청 ID의 게시물이 다릅니다.")
        if request["status"] == "ready":
            return request["result"]
        raise HTTPException(409, "처리 중이거나 중단된 읽기입니다. 같은 요청의 상태를 확인하세요.")

    prior = db.get(REQUESTS, key)
    if prior:
        return replay(prior)
    post = next((p for p in current_posts(db, settings, uid) if p["id"] == body.post_id), None)
    if not post or post.get("owner_uid") != uid:
        raise HTTPException(404, "게시물을 찾을 수 없습니다.")
    if not _eligible(post):
        raise HTTPException(
            422, "읽을 수 있는 게시물 이미지가 없습니다. 영상 본문은 읽지 않습니다."
        )
    signature = source_signature(post)
    quota_id = repo.identity(uid, datetime.now(timezone.utc).strftime("%Y-%m-%d"))

    def reserve(tx):
        prior = tx.get(REQUESTS, key)
        doc = tx.get(READINGS, rid)
        quota = tx.get("quotas", quota_id) or {"count": 0}
        if prior:
            return replay(prior)
        cached = _valid_reading(doc, uid, post)
        pending = {
            "id": key,
            "owner_uid": uid,
            "request_id": str(body.request_id),
            "post_id": body.post_id,
            "source_signature": signature,
            "status": "pending",
            "expires_at": time.time() + 180,
            "created_at": repo.now(),
        }
        if cached:
            tx.set(REQUESTS, key, pending | {"status": "ready", "result": cached})
            return cached
        if doc and doc.get("busy_until", 0) > time.time():
            raise HTTPException(409, "이 게시물을 읽고 있습니다. 잠시 후 결과를 불러오세요.")
        if quota["count"] >= settings.daily_request_limit:
            raise HTTPException(429, "오늘의 AI 요청 한도를 사용했습니다.")
        tx.set("quotas", quota_id, quota | {"owner_uid": uid, "count": quota["count"] + 1})
        tx.set(REQUESTS, key, pending)
        tx.set(
            READINGS,
            rid,
            (doc or {"id": rid, "owner_uid": uid, "post_id": body.post_id})
            | {"busy_until": pending["expires_at"], "active_request": key},
        )
        return None

    prior = db.atomic(reserve)
    if prior:
        return prior
    try:
        images = downloader(post)
        expected = [f"page-{i}" for i, _ in image_sources(post)[:10]]
        if [image["card_id"] for image in images] != expected:
            raise ValueError("Invalid downloaded page coverage")
        context = {
            "post_id": body.post_id,
            "caption": post.get("text", "")[:4000],
            "card_order": expected,
            "covered_count": len(images),
            "total_count": len(post.get("assets", [])),
            "format": post.get("format", "unknown"),
        }
        result = PostReadingReply.model_validate(reader.read(images, context)).model_dump()
        by_id = {p["card_id"]: p for p in result["pages"]}
        if set(by_id) != set(expected):
            raise ValueError("Missing or unknown reading page")
        result["pages"] = [by_id[cid] for cid in expected]

        def finish(tx):
            pending = repo.owned(tx, REQUESTS, key, uid)
            current = repo.owned(tx, READINGS, rid, uid)
            source = next(
                (p for p in current_posts(tx, settings, uid) if p["id"] == body.post_id), None
            )
            if (
                pending["status"] != "pending"
                or current.get("active_request") != key
                or pending["expires_at"] <= time.time()
                or not source
                or source_signature(source) != signature
            ):
                raise HTTPException(409, "게시물 자료가 변경되었거나 읽기 요청이 만료되었습니다.")
            completed = current | {
                "source_signature": signature,
                "reading": result,
                "covered_count": len(images),
                "total_count": context["total_count"],
                "read_at": repo.now(),
                "busy_until": 0,
                "active_request": None,
            }
            envelope = _envelope(completed, cached=False)
            tx.set(READINGS, rid, completed)
            tx.set(
                REQUESTS,
                key,
                pending | {"status": "ready", "result": envelope, "completed_at": repo.now()},
            )
            return envelope

        return db.atomic(finish)
    except Exception as exc:
        try:
            saved = db.get(REQUESTS, key)
            if saved and saved["status"] == "ready":
                return saved["result"]

            def fail(tx):
                pending = repo.owned(tx, REQUESTS, key, uid)
                current = repo.owned(tx, READINGS, rid, uid)
                if pending["status"] == "pending":
                    tx.set(REQUESTS, key, pending | {"status": "failed"})
                if current.get("active_request") == key:
                    tx.set(READINGS, rid, current | {"busy_until": 0, "active_request": None})

            db.atomic(fail)
        except Exception:
            raise HTTPException(
                503, "읽기 저장 상태 확인이 필요합니다. 같은 요청의 상태를 조회하세요."
            ) from None
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(
            502, "게시물 이미지 읽기에 실패했습니다. 이전 성공 결과는 유지됩니다."
        ) from None
