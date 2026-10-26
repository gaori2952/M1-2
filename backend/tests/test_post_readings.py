import base64
import hashlib
import io
import time
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from app import repository as repo
from app.config import Settings
from app.post_media import (
    download_post_images,
    normalize_image,
    source_signature,
    validate_media_url,
)
from app.post_reading_models import PostReadingReply, ReadPostInput
from app.post_reading_service import post_memory, read_post, reading_status, select_posts
from fastapi import HTTPException
from PIL import Image
from pydantic import ValidationError

from .memory_store import MemoryStore

HOST = "buffer-updates-media-backfill-bucket.s3.amazonaws.com"


def post(pid="one", text="전기장 방향", count=2):
    return {
        "id": pid,
        "owner_uid": "alice",
        "text": text,
        "status": "sent",
        "format": "carousel",
        "sent_at": "2026-10-25T01:00:00+00:00",
        "assets": [
            {"type": "image", "mime_type": "image/png", "source": f"https://{HOST}/{pid}-{i}.png"}
            for i in range(count)
        ],
        "tags": [],
    }


def setup(posts=None, limit=30):
    db = MemoryStore()
    cfg = Settings(buffer_owner_uid="alice", buffer_channel_id="channel", daily_request_limit=limit)
    db.set(
        "buffer_connections",
        repo.identity("alice", "buffer"),
        {"owner_uid": "alice", "channel": {"id": "channel"}, "sync_id": "sync"},
    )
    for p in posts or [post()]:
        db.set("buffer_syncs/sync/posts", p["id"], p)
    return db, cfg, Reader()


def png(size=(40, 60), color="white"):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, "PNG")
    return output.getvalue()


def images(p):
    return [normalize_image(png(), f"page-{i + 1}") for i in range(min(10, len(p["assets"])))]


def body(pid="one", request_id=None):
    return ReadPostInput(request_id=request_id or uuid4(), post_id=pid)


class Reader:
    def __init__(self):
        self.calls = []
        self.error = None
        self.transform = lambda result: result

    def read(self, images, context):
        self.calls.append((deepcopy(images), deepcopy(context)))
        if self.error:
            raise self.error
        return self.transform(
            {
                "title": "전기장 방향 읽기",
                "summary": "합성 이미지에서 읽은 내용입니다.",
                "topics": ["전기장"],
                "pages": [
                    {
                        "card_id": a["card_id"],
                        "text": "E=F/q",
                        "description": "화살표",
                        "legible": True,
                    }
                    for a in images
                ],
            }
        )


def read(db, cfg, reader, request=None):
    return read_post(db, reader, cfg, "alice", request or body(), downloader=images)


def test_reading_is_cached_scoped_and_has_no_raw_or_signed_images():
    db, cfg, reader = setup()
    request = body()
    first = read(db, cfg, reader, request)
    assert first["status"] == "ready"
    assert first["cached"] is False
    assert (first["covered_count"], first["total_count"]) == (2, 2)
    assert first["reading"]["pages"][0]["text"] == "E=F/q"
    assert read(db, cfg, reader, request) == first
    assert read(db, cfg, reader)["cached"] is True
    assert len(reader.calls) == 1
    assert post_memory(db, "alice", [post()])["one"]["reading"] == first["reading"]
    assert post_memory(db, "bob", [post()]) == {}
    assert reading_status(db, "alice", request.request_id)["reading"] == first["reading"]
    assert "base64" not in repr(db.docs)
    assert HOST not in repr(db.list("post_readings", "alice"))
    with pytest.raises(HTTPException) as error:
        read_post(db, reader, cfg, "bob", body(), downloader=images)
    assert error.value.status_code == 403


def test_signature_ignores_only_known_rotating_auth_and_invalidates_content_changes():
    p = post()
    p["assets"][0]["source"] += "?X-Amz-Signature=old&X-Amz-Date=old&quality=80&oh=old&oe=old"
    renewed = deepcopy(p)
    renewed["assets"][0]["source"] = (
        f"https://{HOST}/one-0.png?oh=new&quality=80&X-Amz-Date=new&oe=new&X-Amz-Signature=new"
    )
    assert source_signature(p) == source_signature(renewed)
    renewed["assets"][0]["source"] += "&crop=left"
    assert source_signature(p) != source_signature(renewed)
    assert source_signature(post()) != source_signature(post(text="다른 캡션"))
    reordered = post()
    reordered["assets"].reverse()
    assert source_signature(post()) != source_signature(reordered)


def test_changed_media_invalidates_cache_and_request_replay_never_rebills():
    db, cfg, reader = setup()
    request = body()
    read(db, cfg, reader, request)
    changed = post()
    changed["assets"][0]["source"] = f"https://{HOST}/replacement.png"
    db.set("buffer_syncs/sync/posts", "one", changed)
    assert post_memory(db, "alice", [changed]) == {}
    assert read(db, cfg, reader, request)["status"] == "ready"
    assert len(reader.calls) == 1
    assert read(db, cfg, reader)["cached"] is False
    assert len(reader.calls) == 2


def test_request_conflict_failure_and_shared_quota_do_not_retry_model():
    db, cfg, reader = setup([post(), post("two")], limit=2)
    request = body()
    reader.error = OSError("private signed-url must not leak")
    with pytest.raises(HTTPException) as error:
        read(db, cfg, reader, request)
    assert error.value.status_code == 502
    assert "private signed" not in error.value.detail
    assert reading_status(db, "alice", request.request_id)["status"] == "failed"
    with pytest.raises(HTTPException) as error:
        read(db, cfg, reader, request)
    assert error.value.status_code == 409
    with pytest.raises(HTTPException) as error:
        read(db, cfg, reader, body("two", request.request_id))
    assert error.value.status_code == 409
    assert len(reader.calls) == 1
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    db.set("quotas", repo.identity("alice", day), {"owner_uid": "alice", "count": 2})
    with pytest.raises(HTTPException) as error:
        read(db, cfg, reader)
    assert error.value.status_code == 429
    assert len(reader.calls) == 1


@pytest.mark.parametrize("mode", ["missing", "duplicate", "unknown"])
def test_incomplete_or_unknown_model_pages_never_enter_memory(mode):
    db, cfg, reader = setup()

    def invalid(result):
        if mode == "missing":
            result["pages"] = result["pages"][:1]
        if mode == "duplicate":
            result["pages"][1] = result["pages"][0]
        if mode == "unknown":
            result["pages"][1]["card_id"] = "fake"
        return result

    reader.transform = invalid
    with pytest.raises(HTTPException) as error:
        read(db, cfg, reader)
    assert error.value.status_code == 502
    assert post_memory(db, "alice", [post()]) == {}


def test_concurrent_requests_ack_loss_and_expired_leases_never_duplicate_billing():
    db, cfg, reader = setup()
    request = body()
    original_read = reader.read

    def running(*args):
        for other in (request, body()):
            with pytest.raises(HTTPException) as error:
                read(db, cfg, reader, other)
            assert error.value.status_code == 409
        return original_read(*args)

    reader.read = running
    original_atomic = db.atomic
    lost = []

    def atomic(fn):
        result = original_atomic(fn)
        if fn.__name__ == "finish" and not lost:
            lost.append(True)
            raise OSError("lost acknowledgement")
        return result

    db.atomic = atomic
    assert read(db, cfg, reader, request)["status"] == "ready"
    assert len(reader.calls) == 1
    record = db.list("post_reading_requests", "alice")[0]
    record.update(status="pending", expires_at=time.time() - 1)
    db.set("post_reading_requests", record["id"], record)
    assert reading_status(db, "alice", request.request_id)["status"] == "failed"


def test_source_change_during_read_never_commits_obsolete_memory():
    db, cfg, reader = setup()
    original_read = reader.read

    def changed(*args):
        db.set("buffer_syncs/sync/posts", "one", post(text="changed"))
        return original_read(*args)

    reader.read = changed
    with pytest.raises(HTTPException) as error:
        read(db, cfg, reader)
    assert error.value.status_code == 409
    assert post_memory(db, "alice", [post()]) == {}


def test_selection_is_relevant_and_explicit_ids_never_fallback_to_unrelated_posts():
    db, cfg, reader = setup(
        [post(), post("two"), post("three"), post("four"), post("other", "요리")]
    )
    read(db, cfg, reader)
    candidates = select_posts(db, cfg, "alice", "전기장")
    assert len(candidates) <= 3
    assert sum(not c["cached"] for c in candidates) <= 1
    assert candidates[0]["post_id"] == "one"
    assert select_posts(db, cfg, "alice", "존재하지않는주제") == []
    chosen = select_posts(db, cfg, "alice", "전기장", ["other"])
    assert [p["post_id"] for p in chosen] == ["other"]
    with pytest.raises(HTTPException) as error:
        select_posts(db, cfg, "alice", "전기장", ["missing"])
    assert error.value.status_code == 404


def test_video_and_arbitrary_urls_never_reach_downloader_or_model():
    p = post()
    p["assets"] = [
        {
            "type": "video",
            "mime_type": "video/mp4",
            "source": f"https://{HOST}/video.mp4",
            "thumbnail": f"https://{HOST}/thumb.png",
        }
    ]
    db, cfg, reader = setup([p])
    assert select_posts(db, cfg, "alice", "전기장") == []
    with pytest.raises(HTTPException) as error:
        read(db, cfg, reader)
    assert error.value.status_code == 422
    assert not reader.calls
    with pytest.raises(ValidationError):
        ReadPostInput(request_id=uuid4(), post_id="one", url="http://127.0.0.1/private")


@pytest.mark.parametrize(
    "url",
    [
        "http://" + HOST + "/image.png",
        "https://127.0.0.1/image.png",
        "https://evil.example/image.png",
        "https://cdninstagram.com/image.png",
        "https://evilcdninstagram.com/image.png",
        "https://user:pass@" + HOST + "/image.png",
        "https://" + HOST + ":444/image.png",
        "https://" + HOST + "/image.png#fragment",
    ],
)
def test_unsafe_media_hosts_and_url_forms_are_rejected(url):
    with pytest.raises(HTTPException):
        validate_media_url(url)


def test_private_dns_and_mixed_dns_are_rejected(monkeypatch):
    import socket

    for addresses in (["127.0.0.1"], ["169.254.169.254"], ["93.184.216.34", "10.0.0.1"]):
        monkeypatch.setattr(
            socket,
            "getaddrinfo",
            lambda *args, **kwargs: [
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in addresses
            ],
        )
        with pytest.raises(HTTPException):
            validate_media_url("https://" + HOST + "/image.png", resolve=True)


def test_normalization_preserves_page_id_bounds_size_and_hash():
    image = normalize_image(png((2000, 1000)), "page-3")
    data = base64.b64decode(image["base64"])
    assert image["card_id"] == "page-3"
    assert image["mime"] == "image/jpeg"
    assert image["sha256"] == hashlib.sha256(data).hexdigest()
    assert len(data) <= 1_048_576
    with Image.open(io.BytesIO(data)) as converted:
        assert converted.size == (1600, 800)


def test_animated_corrupt_and_pixel_bomb_images_are_rejected():
    output = io.BytesIO()
    Image.new("RGB", (20, 20), "red").save(
        output, "GIF", save_all=True, append_images=[Image.new("RGB", (20, 20), "blue")]
    )
    for data in (b"not an image", output.getvalue(), png((6000, 5000))):
        with pytest.raises(HTTPException):
            normalize_image(data, "page-1")


def test_downloader_caps_at_ten_and_never_decodes_video(monkeypatch):
    import app.post_media as media

    p = post(count=12)
    p["assets"].insert(
        0, {"type": "video", "mime_type": "video/mp4", "source": f"https://{HOST}/video.mp4"}
    )
    downloaded = []

    def fetch(url, deadline, byte_limit):
        downloaded.append(url)
        return png()

    monkeypatch.setattr(media, "_download_image", fetch)
    result = download_post_images(p)
    assert len(result) == 10
    assert result[0]["card_id"] == "page-2"
    assert all("video.mp4" not in u for u in downloaded)


def test_strict_output_schema_rejects_extra_fields_and_unbounded_text():
    result = Reader().read(images(post()), {})
    with pytest.raises(ValidationError):
        PostReadingReply.model_validate(result | {"url": "untrusted"})
    with pytest.raises(ValidationError):
        PostReadingReply.model_validate(result | {"summary": "a" * 1001})


def test_http_close_response_is_normalized_without_re_resolving_dns(monkeypatch):
    import app.post_media as media

    state = {}

    class Sock:
        def settimeout(self, timeout):
            state["timeout"] = timeout

    class Response:
        status = 200

        def __init__(self):
            self.data = png()

        def getheader(self, name, default=None):
            return {"Content-Type": "image/png", "Content-Length": str(len(self.data))}.get(
                name, default
            )

        def read(self, amount):
            chunk, self.data = self.data[:amount], self.data[amount:]
            return chunk

    class Connection:
        def __init__(self, host, address, timeout):
            state.update(host=host, address=address)
            self.sock = Sock()

        def request(self, *args, **kwargs):
            pass

        def connect(self):
            pass

        def getresponse(self):
            self.sock = None  # http.client detaches connections with Connection: close.
            return Response()

        def close(self):
            pass

    import socket

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *a, **kw: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))],
    )
    monkeypatch.setattr(media, "_PinnedHTTPSConnection", Connection)
    p = post(count=1)
    output = download_post_images(p)
    assert output[0]["mime"] == "image/jpeg"
    assert state["host"] == HOST
    assert state["address"] == "93.184.216.34"


@pytest.mark.parametrize(
    "kind",
    [
        "unsafe_redirect",
        "redirect_loop",
        "oversized",
        "stream_overflow",
        "compressed",
        "unsupported_mime",
    ],
)
def test_downloader_rejects_unsafe_or_unbounded_responses(monkeypatch, kind):
    import socket

    import app.post_media as media

    class Response:
        status = 302 if "redirect" in kind else 200

        def getheader(self, name, default=None):
            headers = {"Content-Type": "image/png"}
            if "redirect" in kind:
                headers["Location"] = (
                    "http://127.0.0.1/secret"
                    if kind == "unsafe_redirect"
                    else f"https://{HOST}/loop.png"
                )
            if kind == "oversized":
                headers["Content-Length"] = str(15 * 1024 * 1024 + 1)
            if kind == "compressed":
                headers["Content-Encoding"] = "gzip"
            if kind == "unsupported_mime":
                headers["Content-Type"] = "text/html"
            return headers.get(name, default)

        def read(self, amount):
            return b"x" * amount

    class Connection:
        sock = type("Sock", (), {"settimeout": lambda *a: None})()

        def __init__(self, *args):
            pass

        def request(self, *args, **kwargs):
            pass

        def connect(self):
            pass

        def getresponse(self):
            return Response()

        def close(self):
            pass

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *a, **kw: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))],
    )
    monkeypatch.setattr(media, "_PinnedHTTPSConnection", Connection)
    with pytest.raises(HTTPException) as error:
        download_post_images(post(count=1))
    assert error.value.status_code == 422


def test_pinned_connection_keeps_tls_host_and_connects_to_validated_ip(monkeypatch):
    import app.post_media as media

    state = {}
    sock = type("Sock", (), {"close": lambda *a: None})()

    def connect(address, timeout):
        state["address"] = address
        return sock

    class Context:
        check_hostname = True
        verify_mode = 2

        def wrap_socket(self, raw, server_hostname):
            state["tls_hostname"] = server_hostname
            return raw

    monkeypatch.setattr(media.socket, "create_connection", connect)
    monkeypatch.setattr(media.ssl, "create_default_context", Context)
    connection = media._PinnedHTTPSConnection(HOST, "93.184.216.34", 3)
    connection.connect()
    assert state == {"address": ("93.184.216.34", 443), "tls_hostname": HOST}


def test_failed_auto_reads_are_not_silently_selected_and_billed_again():
    db, cfg, reader = setup()
    reader.error = OSError("unavailable")
    with pytest.raises(HTTPException):
        read(db, cfg, reader)
    assert select_posts(db, cfg, "alice", "전기장") == []
    assert [p["post_id"] for p in select_posts(db, cfg, "alice", "전기장", ["one"])] == ["one"]


def test_illegible_page_never_persists_guessed_text():
    db, cfg, reader = setup()

    def illegible(result):
        result["pages"][0].update(legible=False, text="unreliable guessed equation")
        return result

    reader.transform = illegible
    result = read(db, cfg, reader)
    assert result["reading"]["pages"][0]["text"] == ""


def test_reading_transactions_read_before_writing():
    db, cfg, reader = setup()
    original = db.atomic

    class Unit:
        def __init__(self):
            self.written = False

        def get(self, *args):
            assert not self.written, "Firestore read after write"
            return db.get(*args)

        def list(self, *args):
            assert not self.written, "Firestore read after write"
            return db.list(*args)

        def set(self, *args):
            self.written = True
            db.set(*args)

    db.atomic = lambda fn: original(lambda _: fn(Unit()))
    request = body()
    assert read(db, cfg, reader, request)["status"] == "ready"
    assert read(db, cfg, reader)["cached"]
    assert reading_status(db, "alice", request.request_id)["status"] == "ready"


def test_total_download_budget_is_passed_before_next_image(monkeypatch):
    import app.post_media as media

    limits = []

    def fetch(url, deadline, byte_limit):
        limits.append(byte_limit)
        return b"x" * byte_limit

    monkeypatch.setattr(media, "_download_image", fetch)
    monkeypatch.setattr(media, "normalize_image", lambda data, cid: {"card_id": cid})
    with pytest.raises(HTTPException):
        download_post_images(post(count=10))
    assert limits == [15 * 1024 * 1024] * 4 + [4 * 1024 * 1024]


def test_public_dns_is_accepted_and_dns_wait_is_bounded(monkeypatch):
    import socket
    from threading import Event

    url = "https://" + HOST + "/image.png"
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *a, **kw: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))],
    )
    assert validate_media_url(url, resolve=True) == (HOST, "93.184.216.34")
    release = Event()
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **kw: release.wait(1))
    try:
        with pytest.raises(HTTPException) as error:
            validate_media_url(url, resolve=True, timeout=0.01)
        assert error.value.status_code == 422
    finally:
        release.set()


def test_selection_finds_text_visible_only_inside_cached_image_body():
    db, cfg, reader = setup()

    def body_only(result):
        result["pages"][0]["text"] = "쿼터니언회전"
        return result

    reader.transform = body_only
    read(db, cfg, reader)
    assert [p["post_id"] for p in select_posts(db, cfg, "alice", "쿼터니언회전")] == ["one"]
