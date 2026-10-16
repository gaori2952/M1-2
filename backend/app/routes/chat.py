import json
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import repository as repo
from ..auth import require_owner
from ..chat_service import run_chat
from ..models import ChatInput, DraftUpdate, ReviewInput
from .resources import store

router = APIRouter(prefix="/api", dependencies=[Depends(require_owner)])


@router.post("/chat")
def chat(body: ChatInput, request: Request, uid=Depends(require_owner), db=Depends(store)):
    return run_chat(db, request.app.state.generator, request.app.state.settings, uid, body)


@router.get("/drafts")
def drafts(uid=Depends(require_owner), db=Depends(store)):
    return sorted(db.list("drafts", uid), key=lambda d: d["updated_at"], reverse=True)


@router.get("/drafts/{key}")
def draft(key: str, uid=Depends(require_owner), db=Depends(store)):
    return repo.owned(db, "drafts", key, uid)


@router.put("/drafts/{key}")
def edit_draft(key: str, body: DraftUpdate, uid=Depends(require_owner), db=Depends(store)):
    payload = body.draft.model_dump(mode="json")
    if len(json.dumps(payload, ensure_ascii=False).encode()) > 150000:
        raise HTTPException(422, "원고가 너무 큽니다.")

    def run(tx):
        old = repo.owned(tx, "drafts", key, uid)
        if old["version"] != body.version:
            raise HTTPException(409, "다른 곳에서 수정되었습니다. 다시 불러온 뒤 수정하세요.")
        if not set(payload["source_ids"]).issubset(set(old["source_ids"])):
            raise HTTPException(422, "새 근거 ID를 임의로 추가할 수 없습니다.")
        result = old | {
            "draft": payload,
            "version": old["version"] + 1,
            "status": "draft",
            "updated_at": repo.now(),
        }
        tx.set("drafts", key, result)
        fid = uuid4().hex
        tx.set(
            "feedback",
            fid,
            {
                "id": fid,
                "owner_uid": uid,
                "draft_id": key,
                "before": old["draft"],
                "after": payload,
                "note": body.feedback,
                "preference_applied": False,
                "created_at": repo.now(),
            },
        )
        return result

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
