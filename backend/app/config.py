import os
from dataclasses import dataclass

from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    allowed_user_uids: tuple[str, ...] = ()
    allowed_origins: tuple[str, ...] = ("http://localhost:3000",)
    firebase_service_account_json: str = ""
    llm_provider: str = "openai"
    openai_api_key: str = ""
    openai_model: str = "gpt-6.1-sol"
    anthropic_api_key: str = ""
    anthropic_base_url: str = ""
    anthropic_model: str = "claude-sonnet-4"
    max_output_tokens: int = 4000
    daily_request_limit: int = 30

    @property
    def generator_configured(self):
        if self.llm_provider == "anthropic":
            return bool(self.anthropic_api_key)
        return bool(self.openai_api_key)

    @classmethod
    def from_env(cls):
        load_dotenv()

        def csv(name, default=""):
            return tuple(s.strip() for s in os.getenv(name, default).split(",") if s.strip())

        provider = os.getenv("LLM_PROVIDER", "openai").strip().lower()
        if provider not in ("openai", "anthropic"):
            raise ValueError("LLM_PROVIDER must be openai or anthropic")

        return cls(
            llm_provider=provider,
            anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", ""),
            anthropic_base_url=os.getenv("ANTHROPIC_BASE_URL", ""),
            anthropic_model=os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4"),
            allowed_user_uids=csv("ALLOWED_USER_UIDS"),
            allowed_origins=csv("ALLOWED_ORIGINS", "http://localhost:3000"),
            firebase_service_account_json=os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", ""),
            openai_api_key=os.getenv("OPENAI_API_KEY", ""),
            openai_model=os.getenv("OPENAI_MODEL", "gpt-6.1-sol"),
            max_output_tokens=max(256, min(8000, int(os.getenv("MAX_OUTPUT_TOKENS", "4000")))),
            daily_request_limit=max(1, min(100, int(os.getenv("DAILY_REQUEST_LIMIT", "30")))),
        )
