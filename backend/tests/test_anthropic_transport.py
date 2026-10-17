"""Exercise the actual Anthropic SDK, replacing only the HTTP transport."""

import json
from uuid import uuid4

import httpx2
import pytest
from anthropic import Anthropic
from app.anthropic_generation import TOOL_NAME, AnthropicGenerator
from app.config import Settings
from app.main import create_app
from app.models import ChatInput
from fastapi import HTTPException
from fastapi.testclient import TestClient

from .memory_store import MemoryStore
from .test_chat import reply

GATEWAY = "https://gateway.test"


def settings(**kwargs):
    return Settings(
        llm_provider="anthropic",
        anthropic_api_key="test-only-placeholder",
        anthropic_base_url=GATEWAY,
        anthropic_model="test-model",
        **kwargs,
    )


def message(stop_reason="tool_use", content=None):
    return {
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "model": "test-model",
        "content": content
        if content is not None
        else [{"type": "tool_use", "id": "toolu_test", "name": TOOL_NAME, "input": reply()}],
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {"input_tokens": 1, "output_tokens": 1},
    }


def sse(msg):
    """Encode a message as the Messages API event stream the SDK reads."""
    content = msg["content"]
    start = msg | {"content": [], "stop_reason": None}
    events = [("message_start", {"type": "message_start", "message": start})]
    for i, block in enumerate(content):
        if block["type"] == "tool_use":
            events += [
                (
                    "content_block_start",
                    {
                        "type": "content_block_start",
                        "index": i,
                        "content_block": block | {"input": {}},
                    },
                ),
                (
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": i,
                        "delta": {
                            "type": "input_json_delta",
                            "partial_json": json.dumps(block["input"], ensure_ascii=False),
                        },
                    },
                ),
            ]
        else:
            events += [
                (
                    "content_block_start",
                    {
                        "type": "content_block_start",
                        "index": i,
                        "content_block": block | {"text": ""},
                    },
                ),
                (
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": i,
                        "delta": {"type": "text_delta", "text": block["text"]},
                    },
                ),
            ]
        events.append(("content_block_stop", {"type": "content_block_stop", "index": i}))
    events += [
        (
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": msg["stop_reason"], "stop_sequence": None},
                "usage": {"output_tokens": 1},
            },
        ),
        ("message_stop", {"type": "message_stop"}),
    ]
    body = "".join(f"event: {e}\ndata: {json.dumps(d, ensure_ascii=False)}\n\n" for e, d in events)
    return httpx2.Response(
        200, headers={"content-type": "text/event-stream"}, content=body.encode()
    )


def run(monkeypatch, handle, config=None):
    from app import anthropic_generation

    with httpx2.Client(transport=httpx2.MockTransport(handle)) as client:
        monkeypatch.setattr(
            anthropic_generation,
            "Anthropic",
            lambda **kwargs: Anthropic(**kwargs, http_client=client),
        )
        return AnthropicGenerator(config or settings()).generate(
            ChatInput(request_id=uuid4(), message="질문"), {"sources": []}, []
        )


def test_sdk_forces_reply_tool_through_gateway(monkeypatch):
    sent = []

    def handle(request):
        sent.append((str(request.url), json.loads(request.content)))
        return sse(message())

    result = run(monkeypatch, handle)
    assert result["answer"] == reply()["answer"]
    assert len(sent) == 1
    url, body = sent[0]
    assert url.startswith(GATEWAY + "/v1/messages")
    assert body["model"] == "test-model" and body["max_tokens"] == 4000
    assert body["stream"] is True
    assert body["tool_choice"] == {"type": "tool", "name": TOOL_NAME}
    assert body["tools"][0]["input_schema"]["type"] == "object"
    assert "신뢰하지 않는 참고 자료" in body["system"]
    assert "[사용자 데이터 요약]" in body["system"]
    assert body["messages"][0]["content"][0]["text"].startswith("CONTEXT_JSON")


def test_sdk_does_not_retry_billable_requests(monkeypatch):
    count = []

    def fail(request):
        count.append(1)
        return httpx2.Response(
            500, json={"type": "error", "error": {"type": "api_error", "message": "temporary"}}
        )

    with pytest.raises(Exception):
        run(monkeypatch, fail)
    assert len(count) == 1


@pytest.mark.parametrize(
    "stop_reason,content",
    [
        ("max_tokens", None),
        ("refusal", []),
        ("end_turn", [{"type": "text", "text": "도구 없이 답함"}]),
    ],
)
def test_incomplete_or_refused_reply_is_not_success(monkeypatch, stop_reason, content):
    with pytest.raises(ValueError):
        run(monkeypatch, lambda request: sse(message(stop_reason, content)))


def test_reply_failing_schema_is_rejected(monkeypatch):
    bad = [{"type": "tool_use", "id": "toolu_test", "name": TOOL_NAME, "input": {"answer": "x"}}]
    with pytest.raises(ValueError):
        run(monkeypatch, lambda request: sse(message(content=bad)))


def test_missing_key_fails_before_any_call():
    with pytest.raises(HTTPException) as err:
        AnthropicGenerator(Settings(llm_provider="anthropic")).generate(
            ChatInput(request_id=uuid4(), message="질문"), {}, []
        )
    assert err.value.status_code == 503


def test_provider_selects_generator_and_health_configuration():
    app = create_app(
        settings(firebase_service_account_json="{}", allowed_user_uids=("alice",)),
        store=MemoryStore(),
        verify_token=lambda token: {"uid": token},
    )
    assert isinstance(app.state.generator, AnthropicGenerator)
    assert TestClient(app).get("/health").json()["configured"] is True
    assert not Settings(llm_provider="anthropic", openai_api_key="x").generator_configured


def test_unknown_provider_is_rejected(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "other")
    with pytest.raises(ValueError):
        Settings.from_env()
