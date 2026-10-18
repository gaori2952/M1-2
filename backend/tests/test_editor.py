from copy import deepcopy
from uuid import uuid4

import pytest

from .test_chat import ask, draft, idea, reply
from .test_core import auth

pytest_plugins = ["tests.test_chat"]


def setup_editor(env):
    c, db, g = env
    g.result = reply() | {"draft": draft()}
    did = ask(c, mode="draft", selected_idea=idea()).json()["draft_id"]
    calls = []

    def revise(request, context):
        calls.append(request)
        cards = []
        for i in request.card_indices:
            card = deepcopy(context["draft"]["cards"][i])
            card.update(title="바뀌면 안 되는 제목", body="수정한 설명", diagram="수정한 도식")
            cards.append({"card_index": i, "card": card, "findings": ["조건을 명시하세요."]})
        return {"summary": "검토 제안입니다.", "cards": cards}

    g.revise = revise
    return c, db, g, did, calls


def propose(c, did, **kw):
    return c.post(
        f"/api/drafts/{did}/proposals",
        headers=auth(),
        json={
            "request_id": str(uuid4()),
            "version": 1,
            "card_indices": [1, 3],
            "fields": ["body"],
            "instruction": "설명을 고쳐줘",
        }
        | kw,
    )


def test_proposal_is_preview_and_apply_preserves_everything_outside_mask(chat_env):
    c, db, g, did, calls = setup_editor(chat_env)
    before = c.get(f"/api/drafts/{did}", headers=auth()).json()
    r = propose(c, did)
    assert r.status_code == 200, r.text
    p = r.json()
    assert c.get(f"/api/drafts/{did}", headers=auth()).json() == before
    saved = c.post(
        f"/api/drafts/{did}/proposals/{p['id']}/apply",
        headers=auth(),
        json={"version": 1, "card_indices": [1]},
    )
    assert saved.status_code == 200, saved.text
    after = saved.json()
    expected = deepcopy(before["draft"])
    expected["cards"][1]["body"] = "수정한 설명"
    assert after["draft"] == expected
    assert after["version"] == 2
    # Exact retry recovers the committed result without creating a revision twice.
    assert (
        c.post(
            f"/api/drafts/{did}/proposals/{p['id']}/apply",
            headers=auth(),
            json={"version": 1, "card_indices": [1]},
        ).json()
        == after
    )
    assert len(db.list("feedback", "alice")) == 1
    assert len(calls) == 1


def test_proposal_replay_conflict_owner_and_quota(chat_env):
    c, db, g, did, calls = setup_editor(chat_env)
    rid = str(uuid4())
    p = propose(c, did, request_id=rid)
    assert p.status_code == 200, p.text
    assert propose(c, did, request_id=rid).json() == p.json()
    assert propose(c, did, request_id=rid, instruction="다른 지시").status_code == 409
    assert c.get(f"/api/drafts/{did}/proposals", headers=auth("bob")).status_code == 404
    assert propose(c, did).status_code == 200
    assert propose(c, did).status_code == 429
    assert len(calls) == 2


def test_stale_proposal_does_not_overwrite_and_restore_only_one_card(chat_env):
    c, db, g, did, _ = setup_editor(chat_env)
    p = propose(c, did).json()
    d = draft()
    d["cards"][0]["body"] = "다른 카드 수정"
    d["cards"][1]["body"] = "내 수정"
    assert (
        c.put(f"/api/drafts/{did}", headers=auth(), json={"version": 1, "draft": d}).status_code
        == 200
    )
    assert (
        c.post(
            f"/api/drafts/{did}/proposals/{p['id']}/apply",
            headers=auth(),
            json={"version": 1, "card_indices": [1]},
        ).status_code
        == 409
    )
    revisions = c.get(f"/api/drafts/{did}/revisions", headers=auth()).json()
    assert len(revisions) == 1
    restored = c.post(
        f"/api/drafts/{did}/restore",
        headers=auth(),
        json={
            "version": 2,
            "revision_id": revisions[0]["id"],
            "card_index": 1,
        },
    )
    assert restored.status_code == 200, restored.text
    d["cards"][1] = draft()["cards"][1]
    assert restored.json()["draft"] == d
    assert restored.json()["version"] == 3


@pytest.mark.parametrize(
    "patch",
    [
        {"card_indices": [10]},
        {"card_indices": [1, 1]},
        {"card_indices": []},
        {"fields": ["layout"]},
        {"fields": []},
        {"version": 9},
    ],
)
def test_invalid_edit_selection_never_calls_model(chat_env, patch):
    c, db, g, did, calls = setup_editor(chat_env)
    assert propose(c, did, **patch).status_code in (409, 422)
    assert not calls


def test_import_and_drawing_validation(chat_env):
    c, _, _, _, _ = setup_editor(chat_env)
    r = c.post("/api/drafts", headers=auth(), json={"request_id": str(uuid4()), "draft": draft()})
    assert r.status_code == 201, r.text
    d = draft()
    d["cards"][0]["artwork"] = [
        {"kind": "script", "x": 0, "y": 0, "x2": 100, "y2": 100, "text": ""}
    ]
    assert (
        c.post(
            "/api/drafts", headers=auth(), json={"request_id": str(uuid4()), "draft": d}
        ).status_code
        == 422
    )


def test_model_cannot_add_unselected_card(chat_env):
    c, db, g, did, _ = setup_editor(chat_env)
    g.revise = lambda *a: {
        "summary": "oops",
        "cards": [{"card_index": 0, "card": draft()["cards"][0], "findings": []}],
    }
    assert propose(c, did).status_code == 502
    assert c.get(f"/api/drafts/{did}", headers=auth()).json()["version"] == 1


def test_generation_ack_loss_and_simultaneous_retry_are_safe(chat_env):
    c, db, g, did, calls = setup_editor(chat_env)
    atomic = db.atomic
    lost = []

    def ambiguous(fn):
        result = atomic(fn)
        if fn.__name__ == "finish" and not lost:
            lost.append(True)
            raise OSError("ack lost")
        return result

    db.atomic = ambiguous
    rid = str(uuid4())
    response = propose(c, did, request_id=rid)
    assert response.status_code == 200, response.text
    assert propose(c, did, request_id=rid).json() == response.json()
    assert len(calls) == 1


def test_owner_and_field_mask_preserve_style_quiz_and_diagram(chat_env):
    c, db, g, did, _ = setup_editor(chat_env)
    doc = c.get(f"/api/drafts/{did}", headers=auth()).json()
    doc["style"] = {"brand": "MY BRAND", "accent": "green", "paper": "warm"}
    doc["draft"]["cards"][1]["artwork"] = [
        {"kind": "arrow", "x": 100, "y": 100, "x2": 300, "y2": 100, "text": ""}
    ]
    db.set("drafts", did, doc)
    p = propose(c, did).json()
    body = {"version": 1, "card_indices": [1]}
    assert (
        c.post(
            f"/api/drafts/{did}/proposals/{p['id']}/apply", headers=auth("bob"), json=body
        ).status_code
        == 404
    )
    response = c.post(f"/api/drafts/{did}/proposals/{p['id']}/apply", headers=auth(), json=body)
    assert response.status_code == 200
    new = response.json()
    assert new["style"] == doc["style"]
    assert new["draft"]["quiz"] == doc["draft"]["quiz"]
    assert new["draft"]["cards"][1]["artwork"] == doc["draft"]["cards"][1]["artwork"]
    revision = c.get(f"/api/drafts/{did}/revisions", headers=auth()).json()[0]
    assert c.get(f"/api/drafts/{did}/revisions", headers=auth("bob")).status_code == 404
    assert (
        c.post(
            f"/api/drafts/{did}/restore",
            headers=auth("bob"),
            json={"version": 2, "card_index": 1, "revision_id": revision["id"]},
        ).status_code
        == 404
    )


def test_proposal_fails_if_draft_changed_while_model_runs(chat_env):
    c, db, g, did, _ = setup_editor(chat_env)
    original = g.revise

    def concurrent(request, context):
        doc = db.get("drafts", did)
        doc["version"] += 1
        doc["draft"]["cards"][1]["body"] = "동시에 저장한 내 원고"
        db.set("drafts", did, doc)
        return original(request, context)

    g.revise = concurrent
    assert propose(c, did).status_code == 409
    assert db.get("drafts", did)["draft"]["cards"][1]["body"] == "동시에 저장한 내 원고"
