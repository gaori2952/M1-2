"""Validate before importing. Run with PYTHONPATH=backend python -m scripts.import_sources."""

import argparse
import hashlib
import json
from pathlib import Path

from app.config import Settings
from app.importing import import_records, parse_daily_csv
from app.models import ContentInput
from app.repository import create, identity
from app.store import Firebase, FirestoreStore


def main():
    parser = argparse.ArgumentParser(
        description="Private CSV / content JSON import (dry run by default)"
    )
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--uid", required=True)
    parser.add_argument("--kind", choices=["metrics", "contents"], required=True)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--apply", action="store_true")
    group.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    raw = args.file.read_text(encoding="utf-8-sig")
    rows = (
        parse_daily_csv(raw)
        if args.kind == "metrics"
        else [ContentInput.model_validate(r).model_dump(mode="json") for r in json.loads(raw)]
    )
    if not rows:
        parser.error("가져올 자료가 없습니다.")
    report = {
        "mode": "apply" if args.apply else "dry-run",
        "kind": args.kind,
        "records": len(rows),
        "sha256": hashlib.sha256(args.file.read_bytes()).hexdigest(),
    }
    if args.kind == "metrics":
        report.update(
            dates=len({r["date"] for r in rows}),
            numeric=sum(r["value"] is not None for r in rows),
            missing=sum(r["value"] is None for r in rows),
        )
    if args.apply:
        settings = Settings.from_env()
        if args.uid not in settings.allowed_user_uids:
            parser.error("UID가 ALLOWED_USER_UIDS에 없습니다.")
        db = FirestoreStore(Firebase(settings))
        if args.kind == "metrics":
            import_records(db, args.uid, rows)
        else:
            for row in rows:
                key = identity(
                    args.uid,
                    "content:"
                    + (row["source"] or json.dumps(row, sort_keys=True, ensure_ascii=False)),
                )
                create(
                    db,
                    "contents",
                    args.uid,
                    row | {"review_status": "unverified"},
                    key,
                    skip=True,
                )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
