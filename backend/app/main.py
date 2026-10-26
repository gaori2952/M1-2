import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from google.api_core.exceptions import ResourceExhausted

from .anthropic_generation import AnthropicGenerator
from .buffer_client import BufferClient
from .config import Settings
from .generation import OpenAIGenerator
from .image_review_generation import ImageReviewer
from .image_review_limits import ImageReviewBodyLimit
from .routes.chat import router as chat_router
from .routes.editor import router as editor_router
from .routes.growth import router as growth_router
from .routes.image_reviews import router as image_review_router
from .routes.resources import router
from .store import Firebase, FirestoreStore


def create_app(
    settings=None, *, store=None, verify_token=None, generator=None, image_reviewer=None
    settings=None,
    *,
    store=None,
    verify_token=None,
    generator=None,
    image_reviewer=None,
    buffer_client=None,
    growth_generator=None,
    post_reader=None,
    post_downloader=None,
):
    settings = settings or Settings.from_env()
    firebase = Firebase(settings)
    app = FastAPI(title="M1-2 팔로워 성장 비서", version="0.2.0")
    app.state.settings = settings
    app.state.store = store if store is not None else FirestoreStore(firebase)
    app.state.verify_token = verify_token or firebase.verify
    default_generator = (
        AnthropicGenerator if settings.llm_provider == "anthropic" else OpenAIGenerator
    )
    app.state.generator = generator or default_generator(settings)
    app.state.image_reviewer = image_reviewer or ImageReviewer(settings)
    app.state.growth_generator = growth_generator or app.state.generator
    app.state.buffer_client = buffer_client or BufferClient(settings)
    app.state.image_reviewer = image_reviewer or ImageReviewer(settings)
    app.state.post_reader = post_reader or ImageReviewer(settings)
    app.state.post_downloader = post_downloader
    app.add_middleware(ImageReviewBodyLimit)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.exception_handler(RequestValidationError)
    async def invalid_input(request: Request, exc: RequestValidationError):
        # Image payloads and other submitted values must not be echoed into error logs/UI.
        return JSONResponse(
            status_code=422,
            content={
                "detail": [
                    {k: error[k] for k in ("type", "loc", "msg") if k in error}
                    for error in exc.errors()
                ]
            },
        )

    @app.exception_handler(Exception)
    async def unavailable(request: Request, exc: Exception):
        logging.getLogger(__name__).error("Request failed: %s", type(exc).__name__)
        return JSONResponse(
            status_code=503,
            headers={"Access-Control-Allow-Origin": request.headers["origin"], "Vary": "Origin"}
            if request.headers.get("origin") in settings.allowed_origins
            else {},
            content={
                "detail": "외부 서비스 또는 저장소 연결에 실패했습니다. 잠시 후 다시 시도하세요."
            },
        )

    @app.exception_handler(ResourceExhausted)
    async def database_quota(request: Request, exc: ResourceExhausted):
        logging.getLogger(__name__).warning("Firestore quota exceeded: %s", request.url.path)
        return JSONResponse(
            status_code=503,
            headers={"Retry-After": "60"},
            content={
                "code": "database_quota_exceeded",
                "detail": "데이터베이스 조회 한도를 초과했어요. 한도가 초기화된 뒤 다시 이용해 주세요. 입력 내용은 유지됩니다.",
            },
        )

    @app.get("/health")
    def health():
        return {
            "status": "ok",
            "configured": bool(
                settings.firebase_service_account_json
                and settings.generator_configured
                and settings.allowed_user_uids
            ),
        }

    app.include_router(router)
    app.include_router(chat_router)
    app.include_router(editor_router)
    app.include_router(image_review_router)
    app.include_router(growth_router)
    return app


app = create_app()
