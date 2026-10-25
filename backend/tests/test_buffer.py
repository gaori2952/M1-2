from copy import deepcopy
from uuid import uuid4

import pytest
from app.buffer_client import BufferClient, BufferError, normalize_post
from app.buffer_service import buffer_status, current_posts, sync_buffer
from app.config import Settings
from fastapi import HTTPException

from .memory_store import MemoryStore


def settings():
    return Settings(
        buffer_api_key="test-secret", buffer_channel_id="channel", buffer_owner_uid="alice"
    )


def raw_post(key="post1", follows=0):
    return {
        "id": key,
        "channelId": "channel",
        "text": "합성 전기장 카드뉴스",
        "status": "sent",
        "sentAt": "2026-10-01T11:00:00Z",
        "dueAt": "2026-10-01T10:00:00Z",
        "metricsUpdatedAt": "2026-10-08T11:00:00Z",
        "metadata": {"type": "post"},
        "assets": [
            {
                "type": "image",
                "mimeType": "image/png",
                "source": "https://example.com/image.png",
                "thumbnail": "https://example.com/thumb.png",
            }
        ]
        * 2,
        "externalLink": "https://www.instagram.com/p/synthetic/",
        "tags": [],
        "metrics": [
            {"type": "follows", "name": "Follows", "value": follows, "unit": "count"},
            {"type": "reach", "name": "Reach", "value": 100, "unit": "count"},
        ],
    }


class FakeBuffer:
    def __init__(self):
        self.error = False
        self.calls = 0

    def fetch(self):
        self.calls += 1
        if self.error:
            raise BufferError("upstream_unavailable")
        return {
            "channel": {
                "id": "channel",
                "name": "synthetic",
                "timezone": "Asia/Seoul",
                "postingSchedule": [],
            },
            "posts": [normalize_post(raw_post())],
        }


def test_normalize_preserves_zero_null_and_rejects_invalid_metrics():
    p = normalize_post(raw_post())
    assert p["metrics"]["follows"] == 0
    assert p["metrics"].get("saves") is None
    assert p["format"] == "carousel"
    for bad in (-1, True, float("nan"), 1.5):
        r = raw_post()
        r["metrics"][0]["value"] = bad
        with pytest.raises(BufferError):
            normalize_post(r)
    r = raw_post()
    r["metrics"][0]["unit"] = "percentage"
    with pytest.raises(BufferError):
        normalize_post(r)
    r = raw_post()
    r["externalLink"] = "javascript:alert(1)"
    assert not normalize_post(r)["external_link"]


def test_client_pages_deduplicates_and_checks_owner_channel():
    calls = []

    def transport(query, variables):
        calls.append(variables)
        if "account" in query:
            return {"account": {"organizations": [{"id": "org"}]}}
        if "channels(" in query:
            return {
                "channels": [
                    {
                        "id": "channel",
                        "name": "synthetic",
                        "service": "instagram",
                        "timezone": "Asia/Seoul",
                        "postingSchedule": [],
                    }
                ]
            }
        more = variables.get("after") is None
        return {
            "posts": {
                "edges": [{"node": raw_post()}, {"node": raw_post("post2")}],
                "pageInfo": {"hasNextPage": more, "endCursor": "next"},
            }
        }

    result = BufferClient(settings(), transport=transport).fetch()
    assert len(result["posts"]) == 2
    assert len(calls) == 4

    def repeated(query, variables):
        result = transport(query, variables)
        if "posts" in result:
            result["posts"]["pageInfo"]["hasNextPage"] = True
        return result

    with pytest.raises(BufferError):
        BufferClient(settings(), transport=repeated).fetch()

    def wrong_channel(query, variables):
        result = transport(query, variables)
        if "posts" in result:
            result["posts"]["edges"][0]["node"]["channelId"] = "other"
        return result

    with pytest.raises(BufferError):
        BufferClient(settings(), transport=wrong_channel).fetch()


def test_sync_replay_cache_owner_and_prior_generation_on_failure():
    db, client, cfg = MemoryStore(), FakeBuffer(), settings()
    rid = str(uuid4())
    result = sync_buffer(db, client, cfg, "alice", rid, now=100000)
    assert result["status"] == "done"
    assert current_posts(db, cfg, "alice")[0]["metrics"]["follows"] == 0
    assert sync_buffer(db, client, cfg, "alice", rid, now=100001) == result
    assert sync_buffer(db, client, cfg, "alice", str(uuid4()), now=100002)["cached"]
    assert client.calls == 1
    with pytest.raises(HTTPException) as e:
        current_posts(db, cfg, "bob")
    assert e.value.status_code == 403
    before = deepcopy(current_posts(db, cfg, "alice"))
    client.error = True
    with pytest.raises(HTTPException):
        sync_buffer(db, client, cfg, "alice", str(uuid4()), now=104000)
    assert current_posts(db, cfg, "alice") == before
    assert buffer_status(db, cfg, "alice")["last_error"] == "upstream_unavailable"


def test_partial_persistence_never_switches_pointer_and_quota_limits_attempts():
    db, client, cfg = MemoryStore(), FakeBuffer(), settings()
    sync_buffer(db, client, cfg, "alice", str(uuid4()), now=100000)
    original = db.set

    def fail_write(collection, key, value):
        if collection.endswith("/posts"):
            raise RuntimeError("private details must not escape")
        original(collection, key, value)

    db.set = fail_write
    for i in range(4):
        with pytest.raises(HTTPException):
            sync_buffer(db, client, cfg, "alice", str(uuid4()), now=104000 + i)
    assert len(current_posts(db, cfg, "alice")) == 1
    with pytest.raises(HTTPException) as e:
        sync_buffer(db, client, cfg, "alice", str(uuid4()), now=104010)
    assert e.value.status_code == 429


def test_sync_uses_production_store_interface():
    backing = MemoryStore()

    class ProductionContract:
        get = backing.get
        list = backing.list
        atomic = backing.atomic

    result = sync_buffer(ProductionContract(), FakeBuffer(), settings(), "alice", str(uuid4()))
    assert result["status"] == "done"
    assert len(current_posts(ProductionContract(), settings(), "alice")) == 1
