from datetime import date
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .. import repository as repo
from ..auth import require_owner
from ..buffer_service import (
    buffer_status,
    current_posts,
    require_buffer_owner,
    sync_buffer,
    sync_request_status,
)
from ..growth_models import (
    AnnotationInput,
    BufferSyncInput,
    ExperimentInput,
    ExperimentUpdate,
    PreviewInput,
)
from ..growth_service import (
    annotated_posts,
    experiment_result,
    growth_summary,
    preview_recommendation,
    save_experiment,
    update_experiment,
)
from .resources import store

router = APIRouter(prefix="/api", dependencies=[Depends(require_owner)])


@router.get("/buffer/status")
def status(request: Request, uid=Depends(require_owner), db=Depends(store)):
    return buffer_status(db, request.app.state.settings, uid)


@router.post("/buffer/sync")
def sync(body: BufferSyncInput, request: Request, uid=Depends(require_owner), db=Depends(store)):
    return sync_buffer(
        db,
        request.app.state.buffer_client,
        request.app.state.settings,
        uid,
        body.request_id,
        force=body.force,
    )


@router.get("/buffer/sync/{request_id}")
def sync_status(request_id: UUID, request: Request, uid=Depends(require_owner), db=Depends(store)):
    return sync_request_status(db, request.app.state.settings, uid, request_id)


@router.get("/buffer/posts")
def posts(
    request: Request,
    format: Literal["carousel", "reel", "post", "story"] | None = None,
    status: str | None = None,
    start: date | None = None,
    end: date | None = None,
    offset: int = Query(default=0, ge=0, le=2000),
    limit: int = Query(default=30, ge=1, le=50),
    uid=Depends(require_owner),
    db=Depends(store),
):
    if start and end and start > end:
        raise HTTPException(422, "기간 순서를 확인하세요.")
    values = [
        p
        for p in annotated_posts(db, request.app.state.settings, uid)
        if (not format or p["format"] == format)
        and (not status or p["status"] == status)
        and (not start or (p.get("sent_at") or "")[:10] >= str(start))
        and (not end or (p.get("sent_at") or "")[:10] <= str(end))
    ]
    values.sort(key=lambda p: (p.get("sent_at") or p.get("due_at") or "", p["id"]), reverse=True)
    return {
        "items": values[offset : offset + limit],
        "total": len(values),
        "next_offset": offset + limit if offset + limit < len(values) else None,
    }


@router.put("/buffer/posts/{post_id}/annotation")
def annotate(
    post_id: str,
    body: AnnotationInput,
    request: Request,
    uid=Depends(require_owner),
    db=Depends(store),
):
    if not any(p["id"] == post_id for p in current_posts(db, request.app.state.settings, uid)):
        raise HTTPException(404, "내 수집 자료의 게시물을 선택하세요.")
    key = repo.identity(uid, post_id)
    payload = body.model_dump(mode="json") | {"post_id": post_id}
    if db.get("post_annotations", key):
        return repo.update(db, "post_annotations", uid, key, payload)
    return repo.create(db, "post_annotations", uid, payload, key)


@router.get("/growth/summary")
def summary(
    request: Request,
    observation_mode: Literal["lifetime", "seven_day"] = "lifetime",
    uid=Depends(require_owner),
    db=Depends(store),
):
    return growth_summary(db, request.app.state.settings, uid, observation_mode)


@router.post("/growth/recommendations")
def preview(body: PreviewInput, request: Request, uid=Depends(require_owner), db=Depends(store)):
    return preview_recommendation(
        db, request.app.state.settings, uid, body.request_id, body.options
    )


@router.post("/growth/experiments", status_code=201)
def create_experiment(
    body: ExperimentInput, request: Request, uid=Depends(require_owner), db=Depends(store)
):
    return save_experiment(db, request.app.state.settings, uid, body)


@router.get("/growth/experiments")
def experiments(request: Request, uid=Depends(require_owner), db=Depends(store)):
    cfg = request.app.state.settings
    require_buffer_owner(cfg, uid)
    return [
        experiment_result(db, cfg, uid, e)
        for e in sorted(
            db.list("growth_experiments", uid), key=lambda e: e["created_at"], reverse=True
        )
    ]


@router.put("/growth/experiments/{key}")
def edit_experiment(
    key: str,
    body: ExperimentUpdate,
    request: Request,
    uid=Depends(require_owner),
    db=Depends(store),
):
    return update_experiment(db, request.app.state.settings, uid, key, body)
