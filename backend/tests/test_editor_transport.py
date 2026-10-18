"""Real provider SDK serialization, with only HTTP responses replaced."""

import json
from uuid import uuid4

import httpx
import httpx2
from anthropic import Anthropic
from app.anthropic_generation import TOOL_NAME, AnthropicGenerator
from app.config import Settings
from app.generation import OpenAIGenerator
from app.models import ProposalInput
from openai import OpenAI

from .test_anthropic_transport import message, settings, sse
from .test_chat import draft


def request():
    return ProposalInput(
        request_id=uuid4(),
        version=1,
        card_indices=[0],
        fields=["diagram"],
        instruction="화살표를 고쳐줘",
    )


def result():
    return {
        "summary": "확인 필요",
        "cards": [{"card_index": 0, "card": draft()["cards"][0], "findings": ["방향 확인"]}],
    }


def test_openai_review_uses_card_schema_and_store_false(monkeypatch):
    from app import generation

    sent = []

    def handle(req):
        sent.append(json.loads(req.content))
        return httpx.Response(
            200,
            json={
                "id": "resp_test",
                "object": "response",
                "created_at": 1,
                "status": "completed",
                "model": "test",
                "output": [
                    {
                        "type": "message",
                        "id": "msg_test",
                        "status": "completed",
                        "role": "assistant",
                        "content": [
                            {"type": "output_text", "text": json.dumps(result()), "annotations": []}
                        ],
                    }
                ],
            },
        )

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        monkeypatch.setattr(generation, "OpenAI", lambda **kw: OpenAI(**kw, http_client=client))
        reply = OpenAIGenerator(Settings(openai_api_key="test-only")).revise(
            request(), {"draft": draft()}
        )
    assert reply["cards"][0]["card_index"] == 0
    assert sent[0]["store"] is False
    assert sent[0]["text"]["format"]["schema"]["title"] == "CardReviewReply"
    assert "디자인/브랜드/페이지 순서는 변경 대상이 아닙니다" in sent[0]["input"][0]["content"]


def test_anthropic_review_uses_card_schema_and_stream(monkeypatch):
    from app import anthropic_generation

    sent = []

    def handle(req):
        sent.append(json.loads(req.content))
        return sse(
            message(
                content=[
                    {"type": "tool_use", "id": "tool_test", "name": TOOL_NAME, "input": result()}
                ]
            )
        )

    with httpx2.Client(transport=httpx2.MockTransport(handle)) as client:
        monkeypatch.setattr(
            anthropic_generation, "Anthropic", lambda **kw: Anthropic(**kw, http_client=client)
        )
        reply = AnthropicGenerator(settings()).revise(request(), {"draft": draft()})
    assert reply["cards"][0]["card_index"] == 0
    assert sent[0]["stream"] is True
    assert sent[0]["tools"][0]["input_schema"]["title"] == "CardReviewReply"
