import pytest
from app.analytics import summarize
from app.config import Settings
from app.content_search import select_contents
from app.importing import parse_daily_csv
from app.main import create_app
from fastapi.testclient import TestClient

from .memory_store import MemoryStore


@pytest.fixture
def env():
    store = MemoryStore()

    def verify(token):
        if token not in ("alice", "bob", "outsider"):
            raise ValueError("bad token")
        return {"uid": token}

    app = create_app(Settings(allowed_user_uids=("alice", "bob")), store=store, verify_token=verify)
    return TestClient(app), store


def auth(uid="alice"):
    return {"Authorization": f"Bearer {uid}"}


def test_auth_is_required_and_allowlisted(env):
    c, _ = env
    assert c.get("/health").status_code == 200
    assert c.get("/docs").status_code == 200
    assert c.get("/api/data").status_code == 401
    assert c.get("/api/data", headers=auth("bad")).status_code == 401
    assert c.get("/api/data", headers=auth("outsider")).status_code == 403
    assert c.get("/api/data", headers=auth()).json() == []


@pytest.mark.parametrize(
    "changes",
    [
        {"value": -1},
        {"value": 1.5},
        {"value": True},
        {"value": "10"},
        {"metric": "bad"},
        {"date": "2026-02-30"},
        {"owner_uid": "bob"},
    ],
)
def test_invalid_metric_input(env, changes):
    c, _ = env
    body = {"date": "2026-10-01", "metric": "views", "value": 0, "memo": ""} | changes
    assert c.post("/api/data", json=body, headers=auth()).status_code == 422


def test_crud_isolated_duplicate_and_summary_updates(env):
    c, _ = env
    body = {"date": "2026-10-01", "metric": "views", "value": 0, "memo": ""}
    r = c.post("/api/data", json=body, headers=auth())
    assert r.status_code == 201
    rid = r.json()["id"]
    assert c.post("/api/data", json=body, headers=auth()).status_code == 409
    assert c.get("/api/data", headers=auth("bob")).json() == []
    assert (
        c.put(
            "/api/data/" + rid,
            json={"value": 9, "memo": "changed"},
            headers=auth("bob"),
        ).status_code
        == 404
    )
    assert (
        c.put("/api/data/" + rid, json={"value": 9, "memo": "changed"}, headers=auth()).status_code
        == 200
    )
    summary = c.get("/api/data/summary", headers=auth()).json()
    assert summary["metrics"]["views"]["max"] == 9
    assert c.delete("/api/data/" + rid, headers=auth()).status_code == 204
    assert c.get("/api/data", headers=auth()).json() == []


def test_imported_metrics_are_read_only_including_legacy_csv_records(env):
    c, db = env
    header = "date,views,viewers,interactions,visits,follows,link_clicks\n"
    assert (
        c.post(
            "/api/data/import",
            json={"csv_text": header + "2026-10-14,10,0,2,1,3,0\n"},
            headers=auth(),
        ).status_code
        == 200
    )
    records = c.get("/api/data", headers=auth()).json()
    row = next(r for r in records if r["metric"] == "views")
    assert row["editable"] is False
    assert (
        c.put("/api/data/" + row["id"], json={"value": 999, "memo": ""}, headers=auth()).status_code
        == 403
    )
    assert c.delete("/api/data/" + row["id"], headers=auth()).status_code == 403
    assert db.get("data", row["id"])["value"] == 10
    legacy = db.get("data", row["id"])
    legacy.pop("source", None)
    db.set("data", row["id"], legacy)
    assert c.get("/api/data", headers=auth()).json()[0]["editable"] is False
    assert c.delete("/api/data/" + row["id"], headers=auth()).status_code == 403


def test_calendar_comparison_preserves_missing_and_zero():
    records = [
        {"date": "2026-10-01", "metric": "views", "value": 0},
        {"date": "2026-10-08", "metric": "views", "value": 14},
        {"date": "2026-10-09", "metric": "views", "value": None},
    ]
    s = summarize(records, "2026-10-08", "2026-10-14")
    v = s["metrics"]["views"]
    assert s["previous_period"] == {"start": "2026-10-01", "end": "2026-10-07"}
    assert v["count"] == 1 and v["missing_count"] == 6 and v["average"] == 14
    assert v["previous_average"] == 0 and v["change_percent"] is None and v["change"] == 14
    assert v["trend"] == "insufficient_data"
    assert s["metrics"]["follows"]["average"] is None


def test_empty_and_bad_date_range(env):
    c, _ = env
    assert c.get("/api/data/summary", headers=auth()).json()["period"] is None
    assert (
        c.get("/api/data/summary?start=2026-10-14&end=2026-10-01", headers=auth()).status_code
        == 422
    )


def test_import_preserves_missing_and_rejects_duplicates():
    header = "date,views,viewers,interactions,visits,follows,link_clicks\n"
    records = parse_daily_csv(header + "2026-10-14,10,0,2,1,,0\n")
    assert len(records) == 6
    assert next(r for r in records if r["metric"] == "follows")["value"] is None
    assert next(r for r in records if r["metric"] == "viewers")["value"] == 0
    with pytest.raises(ValueError):
        parse_daily_csv(header + "2026-10-14,1,2,3,4,5,6\n" * 2)
    with pytest.raises(ValueError):
        parse_daily_csv(header + "2026-10-14,1.5,2,3,4,5,6\n")


def test_search_and_content_ownership(env):
    c, _ = env
    r = c.post(
        "/api/contents",
        headers=auth(),
        json={"title": "전자기학", "text": "전기장과 가우스 법칙", "tags": ["물리"]},
    )
    assert r.status_code == 201
    cid = r.json()["id"]
    assert c.get("/api/contents/" + cid, headers=auth("bob")).status_code == 404
    items = c.get("/api/contents", headers=auth()).json()
    assert select_contents("전자기학", items, [])[0]["id"] == cid
    assert select_contents("열역학", items, []) == []
    assert select_contents("열역학", items, [cid])[0]["id"] == cid
    with pytest.raises(Exception):
        select_contents("x", items, ["missing"])

    assert (
        c.put(
            "/api/contents/" + cid,
            headers=auth(),
            json={"title": "수정", "text": "수정 원고", "tags": []},
        ).json()["review_status"]
        == "unverified"
    )


def test_manual_conversation_save_load_delete_and_role_validation(env):
    c, _ = env
    r = c.post(
        "/api/conversations",
        headers=auth(),
        json={
            "title": "테스트",
            "messages": [
                {"role": "user", "content": "질문"},
                {"role": "assistant", "content": "답변"},
            ],
        },
    )
    assert r.status_code == 201
    cid = r.json()["id"]
    assert "messages" not in c.get("/api/conversations", headers=auth()).json()[0]
    assert len(c.get("/api/conversations/" + cid, headers=auth()).json()["messages"]) == 2
    assert c.get("/api/conversations/" + cid, headers=auth("bob")).status_code == 404
    assert c.delete("/api/conversations/" + cid, headers=auth()).status_code == 204
    assert c.get("/api/conversations/" + cid, headers=auth()).status_code == 404
    assert (
        c.post(
            "/api/conversations",
            headers=auth(),
            json={"title": "x", "messages": [{"role": "system", "content": "x"}]},
        ).status_code
        == 422
    )


def test_import_accepts_integer_formatted_decimals_without_truncating():
    header = "date,views,viewers,interactions,visits,follows,link_clicks\n"
    rows = parse_daily_csv(header + "2026-10-14,10.00000000,0.00000000,2,1,,0\n")
    assert rows[0]["value"] == 10
    with pytest.raises(ValueError):
        parse_daily_csv(header + "2026-10-14,10.00000001,0,2,1,,0\n")


def test_reimport_does_not_overwrite_user_edits(env):
    from app.importing import import_records
    from app.repository import identity

    c, db = env
    rows = [{"date": "2026-10-01", "metric": "views", "value": 10, "memo": "import"}]
    key = identity("alice", "2026-10-01_views")
    assert (
        c.post(
            "/api/data",
            headers=auth(),
            json={"date": "2026-10-01", "metric": "views", "value": 99, "memo": "my edit"},
        ).status_code
        == 201
    )
    import_records(db, "alice", rows)
    assert len(db.list("data", "alice")) == 1
    assert db.get("data", key)["value"] == 99


def test_no_configuration_never_bypasses_auth():
    c = TestClient(create_app(Settings()))
    assert c.get("/api/data").status_code == 401
    assert c.get("/api/data", headers=auth()).status_code == 503


def test_content_performance_round_trip_and_validation(env):
    c, _ = env
    body = {"title": "전위", "text": "본문", "performance": {"views": 1200, "saves": 0}}
    r = c.post("/api/contents", headers=auth(), json=body)
    assert r.status_code == 201
    perf = r.json()["performance"]
    assert perf["views"] == 1200 and perf["saves"] == 0 and perf["shares"] is None
    bad = body | {"performance": {"views": -1}}
    assert c.post("/api/contents", headers=auth(), json=bad).status_code == 422
    unknown = body | {"performance": {"followers": 3}}
    assert c.post("/api/contents", headers=auth(), json=unknown).status_code == 422
