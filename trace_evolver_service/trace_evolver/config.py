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


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


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
    # 默认不向服务端显式传 max_tokens，避免推理模型在输出 JSON 前被本地上限截断。
    max_tokens: int | None = None
    context_window_tokens: int = 128_000
    system_reserve_tokens: int = 8_000
    trace_budget_tokens: int = 24_000
    output_reserve_tokens: int = 12_000
    markdown_soft_cap_tokens: int = 60_000
    markdown_hard_cap_tokens: int = 80_000
    max_message_chars: int = Field(
        default_factory=lambda: _env_int("TRACE_EVOLVER_LLM_MAX_MESSAGE_CHARS", 60_000)
    )

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
    error_analyst_react_max_reads: int = 3
    error_analyst_max_markdown_reads: int = 2
    error_analyst_max_artifact_reads: int = 1
    llm_max_trace_chars: int = Field(
        default_factory=lambda: _env_int("TRACE_EVOLVER_LLM_MAX_TRACE_CHARS", 24_000)
    )
    llm_max_skill_file_chars: int = Field(
        default_factory=lambda: _env_int("TRACE_EVOLVER_LLM_MAX_SKILL_FILE_CHARS", 50_000)
    )
    llm_max_visible_file_chars: int = Field(
        default_factory=lambda: _env_int("TRACE_EVOLVER_LLM_MAX_VISIBLE_FILE_CHARS", 50_000)
    )
    llm_max_artifact_lines: int = Field(
        default_factory=lambda: _env_int("TRACE_EVOLVER_LLM_MAX_ARTIFACT_LINES", 200)
    )
    llm_max_artifact_chars: int = Field(
        default_factory=lambda: _env_int("TRACE_EVOLVER_LLM_MAX_ARTIFACT_CHARS", 20_000)
    )
    llm_max_tool_message_chars: int = Field(
        default_factory=lambda: _env_int("TRACE_EVOLVER_LLM_MAX_TOOL_MESSAGE_CHARS", 30_000)
    )
    llm_max_merge_prompt_chars: int = Field(
        default_factory=lambda: _env_int("TRACE_EVOLVER_LLM_MAX_MERGE_PROMPT_CHARS", 50_000)
    )
    family_similarity_threshold: float = 0.35
    episode_gap_minutes: int = 30
    enable_episode_route_classifier: bool = True
    episode_route_confidence_threshold: float = 0.75
    episode_route_max_traces: int = 3
    episode_route_user_chars: int = 500
    episode_route_assistant_chars: int = 700
    episode_route_error_chars: int = 300
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
