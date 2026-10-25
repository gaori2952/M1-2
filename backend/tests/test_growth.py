from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from app.buffer_service import sync_buffer
from app.growth_analytics import analyze_growth, build_recommendation
from app.growth_models import ExperimentInput, ExperimentUpdate, GrowthOptions
from app.growth_service import preview_recommendation, save_experiment, update_experiment
from fastapi import HTTPException

from .memory_store import MemoryStore
from .test_buffer import FakeBuffer, settings

NOW = datetime(2026, 10, 21, tzinfo=timezone.utc)


def post(key, day=1, hour=11, follows=2, reach=100, kind="carousel"):
    sent = NOW - timedelta(days=day)
    sent = sent.replace(hour=hour)
    return {
        "id": key,
        "format": kind,
        "status": "sent",
        "text": "전기장",
        "tags": [],
        "sent_at": sent.isoformat(),
        "metrics_updated_at": NOW.isoformat(),
        "metrics": {"follows": follows, "reach": reach},
        "external_link": "https://example.com/post",
        "assets": [],
    }


def test_growth_null_zero_format_and_future_exclusion():
    ps = [
        post("zero", follows=0),
        post("null", follows=None),
        post("no_reach", reach=0),
        post("reel", kind="reel", follows=None),
        post("future", day=-1),
        post("draft") | {"status": "draft"},
    ]
    s = analyze_growth(ps, "Asia/Seoul", now=NOW)
    assert s["formats"]["carousel"]["count"] == 3
    assert s["formats"]["carousel"]["conversion_count"] == 1
    assert s["formats"]["carousel"]["median_conversion"] == 0
    assert s["formats"]["reel"]["median_conversion"] is None
    assert s["excluded_count"] == 2


def test_time_comparison_requires_multiple_days_and_two_supported_bins():
    ps = [post(str(i), day=i + 1, hour=10 if i < 3 else 13) for i in range(6)]
    s = analyze_growth(ps, "Asia/Seoul", now=NOW)
    assert s["formats"]["carousel"]["can_compare_times"]
    assert {x["start_hour"] for x in s["time_comparisons"]} == {18, 21}
    assert not analyze_growth(ps[:3], "Asia/Seoul", now=NOW)["formats"]["carousel"][
        "can_compare_times"
    ]
    p = post("midnight", hour=16)
    assert analyze_growth([p], "Asia/Seoul", now=NOW)["time_comparisons"][0]["start_hour"] == 0


def test_same_age_uses_stored_snapshot_not_current_accumulated_value():
    p = post("old", day=20, follows=999)
    p["observations"] = [
        {
            "metrics_updated_at": (
                datetime.fromisoformat(p["sent_at"]) + timedelta(days=7)
            ).isoformat(),
            "metrics": {"follows": 2, "reach": 100},
        }
    ]
    s = analyze_growth([p], "Asia/Seoul", now=NOW, observation_mode="seven_day")
    assert s["formats"]["carousel"]["median_conversion"] == 2
    p.pop("observations")
    assert (
        analyze_growth([p], "Asia/Seoul", now=NOW, observation_mode="seven_day")["formats"][
            "carousel"
        ]["conversion_count"]
        == 0
    )


def test_candidates_are_confirmed_future_times_and_unknown_growth_is_experiment():
    options = GrowthOptions(format="reel", topic="전기장", slots=[NOW + timedelta(hours=5)])
    r = build_recommendation(
        [post("r", kind="reel", follows=None)], {"timezone": "Asia/Seoul"}, options, "v1", now=NOW
    )
    assert len(r["candidates"]) == 1
    assert r["candidates"][0]["kind"] == "experiment"
    assert r["goal"] == "followers"
    bad = GrowthOptions(slots=[NOW - timedelta(hours=1)])
    with pytest.raises(HTTPException):
        build_recommendation([], {"timezone": "Asia/Seoul"}, bad, "v1", now=NOW)


def test_saved_experiment_has_immutable_baseline_and_checks_link():
    db, cfg = MemoryStore(), settings()
    sync_buffer(db, FakeBuffer(), cfg, "alice", str(uuid4()))
    rid = uuid4()
    options = GrowthOptions(slots=[datetime.now(timezone.utc) + timedelta(hours=5)])
    preview = preview_recommendation(db, cfg, "alice", rid, options)
    body = ExperimentInput(request_id=rid, candidate_id=preview["candidates"][0]["id"])
    exp = save_experiment(db, cfg, "alice", body)
    assert save_experiment(db, cfg, "alice", body)["id"] == exp["id"]
    linked = update_experiment(db, cfg, "alice", exp["id"], ExperimentUpdate(post_id="post1"))
    assert linked["baseline"] == exp["baseline"]
    assert linked["deviated"]
    with pytest.raises(HTTPException):
        update_experiment(db, cfg, "bob", exp["id"], ExperimentUpdate(post_id="post1"))
    with pytest.raises(HTTPException):
        save_experiment(db, cfg, "alice", ExperimentInput(request_id=rid, candidate_id="invented"))


def test_seven_day_evidence_retains_selected_observation_timestamp():
    p = post("old", day=20, follows=999)
    observed = (datetime.fromisoformat(p["sent_at"]) + timedelta(days=7)).isoformat()
    p["observations"] = [{"metrics_updated_at": observed, "metrics": {"follows": 2, "reach": 100}}]
    result = build_recommendation(
        [p], {"timezone": "Asia/Seoul"}, GrowthOptions(observation_mode="seven_day"), "v1", now=NOW
    )
    assert result["evidence"][0]["metrics"]["follows"] == 2
    assert result["evidence"][0]["metrics_updated_at"] == observed
