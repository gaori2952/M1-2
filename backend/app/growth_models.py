from datetime import date
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class GrowthInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class GrowthOptions(GrowthInput):
    format: Literal["carousel", "reel", "post", "story"] = "carousel"
    topic: str = Field(default="", max_length=300)
    slots: list[AwareDatetime] = Field(default_factory=list, max_length=14)
    observation_mode: Literal["lifetime", "seven_day"] = "lifetime"


class SyncInput(GrowthInput):
    request_id: UUID


class PreviewInput(SyncInput):
    options: GrowthOptions


Count = Annotated[int, Field(strict=True, ge=0, le=10**12)]


class AnnotationInput(GrowthInput):
    tags: list[Annotated[str, Field(min_length=1, max_length=60)]] = Field(
        default_factory=list, max_length=12
    )
    memo: str = Field(default="", max_length=2000)
    manual_follows: Count | None = None
    manual_reach: Count | None = None
    manual_observed_on: date | None = None


class ExperimentInput(SyncInput):
    candidate_id: str = Field(min_length=1, max_length=100)


class ExperimentUpdate(GrowthInput):
    post_id: str | None = Field(default=None, min_length=1, max_length=200)
    memo: str = Field(default="", max_length=2000)
    cancelled: bool = False


class CsvInput(GrowthInput):
    csv_text: str = Field(min_length=1, max_length=2 * 1024 * 1024)
