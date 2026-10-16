from copy import deepcopy
from uuid import uuid4

import pytest
from app.config import Settings
from app.main import create_app
from fastapi.testclient import TestClient

from .memory_store import MemoryStore
from .test_core import auth


def reply():
    return {
        "answer": "근거가 제한되어 있어요. 초안으로 검토해 주세요.",
        "source_ids": [],
        "ideas": [],
        "draft": None,
    }


def idea():
    return {
        "title": "전기장 후속",
        "objective": "전기장을 이해한다",
        "prerequisites": "벡터",
        "relationship": "후속 제안",
        "reason": "개념 연결",
        "source_ids": [],
    }


def draft():
    return {
        "title": idea()["title"],
        "objective": idea()["objective"],
        "cards": [
            {
                "title": f"카드 {i}",
                "body": "내용",
                "formula": "E",
                "conditions": "조건",
                "diagram": "화살표",
            }
            for i in range(6)
        ],
        "quiz": {
            "question": "전기장은?",
            "choices": ["A", "B", "C", "D"],
            "answer_index": 0,
            "explanation": "설명",
            "choice_explanations": ["정답", "이유", "이유", "이유"],
        },
        "review_items": ["수식과 조건 확인"],
        "source_ids": [],
    }


class Generator:
    def __init__(self):
        self.calls = []
        self.result = reply()
        self.error = None

    def generate(self, request, context, history):
        self.calls.append((request, deepcopy(context), deepcopy(history)))
        if self.error:
            raise self.error
        return self.result


@pytest.fixture
def chat_env():
    db = MemoryStore()
    g = Generator()
    app = create_app(
        Settings(allowed_user_uids=("alice", "bob"), daily_request_limit=3),
        store=db,
        verify_token=lambda t: {"uid": t},
        generator=g,
    )
    return TestClient(app), db, g


def ask(c, **kwargs):
    return c.post(
        "/api/chat",
        headers=auth(),
        json={"request_id": str(uuid4()), "message": "다음 콘텐츠 추천"} | kwargs,
    )


def test_context_save_replay_and_owner(chat_env):
    c, db, g = chat_env
    c.post("/api/data", headers=auth(), json={"date": "2026-10-01", "value": 15})
    assert (
        c.put(
            "/api/profile",
            headers=auth(),
            json={"instructions": "짧고 쉽게", "confirmed": True},
        ).status_code
        == 200
    )
    source = c.post(
        "/api/contents",
        headers=auth(),
        json={"title": "전자기학", "text": "<script>evil</script>", "tags": []},
    ).json()
    rid = str(uuid4())
    r = ask(c, request_id=rid, selected_content_ids=[source["id"]])
    assert r.status_code == 200, r.text
    result = r.json()
    cid = result["conversation_id"]
    assert g.calls[0][1]["summary"]["metrics"]["views"]["max"] == 15
    assert g.calls[0][1]["profile"]["instructions"] == "짧고 쉽게"
    assert g.calls[0][1]["sources"][0]["id"] == source["id"]
    assert ask(c, request_id=rid, selected_content_ids=[source["id"]]).json() == result
    assert len(g.calls) == 1
    assert ask(c, request_id=rid, message="다른 내용").status_code == 409
    assert c.get("/api/conversations/" + cid, headers=auth("bob")).status_code == 404
    assert ask(c, conversation_id=cid).status_code == 200
    messages = c.get("/api/conversations/" + cid, headers=auth()).json()["messages"]
    assert [m["role"] for m in messages] == ["user", "assistant", "user", "assistant"]
    assert len(g.calls[1][2]) == 2
    assert c.delete("/api/conversations/" + cid, headers=auth()).status_code == 204
    assert ask(c, request_id=rid, selected_content_ids=[source["id"]]).status_code == 410
    assert not db.list(f"conversations/{cid}/messages", "alice")


@pytest.mark.parametrize(
    "bad",
    [
        {"answer": "ok", "source_ids": ["fake"], "ideas": [], "draft": None},
        {"answer": "ok", "source_ids": [], "ideas": [idea()], "draft": None},
        {"broken": True},
    ],
)
def test_bad_generation_is_not_saved(chat_env, bad):
    c, db, g = chat_env
    g.result = bad
    r = ask(c, mode="ideas")
    assert r.status_code == 502
    assert c.get("/api/conversations", headers=auth()).json() == []


def test_quota_and_failed_requests_do_not_auto_retry(chat_env):
    c, db, g = chat_env
    g.error = TimeoutError()
    rid = str(uuid4())
    assert ask(c, request_id=rid).status_code == 502
    assert ask(c, request_id=rid).status_code == 409
    assert len(g.calls) == 1
    ask(c)
    ask(c)
    assert ask(c).status_code == 429
    assert len(g.calls) == 3


def test_draft_edit_conflict_feedback_and_confirmed_preferences(chat_env):
    c, db, g = chat_env
    g.result = reply() | {"draft": draft()}
    r = ask(c, mode="draft", selected_idea=idea())
    assert r.status_code == 200, r.text
    did = r.json()["draft_id"]
    d = c.get("/api/drafts/" + did, headers=auth()).json()
    assert d["version"] == 1 and d["status"] == "draft"
    revised = draft()
    revised["cards"][0]["body"] = "짧게 수정"
    body = {"version": 1, "draft": revised, "feedback": "짧게 써줘"}
    assert c.put("/api/drafts/" + did, headers=auth("bob"), json=body).status_code == 404
    saved = c.put("/api/drafts/" + did, headers=auth(), json=body)
    assert saved.status_code == 200 and saved.json()["version"] == 2
    assert c.put("/api/drafts/" + did, headers=auth(), json=body).status_code == 409
    assert c.get("/api/profile", headers=auth()).json()["instructions"] == ""
    assert len(db.list("feedback", "alice")) == 1
    assert (
        c.put(
            "/api/profile",
            headers=auth(),
            json={"instructions": "짧게", "confirmed": False},
        ).status_code
        == 422
    )
    assert (
        c.post(
            "/api/drafts/" + did + "/review",
            headers=auth(),
            json={"version": 2, "confirmed": True},
        ).json()["status"]
        == "reviewed"
    )


def test_foreign_sources_rejected_before_model(chat_env):
    c, db, g = chat_env
    other = c.post(
        "/api/contents", headers=auth("bob"), json={"title": "비밀", "text": "비밀"}
    ).json()
    assert ask(c, selected_content_ids=[other["id"]]).status_code == 404
    assert not g.calls


def test_simultaneous_duplicate_has_one_model_call(chat_env):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    c, db, g = chat_env
    entered = Event()
    release = Event()
    original = g.generate

    def blocked(*args):
        entered.set()
        release.wait(5)
        return original(*args)

    g.generate = blocked
    rid = str(uuid4())
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(ask, c, request_id=rid)
        assert entered.wait(3)
        assert ask(c, request_id=rid).status_code == 409
        release.set()
        assert first.result().status_code == 200
    assert len(g.calls) == 1
    assert ask(c, request_id=rid).status_code == 200
    assert len(g.calls) == 1


def test_storage_failure_leaves_no_success_messages(chat_env):
    c, db, g = chat_env
    original = db.set

    def broken(collection, key, value):
        if "/messages" in collection:
            raise OSError("storage down")
        original(collection, key, value)

    db.set = broken
    assert ask(c).status_code == 502
    assert not any("/messages" in key[0] for key in db.docs)
    assert c.get("/api/conversations", headers=auth()).json() == []


def test_series_context_and_wrong_draft_shape(chat_env):
    c, db, g = chat_env
    series = c.post(
        "/api/series",
        headers=auth(),
        json={"title": "입문", "instructions": "비유 먼저", "confirmed": True},
    ).json()
    assert ask(c, series_id=series["id"]).status_code == 200
    assert g.calls[-1][1]["series"]["instructions"] == "비유 먼저"
    changed = draft()
    changed["title"] = "모델이 바꾼 제목"
    g.result = reply() | {"draft": changed}
    assert ask(c, mode="draft", selected_idea=idea()).status_code == 502
    changed = draft()
    changed["cards"] = changed["cards"][:4]
    g.result = reply() | {"draft": changed}
    assert ask(c, mode="draft", selected_idea=idea()).status_code == 502
