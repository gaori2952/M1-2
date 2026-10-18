from fastapi import APIRouter, Depends, Request

from .. import image_review_service as service
from .. import repository as repo
from ..auth import require_owner
from ..image_review_models import CheckInput, Key, ReviewCreate, RunInput
from .resources import store

router = APIRouter(prefix="/api/image-reviews", dependencies=[Depends(require_owner)])


@router.post("", status_code=201)
def create(body: ReviewCreate, uid=Depends(require_owner), db=Depends(store)):
    return service.create(db, uid, body)


@router.get("")
def listing(uid=Depends(require_owner), db=Depends(store)):
    docs = sorted(db.list(service.REVIEWS, uid), key=lambda r: r["updated_at"], reverse=True)
    return [
        {k: r[k] for k in ("id", "title", "version", "updated_at")}
        | {"card_count": len(r["cards"])}
        for r in docs[:100]
    ]


@router.get("/{rid}")
def detail(rid: Key, uid=Depends(require_owner), db=Depends(store)):
    return service.detail(db, rid, uid)


@router.post("/{rid}/runs")
def run(rid: Key, body: RunInput, request: Request, uid=Depends(require_owner), db=Depends(store)):
    return service.run(
        db, request.app.state.image_reviewer, request.app.state.settings, uid, rid, body
    )


@router.get("/{rid}/runs/{request_id}")
def status(rid: Key, request_id: Key, uid=Depends(require_owner), db=Depends(store)):
    return service.request_status(db, rid, uid, request_id)


@router.get("/{rid}/cards/{cid}/versions")
def versions(rid: Key, cid: Key, uid=Depends(require_owner), db=Depends(store)):
    repo.owned(db, service.REVIEWS, rid, uid)
    return sorted(
        [
            v
            for v in db.list(service.VERSIONS, uid)
            if v["review_id"] == rid and v["card_id"] == cid
        ],
        key=lambda v: v["version"],
        reverse=True,
    )


@router.put("/{rid}/checks/{fid}")
def check(rid: Key, fid: Key, body: CheckInput, uid=Depends(require_owner), db=Depends(store)):
    return service.check(db, uid, rid, fid, body.checked)
