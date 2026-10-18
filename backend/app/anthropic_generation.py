import json

from anthropic import Anthropic
from fastapi import HTTPException

from .generation import REVIEW_SYSTEM, system_prompt, user_context
from .models import CardReviewReply, GeneratedReply

TOOL_NAME = "submit_reply"
# Forced tool use returns the reply as schema-shaped JSON. Models that reject forced
# tool_choice (Opus 5.5, Sonnet 5.5, Fable 5.1) are not supported by this path.
REPLY_TOOL = {
    "name": TOOL_NAME,
    "description": "요청 모드에 맞는 최종 응답을 제출합니다. 모든 응답은 이 도구로만 제출합니다.",
    "input_schema": GeneratedReply.model_json_schema(),
}


class AnthropicGenerator:
    def __init__(self, settings):
        self.settings = settings

    def revise(self, request, context):
        return self._generate(request, context, [], CardReviewReply, REVIEW_SYSTEM)

    def generate(self, request, context, history):
        return self._generate(request, context, history, GeneratedReply, system_prompt(context))

    def _generate(self, request, context, history, schema, prompt):
        if not self.settings.anthropic_api_key:
            raise HTTPException(503, "ANTHROPIC_API_KEY 설정이 필요합니다.")
        client = Anthropic(
            api_key=self.settings.anthropic_api_key,
            base_url=self.settings.anthropic_base_url or None,
            timeout=90,
            max_retries=0,
        )
        # Streaming keeps bytes flowing so gateways with ~60s idle limits don't cut long drafts.
        with client.messages.stream(
            model=self.settings.anthropic_model,
            max_tokens=self.settings.max_output_tokens,
            system=prompt,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_context(context, history)},
                        {
                            "type": "text",
                            "text": json.dumps(request.model_dump(mode="json"), ensure_ascii=False),
                        },
                    ],
                }
            ],
            tools=[REPLY_TOOL | {"input_schema": schema.model_json_schema()}],
            tool_choice={"type": "tool", "name": TOOL_NAME},
        ) as stream:
            response = stream.get_final_message()
        if response.stop_reason not in ("tool_use", "end_turn"):
            raise ValueError("Incomplete or refused generation")
        block = next(
            (b for b in response.content if b.type == "tool_use" and b.name == TOOL_NAME), None
        )
        if block is None:
            raise ValueError("Incomplete or refused generation")
        return schema.model_validate(block.input).model_dump(mode="json", exclude_unset=True)
