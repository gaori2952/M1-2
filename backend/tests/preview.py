"""Local E2E fixture only. Never use this app as a deployment entry point."""

from datetime import date, timedelta

from app.config import Settings
from app.main import create_app
from app.repository import create, identity

from .memory_store import MemoryStore
from .test_chat import draft, idea, reply


class PreviewGenerator:
    def generate(self, request, context, history):
        sources = [s["id"] for s in context["sources"]]
        if request.mode == "ideas":
            titles = [
                "전기장과 전위, 무엇이 다를까?",
                "가우스 법칙을 쓰기 좋은 순간",
                "축전기는 어떻게 에너지를 저장할까?",
            ]
            return reply() | {
                "answer": "참고 원고를 바탕으로 만든 후속 주제 후보예요. 과학적 정확성은 검토해 주세요.",
                "source_ids": sources,
                "ideas": [idea() | {"title": t, "source_ids": sources} for t in titles],
            }
        if request.mode == "draft":
            d = draft()
            d["title"] = request.selected_idea.title
            d["objective"] = request.selected_idea.objective
            d["cards"] = (d["cards"] * 2)[: request.card_count]
            d["source_ids"] = sources
            return reply() | {
                "answer": "선택한 주제로 카드뉴스와 퀴즈 초안을 준비했어요.",
                "source_ids": sources,
                "draft": d,
            }
        count = context["summary"]["metrics"].get("views", {}).get("count", 0)
        return reply() | {
            "answer": f"선택 기간 조회수의 유효 관측은 {count}개예요. 계정 단위 지표이므로 특정 게시물의 성과는 확인할 수 없어요. 다음 콘텐츠는 기존 원고의 후속 개념으로 기획해 보세요.",
            "source_ids": sources,
        }


store = MemoryStore()
for i in range(120):
    day = str(date(2026, 6, 18) + timedelta(days=i))
    create(
        store,
        "data",
        "alice",
        {
            "date": day,
            "metric": "views",
            "value": 1000 + i * 17 + (i % 7) * 100,
            "memo": "합성 테스트 데이터",
        },
        identity("alice", day + "_views"),
    )
create(
    store,
    "contents",
    "alice",
    {
        "title": "전자기학 01 · 전기장을 읽는 법",
        "text": "합성 테스트 원고: 전기장은 단위 양전하가 받는 힘으로 정의한다. 다음 편에서는 전위와 연결해 설명한다.",
        "tags": ["전자기학", "전기장"],
        "kind": "manuscript",
        "publication_status": "unknown",
        "review_status": "unverified",
        "source": "E2E 합성 자료",
    },
)
app = create_app(
    Settings(
        allowed_user_uids=("alice",),
        allowed_origins=("http://127.0.0.1:18101",),
        daily_request_limit=100,
    ),
    store=store,
    verify_token=lambda token: {"uid": token},
    generator=PreviewGenerator(),
)
