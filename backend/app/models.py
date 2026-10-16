from datetime import date as Date
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

Metric = Literal["views", "viewers", "interactions", "visits", "follows", "link_clicks"]
METRICS = ("views", "viewers", "interactions", "visits", "follows", "link_clicks")
Short = Annotated[str, Field(min_length=1, max_length=200)]
Text = Annotated[str, Field(min_length=1, max_length=4000)]
DocId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")]
Value = Annotated[int, Field(strict=True, ge=0, le=10**12)] | None


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class MetricInput(Input):
    date: Date
    metric: Metric = "views"
    value: Value
    memo: str = Field(default="", max_length=2000)


class MetricUpdate(Input):
    value: Value
    memo: str = Field(default="", max_length=2000)


class Performance(Input):
    """Per-post metrics the user copies from platform insights. Empty means unknown."""

    views: Value = None
    reach: Value = None
    likes: Value = None
    comments: Value = None
    saves: Value = None
    shares: Value = None


class ContentInput(Input):
    title: Short
    text: str = Field(min_length=1, max_length=20000)
    tags: list[Annotated[str, Field(min_length=1, max_length=40)]] = Field(
        default_factory=list, max_length=12
    )
    kind: Literal["manuscript", "review", "style"] = "manuscript"
    publication_status: Literal["unknown", "published", "unpublished"] = "unknown"
    published_at: Date | None = None
    source: str = Field(default="", max_length=1000)
    performance: Performance | None = None


class MessageInput(Input):
    role: Literal["user", "assistant"]
    content: Text


class ConversationInput(Input):
    title: Short
    messages: list[MessageInput] = Field(min_length=1, max_length=40)


class PreferenceInput(Input):
    instructions: str = Field(max_length=4000)
    confirmed: Literal[True]


class SeriesInput(PreferenceInput):
    title: Short


class Idea(Input):
    title: Short
    objective: Text
    prerequisites: str = Field(max_length=2000)
    relationship: str = Field(max_length=2000)
    reason: Text
    source_ids: list[DocId] = Field(max_length=5)


class Card(Input):
    title: Short
    body: Text
    formula: str = Field(max_length=2000)
    conditions: str = Field(max_length=2000)
    diagram: str = Field(max_length=2000)


class Quiz(Input):
    question: Text
    choices: list[Text] = Field(min_length=4, max_length=4)
    answer_index: int = Field(ge=0, le=3)
    explanation: Text
    choice_explanations: list[Text] = Field(min_length=4, max_length=4)


class Draft(Input):
    title: Short
    objective: Text
    cards: list[Card] = Field(min_length=4, max_length=10)
    quiz: Quiz
    review_items: list[Text] = Field(min_length=1, max_length=12)
    source_ids: list[DocId] = Field(max_length=5)


class GeneratedReply(Input):
    answer: Text
    source_ids: list[DocId] = Field(max_length=5)
    ideas: list[Idea] = Field(max_length=3)
    draft: Draft | None


class ChatInput(Input):
    request_id: UUID
    conversation_id: DocId | None = None
    mode: Literal["chat", "ideas", "draft"] = "chat"
    message: Text
    selected_content_ids: list[DocId] = Field(default_factory=list, max_length=5)
    series_id: DocId | None = None
    start: Date | None = None
    end: Date | None = None
    selected_idea: Idea | None = None
    card_count: int = Field(default=6, ge=4, le=10)

    @model_validator(mode="after")
    def validate_request(self):
        if bool(self.start) != bool(self.end):
            raise ValueError("시작일과 종료일을 함께 지정하세요.")
        if self.start and (self.end < self.start or (self.end - self.start).days > 365):
            raise ValueError("기간은 순서대로 최대 366일입니다.")
        if self.mode == "draft" and self.selected_idea is None:
            raise ValueError("원고로 만들 후보를 선택하세요.")
        return self


class DraftUpdate(Input):
    version: int = Field(ge=1)
    draft: Draft
    feedback: str = Field(default="", max_length=2000)


class ReviewInput(Input):
    version: int = Field(ge=1)
    confirmed: Literal[True]
