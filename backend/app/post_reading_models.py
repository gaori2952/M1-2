from typing import Annotated
from uuid import UUID

from pydantic import Field, model_validator

from .image_review_models import StrictModel


class ReadPostInput(StrictModel):
    request_id: UUID
    post_id: str = Field(min_length=1, max_length=200)


class ReadingPage(StrictModel):
    card_id: str = Field(min_length=1, max_length=64)
    text: str = Field(max_length=600)
    description: str = Field(max_length=300)
    legible: bool = Field(strict=True)

    @model_validator(mode="after")
    def no_unread_text(self):
        if not self.legible:
            self.text = ""
        return self


class PostReadingReply(StrictModel):
    title: str = Field(min_length=1, max_length=160)
    summary: str = Field(max_length=1000)
    topics: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(max_length=20)
    pages: list[ReadingPage] = Field(min_length=1, max_length=10)

    @model_validator(mode="after")
    def unique_pages(self):
        if len({p.card_id for p in self.pages}) != len(self.pages):
            raise ValueError("Duplicate page IDs")
        return self
