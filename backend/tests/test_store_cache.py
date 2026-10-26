from types import SimpleNamespace

from app import store as module
from app.config import Settings
from app.main import create_app
from fastapi.testclient import TestClient
from google.api_core.exceptions import ResourceExhausted

from .memory_store import MemoryStore


def test_firestore_read_cache_is_scoped_copied_expiring_and_invalidated(monkeypatch):
    backing = MemoryStore()
    reads = []
    clock = [100]

    class Unit:
        def __init__(self, *args):
            pass

        def get(self, *args):
            reads.append(("get", args))
            return backing.get(*args)

        def list(self, *args):
            reads.append(("list", args))
            return backing.list(*args)

        def set(self, *args):
            backing.set(*args)

        writes = []

    monkeypatch.setattr(module, "FirestoreUnit", Unit)
    monkeypatch.setattr(module.firestore, "transactional", lambda f: f)
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    backing.set("data", "a", {"owner_uid": "alice", "value": 1})
    db = module.FirestoreStore(SimpleNamespace(db=SimpleNamespace(transaction=lambda: None)))
    first = db.list("data", "alice")
    first[0]["value"] = 999
    assert db.list("data", "alice")[0]["value"] == 1
    assert db.list("data", "bob") == []
    assert len(reads) == 2
    clock[0] += 901
    assert db.list("data", "alice")[0]["value"] == 1
    assert len(reads) == 3
    db.atomic(lambda tx: tx.set("data", "a", {"owner_uid": "alice", "value": 2}))
    assert db.list("data", "alice")[0]["value"] == 2
    assert len(reads) == 4


def test_quota_error_is_explicit_and_readable_cross_origin():
    class LimitedStore(MemoryStore):
        def list(self, *args):
            raise ResourceExhausted("Quota exceeded")

    app = create_app(
        Settings(allowed_user_uids=("alice",), allowed_origins=("https://example.com",)),
        store=LimitedStore(),
        verify_token=lambda _: {"uid": "alice"},
    )
    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.get(
            "/api/data", headers={"Authorization": "Bearer test", "Origin": "https://example.com"}
        )
    assert r.status_code == 503
    assert r.json()["code"] == "database_quota_exceeded"
    assert r.headers["access-control-allow-origin"] == "https://example.com"
