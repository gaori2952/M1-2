import base64
import hashlib
import io
import json

import httpx
import httpx2
import pytest
from anthropic import Anthropic
from app.config import Settings
from app.image_assets import decode_asset
from app.image_review_generation import ImageReviewer
from app.image_review_models import ReviewImage
from fastapi import HTTPException
from openai import OpenAI
from PIL import Image

from .test_anthropic_transport import message, settings, sse


def asset(kind="PNG", color="white", cid="card-1"):
    b = io.BytesIO()
    Image.new("RGB", (120, 120), color).save(b, format=kind)
    data = b.getvalue()
    mime = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}[kind]
    return {
        "card_id": cid,
        "name": "same.png",
        "sha256": hashlib.sha256(data).hexdigest(),
        "mime": mime,
        "base64": base64.b64encode(data).decode(),
    }


def reply():
    return {
        "cards": [
            {
                "card_id": "card-1",
                "summary": "이번 검토에서 지적 없음",
                "findings": [],
                "resolutions": [],
            }
        ],
        "connections": [],
    }


@pytest.mark.parametrize("kind", ["PNG", "JPEG", "WEBP"])
def test_decodes_actual_image(kind):
    a = asset(kind)
    assert decode_asset(ReviewImage(**a))["sha256"] == a["sha256"]


@pytest.mark.parametrize(
    "patch", [{"mime": "image/jpeg"}, {"base64": "aGVsbG8="}, {"sha256": "0" * 64}]
)
def test_rejects_spoofed_corrupt_and_wrong_hash(patch):
    with pytest.raises(HTTPException) as e:
        decode_asset(ReviewImage(**(asset() | patch)))
    assert e.value.status_code == 422


def test_rejects_animation_and_large_dimensions():
    b = io.BytesIO()
    Image.new("RGB", (10, 10), "red").save(
        b, "PNG", save_all=True, append_images=[Image.new("RGB", (10, 10), "blue")], duration=100
    )
    a = asset() | {
        "base64": base64.b64encode(b.getvalue()).decode(),
        "sha256": hashlib.sha256(b.getvalue()).hexdigest(),
    }
    with pytest.raises(HTTPException):
        decode_asset(ReviewImage(**a))
    b = io.BytesIO()
    Image.new("RGB", (2401, 20)).save(b, "PNG")
    with pytest.raises(HTTPException):
        decode_asset(
            ReviewImage(
                **(
                    a
                    | {
                        "base64": base64.b64encode(b.getvalue()).decode(),
                        "sha256": hashlib.sha256(b.getvalue()).hexdigest(),
                    }
                )
            )
        )


def test_openai_multimodal_schema_store_false(monkeypatch):
    from app import image_review_generation as m

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
                            {"type": "output_text", "text": json.dumps(reply()), "annotations": []}
                        ],
                    }
                ],
            },
        )

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        monkeypatch.setattr(m, "OpenAI", lambda **kw: OpenAI(**kw, http_client=client))
        result = ImageReviewer(Settings(openai_api_key="test-only")).review([asset()], {})
    assert result == reply()
    assert sent[0]["store"] is False
    content = sent[0]["input"][1]["content"]
    assert any(
        c["type"] == "input_image" and c["image_url"].startswith("data:image/png;base64,")
        for c in content
    )
    assert sent[0]["text"]["format"]["schema"]["title"] == "ReviewReply"


def test_anthropic_multimodal_stream(monkeypatch):
    from app import image_review_generation as m

    sent = []

    def handle(req):
        sent.append(json.loads(req.content))
        return sse(
            message(
                content=[{"type": "tool_use", "id": "t", "name": "submit_review", "input": reply()}]
            )
        )

    with httpx2.Client(transport=httpx2.MockTransport(handle)) as client:
        monkeypatch.setattr(m, "Anthropic", lambda **kw: Anthropic(**kw, http_client=client))
        assert ImageReviewer(settings()).review([asset()], {}) == reply()
    assert sent[0]["stream"] is True
    assert any(
        c["type"] == "image" and c["source"]["media_type"] == "image/png"
        for c in sent[0]["messages"][0]["content"]
    )


def test_missing_key_is_explicit():
    with pytest.raises(HTTPException) as e:
        ImageReviewer(Settings()).review([asset()], {})
    assert e.value.status_code == 503
