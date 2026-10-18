from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

Key = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")]
Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
Category = Literal["error", "uncertain", "improvement"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CardMeta(StrictModel):
    card_id: Key
    name: str = Field(min_length=1, max_length=200)
    sha256: Digest


class ReviewImage(CardMeta):
    mime: Literal["image/png", "image/jpeg", "image/webp"]
    base64: str = Field(min_length=4, max_length=1_398_104)


class ReviewCreate(StrictModel):
    request_id: UUID
    title: str = Field(min_length=1, max_length=120)
    cards: list[CardMeta] = Field(min_length=1, max_length=10)
    criteria: str = Field(default="", max_length=1000)

    @model_validator(mode="after")
    def unique_cards(self):
        if len({c.card_id for c in self.cards}) != len(self.cards):
            raise ValueError("카드 ID가 중복되었습니다.")
        return self


class RunInput(StrictModel):
    request_id: UUID
    version: int = Field(ge=0, strict=True)
    target_card_id: Key | None = None
    images: list[ReviewImage] = Field(min_length=1, max_length=10)
    previous_image: ReviewImage | None = None


class Finding(StrictModel):
    category: Category
    location: str = Field(min_length=1, max_length=160)
    evidence: str = Field(min_length=1, max_length=500)
    reason: str = Field(min_length=1, max_length=700)
    suggestion: str = Field(min_length=1, max_length=700)


class Resolution(StrictModel):
    finding_id: Key
    status: Literal["resolved", "remaining", "uncertain"]


class CardResult(StrictModel):
    card_id: Key
    summary: str = Field(min_length=1, max_length=500)
    findings: list[Finding] = Field(max_length=5)
    resolutions: list[Resolution] = Field(max_length=5)


class Connection(Finding):
    card_ids: list[Key] = Field(min_length=1, max_length=10)


class ReviewReply(StrictModel):
    cards: list[CardResult] = Field(min_length=1, max_length=10)
    connections: list[Connection] = Field(max_length=5)


class CheckInput(StrictModel):
    checked: bool = Field(strict=True)
