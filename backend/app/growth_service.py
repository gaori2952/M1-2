import hashlib
import json
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from . import repository as repo
from .buffer_service import connection, current_posts, require_buffer_owner
from .growth_analytics import (
    analyze_growth,
    build_recommendation,
    content_references,
    conversion,
    dt,
    measurement,
    selected_observation,
)


def annotated_posts(db, settings, uid, *, observations=False):
    posts = current_posts(db, settings, uid)
    annotations = {a["post_id"]: a for a in db.list("post_annotations", uid)}
    for p in posts:
        p["annotation"] = annotations.get(p["id"], {})
        p["tags"] = list(dict.fromkeys(p.get("tags", []) + p["annotation"].get("tags", [])))
    if observations:
        history = sorted(
            [
                s
                for s in db.list("buffer_syncs", uid)
                if s.get("status") == "done" and s.get("channel_id") == settings.buffer_channel_id
            ],
            key=lambda s: s.get("completed_at", ""),
            reverse=True,
        )
        by_id = {p["id"]: p for p in posts}
        seen = set()
        for sync in history:
            for old in db.list(f"buffer_syncs/{sync['id']}/posts", uid):
                signature = (
                    old["id"],
                    old.get("metrics_updated_at"),
                    json.dumps(old["metrics"], sort_keys=True),
                )
                if old["id"] in by_id and signature not in seen:
                    by_id[old["id"]].setdefault("observations", []).append(
                        {
                            "metrics_updated_at": old.get("metrics_updated_at"),
                            "metrics": old["metrics"],
                            "observed_at": old.get("observed_at"),
                        }
                    )
                    seen.add(signature)
    return posts


def growth_context(db, settings, uid, options, message=None):
    c = connection(db, settings, uid)
    if message is not None:
        now = datetime.now(timezone.utc)
        options = options.model_copy(
            update={
                "slots": [slot for slot in options.slots if now < slot <= now + timedelta(days=7)]
            }
        )
    posts = annotated_posts(db, settings, uid, observations=options.observation_mode == "seven_day")
    result = build_recommendation(
        posts,
        c.get("channel") or {"timezone": "Asia/Seoul"},
        options,
        c.get("sync_id"),
    )
    if message is not None:
        result.update(content_references(posts, options, message))
        secondary_metrics = (
            "저장",
            "공유",
            "조회",
            "좋아요",
            "댓글",
            "시청",
            "반응",
            "save",
            "share",
            "view",
            "like",
            "comment",
            "watch",
        )
        if not any(word in message.casefold() for word in secondary_metrics):
            # Keep the follower goal from being replaced by larger save/share counts.
            for reference in [*result["evidence"], *result["time_evidence"]]:
                if reference["metrics"] is not None:
                    reference["metrics"] = {
                        key: reference["metrics"].get(key) for key in ("follows", "reach")
                    }
    return result


def preview_recommendation(db, settings, uid, request_id, options):
    require_buffer_owner(settings, uid)
    key = repo.identity(uid, "growth_" + str(request_id))
    fingerprint = hashlib.sha256(options.model_dump_json().encode()).hexdigest()
    prior = db.get("growth_recommendations", key)
    if prior:
        if prior["fingerprint"] != fingerprint:
            raise HTTPException(409, "같은 요청 ID에 다른 게시 조건을 사용할 수 없습니다.")
        return prior["result"]
    result = growth_context(db, settings, uid, options) | {"request_id": str(request_id)}
    repo.create(
        db,
        "growth_recommendations",
        uid,
        {"fingerprint": fingerprint, "result": result},
        key,
        skip=True,
    )
    return result


def save_experiment(db, settings, uid, body):
    require_buffer_owner(settings, uid)
    record = repo.owned(
        db, "growth_recommendations", repo.identity(uid, "growth_" + str(body.request_id)), uid
    )
    result = record["result"]
    candidate = next((c for c in result["candidates"] if c["id"] == body.candidate_id), None)
    if not candidate:
        raise HTTPException(422, "저장된 추천의 시간 후보를 선택하세요.")
    return repo.create(
        db,
        "growth_experiments",
        uid,
        {
            "request_id": str(body.request_id),
            "candidate": candidate,
            "format": result["format"],
            "topic": result["topic"],
            "baseline": result,
            "status": "planned",
            "post_id": None,
            "memo": "",
        },
        repo.identity(uid, "experiment_" + str(body.request_id) + "_" + body.candidate_id),
        skip=True,
    )


def experiment_result(db, settings, uid, experiment):
    if experiment["status"] == "cancelled" or not experiment.get("post_id"):
        return experiment
    post = next(
        (
            p
            for p in annotated_posts(db, settings, uid, observations=True)
            if p["id"] == experiment["post_id"]
        ),
        None,
    )
    if not post:
        return experiment | {
            "status": "linked",
            "observation_message": "현재 수집 자료에서 연결 게시물을 찾을 수 없습니다.",
        }
    metrics = measurement(post, "seven_day", datetime.now(timezone.utc))
    observation = selected_observation(post, "seven_day", datetime.now(timezone.utc)) or {}
    return experiment | {
        "status": "observed" if conversion(metrics) is not None else "awaiting_observation",
        "observed_metrics": metrics,
        "observed_conversion": conversion(metrics),
        "current_metrics": post["metrics"],
        "metrics_updated_at": observation.get("metrics_updated_at"),
        "observed_at": observation.get("observed_at"),
        "current_metrics_updated_at": post.get("metrics_updated_at"),
        "observation_message": "실제 7일차 부근 관측입니다. 한 건으로 개선 효과를 확정하지 않습니다."
        if conversion(metrics) is not None
        else "비교 시점 또는 팔로우 자료 없음 · 누적 성과는 별도 참고하세요.",
    }


def update_experiment(db, settings, uid, key, body):
    require_buffer_owner(settings, uid)
    exp = repo.owned(db, "growth_experiments", key, uid)
    patch = {"memo": body.memo}
    if body.cancelled:
        patch["status"] = "cancelled"
    elif body.post_id:
        post = next((p for p in current_posts(db, settings, uid) if p["id"] == body.post_id), None)
        if (
            not post
            or post["format"] != exp["format"]
            or post["status"] != "sent"
            or not dt(post.get("sent_at"))
            or dt(post["sent_at"]) > datetime.now(timezone.utc)
        ):
            raise HTTPException(422, "같은 형식의 실제 게시 완료 자료를 선택하세요.")
        difference = abs((dt(post["sent_at"]) - dt(exp["candidate"]["at"])).total_seconds()) / 60
        patch |= {
            "post_id": post["id"],
            "status": "linked",
            "actual_sent_at": post["sent_at"],
            "time_difference_minutes": round(difference, 1),
            "deviated": difference >= 60,
        }
    return experiment_result(
        db, settings, uid, repo.update(db, "growth_experiments", uid, key, patch)
    )


def growth_summary(db, settings, uid, observation_mode="lifetime"):
    c = connection(db, settings, uid)
    return analyze_growth(
        annotated_posts(db, settings, uid, observations=observation_mode == "seven_day"),
        (c.get("channel") or {}).get("timezone", "Asia/Seoul"),
        observation_mode=observation_mode,
    )
