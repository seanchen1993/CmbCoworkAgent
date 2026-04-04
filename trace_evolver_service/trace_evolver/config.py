from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, Field


def _load_dotenv() -> None:
    """Best-effort .env loading without extra dependency."""
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if not key:
            continue
        os.environ.setdefault(key, value)


_load_dotenv()


class LLMSettings(BaseModel):
    base_url: str = Field(
        default_factory=lambda: os.environ.get(
            "TRACE_EVOLVER_LLM_BASE_URL",
            "https://api.minimaxi.com/v1",
        )
    )
    api_key: str = Field(
        default_factory=lambda: os.environ.get("TRACE_EVOLVER_LLM_API_KEY", "")
    )
    model: str = Field(
        default_factory=lambda: os.environ.get(
            "TRACE_EVOLVER_LLM_MODEL",
            "MiniMax-M2.7",
        )
    )
    temperature: float = 0.3
    max_tokens: int = 4096
    context_window_tokens: int = 128_000
    system_reserve_tokens: int = 8_000
    trace_budget_tokens: int = 24_000
    output_reserve_tokens: int = 12_000
    markdown_soft_cap_tokens: int = 60_000
    markdown_hard_cap_tokens: int = 80_000

    @property
    def markdown_soft_budget_tokens(self) -> int:
        available = max(
            8_000,
            self.context_window_tokens - self.system_reserve_tokens - self.trace_budget_tokens - self.output_reserve_tokens,
        )
        return max(8_000, min(self.markdown_soft_cap_tokens, int(available * 0.75)))

    @property
    def markdown_hard_budget_tokens(self) -> int:
        available = max(
            12_000,
            self.context_window_tokens - self.system_reserve_tokens - self.trace_budget_tokens - self.output_reserve_tokens,
        )
        return max(self.markdown_soft_budget_tokens, min(self.markdown_hard_cap_tokens, available))


class Settings(BaseModel):
    state_dir: Path = Field(
        default_factory=lambda: Path(
            os.environ.get(
                "TRACE_EVOLVER_STATE_DIR",
                str(Path.cwd() / ".trace-evolver-state"),
            )
        ).resolve()
    )
    sqlite_filename: str = "trace_evolver.sqlite"
    default_model_profile: str = "default"
    markdown_react_max_turns: int = 3
    markdown_react_max_files: int = 4
    markdown_react_max_token_budget: int = 12_000
    markdown_patch_planning_max_rounds: int = 2
    family_similarity_threshold: float = 0.35
    episode_gap_minutes: int = 30
    host: str = "127.0.0.1"
    port: int = 8017
    log_level: str = "info"
    llm: LLMSettings = Field(default_factory=LLMSettings)

    @property
    def sqlite_path(self) -> Path:
        return self.state_dir / self.sqlite_filename


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    settings = Settings()
    settings.state_dir.mkdir(parents=True, exist_ok=True)
    return settings
