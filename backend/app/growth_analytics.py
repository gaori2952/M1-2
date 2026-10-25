import hashlib
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from statistics import median
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from .content_search import select_contents

LIMITATIONS = [
    "관측된 차이는 시간·주제의 인과적 효과나 팔로워 증가 보장이 아닙니다.",
    "누적값은 게시 후 경과 시간이 다릅니다. 7일차 부근 관측이 있는 자료끼리 따로 비교하세요.",
    "게시물별 팔로우 결측은 0이 아닙니다. 계정 일별 팔로우를 개별 게시물에 배분하지 않습니다.",
    "Buffer 성과는 실험적 API이며 갱신이 지연될 수 있습니다.",
]


def dt(value):
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result if result.tzinfo else None
    except (ValueError, AttributeError, TypeError):
        return None


def selected_observation(post, observation_mode, now):
    sent = dt(post.get("sent_at"))
    if post.get("status") != "sent" or not sent or sent > now:
        return None
    if observation_mode == "lifetime":
        updated = dt(post.get("metrics_updated_at"))
        return None if updated and (updated > now or updated < sent) else post
    observations = [post, *post.get("observations", [])]
    valid = []
    for o in observations:
        updated = dt(o.get("metrics_updated_at"))
        if updated and updated <= now and 6 <= (updated - sent).total_seconds() / 86400 <= 8:
            valid.append((abs((updated - sent).total_seconds() / 86400 - 7), updated, o))
    return min(valid, key=lambda x: (x[0], x[1]))[2] if valid else None


def measurement(post, observation_mode, now):
    observation = selected_observation(post, observation_mode, now)
    return observation.get("metrics", {}) if observation is not None else None


def conversion(metrics):
    if metrics is None or metrics.get("follows") is None or not metrics.get("reach"):
        return None
    return metrics["follows"] / metrics["reach"] * 100


def post_reference(post, observation_mode, now):
    observation = selected_observation(post, observation_mode, now) or {}
    return {
        "id": post["id"],
        "text": post.get("text", "")[:2000],
        "format": post["format"],
        "external_link": post.get("external_link", ""),
        "sent_at": post["sent_at"],
        "metrics_updated_at": observation.get("metrics_updated_at"),
        "observed_at": observation.get("observed_at"),
        "metrics": measurement(post, observation_mode, now),
        "tags": post.get("tags", []),
    }


def content_references(posts, options, query, now=None):
    now = now or datetime.now(timezone.utc)
    recent = sorted(
        [
            p
            for p in posts
            if p.get("status") == "sent" and dt(p.get("sent_at")) and dt(p["sent_at"]) <= now
        ],
        key=lambda p: (dt(p["sent_at"]), p["id"]),
        reverse=True,
    )
    related = select_contents(
        query + " " + options.topic,
        [p | {"title": p.get("text", "")[:120]} for p in recent],
        [],
    )
    same_format = [p for p in recent if p["format"] == options.format]
    ranked = sorted(
        [
            p
            for p in same_format
            if conversion(measurement(p, options.observation_mode, now)) is not None
        ],
        key=lambda p: conversion(measurement(p, options.observation_mode, now)),
        reverse=True,
    )
    chosen, reasons = {}, defaultdict(list)
    for pool, label in [
        (related[:2], "질문·관심 주제와 관련된 캡션"),
        (ranked[:2], "같은 형식의 팔로우 전환율 상위"),
        (same_format[:1], "같은 형식의 최근 게시물"),
        (recent[:2], "최근 게시물"),
        (related + same_format + recent, "게시 이력 참고"),
    ]:
        for p in pool:
            if p["id"] not in chosen and len(chosen) >= 5:
                continue
            chosen[p["id"]] = p
            if label not in reasons[p["id"]]:
                reasons[p["id"]].append(label)
    return {
        "evidence": [
            post_reference(p, options.observation_mode, now) | {"reference_basis": reasons[p["id"]]}
            for p in chosen.values()
        ],
        "content_history": [
            {
                "id": p["id"],
                "format": p["format"],
                "sent_at": p["sent_at"],
                "caption_excerpt": p.get("text", "")[:300],
                "external_link": p.get("external_link", ""),
            }
            for p in recent[:60]
        ],
        "content_history_total": len(recent),
    }


def analyze_growth(posts, timezone_name, now=None, observation_mode="lifetime"):
    now = now or datetime.now(timezone.utc)
    zone = ZoneInfo(timezone_name)
    groups, bins = defaultdict(list), defaultdict(list)
    excluded = 0
    for p in posts:
        sent = dt(p.get("sent_at"))
        if p.get("status") != "sent" or not sent or sent > now:
            excluded += 1
            continue
        metrics = measurement(p, observation_mode, now)
        rate = conversion(metrics)
        row = {"id": p["id"], "rate": rate, "metrics": metrics}
        groups[p["format"]].append(row)
        if rate is not None:
            local = sent.astimezone(zone)
            bins[(p["format"], local.hour // 3 * 3)].append(row | {"date": str(local.date())})
    time_comparisons = []
    for (kind, hour), rows in sorted(bins.items()):
        dates = len({r["date"] for r in rows})
        time_comparisons.append(
            {
                "format": kind,
                "start_hour": hour,
                "end_hour": hour + 3,
                "count": len(rows),
                "date_count": dates,
                "supported": len(rows) >= 3 and dates >= 2,
                "median_conversion": median(r["rate"] for r in rows),
                "evidence_ids": [r["id"] for r in rows[:5]],
            }
        )
    formats = {}
    for kind in ("carousel", "reel", "post", "story"):
        rows = groups[kind]
        rates = [r["rate"] for r in rows if r["rate"] is not None]
        follows = [
            r["metrics"]["follows"]
            for r in rows
            if r["metrics"] is not None and r["metrics"].get("follows") is not None
        ]
        formats[kind] = {
            "count": len(rows),
            "follows_count": len(follows),
            "missing_follows_count": len(rows) - len(follows),
            "conversion_count": len(rates),
            "median_follows": median(follows) if follows else None,
            "median_conversion": median(rates) if rates else None,
            "can_compare_times": sum(
                b["supported"] for b in time_comparisons if b["format"] == kind
            )
            >= 2,
        }
    return {
        "goal": "followers",
        "as_of": now.isoformat(),
        "timezone": timezone_name,
        "observation_mode": observation_mode,
        "formats": formats,
        "time_comparisons": time_comparisons,
        "excluded_count": excluded,
        "limitations": LIMITATIONS,
    }


def build_recommendation(posts, channel, options, version, now=None):
    now = now or datetime.now(timezone.utc)
    zone = ZoneInfo(channel.get("timezone", "Asia/Seoul"))
    summary = analyze_growth(posts, str(zone), now, options.observation_mode)
    selected = [
        p
        for p in posts
        if p["format"] == options.format
        and p.get("status") == "sent"
        and dt(p.get("sent_at"))
        and dt(p["sent_at"]) <= now
    ]
    terms = [w.casefold() for w in options.topic.split() if len(w) >= 2]
    matching = [
        p
        for p in selected
        if not terms
        or any(
            w in (p.get("text", "") + " " + " ".join(p.get("tags", []))).casefold() for w in terms
        )
    ]
    matching.sort(
        key=lambda p: (
            conversion(measurement(p, options.observation_mode, now)) is not None,
            conversion(measurement(p, options.observation_mode, now)) or 0,
        ),
        reverse=True,
    )
    evidence = matching[:5]
    slots = sorted(set(options.slots))
    if any(not now < slot <= now + timedelta(days=7) for slot in slots):
        raise HTTPException(422, "가능한 시간은 지금부터 7일 이내의 미래 시각으로 선택하세요.")
    candidates = []
    stats = summary["formats"][options.format]
    for slot in slots:
        hour = slot.astimezone(zone).hour // 3 * 3
        group = next(
            (
                g
                for g in summary["time_comparisons"]
                if g["format"] == options.format and g["start_hour"] == hour and g["supported"]
            ),
            None,
        )
        basis = group if stats["can_compare_times"] else None
        candidates.append(
            {
                "id": hashlib.sha256(slot.isoformat().encode()).hexdigest()[:16],
                "at": slot.isoformat(),
                "kind": "observed_pattern" if basis else "experiment",
                "sample_count": basis["count"] if basis else 0,
                "median_conversion": basis["median_conversion"] if basis else None,
                "evidence_ids": basis["evidence_ids"] if basis else [],
                "reason": (
                    f"이 시간대({hour:02d}–{hour + 3:02d}시)에 올린 같은 형식 게시물 "
                    f"{basis['count']}개, {basis['date_count']}일의 기록에서 "
                    f"팔로우 전환율 중앙값이 {basis['median_conversion']:.2f}%였어요. "
                    "내가 선택한 시간 중 이 기록을 참고해 시험할 후보예요. "
                    "콘텐츠 주제는 반영하지 않은 시간대 비교예요."
                )
                if basis
                else (
                    "내가 올릴 수 있다고 추가한 시간이에요. "
                    "비교할 기록이 부족해서 다른 시간보다 좋다는 근거는 아직 없어요."
                ),
            }
        )
    candidates.sort(
        key=lambda c: (c["kind"] != "observed_pattern", -(c["median_conversion"] or 0), c["at"])
    )
    candidate_ids = {key for candidate in candidates[:2] for key in candidate["evidence_ids"]}
    return {
        "goal": "followers",
        "version": version,
        "as_of": now.isoformat(),
        "format": options.format,
        "topic": options.topic,
        "observation_mode": options.observation_mode,
        "timezone": str(zone),
        "summary": summary,
        "candidates": candidates[:2],
        "evidence": [post_reference(p, options.observation_mode, now) for p in evidence],
        "time_evidence": [
            post_reference(p, options.observation_mode, now)
            for p in selected
            if p["id"] in candidate_ids
        ],
        "missing": (["게시물별 팔로우 자료 없음"] if not stats["follows_count"] else [])
        + (["비교할 시간 구간 표본 부족"] if not stats["can_compare_times"] else [])
        + (["주제와 일치하는 캡션·태그 없음"] if terms and not evidence else [])
        + (["가능한 게시 시간을 선택하세요"] if not slots else []),
    }
