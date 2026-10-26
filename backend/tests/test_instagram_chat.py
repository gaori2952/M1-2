import json
from uuid import uuid4

import httpx
import httpx2
from anthropic import Anthropic
from app.anthropic_generation import AnthropicGenerator
from app.config import Settings
from app.generation import OpenAIGenerator
from app.models import ChatInput
from openai import OpenAI

from .test_anthropic_transport import message, settings, sse
from .test_chat import reply
from .test_growth_chat import env as env
from .test_image_review_transport import asset


def test_draft_images_are_validated_sent_and_only_metadata_persists(env):
    c, db, generator = env
    image = asset(cid="draft-one")
    generator.result = reply() | {"work_text": "후속 카드뉴스 초안\n첫 장: 전위차는 왜 0일까?"}
    body = {
        "request_id": str(uuid4()),
        "mode": "growth",
        "message": "이 초안을 내 게시물과 비교해줘",
        "growth_options": {"post_ids": ["post1"]},
        "images": [image],
    }
    response = c.post("/api/chat", json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["result"]["work_text"].startswith("후속")
    assert generator.calls[0][0].images[0].sha256 == image["sha256"]
    history = c.get("/api/conversations/" + result["conversation_id"]).json()
    assert history["messages"][0]["images"][0]["sha256"] == image["sha256"]
    assert image["base64"] not in repr(db.docs)
    assert c.post("/api/chat", json=body).json() == result
    assert len(generator.calls) == 1
    body["request_id"] = str(uuid4())
    body["images"][0]["sha256"] = "0" * 64
    assert c.post("/api/chat", json=body).status_code == 422
    assert len(generator.calls) == 1


def test_selected_buffer_source_must_belong_to_owner(env):
    c, db, g = env
    body = {
        "request_id": str(uuid4()),
        "mode": "growth",
        "message": "이 게시물을 재활용해줘",
        "growth_options": {"post_ids": ["other-users-post"]},
    }
    assert c.post("/api/chat", json=body).status_code == 404
    assert not g.calls


def test_follow_up_receives_previous_work_text_and_attachment_limit(env):
    c, _, g = env
    g.result = reply() | {"work_text": "마지막 장 고유 문구 123"}
    first = c.post(
        "/api/chat",
        json={
            "request_id": str(uuid4()),
            "mode": "growth",
            "message": "후속 원고 써줘",
            "growth_options": {},
            "images": [asset()],
        },
    ).json()
    second = c.post(
        "/api/chat",
        json={
            "request_id": str(uuid4()),
            "mode": "growth",
            "conversation_id": first["conversation_id"],
            "message": "마지막 장만 줄여줘",
            "growth_options": {},
        },
    )
    assert second.status_code == 200, second.text
    history = g.calls[-1][2]
    assert history[-1]["work_text"] == "마지막 장 고유 문구 123"
    assert history[0]["image_metadata_only"][0]["name"] == "same.png"
    assert "base64" not in repr(history)


def test_large_reading_library_still_fits_firestore_request_document():
    from app.chat_service import run_chat
    from app.post_media import source_signature
    from app.post_reading_models import PostReadingReply
    from app.repository import identity
    from google.cloud.firestore_v1 import _helpers
    from google.cloud.firestore_v1.types.document import Document

    from .test_chat import Generator, idea
    from .test_post_readings import post, setup

    posts = [
        post(f"p{i:02d}", count=10)
        | {
            "metrics": {"follows": 1, "reach": 100},
            "metrics_updated_at": "2026-10-25T01:00:00+00:00",
        }
        for i in range(60)
    ]
    db, cfg, _ = setup(posts)
    reading = PostReadingReply(
        title="한" * 160,
        summary="가" * 1000,
        topics=["나" * 80 for _ in range(20)],
        pages=[
            {"card_id": f"page-{i}", "text": "다" * 600, "description": "라" * 300, "legible": True}
            for i in range(1, 11)
        ],
    ).model_dump()
    for p in posts:
        key = identity("alice", "post-reading:" + p["id"])
        db.set(
            "post_readings",
            key,
            {
                "id": key,
                "owner_uid": "alice",
                "post_id": p["id"],
                "source_signature": source_signature(p),
                "reading": reading,
                "covered_count": 10,
                "total_count": 10,
                "read_at": "2026-10-26T00:00:00+00:00",
            },
        )
    generator = Generator()
    generator.result = reply() | {
        "source_ids": [f"p{i:02d}" for i in range(5)],
        "ideas": [
            idea() | {"source_ids": [f"p{i:02d}" for i in range(5 + 5 * j, 10 + 5 * j)]}
            for j in range(3)
        ],
    }
    run_chat(
        db,
        generator,
        cfg,
        "alice",
        ChatInput(request_id=uuid4(), mode="growth", message="후속 원고", growth_options={}),
    )
    request_doc = db.list("requests", "alice")[0]
    assert Document(fields=_helpers.encode_dict(request_doc))._pb.ByteSize() < 1_048_576
    assert len(generator.calls[0][1]["growth"]["content_history"]) == 60
    assert len(request_doc["response"]["result"]["growth"]["content_history"]) == 20


def test_korean_question_chip_finds_topic_with_particle():
    from app.content_search import select_contents
    from app.post_reading_service import select_posts

    from .test_post_readings import post, setup

    db, cfg, _ = setup([post(text="전기장 방향")])
    query = "내 게시물 중 전기장을 다룬 내용을 찾아줘."
    assert select_posts(db, cfg, "alice", query)[0]["post_id"] == "one"
    assert (
        select_contents(
            query, [{"id": "one", "title": "전기장 방향", "text": "전기장 방향", "tags": []}], []
        )[0]["id"]
        == "one"
    )


def test_openai_chat_sends_images_once_as_images_not_json_text(monkeypatch):
    from app import generation

    sent = []

    def handle(request):
        sent.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "resp_test",
                "object": "response",
                "created_at": 1,
                "status": "completed",
                "model": "test-model",
                "output": [
                    {
                        "type": "message",
                        "id": "msg_test",
                        "status": "completed",
                        "role": "assistant",
                        "content": [
                            {"type": "output_text", "text": json.dumps(reply()), "annotations": []}
                        ],
                    }
                ],
            },
        )

    image = asset()
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        monkeypatch.setattr(generation, "OpenAI", lambda **kw: OpenAI(**kw, http_client=client))
        OpenAIGenerator(Settings(openai_api_key="test")).generate(
            ChatInput(
                request_id=uuid4(),
                mode="growth",
                growth_options={},
                message="초안 비교",
                images=[image],
            ),
            {},
            [],
        )
    blocks = sent[0]["input"][-1]["content"]
    assert len([b for b in blocks if b["type"] == "input_image"]) == 1
    assert all(
        image["base64"] not in b.get("text", "") for b in blocks if b["type"] == "input_text"
    )
    assert sent[0]["store"] is False


def test_anthropic_chat_uses_native_image_blocks(monkeypatch):
    from app import anthropic_generation

    sent = []

    def handle(request):
        sent.append(json.loads(request.content))
        return sse(message())

    image = asset()
    with httpx2.Client(transport=httpx2.MockTransport(handle)) as client:
        monkeypatch.setattr(
            anthropic_generation, "Anthropic", lambda **kw: Anthropic(**kw, http_client=client)
        )
        AnthropicGenerator(settings()).generate(
            ChatInput(
                request_id=uuid4(),
                mode="growth",
                growth_options={},
                message="초안 비교",
                images=[image],
            ),
            {},
            [],
        )
    blocks = sent[0]["messages"][-1]["content"]
    assert len([b for b in blocks if b["type"] == "image"]) == 1
    assert all(image["base64"] not in b.get("text", "") for b in blocks if b["type"] == "text")


def test_post_reader_uses_separate_reading_schema(monkeypatch):
    from app import image_review_generation
    from app.image_review_generation import ImageReviewer

    sent = []
    reading = {
        "title": "전위",
        "summary": "등전위면",
        "topics": ["전위"],
        "pages": [
            {"card_id": "card-1", "text": "전위차 0", "description": "합성", "legible": True}
        ],
    }

    def handle(request):
        sent.append(json.loads(request.content))
        return sse(
            message(
                content=[
                    {"type": "tool_use", "id": "t", "name": "submit_post_reading", "input": reading}
                ]
            )
        )

    with httpx2.Client(transport=httpx2.MockTransport(handle)) as client:
        monkeypatch.setattr(
            image_review_generation, "Anthropic", lambda **kw: Anthropic(**kw, http_client=client)
        )
        assert ImageReviewer(settings()).read([asset()], {"card_order": ["card-1"]}) == reading
    assert sent[0]["tool_choice"]["name"] == "submit_post_reading"
    assert sent[0]["tools"][0]["input_schema"]["title"] == "PostReadingReply"


def test_invalid_image_validation_does_not_echo_submitted_payload(env):
    c, _, _ = env
    image = asset() | {"mime": "invalid"}
    response = c.post(
        "/api/chat",
        json={
            "request_id": str(uuid4()),
            "mode": "growth",
            "growth_options": {},
            "message": "비교",
            "images": [image],
        },
    )
    assert response.status_code == 422
    assert image["base64"] not in response.text
    assert "input" not in response.json()["detail"][0]


def test_saved_image_body_is_retrieved_without_relabeling_caption(env):
    from app.repository import identity

    from .test_post_readings import Reader, images, post

    c, db, g = env
    sync_id = db.list("buffer_connections", "alice")[0]["sync_id"]
    original = post("body-only", text="오늘의 공학 카드") | {
        "metrics": {},
        "metrics_updated_at": None,
    }
    db.set(f"buffer_syncs/{sync_id}/posts", identity("alice", original["id"]), original)
    reader = Reader()
    reader.transform = lambda r: r | {"summary": "오일러 좌굴 임계하중", "topics": ["좌굴"]}
    c.app.state.post_reader = reader
    c.app.state.post_downloader = images
    read_body = {"request_id": str(uuid4()), "post_id": "body-only"}
    result = c.post("/api/post-readings", json=read_body)
    assert result.status_code == 200, result.text
    assert c.post("/api/post-readings", json=read_body).json() == result.json()
    assert len(reader.calls) == 1
    response = c.post(
        "/api/chat",
        json={
            "request_id": str(uuid4()),
            "mode": "growth",
            "message": "좌굴 관련 게시물 찾아줘",
            "growth_options": {},
        },
    )
    assert response.status_code == 200, response.text
    source = next(s for s in g.calls[0][1]["sources"] if s["id"] == "body-only")
    assert source["text"] == "오늘의 공학 카드"
    assert source["reading"]["summary"] == "오일러 좌굴 임계하중"
    assert source["reading"]["covered_count"] == 2
    history = c.get("/api/conversations/" + response.json()["conversation_id"]).json()
    assert any(s.get("reading") for s in history["messages"][1]["result"]["growth"]["evidence"])
