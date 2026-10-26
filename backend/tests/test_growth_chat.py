from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from app.config import Settings
from app.generation import system_prompt
from app.main import create_app
from fastapi.testclient import TestClient

from .memory_store import MemoryStore
from .test_buffer import FakeBuffer
from .test_chat import Generator


@pytest.fixture
def env():
    db, generator = MemoryStore(), Generator()
    cfg = Settings(
        allowed_user_uids=("alice", "bob"),
        openai_api_key="synthetic-key",
        buffer_owner_uid="alice",
        buffer_channel_id="channel",
        buffer_api_key="synthetic-buffer-key",
    )
    app = create_app(
        cfg,
        store=db,
        verify_token=lambda t: {"uid": t},
        buffer_client=FakeBuffer(),
        growth_generator=generator,
    )
    with TestClient(app) as client:
        client.headers["Authorization"] = "Bearer alice"
        assert client.post("/api/buffer/sync", json={"request_id": str(uuid4())}).status_code == 200
        yield client, db, generator


def options():
    return {
        "format": "carousel",
        "topic": "전기장",
        "slots": [(datetime.now(timezone.utc) + timedelta(hours=3)).isoformat()],
    }


def test_growth_chat_grounded_saved_and_replay(env):
    c, db, g = env
    rid = str(uuid4())
    body = {
        "request_id": rid,
        "mode": "growth",
        "message": "언제 올릴까?",
        "growth_options": options(),
    }
    r = c.post("/api/chat", json=body)
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["result"]["growth"]["goal"] == "followers"
    assert result["result"]["growth"]["evidence"][0]["id"] == "post1"
    context = g.calls[0][1]
    assert len(context["sources"]) <= 5
    assert "[사용자 데이터 요약]" in system_prompt(context)
    assert "자료 없음" in system_prompt(context) or "저장된 데이터가 없습니다" in system_prompt(
        context
    )
    assert c.post("/api/chat", json=body).json() == result
    assert len(g.calls) == 1
    saved = c.post(
        "/api/growth/experiments",
        json={"request_id": rid, "candidate_id": result["result"]["growth"]["candidates"][0]["id"]},
    )
    assert saved.status_code == 201, saved.text
    history = c.get("/api/conversations/" + result["conversation_id"]).json()
    assert history["messages"][1]["result"]["growth"] == result["result"]["growth"]
    assert c.get("/api/buffer/status", headers={"Authorization": "Bearer bob"}).status_code == 403
    assert "synthetic-buffer-key" not in c.get("/api/buffer/status").text


def test_content_recommendations_are_returned_saved_and_validate_their_sources(env):
    from .test_chat import idea

    c, db, g = env
    g.result = {
        "answer": "다음에는 전위차를 다루는 카드뉴스를 추천해요.",
        "ideas": [
            idea() | {"title": "전기장은 있는데 왜 전위차는 0일까?", "source_ids": ["post1"]}
        ],
        "source_ids": ["post1"],
        "draft": None,
    }
    body = {
        "request_id": str(uuid4()),
        "mode": "growth",
        "message": "다음에 어떤 콘텐츠 올리는 게 좋아 보여?",
        "growth_options": {"format": "carousel"},
    }
    response = c.post("/api/chat", json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["result"]["ideas"][0]["title"] == "전기장은 있는데 왜 전위차는 0일까?"
    history = c.get("/api/conversations/" + result["conversation_id"]).json()
    assert history["messages"][1]["result"]["ideas"] == result["result"]["ideas"]
    g.result["ideas"][0]["source_ids"] = ["invented"]
    assert c.post("/api/chat", json=body | {"request_id": str(uuid4())}).status_code == 502


def test_content_question_can_reference_recent_posts_and_posts_without_follow_metrics(env):
    from app.repository import identity

    from .test_growth import post

    c, db, g = env
    sync_id = db.list("buffer_connections", "alice")[0]["sync_id"]
    for i in range(6):
        p = post(f"high{i}", day=30 + i, follows=100 - i) | {
            "metrics_updated_at": datetime.now(timezone.utc).isoformat()
        }
        db.set(
            f"buffer_syncs/{sync_id}/posts", identity("alice", p["id"]), p | {"owner_uid": "alice"}
        )
    for p in [
        post("recent", day=1, follows=0) | {"text": "전위차와 전기장의 관계"},
        post("motor", day=2, follows=None, kind="reel") | {"text": "모터가 돌아가는 원리"},
    ]:
        p["metrics_updated_at"] = datetime.now(timezone.utc).isoformat()
        db.set(
            f"buffer_syncs/{sync_id}/posts", identity("alice", p["id"]), p | {"owner_uid": "alice"}
        )
    response = c.post(
        "/api/chat",
        json={
            "request_id": str(uuid4()),
            "mode": "growth",
            "message": "모터 콘텐츠 다음에 어떤 주제를 올릴까?",
            "growth_options": {"format": "carousel"},
        },
    )
    assert response.status_code == 200, response.text
    context = g.calls[0][1]
    assert {"recent", "motor", "high0"}.issubset({s["id"] for s in context["sources"]})
    assert len(context["sources"]) <= 5
    motor = next(s for s in context["sources"] if s["id"] == "motor")
    assert motor["metrics"]["follows"] is None
    assert motor["format"] == "reel"
    assert motor["reference_basis"]
    assert len(context["growth"]["content_history"]) == 9


def test_expired_optional_time_does_not_block_a_content_question(env):
    c, db, g = env
    response = c.post(
        "/api/chat",
        json={
            "request_id": str(uuid4()),
            "mode": "growth",
            "message": "다음 콘텐츠 추천해줘",
            "growth_options": {
                "slots": [(datetime.now(timezone.utc) - timedelta(days=1)).isoformat()]
            },
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["result"]["growth"]["candidates"] == []


def test_caption_history_can_be_cited_without_claiming_unprovided_metrics(env):
    from app.repository import identity

    from .test_chat import idea
    from .test_growth import post

    c, db, g = env
    sync_id = db.list("buffer_connections", "alice")[0]["sync_id"]
    for i in range(8):
        p = post(f"history{i}", day=30 + i, follows=i + 1) | {
            "text": f"합성 캡션 {i}",
            "metrics_updated_at": datetime.now(timezone.utc).isoformat(),
        }
        db.set(
            f"buffer_syncs/{sync_id}/posts", identity("alice", p["id"]), p | {"owner_uid": "alice"}
        )
    g.result = {
        "answer": "캡션의 후속 주제를 제안해요.",
        "source_ids": ["history3"],
        "ideas": [idea() | {"source_ids": ["history3"]}],
        "draft": None,
    }
    response = c.post(
        "/api/chat",
        json={
            "request_id": str(uuid4()),
            "mode": "growth",
            "message": "다음 콘텐츠 추천해줘",
            "growth_options": {},
        },
    )
    assert response.status_code == 200, response.text
    context = g.calls[0][1]
    assert "history3" not in {p["id"] for p in context["sources"]}
    reference = next(
        p for p in response.json()["result"]["growth"]["content_history"] if p["id"] == "history3"
    )
    assert reference["external_link"] == "https://example.com/post"
    assert "metrics" not in reference


@pytest.mark.parametrize(
    "message,other_metrics",
    [("다음 콘텐츠를 추천해줘", False), ("저장과 공유 성과를 비교해줘", True)],
)
def test_follower_goal_context_does_not_substitute_save_or_share_counts(
    env, message, other_metrics
):
    c, db, g = env
    sync_id = db.list("buffer_connections", "alice")[0]["sync_id"]
    collection = f"buffer_syncs/{sync_id}/posts"
    original = db.list(collection, "alice")[0]
    original["metrics"] |= {"shares": 999, "saves": 777, "views": 12345}
    from app.repository import identity

    db.set(collection, identity("alice", original["id"]), original)
    response = c.post(
        "/api/chat",
        json={
            "request_id": str(uuid4()),
            "mode": "growth",
            "message": message,
            "growth_options": {},
        },
    )
    assert response.status_code == 200, response.text
    metrics = g.calls[0][1]["sources"][0]["metrics"]
    if other_metrics:
        assert metrics["shares"] == 999
    else:
        assert metrics == {"follows": 0, "reach": 100}
    assert c.get("/api/buffer/posts").json()["items"][0]["metrics"]["shares"] == 999


def test_preview_without_gpt_and_annotation_preserves_original(env):
    c, db, g = env
    rid = str(uuid4())
    r = c.post("/api/growth/recommendations", json={"request_id": rid, "options": options()})
    assert r.status_code == 200 and not g.calls
    assert r.json()["candidates"][0]["kind"] == "experiment"
    assert (
        c.put(
            "/api/buffer/posts/post1/annotation", json={"tags": ["물리"], "manual_follows": 20}
        ).status_code
        == 200
    )
    p = c.get("/api/buffer/posts").json()["items"][0]
    assert p["metrics"]["follows"] == 0 and p["annotation"]["manual_follows"] == 20


@pytest.mark.parametrize(
    "provider,key_name", [("anthropic", "ANTHROPIC_API_KEY"), ("openai", "OPENAI_API_KEY")]
)
def test_missing_selected_provider_key_is_explicit(provider, key_name):
    cfg = Settings(allowed_user_uids=("alice",), llm_provider=provider)
    with TestClient(create_app(cfg, store=MemoryStore(), verify_token=lambda t: {"uid": t})) as c:
        r = c.post(
            "/api/chat",
            headers={"Authorization": "Bearer alice"},
            json={
                "request_id": str(uuid4()),
                "mode": "growth",
                "message": "성장",
                "growth_options": options(),
            },
        )
        assert r.status_code == 503 and key_name in r.json()["detail"]


def test_import_validates_duplicates_and_preserves_user_edits(env):
    c, db, g = env
    csv = "date,views,viewers,interactions,visits,follows,link_clicks\n2026-10-01,100,20,10,5,,0\n"
    r = c.post("/api/data/import", json={"csv_text": csv})
    assert r.status_code == 200 and r.json()["imported"] == 6
    assert r.json()["missing_count"] == 1
    row = c.get("/api/data?metric=views").json()[0]
    assert (
        c.put("/api/data/" + row["id"], json={"value": 999, "memo": "내 수정"}).status_code == 200
    )
    assert c.post("/api/data/import", json={"csv_text": csv}).json()["skipped"] == 6
    assert c.get("/api/data?metric=views").json()[0]["value"] == 999
    assert c.post("/api/data/import", json={"csv_text": "bad"}).status_code == 422


def test_expired_pending_requests_are_recoverable(env):
    c, db, g = env
    from app.repository import identity

    rid = str(uuid4())
    db.set(
        "requests",
        identity("alice", rid),
        {
            "id": identity("alice", rid),
            "owner_uid": "alice",
            "status": "pending",
            "expires_at": 1,
            "conversation_id": "conversation",
        },
    )
    db.set(
        "conversations",
        "conversation",
        {
            "id": "conversation",
            "owner_uid": "alice",
            "active_request": identity("alice", rid),
            "busy_until": 1,
            "message_count": 2,
        },
    )
    assert c.get("/api/chat/requests/" + rid).json()["status"] == "failed"
    assert db.get("conversations", "conversation")["active_request"] is None
    sid = str(uuid4())
    db.set(
        "buffer_syncs",
        identity("alice", "buffer_" + sid),
        {
            "id": identity("alice", "buffer_" + sid),
            "owner_uid": "alice",
            "status": "pending",
            "expires_at": 1,
        },
    )
    assert c.get("/api/buffer/sync/" + sid).json()["status"] == "failed"


def test_deleted_request_status_does_not_read_empty_conversation_id(env):
    c, db, g = env
    from app.repository import identity

    rid = str(uuid4())
    db.set(
        "requests",
        identity("alice", rid),
        {"id": identity("alice", rid), "owner_uid": "alice", "status": "deleted"},
    )
    original_get = db.get

    def guarded_get(collection, key):
        if not key:
            raise ValueError("Firestore document IDs cannot be empty")
        return original_get(collection, key)

    db.get = guarded_get
    assert c.get("/api/chat/requests/" + rid).json()["status"] == "deleted"


def test_growth_uses_configured_anthropic_without_openai_key():
    from app.anthropic_generation import AnthropicGenerator

    cfg = Settings(
        allowed_user_uids=("alice",),
        llm_provider="anthropic",
        anthropic_api_key="synthetic-key",
        buffer_owner_uid="alice",
        buffer_channel_id="channel",
        buffer_api_key="synthetic-buffer",
    )
    actual_app = create_app(cfg, store=MemoryStore(), verify_token=lambda t: {"uid": t})
    assert isinstance(actual_app.state.growth_generator, AnthropicGenerator)
    generator = Generator()
    app = create_app(
        cfg,
        store=MemoryStore(),
        verify_token=lambda t: {"uid": t},
        generator=generator,
        buffer_client=FakeBuffer(),
    )
    with TestClient(app) as c:
        c.headers["Authorization"] = "Bearer alice"
        assert c.post("/api/buffer/sync", json={"request_id": str(uuid4())}).status_code == 200
        status = c.get("/api/buffer/status").json()
        assert status["chat_configured"] and status["assistant_provider"] == "anthropic"
        assert not status["gpt_configured"]
        response = c.post(
            "/api/chat",
            json={
                "request_id": str(uuid4()),
                "mode": "growth",
                "message": "이 기록으로 조언해줘",
                "growth_options": options(),
            },
        )
        assert response.status_code == 200, response.text
        assert len(generator.calls) == 1
