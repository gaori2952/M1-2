import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .anthropic_generation import AnthropicGenerator
from .config import Settings
from .generation import OpenAIGenerator
from .routes.chat import router as chat_router
from .routes.resources import router
from .store import Firebase, FirestoreStore


def create_app(settings=None, *, store=None, verify_token=None, generator=None):
    settings = settings or Settings.from_env()
    firebase = Firebase(settings)
    app = FastAPI(title="M1-2 콘텐츠 비서", version="0.1.0")
    app.state.settings = settings
    app.state.store = store if store is not None else FirestoreStore(firebase)
    app.state.verify_token = verify_token or firebase.verify
    default_generator = (
        AnthropicGenerator if settings.llm_provider == "anthropic" else OpenAIGenerator
    )
    app.state.generator = generator or default_generator(settings)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.exception_handler(Exception)
    async def unavailable(request: Request, exc: Exception):
        logging.getLogger(__name__).error("Request failed: %s", type(exc).__name__)
        return JSONResponse(
            status_code=503,
            content={
                "detail": "외부 서비스 또는 저장소 연결에 실패했습니다. 잠시 후 다시 시도하세요."
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
    return app


app = create_app()
