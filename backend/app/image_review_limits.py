from starlette.responses import JSONResponse


class ImageReviewBodyLimit:
    """Bound image JSON before parsing, including requests without Content-Length."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not (
            scope["path"].startswith("/api/image-reviews") or scope["path"] == "/api/chat"
        ):
            return await self.app(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > 16 * 1024 * 1024:
                return await JSONResponse(
                    status_code=413, content={"detail": "이미지 검토 요청은 16MB 이하여야 합니다."}
                )(scope, receive, send)
            if not message.get("more_body", False):
                break
        delivered = False

        async def bounded_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, bounded_receive, send)
