"""Bounded downloads of Buffer-owned images; source bytes remain transient."""

import base64
import hashlib
import http.client
import io
import ipaddress
import json
import socket
import ssl
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from threading import Timer
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

from fastapi import HTTPException
from PIL import Image, ImageOps

BUFFER_HOST = "buffer-updates-media-backfill-bucket.s3.amazonaws.com"
IMAGE_BYTES = 15 * 1024 * 1024
TOTAL_BYTES = 64 * 1024 * 1024
IMAGE_MIMES = {"image/png", "image/jpeg", "image/webp"}
_DNS_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="post-media-dns")


def validate_media_url(value, *, resolve=False, timeout=5):
    pending = None
    try:
        url = urlsplit(value)
        host = url.hostname or ""
        if (
            not isinstance(value, str)
            or len(value) > 8000
            or any(ord(c) < 33 or ord(c) == 127 for c in value)
            or url.scheme != "https"
            or url.username is not None
            or url.password is not None
            or url.port not in (None, 443)
            or url.fragment
            or not (
                host == BUFFER_HOST
                or host.endswith(".cdninstagram.com")
                or host.endswith(".fbcdn.net")
            )
        ):
            raise ValueError
        if resolve:
            pending = _DNS_POOL.submit(socket.getaddrinfo, host, 443, type=socket.SOCK_STREAM)
            answers = pending.result(timeout=timeout)
            addresses = list(dict.fromkeys(answer[4][0] for answer in answers))
            if not addresses or any(not ipaddress.ip_address(ip).is_global for ip in addresses):
                raise ValueError
            return host, addresses[0]
        return value
    except (ValueError, TypeError, OSError, TimeoutError):
        if pending:
            pending.cancel()
        raise HTTPException(422, "게시물 이미지 주소를 안전하게 확인할 수 없습니다.") from None


def image_sources(post):
    return [
        (i, asset)
        for i, asset in enumerate(post.get("assets", []), 1)
        if str(asset.get("type", "")).casefold() == "image"
        and asset.get("mime_type") in IMAGE_MIMES
        and asset.get("source")
    ]


def _stable_source(value):
    url = urlsplit(value or "")
    # Drop only AWS signing keys and Meta oh/oe. Preserve transforms and all _nc_* keys.
    rotating = {"awsaccesskeyid", "signature", "expires", "oh", "oe"}
    query = [
        (key, value)
        for key, value in parse_qsl(url.query, keep_blank_values=True)
        if key.casefold() not in rotating and not key.casefold().startswith("x-amz-")
    ]
    return urlunsplit(
        (url.scheme.lower(), url.netloc.lower(), url.path, urlencode(sorted(query)), "")
    )


def source_signature(post):
    source = {
        "caption": post.get("text", ""),
        "assets": [
            {
                "type": a.get("type"),
                "mime": a.get("mime_type"),
                "source": _stable_source(a.get("source")),
            }
            for a in post.get("assets", [])
        ],
    }
    return hashlib.sha256(
        json.dumps(source, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, address, timeout):
        super().__init__(host, timeout=timeout, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        # Connect to the validated literal address while retaining hostname TLS verification.
        sock = socket.create_connection((self.address, 443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except Exception:
            sock.close()
            raise


def _download_image(value, deadline, byte_limit=IMAGE_BYTES):
    for redirects in range(3):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise HTTPException(422, "게시물 이미지 다운로드 시간이 초과되었습니다.")
        host, address = validate_media_url(value, resolve=True, timeout=min(5, remaining))
        remaining = deadline - time.monotonic()
        connection = _PinnedHTTPSConnection(host, address, min(10, remaining))
        timer = None
        try:
            connection.connect()
            sock = connection.sock

            def stop():
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

            # A socket timeout alone lets a slow stream of HTTP headers run indefinitely.
            timer = Timer(max(0.01, deadline - time.monotonic()), stop)
            timer.daemon = True
            timer.start()
            url = urlsplit(value)
            target = urlunsplit(("", "", url.path or "/", url.query, ""))
            connection.request("GET", target, headers={"Accept": ", ".join(sorted(IMAGE_MIMES))})
            response = connection.getresponse()
            if response.status in {301, 302, 303, 307, 308}:
                location = response.getheader("Location")
                if not location or redirects == 2:
                    raise ValueError("redirect limit")
                value = urljoin(value, location)
                continue
            if response.status != 200:
                raise ValueError("unavailable image")
            mime = (response.getheader("Content-Type") or "").split(";", 1)[0].strip().lower()
            if (
                mime not in IMAGE_MIMES
                or response.getheader("Content-Encoding", "identity") != "identity"
            ):
                raise ValueError("unsupported response")
            length = response.getheader("Content-Length")
            if length is not None and (int(length) < 1 or int(length) > byte_limit):
                raise ValueError("download too large")
            data = bytearray()
            while True:
                if time.monotonic() >= deadline:
                    raise ValueError("download time limit")
                sock.settimeout(min(10, max(0.01, deadline - time.monotonic())))
                chunk = response.read(min(65536, byte_limit + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > byte_limit:
                    raise ValueError("download too large")
            return bytes(data)
        except HTTPException:
            raise
        except (OSError, ValueError, http.client.HTTPException):
            raise HTTPException(
                422, "게시물 이미지를 제한 안에서 다운로드할 수 없습니다."
            ) from None
        finally:
            if timer:
                timer.cancel()
            connection.close()
    raise HTTPException(422, "게시물 이미지 리디렉션이 너무 많습니다.")


def normalize_image(data, card_id):
    try:
        if not data or len(data) > IMAGE_BYTES:
            raise ValueError("image size")
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                if (
                    image.format not in {"PNG", "JPEG", "WEBP"}
                    or image.width * image.height > 24_000_000
                    or max(image.size) > 12000
                    or getattr(image, "n_frames", 1) != 1
                ):
                    raise ValueError("format or pixels")
                image.verify()
            with Image.open(io.BytesIO(data)) as image:
                image.load()
                image = ImageOps.exif_transpose(image)
                image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
                if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
                    rgba = image.convert("RGBA")
                    normalized = Image.new("RGB", rgba.size, "white")
                    normalized.paste(rgba, mask=rgba.getchannel("A"))
                else:
                    normalized = image.convert("RGB")
                for quality in (85, 75, 65, 50, 35):
                    output = io.BytesIO()
                    normalized.save(output, "JPEG", quality=quality, optimize=True)
                    encoded = output.getvalue()
                    if len(encoded) <= 1_048_576:
                        break
                else:
                    raise ValueError("normalized size")
    except Exception:
        raise HTTPException(422, "게시물 이미지 형식·크기·픽셀 수를 확인할 수 없습니다.") from None
    return {
        "card_id": card_id,
        "name": card_id + ".jpg",
        "mime": "image/jpeg",
        "base64": base64.b64encode(encoded).decode(),
        "sha256": hashlib.sha256(encoded).hexdigest(),
    }


def download_post_images(post):
    sources = image_sources(post)[:10]
    if not sources:
        raise HTTPException(
            422, "읽을 수 있는 게시물 이미지가 없습니다. 영상 본문은 읽지 않습니다."
        )
    deadline, total, result = time.monotonic() + 60, 0, []
    for position, asset in sources:
        if total >= TOTAL_BYTES:
            raise HTTPException(422, "게시물 이미지 전체 다운로드 한도를 초과했습니다.")
        data = _download_image(asset["source"], deadline, min(IMAGE_BYTES, TOTAL_BYTES - total))
        total += len(data)
        if total > TOTAL_BYTES:
            raise HTTPException(422, "게시물 이미지 전체 다운로드 한도를 초과했습니다.")
        result.append(normalize_image(data, f"page-{position}"))
    return result
