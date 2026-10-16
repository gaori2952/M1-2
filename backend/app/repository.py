import hashlib
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import HTTPException


def now():
    return datetime.now(timezone.utc).isoformat()


def identity(uid, key):
    return hashlib.sha256((uid + "\0" + key).encode()).hexdigest()


def owned(store, collection, key, uid):
    doc = store.get(collection, key)
    if not doc or doc.get("owner_uid") != uid or doc.get("deleted"):
        raise HTTPException(404, "자료를 찾을 수 없습니다.")
    return doc


def create(store, collection, uid, payload, key=None, skip=False):
    key = key or uuid4().hex

    def run(tx):
        existing = tx.get(collection, key)
        if existing:
            if skip and existing.get("owner_uid") == uid:
                return existing
            raise HTTPException(409, "이미 존재하는 기록입니다.")
        result = dict(payload, id=key, owner_uid=uid, created_at=now(), updated_at=now())
        tx.set(collection, key, result)
        return result

    return store.atomic(run)


def update(store, collection, uid, key, payload):
    def run(tx):
        result = owned(tx, collection, key, uid) | payload | {"updated_at": now()}
        tx.set(collection, key, result)
        return result

    return store.atomic(run)


def remove(store, collection, uid, key):
    def run(tx):
        owned(tx, collection, key, uid)
        tx.delete(collection, key)

    store.atomic(run)


def list_conversations(store, uid):
    return sorted(
        [
            r
            for r in store.list("conversations", uid)
            if not r.get("deleted") and not r.get("pending")
        ],
        key=lambda r: r["updated_at"],
        reverse=True,
    )


def conversation_detail(store, uid, key):
    doc = owned(store, "conversations", key, uid)
    doc["messages"] = sorted(
        store.list(f"conversations/{key}/messages", uid), key=lambda m: m["sequence"]
    )
    return doc


def save_conversation(store, uid, payload):
    key = uuid4().hex

    def run(tx):
        doc = {
            "id": key,
            "owner_uid": uid,
            "title": payload.title,
            "created_at": now(),
            "updated_at": now(),
            "message_count": len(payload.messages),
            "version": 1,
        }
        tx.set("conversations", key, doc)
        for i, m in enumerate(payload.messages):
            mid = uuid4().hex
            tx.set(
                f"conversations/{key}/messages",
                mid,
                m.model_dump() | {"id": mid, "owner_uid": uid, "sequence": i, "created_at": now()},
            )
        return doc

    return store.atomic(run)


def delete_conversation(store, uid, key):
    def run(tx):
        doc = owned(tx, "conversations", key, uid)
        messages = tx.list(f"conversations/{key}/messages", uid)
        requests = [r for r in tx.list("requests", uid) if r.get("conversation_id") == key]
        if doc.get("busy_until", 0) > datetime.now(timezone.utc).timestamp():
            raise HTTPException(409, "답변 생성 중에는 대화를 삭제할 수 없습니다.")
        for m in messages:
            tx.delete(f"conversations/{key}/messages", m["id"])
        # Keep a small tombstone so a retry cannot resurrect a deleted conversation.
        for r in requests:
            tx.set(
                "requests",
                r["id"],
                {
                    "id": r["id"],
                    "owner_uid": uid,
                    "status": "deleted",
                    "fingerprint": r["fingerprint"],
                },
            )
        tx.delete("conversations", key)

    store.atomic(run)
