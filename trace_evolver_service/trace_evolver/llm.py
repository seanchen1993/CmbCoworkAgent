"""
LLM 客户端封装。

使用 OpenAI 兼容接口调用 MiniMax API。
所有 analyst 模块通过本模块与 LLM 交互，不直接持有 API 密钥。
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

from openai import OpenAI

from trace_evolver.config import LLMSettings

logger = logging.getLogger(__name__)

_MAX_RETRIES = 1
_RETRY_BACKOFF_S = 2.0


class LLMClient:
    """OpenAI-compatible LLM client targeting MiniMax API."""

    def __init__(self, llm_settings: LLMSettings):
        self._settings = llm_settings
        self._client = OpenAI(
            api_key=llm_settings.api_key,
            base_url=llm_settings.base_url,
        )

    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> str:
        """Send a chat completion request and return the assistant message content.

        Retries once on transient errors before raising.
        """
        last_exc: Exception | None = None
        for attempt in range(_MAX_RETRIES + 1):
            try:
                request_kwargs: dict[str, Any] = {
                    "model": self._settings.model,
                    "messages": messages,
                    "temperature": temperature if temperature is not None else self._settings.temperature,
                }
                resolved_max_tokens = max_tokens if max_tokens is not None else self._settings.max_tokens
                if resolved_max_tokens is not None:
                    request_kwargs["max_tokens"] = resolved_max_tokens
                resp = self._client.chat.completions.create(
                    **request_kwargs,
                )
                content = resp.choices[0].message.content or ""
                content = _strip_think_tags(content)
                logger.debug("LLM response length: %d chars", len(content))
                return content
            except Exception as exc:
                last_exc = exc
                if attempt < _MAX_RETRIES:
                    logger.warning("LLM call failed (attempt %d), retrying in %.1fs: %s", attempt + 1, _RETRY_BACKOFF_S, exc)
                    time.sleep(_RETRY_BACKOFF_S)
        raise last_exc  # type: ignore[misc]

    def chat_json(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> dict[str, Any]:
        """Send a chat completion and parse the response as JSON.

        The prompt must instruct the model to return valid JSON.
        Falls back to extracting the first JSON object if the response
        contains markdown fences or surrounding text.
        """
        raw = self.chat(messages, temperature=temperature, max_tokens=max_tokens)
        return _extract_json(raw)


_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


def _strip_think_tags(text: str) -> str:
    """Remove <think>...</think> blocks from reasoning-model output."""
    return _THINK_RE.sub("", text).strip()


def _extract_json(text: str) -> dict[str, Any]:
    """Best-effort JSON extraction from LLM output."""
    text = text.strip()
    # Strip markdown code fences
    if text.startswith("```"):
        first_newline = text.index("\n") if "\n" in text else 3
        text = text[first_newline + 1 :]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Try to find the first { ... } block
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            pass
    logger.error("Failed to parse JSON from LLM response: %s", text[:500])
    raise ValueError(f"Could not parse JSON from LLM response: {text[:200]}")
