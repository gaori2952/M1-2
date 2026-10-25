import base64
import hashlib
import io
import warnings

from fastapi import HTTPException
from PIL import Image


def decode_asset(asset):
    try:
        data = base64.b64decode(asset.base64, validate=True)
        if len(data) > 1_048_576 or hashlib.sha256(data).hexdigest() != asset.sha256:
            raise ValueError("size or digest")
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                expected = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}
                if (
                    expected.get(image.format) != asset.mime
                    or max(image.size) > 2400
                    or image.width * image.height > 5_760_000
                    or getattr(image, "n_frames", 1) != 1
                ):
                    raise ValueError("format or dimensions")
                image.verify()
            # verify() checks container integrity; load() catches truncated pixel streams.
            with Image.open(io.BytesIO(data)) as image:
                image.load()
    except Exception:
        raise HTTPException(422, f"이미지 형식·크기·해시를 확인하세요: {asset.name}") from None
    return asset.model_dump()
