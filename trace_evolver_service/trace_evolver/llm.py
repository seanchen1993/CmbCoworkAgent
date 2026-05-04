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
from trace_evolver.utils import compress_text_for_llm

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

    def _call(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> Any:
        """Send a chat completion request and return the raw message object.

        Retries once on transient errors before raising.
        """
        bounded_messages = _compress_messages(messages, self._settings.max_message_chars)
        last_exc: Exception | None = None
        for attempt in range(_MAX_RETRIES + 1):
            try:
                request_kwargs: dict[str, Any] = {
                    "model": self._settings.model,
                    "messages": bounded_messages,
                    "temperature": temperature if temperature is not None else self._settings.temperature,
                }
                resolved_max_tokens = max_tokens if max_tokens is not None else self._settings.max_tokens
                if resolved_max_tokens is not None:
                    request_kwargs["max_tokens"] = resolved_max_tokens
                resp = self._client.chat.completions.create(
                    **request_kwargs,
                )
                return resp.choices[0].message
            except Exception as exc:
                last_exc = exc
                if attempt < _MAX_RETRIES:
                    logger.warning("LLM call failed (attempt %d), retrying in %.1fs: %s", attempt + 1, _RETRY_BACKOFF_S, exc)
                    time.sleep(_RETRY_BACKOFF_S)
        raise last_exc  # type: ignore[misc]

    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> str:
        """Send a chat completion request and return the assistant message content."""
        msg = self._call(messages, temperature=temperature, max_tokens=max_tokens)
        content = msg.content or ""
        content = _strip_think_tags(content)
        logger.debug("LLM response length: %d chars", len(content))
        return content

    def chat_json(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> dict[str, Any]:
        """Send a chat completion and parse the response as JSON.

        Checks both message.content and message.tool_calls, since some models
        (e.g. MiniMax) may route JSON actions through the tool_calls field
        instead of content.
        """
        msg = self._call(messages, temperature=temperature, max_tokens=max_tokens)
        content = _strip_think_tags(msg.content or "")

        # 1) Try to extract JSON from content first
        if content.strip():
            try:
                return _extract_json(content)
            except ValueError:
                logger.debug("Could not extract JSON from content, checking tool_calls")

        # 2) Fall back to tool_calls if the model used structured tool calling
        tool_calls = getattr(msg, "tool_calls", None)
        if tool_calls:
            for tc in tool_calls:
                fn = getattr(tc, "function", None)
                if fn and fn.arguments:
                    try:
                        return json.loads(fn.arguments)
                    except json.JSONDecodeError:
                        try:
                            return _extract_json(fn.arguments)
                        except ValueError:
                            continue
            logger.warning("Found tool_calls but could not parse arguments as JSON")

        # 3) If content had text but we skipped it above, raise with context
        if content.strip():
            raise ValueError(f"Could not parse JSON from LLM response: {content[:200]}")
        raise ValueError("LLM returned empty content and no parseable tool_calls")


_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
_MINIMAX_TOOL_CALL_RE = re.compile(r"<minimax:tool_call>\s*", re.DOTALL)
_MINIMAX_TOOL_CALL_END_RE = re.compile(r"\s*</minimax:tool_call>", re.DOTALL)


def _compress_messages(messages: list[dict[str, str]], max_chars: int) -> list[dict[str, str]]:
    """Apply a final per-message hard cap before sending content to the LLM."""
    bounded: list[dict[str, str]] = []
    for message in messages:
        next_message = dict(message)
        content = next_message.get("content")
        if isinstance(content, str):
            role = str(next_message.get("role", "message"))
            next_message["content"] = compress_text_for_llm(content, max_chars, label=f"{role} message")
        bounded.append(next_message)
    return bounded


def _strip_think_tags(text: str) -> str:
    """Remove <think>...</think> and <minimax:tool_call> wrapper tags from model output."""
    text = _THINK_RE.sub("", text)
    text = _MINIMAX_TOOL_CALL_RE.sub("", text)
    text = _MINIMAX_TOOL_CALL_END_RE.sub("", text)
    return text.strip()


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
    # Last resort: try to find a valid JSON object by scanning from each '{'
    if start != -1:
        for i in range(start, len(text)):
            if text[i] == "{":
                depth = 0
                for j in range(i, len(text)):
                    if text[j] == "{":
                        depth += 1
                    elif text[j] == "}":
                        depth -= 1
                        if depth == 0:
                            try:
                                return json.loads(text[i : j + 1])
                            except json.JSONDecodeError:
                                break
    logger.error("Failed to parse JSON from LLM response: %s", text[:500])
    raise ValueError(f"Could not parse JSON from LLM response: {text[:200]}")
