"""Exercise the actual OpenAI SDK, replacing only the HTTP transport."""

import json
from uuid import uuid4

import httpx
import pytest
from app.config import Settings
from app.generation import OpenAIGenerator
from app.models import ChatInput
from openai import OpenAI

from .test_chat import reply


def test_sdk_uses_structured_output_limits_and_does_not_store(monkeypatch):
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

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        monkeypatch.setattr(
            generation, "OpenAI", lambda **kwargs: OpenAI(**kwargs, http_client=client)
        )
        result = OpenAIGenerator(
            Settings(openai_api_key="test-only-placeholder", openai_model="test-model")
        ).generate(ChatInput(request_id=uuid4(), message="질문"), {"sources": []}, [])
    assert result["answer"] == reply()["answer"]
    assert len(sent) == 1
    assert sent[0]["store"] is False and sent[0]["max_output_tokens"] == 4000
    assert sent[0]["text"]["format"]["type"] == "json_schema"
    assert sent[0]["text"]["format"]["strict"] is True
    assert sent[0]["input"][0]["role"] == "system"


def test_sdk_does_not_retry_billable_requests(monkeypatch):
    from app import generation

    count = []

    def fail(request):
        count.append(1)
        return httpx.Response(500, json={"error": {"message": "temporary", "type": "server_error"}})

    with httpx.Client(transport=httpx.MockTransport(fail)) as client:
        monkeypatch.setattr(
            generation, "OpenAI", lambda **kwargs: OpenAI(**kwargs, http_client=client)
        )
        with pytest.raises(Exception):
            OpenAIGenerator(Settings(openai_api_key="test-only-placeholder")).generate(
                ChatInput(request_id=uuid4(), message="질문"), {}, []
            )
    assert len(count) == 1
