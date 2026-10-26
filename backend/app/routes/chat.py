from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import editor_service as editor
from .. import repository as repo
from ..auth import require_owner
from ..chat_service import request_status, run_chat
from ..models import ChatInput, DraftUpdate, ReviewInput
from .resources import store

router = APIRouter(prefix="/api", dependencies=[Depends(require_owner)])


@router.get("/chat/requests/{request_id}")
def chat_status(request_id: UUID, uid=Depends(require_owner), db=Depends(store)):
    return request_status(db, uid, request_id)


@router.post("/chat")
def chat(body: ChatInput, request: Request, uid=Depends(require_owner), db=Depends(store)):
    if body.mode == "growth":
        settings = request.app.state.settings
        if not settings.generator_configured:
            key_name = (
                "ANTHROPIC_API_KEY" if settings.llm_provider == "anthropic" else "OPENAI_API_KEY"
            )
            raise HTTPException(
                503,
                f"성장 상담에는 {key_name} 설정이 필요합니다. 통계와 시간 후보는 AI 호출 없이 확인할 수 있어요.",
            )
        return run_chat(
            db, request.app.state.growth_generator, request.app.state.settings, uid, body
        )
    return run_chat(db, request.app.state.generator, request.app.state.settings, uid, body)


@router.get("/drafts")
def drafts(uid=Depends(require_owner), db=Depends(store)):
    return sorted(db.list("drafts", uid), key=lambda d: d["updated_at"], reverse=True)


@router.get("/drafts/{key}")
def draft(key: str, uid=Depends(require_owner), db=Depends(store)):
    return repo.owned(db, "drafts", key, uid)


@router.put("/drafts/{key}")
def edit_draft(key: str, body: DraftUpdate, uid=Depends(require_owner), db=Depends(store)):
    payload = body.draft.model_dump(mode="json", exclude_unset=True)
    editor.check_size(payload)

    def run(tx):
        old = repo.owned(tx, "drafts", key, uid)
        editor.check_version(old, body.version)
        if not set(payload["source_ids"]).issubset(set(old["source_ids"])):
            raise HTTPException(422, "새 근거 ID를 임의로 추가할 수 없습니다.")
        return editor.save_revision(
            tx, old, payload, body.feedback, body.style.model_dump() if body.style else None
        )

    return db.atomic(run)


@router.post("/drafts/{key}/review")
def review_draft(key: str, body: ReviewInput, uid=Depends(require_owner), db=Depends(store)):
    def run(tx):
        old = repo.owned(tx, "drafts", key, uid)
        if old["version"] != body.version:
            raise HTTPException(409, "최신 원고를 다시 불러오세요.")
        result = old | {
            "status": "reviewed",
            "version": old["version"] + 1,
            "updated_at": repo.now(),
        }
        tx.set("drafts", key, result)
        return result

    return db.atomic(run)
