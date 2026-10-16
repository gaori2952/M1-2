from datetime import date, timedelta

from fastapi import HTTPException

from .models import METRICS

LIMITATIONS = [
    "계정 일별 지표는 게시물별 성과나 인과관계의 근거가 아닙니다.",
    "시청자 합계는 기간 고유 인원, 팔로우 합계는 전체 팔로워 수가 아닙니다.",
    "결측값은 0으로 채우지 않습니다.",
]


def summarize(records, start=None, end=None):
    if bool(start) != bool(end):
        raise HTTPException(422, "시작일과 종료일을 함께 지정하세요.")
    if not start and records:
        end = max(date.fromisoformat(r["date"]) for r in records)
        start = end - timedelta(days=6)
    if not start:
        return {
            "period": None,
            "previous_period": None,
            "count": 0,
            "date_count": 0,
            "metrics": {},
            "daily": [],
            "limitations": LIMITATIONS,
        }
    start = date.fromisoformat(str(start))
    end = date.fromisoformat(str(end))
    if end < start or (end - start).days > 365:
        raise HTTPException(422, "기간은 순서대로 최대 366일입니다.")
    days = (end - start).days + 1
    prev = start - timedelta(days=days)
    by_key = {(r["date"], r["metric"]): r["value"] for r in records}
    metrics = {}
    daily = []
    for metric in METRICS:
        current = [
            (
                str(start + timedelta(days=i)),
                by_key.get((str(start + timedelta(days=i)), metric)),
            )
            for i in range(days)
        ]
        valid = [(d, v) for d, v in current if v is not None]
        previous = [by_key.get((str(prev + timedelta(days=i)), metric)) for i in range(days)]
        old = [v for v in previous if v is not None]
        avg = sum(v for _, v in valid) / len(valid) if valid else None
        old_avg = sum(old) / len(old) if old else None
        change = avg - old_avg if avg is not None and old_avg is not None else None
        pct = 100 * change / old_avg if change is not None and old_avg else None
        complete = len(valid) == days and len(old) == days
        trend = (
            "insufficient_data"
            if not complete
            else ("up" if change > 0 else "down" if change < 0 else "stable")
        )
        metrics[metric] = {
            "count": len(valid),
            "missing_count": days - len(valid),
            "total": sum(v for _, v in valid) if valid else None,
            "average": avg,
            "min": min((v for _, v in valid), default=None),
            "max": max((v for _, v in valid), default=None),
            "peak_date": max(valid, key=lambda p: p[1])[0] if valid else None,
            "previous_count": len(old),
            "previous_missing_count": days - len(old),
            "previous_average": old_avg,
            "change": change,
            "change_percent": pct,
            "trend": trend,
        }
        daily.extend({"date": d, "metric": metric, "value": v} for d, v in current)
    return {
        "period": {"start": str(start), "end": str(end)},
        "previous_period": {"start": str(prev), "end": str(start - timedelta(days=1))},
        "date_count": days,
        "count": sum(m["count"] for m in metrics.values()),
        "metrics": metrics,
        "daily": daily,
        "limitations": LIMITATIONS,
    }
