from copy import deepcopy

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import editor_service as editor
from .. import repository as repo
from ..auth import require_owner
from ..models import CardSelection, DraftCreate, ProposalInput, RestoreInput
from .resources import store

router = APIRouter(prefix="/api", dependencies=[Depends(require_owner)])


@router.post("/drafts", status_code=201)
def create_draft(body: DraftCreate, uid=Depends(require_owner), db=Depends(store)):
    payload = body.draft.model_dump(exclude_unset=True)
    editor.check_size(payload)
    # Imported IDs are not trusted provenance; resolve every claimed source.
    for sid in payload["source_ids"]:
        repo.owned(db, "contents", sid, uid)
    key = repo.identity(uid, "import:" + str(body.request_id))

    def create(tx):
        prior = tx.get("drafts", key)
        if prior:
            if prior.get("import_payload") != body.model_dump(mode="json"):
                raise HTTPException(409, "같은 요청 ID의 내용이 다릅니다.")
            return prior
        result = {
            "id": key,
            "owner_uid": uid,
            "draft": payload,
            "version": 1,
            "style": body.style.model_dump(),
            "status": "draft",
            "source_ids": payload["source_ids"],
            "created_at": repo.now(),
            "updated_at": repo.now(),
            "import_payload": body.model_dump(mode="json"),
        }
        tx.set("drafts", key, result)
        return result

    return db.atomic(create)


@router.post("/drafts/{key}/proposals")
def propose(
    key: str, body: ProposalInput, request: Request, uid=Depends(require_owner), db=Depends(store)
):
    return editor.propose(
        db, request.app.state.generator, request.app.state.settings, uid, key, body
    )


@router.get("/drafts/{key}/proposals")
def proposals(key: str, uid=Depends(require_owner), db=Depends(store)):
    repo.owned(db, "drafts", key, uid)
    return sorted(
        [p for p in db.list("card_proposals", uid) if p["draft_id"] == key],
        key=lambda p: p["created_at"],
        reverse=True,
    )


@router.post("/drafts/{key}/proposals/{pid}/apply")
def apply(key: str, pid: str, body: CardSelection, uid=Depends(require_owner), db=Depends(store)):
    return editor.apply_proposal(db, uid, key, pid, body)


@router.get("/drafts/{key}/revisions")
def revisions(key: str, uid=Depends(require_owner), db=Depends(store)):
    repo.owned(db, "drafts", key, uid)
    return sorted(
        [r for r in db.list("feedback", uid) if r["draft_id"] == key],
        key=lambda r: r["created_at"],
        reverse=True,
    )


@router.post("/drafts/{key}/restore")
def restore(key: str, body: RestoreInput, uid=Depends(require_owner), db=Depends(store)):
    def run(tx):
        old = repo.owned(tx, "drafts", key, uid)
        revision = repo.owned(tx, "feedback", body.revision_id, uid)
        editor.check_version(old, body.version)
        if revision["draft_id"] != key:
            raise HTTPException(404, "이 원고의 이력이 아닙니다.")
        i = body.card_index
        if i >= len(old["draft"]["cards"]) or i >= len(revision["before"]["cards"]):
            raise HTTPException(422, "이력에 없는 카드입니다.")
        payload = deepcopy(old["draft"])
        payload["cards"][i] = revision["before"]["cards"][i]
        return editor.save_revision(tx, old, payload, f"{i + 1}번 카드 복원 ({body.revision_id})")

    return db.atomic(run)
