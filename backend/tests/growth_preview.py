"""Synthetic local browser fixture. Not a deployment entry point."""

from datetime import datetime, timedelta, timezone

from app.buffer_client import normalize_post
from app.main import create_app
from app.repository import create, identity

from .preview import PreviewGenerator, store
from .test_buffer import raw_post
from .test_chat import idea, reply
from .test_image_review_transport import asset
from .test_image_reviews import Reviewer


class SyntheticPostReader:
    def read(self, images, context):
        return {
            "title": "전기장과 전위의 차이",
            "summary": "합성 이미지: 등전위면을 따라 움직일 때 전기장이 있어도 전위차는 0이다.",
            "topics": ["전기장", "전위", "등전위면"],
            "pages": [
                {
                    "card_id": cid,
                    "text": "등전위면에서 전위차는 0",
                    "description": "합성 카드",
                    "legible": True,
                }
                for cid in context["card_order"]
            ],
        }


def synthetic_post_images(post):
    from app.post_media import image_sources

    return [asset(cid=f"page-{i}") for i, _ in image_sources(post)[:10]]


class SyntheticBuffer:
    def fetch(self):
        now = datetime.now(timezone.utc)
        posts = []
        for i in range(15):
            r = raw_post(f"synthetic{i}", follows=i + 2 if i < 12 else None)
            r["sentAt"] = (
                (now - timedelta(days=i + 10))
                .replace(hour=10 if i % 2 else 13, minute=0, second=0)
                .isoformat()
            )
            r["metricsUpdatedAt"] = now.isoformat()
            r["text"] = f"합성 자료 {i + 1} · 전기장과 전위, 한 장으로 이해하기"
            if i >= 12:
                r["metadata"]["type"] = "reel"
                r["assets"] = r["assets"][:1]
            posts.append(normalize_post(r))
        return {
            "channel": {
                "id": "channel",
                "name": "합성 자료 · 테스트 계정",
                "service": "instagram",
                "timezone": "Asia/Seoul",
                "postingSchedule": [],
            },
            "posts": posts,
        }


class SyntheticGrowth(PreviewGenerator):
    def generate(self, request, context, history):
        if request.mode != "growth":
            return super().generate(request, context, history)
        g = context["growth"]
        stats = g["summary"]["formats"][g["format"]]
        if any(
            word in request.message for word in ("초안", "재활용", "시리즈", "GPT", "퀴즈", "비교")
        ):
            return reply() | {
                "answer": "합성 테스트: 기존 게시물의 전기장·전위 설명과 비교해 새 적용 문제로 구성했어요.",
                "source_ids": [s["id"] for s in context["sources"]],
                "work_text": "후속 카드뉴스 초안\n1. 전기장은 있는데 전위차는 왜 0일까?\n2. 등전위면을 따라 움직이는 상황\n3. 이동 방향과 일의 관계\n4. 정답 확인 퀴즈",
            }
        if "콘텐츠" in request.message:
            source_ids = [context["sources"][0]["id"], g["content_history"][-1]["id"]]
            return reply() | {
                "answer": "합성 테스트 응답입니다. 다음에는 전기장과 전위의 차이를 문제로 묻는 카드뉴스를 추천해요. 기존 개념 설명에서 일상적인 오개념을 푸는 방식으로 확장해요.",
                "ideas": [
                    idea()
                    | {
                        "title": "전기장은 있는데 전위차는 왜 0일까?",
                        "objective": "첫 장: 전기장은 있는데 전위차는 0? → 등전위면 예시 → 이동 방향과 일의 관계 → 마지막에 정답 확인 퀴즈",
                        "reason": "기존 전기장·전위 캡션을 바탕으로, 두 개념을 구분하는 상황 문제를 새로 제안해요.",
                        "relationship": "개념 설명 다음에 적용 문제로 확장해요.",
                        "source_ids": source_ids,
                    }
                ],
                "source_ids": source_ids,
            }
        return reply() | {
            "answer": f"합성 테스트 응답입니다. 같은 형식의 팔로우 유효 관측은 {stats['follows_count']}개예요. 아래 시간 후보는 실제로 선택한 가능한 시간에서 계산했어요. 이번에는 주제를 유지하고 게시 시간 하나만 시험해 보세요. 관측 차이가 시간 효과를 입증하지는 않아요.",
            "source_ids": [s["id"] for s in context["sources"]],
        }


for record in store.list("data", "alice"):
    store.set("data", record["id"], record | {"source": "imported"})

for i in range(120):
    day = str((datetime.now(timezone.utc) - timedelta(days=119 - i)).date())
    create(
        store,
        "data",
        "alice",
        {
            "date": day,
            "metric": "follows",
            "value": 20 + i % 13,
            "memo": "합성 시계열",
            "source": "imported",
        },
        identity("alice", day + "_follows"),
        skip=True,
    )

from app.config import Settings  # noqa: E402

app = create_app(
    Settings(
        allowed_user_uids=("alice",),
        allowed_origins=("http://127.0.0.1:18101",),
        llm_provider="anthropic",
        anthropic_api_key="synthetic-only",
        buffer_api_key="synthetic-only",
        buffer_channel_id="channel",
        buffer_owner_uid="alice",
        daily_request_limit=100,
    ),
    store=store,
    verify_token=lambda t: {"uid": t},
    generator=PreviewGenerator(),
    growth_generator=SyntheticGrowth(),
    buffer_client=SyntheticBuffer(),
    image_reviewer=Reviewer(),
    post_reader=SyntheticPostReader(),
    post_downloader=synthetic_post_images,
)
