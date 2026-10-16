import csv
import io
import re
from decimal import Decimal

from .models import METRICS, MetricInput
from .repository import create, identity


def parse_daily_csv(text):
    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
    if reader.fieldnames != ["date", *METRICS]:
        raise ValueError("CSV 헤더는 date와 6개 지표 순서여야 합니다.")
    rows = []
    seen = set()
    for line in reader:
        if line["date"] in seen:
            raise ValueError("중복 날짜입니다.")
        seen.add(line["date"])
        for metric in METRICS:
            raw = line[metric]
            if raw is None or (raw.strip() and not re.fullmatch(r"\d+(?:\.0+)?", raw.strip())):
                raise ValueError("정수 또는 빈 값만 허용합니다.")
            rows.append(
                MetricInput(
                    date=line["date"],
                    metric=metric,
                    value=int(Decimal(raw)) if raw.strip() else None,
                    memo="M1-1 CSV 가져오기",
                ).model_dump(mode="json")
            )
    if not rows:
        raise ValueError("CSV가 비어 있습니다.")
    return rows


def import_records(store, uid, rows):
    for r in rows:
        create(
            store,
            "data",
            uid,
            r,
            identity(uid, r["date"] + "_" + r["metric"]),
            skip=True,
        )
