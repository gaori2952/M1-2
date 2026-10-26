from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import repository as repo
from ..analytics import summarize
from ..auth import require_owner
from ..growth_models import CsvInput
from ..importing import imported_record, parse_daily_csv
from ..models import (
    ContentInput,
    ConversationInput,
    Metric,
    MetricInput,
    MetricUpdate,
    PreferenceInput,
    SeriesInput,
)

router = APIRouter(prefix="/api", dependencies=[Depends(require_owner)])


def store(request: Request):
    return request.app.state.store


@router.get("/data")
def list_data(
    start: date | None = None,
    end: date | None = None,
    metric: Metric | None = None,
    uid=Depends(require_owner),
    db=Depends(store),
):
    records = db.list("data", uid)
    if start or end:
        summarize([], start, end)
    return sorted(
        [
            r | {"editable": not imported_record(r)}
            for r in records
            if (not start or r["date"] >= str(start))
            and (not end or r["date"] <= str(end))
            and (not metric or r["metric"] == metric)
        ],
        key=lambda r: (r["date"], r["metric"]),
    )


@router.get("/data/summary")
def summary(
    start: date | None = None,
    end: date | None = None,
    uid=Depends(require_owner),
    db=Depends(store),
):
    return summarize(db.list("data", uid), start, end)


@router.post("/data", status_code=201)
def add_data(body: MetricInput, uid=Depends(require_owner), db=Depends(store)):
    return repo.create(
        db,
        "data",
        uid,
        body.model_dump(mode="json") | {"source": "manual"},
        repo.identity(uid, str(body.date) + "_" + body.metric),
    )


@router.post("/data/import")
def import_data(body: CsvInput, uid=Depends(require_owner), db=Depends(store)):
    try:
        if len(body.csv_text.encode()) > 2 * 1024 * 1024:
            raise ValueError("CSV는 2MB 이하로 가져오세요.")
        rows = parse_daily_csv(body.csv_text)
        dates = sorted({r["date"] for r in rows})
        if (
            len(dates) > 366
            or (date.fromisoformat(dates[-1]) - date.fromisoformat(dates[0])).days > 365
        ):
            raise ValueError("CSV 기간은 최대 366일입니다.")
    except (ValueError, KeyError, TypeError) as e:
        raise HTTPException(
            422, str(e) if isinstance(e, ValueError) else "CSV 열과 값을 확인하세요."
        ) from None
    imported = skipped = 0
    for row in rows:
        key = repo.identity(uid, row["date"] + "_" + row["metric"])

        def write(tx):
            if tx.get("data", key):
                return False
            tx.set(
                "data",
                key,
                row
                | {
                    "id": key,
                    "owner_uid": uid,
                    "source": "imported",
                    "created_at": repo.now(),
                    "updated_at": repo.now(),
                },
            )
            return True

        if db.atomic(write):
            imported += 1
        else:
            skipped += 1
    return {
        "imported": imported,
        "skipped": skipped,
        "date_count": len(dates),
        "valid_count": sum(r["value"] is not None for r in rows),
        "missing_count": sum(r["value"] is None for r in rows),
    }


@router.put("/data/{key}")
def edit_data(key: str, body: MetricUpdate, uid=Depends(require_owner), db=Depends(store)):
    if imported_record(repo.owned(db, "data", key, uid)):
        raise HTTPException(403, "가져온 원본 자료는 수정할 수 없습니다.")
    return repo.update(db, "data", uid, key, body.model_dump())


@router.delete("/data/{key}", status_code=204)
def delete_data(key: str, uid=Depends(require_owner), db=Depends(store)):
    if imported_record(repo.owned(db, "data", key, uid)):
        raise HTTPException(403, "가져온 원본 자료는 삭제할 수 없습니다.")
    repo.remove(db, "data", uid, key)


@router.get("/contents")
def contents(uid=Depends(require_owner), db=Depends(store)):
    return sorted(db.list("contents", uid), key=lambda r: r["updated_at"], reverse=True)


@router.post("/contents", status_code=201)
def add_content(body: ContentInput, uid=Depends(require_owner), db=Depends(store)):
    return repo.create(
        db,
        "contents",
        uid,
        body.model_dump(mode="json") | {"review_status": "unverified"},
    )


@router.get("/contents/{key}")
def get_content(key: str, uid=Depends(require_owner), db=Depends(store)):
    return repo.owned(db, "contents", key, uid)


@router.put("/contents/{key}")
def edit_content(key: str, body: ContentInput, uid=Depends(require_owner), db=Depends(store)):
    return repo.update(
        db,
        "contents",
        uid,
        key,
        body.model_dump(mode="json") | {"review_status": "unverified"},
    )


@router.delete("/contents/{key}", status_code=204)
def delete_content(key: str, uid=Depends(require_owner), db=Depends(store)):
    repo.remove(db, "contents", uid, key)


@router.get("/conversations")
def conversations(uid=Depends(require_owner), db=Depends(store)):
    return repo.list_conversations(db, uid)


@router.post("/conversations", status_code=201)
def save_conversation(body: ConversationInput, uid=Depends(require_owner), db=Depends(store)):
    return repo.save_conversation(db, uid, body)


@router.get("/conversations/{key}")
def get_conversation(key: str, uid=Depends(require_owner), db=Depends(store)):
    return repo.conversation_detail(db, uid, key)


@router.delete("/conversations/{key}", status_code=204)
def delete_conversation(key: str, uid=Depends(require_owner), db=Depends(store)):
    repo.delete_conversation(db, uid, key)


@router.get("/profile")
def profile(uid=Depends(require_owner), db=Depends(store)):
    return db.get("profiles", repo.identity(uid, "profile")) or {
        "instructions": "",
        "confirmed": False,
    }


@router.put("/profile")
def set_profile(body: PreferenceInput, uid=Depends(require_owner), db=Depends(store)):
    key = repo.identity(uid, "profile")
    doc = body.model_dump() | {"id": key, "owner_uid": uid, "updated_at": repo.now()}
    db.atomic(lambda tx: tx.set("profiles", key, doc))
    return doc


@router.get("/series")
def series(uid=Depends(require_owner), db=Depends(store)):
    return db.list("series", uid)


@router.post("/series", status_code=201)
def add_series(body: SeriesInput, uid=Depends(require_owner), db=Depends(store)):
    return repo.create(db, "series", uid, body.model_dump())


@router.put("/series/{key}")
def edit_series(key: str, body: SeriesInput, uid=Depends(require_owner), db=Depends(store)):
    return repo.update(db, "series", uid, key, body.model_dump())
