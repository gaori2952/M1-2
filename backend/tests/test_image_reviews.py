from copy import deepcopy
from uuid import uuid4

import pytest
from app.config import Settings
from app.main import create_app
from fastapi.testclient import TestClient

from .memory_store import MemoryStore
from .test_core import auth
from .test_image_review_transport import asset


class Reviewer:
    def __init__(self):
        self.calls = []
        self.error = None
        self.transform = lambda r: r

    def review(self, images, context):
        self.calls.append((deepcopy(images), deepcopy(context)))
        if self.error:
            raise self.error
        return self.transform(
            {
                "cards": [
                    {
                        "card_id": cid,
                        "summary": "합성 검토",
                        "findings": [
                            {
                                "category": "uncertain",
                                "location": "상단 수식",
                                "evidence": "E=F/q",
                                "reason": "단위 확인 필요",
                                "suggestion": "단위를 명시하세요",
                            }
                        ],
                        "resolutions": [
                            {"finding_id": f["id"], "status": "resolved"}
                            for f in context["previous_findings"].get(cid, [])
                        ],
                    }
                    for cid in context["target_card_ids"]
                ],
                "connections": []
                if context["single_card"]
                else [
                    {
                        "card_ids": context["target_card_ids"],
                        "category": "improvement",
                        "location": "전체",
                        "evidence": "기호 표기",
                        "reason": "표기 일관성",
                        "suggestion": "같은 기호를 사용하세요",
                    }
                ],
            }
        )


@pytest.fixture
def image_env():
    db, reviewer = MemoryStore(), Reviewer()
    app = create_app(
        Settings(allowed_user_uids=("alice", "bob"), daily_request_limit=4),
        store=db,
        verify_token=lambda t: {"uid": t},
        image_reviewer=reviewer,
    )
    return TestClient(app), db, reviewer


def create(c, images=None, **kw):
    images = images or [asset(cid="one"), asset(color="red", cid="two")]
    body = {
        "request_id": str(uuid4()),
        "title": "테스트 검토",
        "criteria": "부호 확인",
        "cards": [{k: a[k] for k in ("card_id", "name", "sha256")} for a in images],
    } | kw
    r = c.post("/api/image-reviews", json=body, headers=auth())
    assert r.status_code == 201, r.text
    return r.json(), images


def run(c, doc, images, **kw):
    return c.post(
        f"/api/image-reviews/{doc['id']}/runs",
        headers=auth(),
        json={"request_id": str(uuid4()), "version": doc["version"], "images": images} | kw,
    )


def detail(c, doc):
    r = c.get(f"/api/image-reviews/{doc['id']}", headers=auth())
    assert r.status_code == 200, r.text
    return r.json()


def test_batch_replace_history_checks_and_no_images_saved(image_env):
    c, db, g = image_env
    d, images = create(c)
    r = run(c, d, images)
    assert r.status_code == 200, r.text
    d = detail(c, d)
    assert len(d["cards"]) == 2
    assert [x["card_id"] for x in d["cards"]] == ["one", "two"]
    assert d["connections_stale"] is False
    first = deepcopy(d["cards"][0])
    fid = first["result"]["findings"][0]["id"]
    assert (
        c.put(
            f"/api/image-reviews/{d['id']}/checks/{fid}", headers=auth(), json={"checked": True}
        ).status_code
        == 200
    )
    replacement = asset(color="blue", cid="one")
    r = run(c, d, [replacement, images[1]], target_card_id="one", previous_image=images[0])
    assert r.status_code == 200, r.text
    updated = detail(c, d)
    assert updated["version"] == 2
    assert updated["cards"][1] == d["cards"][1]
    assert updated["cards"][0]["sha256"] == replacement["sha256"]
    assert updated["cards"][0]["result"]["findings"][0]["checked"] is False
    assert updated["cards"][0]["result"]["resolutions"] == [
        {
            "finding_id": fid,
            "status": "resolved",
            "previous_finding": {"location": "상단 수식", "evidence": "E=F/q"},
        }
    ]
    assert updated["connections_stale"] is True
    versions = c.get(f"/api/image-reviews/{d['id']}/cards/one/versions", headers=auth()).json()
    assert [v["version"] for v in versions] == [2, 1]
    assert versions[1]["result"]["findings"][0]["checked"] is True
    assert "base64" not in repr(db.docs)
    assert len(g.calls) == 2


def test_ownership_replay_conflict_quota_and_size(image_env):
    c, db, g = image_env
    rid = str(uuid4())
    d, images = create(c, request_id=rid)
    assert create(c, request_id=rid)[0] == d
    for suffix in ("", "/cards/one/versions", "/runs/" + str(uuid4())):
        assert (
            c.get(f"/api/image-reviews/{d['id']}" + suffix, headers=auth("bob")).status_code == 404
        )
    assert c.get("/api/image-reviews", headers=auth("bob")).json() == []
    request_id = str(uuid4())
    a = run(c, d, images, request_id=request_id)
    assert a.status_code == 200, a.text
    assert run(c, d, images, request_id=request_id).json() == a.json()
    assert len(g.calls) == 1
    assert run(c, d, images, request_id=request_id, version=1).status_code == 409
    assert run(c, d, images).status_code == 409
    for _ in range(3):
        d = detail(c, d)
        assert run(c, d, images).status_code == 200
    assert run(c, detail(c, d), images).status_code == 429
    assert len(g.calls) == 4
    assert (
        c.post(
            "/api/image-reviews", headers=auth(), content=b" " * (16 * 1024 * 1024 + 1)
        ).status_code
        == 413
    )


@pytest.mark.parametrize("kind", ["missing", "duplicate", "unknown", "hash", "previous"])
def test_invalid_inputs_never_call_model(image_env, kind):
    c, db, g = image_env
    d, images = create(c)
    args = {}
    if kind == "missing":
        images = images[:1]
    if kind == "duplicate":
        images[1] = images[0]
    if kind == "unknown":
        images[0]["card_id"] = "fake"
    if kind == "hash":
        images[0]["sha256"] = "0" * 64
    if kind == "previous":
        args = {"target_card_id": "one", "previous_image": images[1]}
    assert run(c, d, images, **args).status_code == 422
    assert not g.calls


def test_model_failures_and_response_validation_preserve_old_version(image_env):
    c, db, g = image_env
    d, images = create(c)
    g.transform = lambda r: r | {"cards": r["cards"][:1]}
    r = run(c, d, images)
    assert r.status_code == 502
    assert detail(c, d)["version"] == 0
    assert not db.list("image_review_versions", "alice")
    g.transform = lambda r: r
    g.error = ValueError("unsupported image model")
    rid = str(uuid4())
    assert run(c, d, images, request_id=rid).status_code == 502
    status = c.get(f"/api/image-reviews/{d['id']}/runs/{rid}", headers=auth()).json()
    assert status["status"] == "failed"
    assert run(c, d, images, request_id=rid).status_code == 409
    assert len(g.calls) == 2


def test_ack_loss_concurrent_retry_and_stale_completion(image_env):
    c, db, g = image_env
    d, images = create(c)
    original = db.atomic
    lost = []

    def atomic(fn):
        result = original(fn)
        if fn.__name__ == "finish" and not lost:
            lost.append(True)
            raise OSError("lost ack")
        return result

    db.atomic = atomic
    rid = str(uuid4())
    original_review = g.review

    def review(*args):
        assert run(c, d, images, request_id=rid).status_code == 409
        return original_review(*args)

    g.review = review
    assert run(c, d, images, request_id=rid).status_code == 200
    assert len(g.calls) == 1
    assert detail(c, d)["version"] == 1


def test_fake_resolution_or_connection_card_is_rejected(image_env):
    c, _, g = image_env
    d, images = create(c)

    def invalid(r):
        r["cards"][0]["resolutions"] = [{"finding_id": "fake", "status": "resolved"}]
        return r

    g.transform = invalid
    assert run(c, d, images).status_code == 502


def test_stale_or_expired_completion_never_overwrites(image_env):
    c, db, g = image_env
    d, images = create(c)
    original = g.review

    def review(*args):
        result = original(*args)
        doc = db.get("image_reviews", d["id"])
        doc["version"] += 1
        db.set("image_reviews", d["id"], doc)
        return result

    g.review = review
    assert run(c, d, images).status_code == 409
    assert not db.list("image_review_versions", "alice")
    assert detail(c, d)["version"] == 1


def test_unknown_connection_and_expired_request_status(image_env):
    import time

    c, db, g = image_env
    d, images = create(c)

    def invalid(r):
        r["connections"][0]["card_ids"] = ["unknown"]
        return r

    g.transform = invalid
    rid = str(uuid4())
    assert run(c, d, images, request_id=rid).status_code == 502
    request = db.list("image_review_requests", "alice")[0]
    request.update(status="pending", expires_at=time.time() - 1)
    db.set("image_review_requests", request["id"], request)
    assert (
        c.get(f"/api/image-reviews/{d['id']}/runs/{rid}", headers=auth()).json()["status"]
        == "interrupted"
    )


def test_firestore_reads_before_writes_contract(image_env):
    c, db, _ = image_env
    original = db.atomic

    class Unit:
        def __init__(self):
            self.written = False

        def get(self, *a):
            assert not self.written, "Firestore read after write"
            return db.get(*a)

        def list(self, *a):
            assert not self.written, "Firestore read after write"
            return db.list(*a)

        def set(self, *a):
            self.written = True
            db.set(*a)

    db.atomic = lambda fn: original(lambda _: fn(Unit()))
    d, images = create(c)
    assert run(c, d, images).status_code == 200
    d = detail(c, d)
    fid = d["cards"][0]["result"]["findings"][0]["id"]
    assert (
        c.put(
            f"/api/image-reviews/{d['id']}/checks/{fid}", headers=auth(), json={"checked": True}
        ).status_code
        == 200
    )
