"""
LangChain-based bounded ReAct loop for the ErrorAnalyst patch stage.

Uses structured tool calling (bind_tools) instead of JSON-in-text parsing,
making it robust to model-specific output quirks (e.g. MiniMax <minimax:tool_call>).

Only the ErrorAnalyst._react_patch_loop uses this module.
Other analyst stages (diagnosis, success, merge) still use LLMClient.chat_json.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from langchain_core.messages import (
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

from trace_evolver.config import LLMSettings
from trace_evolver.utils import compress_text_for_llm

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tool parameter schemas (used as bind_tools input → OpenAI function schemas)
# ---------------------------------------------------------------------------

class ReadFileParams(BaseModel):
    """Read a markdown file from the skill bundle to gain context before patching."""

    file: str = Field(description="Bundle-relative path from the markdown catalog")
    reason: str = Field(description="Why you need this file")


class ReadArtifactParams(BaseModel):
    """Read a file artifact written by the agent during the traced episode."""

    art_id: str = Field(description="Artifact ID from the artifact catalog")
    offset: int = Field(default=0, ge=0, description="Starting line, 0-based")
    limit: int = Field(default=80, ge=1, description="Max lines to return")
    reason: str = Field(description="Why you need this artifact")


class EditSpec(BaseModel):
    """Single edit operation inside a write_patch call."""

    file: str = Field(default="SKILL.md", description="SKILL.md or references/xxx.md")
    op: str = Field(description="edit | append_file_end | create")
    old_string: str | None = Field(default=None, description="For edit: exact text to replace")
    new_string: str | None = Field(default=None, description="For edit: replacement text")
    content: str | None = Field(default=None, description="For append_file_end/create")
    intent: str = Field(
        default="guardrail",
        description="trigger | workflow | guardrail | example | reference | metadata",
    )


class WritePatchParams(BaseModel):
    """Submit the final patch — terminal action that ends the loop."""

    edits: list[EditSpec] = Field(description="Edit operations to apply")
    confidence: float = Field(ge=0.0, le=1.0, description="Confidence between 0.4 and 0.9")
    rationale: str = Field(description="Why these changes prevent the failure")


# ---------------------------------------------------------------------------
# Tool name constants (bind_tools uses Pydantic class names)
# ---------------------------------------------------------------------------

_NAME_READ_FILE = "ReadFileParams"
_NAME_READ_ARTIFACT = "ReadArtifactParams"
_NAME_WRITE_PATCH = "WritePatchParams"


# ---------------------------------------------------------------------------
# Model factory
# ---------------------------------------------------------------------------

def create_chat_model(settings: LLMSettings) -> ChatOpenAI:
    """Instantiate a ChatOpenAI pointing at the configured provider."""
    return ChatOpenAI(
        model=settings.model,
        api_key=settings.api_key,
        base_url=settings.base_url,
        temperature=0.2,
    )


# ---------------------------------------------------------------------------
# Bounded ReAct loop
# ---------------------------------------------------------------------------

def run_react_loop(
    model: ChatOpenAI,
    system_prompt: str,
    user_content: str,
    *,
    max_markdown_reads: int = 2,
    max_artifact_reads: int = 1,
    hard_budget_tokens: int,
    file_contents: dict[str, str],
    used_tokens: int,
    known_paths: set[str],
    read_file_cb: Callable[[str], tuple[str | None, int]],
    read_artifact_cb: Callable[[str, int, int], tuple[str | None, int]] | None = None,
    has_artifacts: bool = False,
    max_artifact_lines: int = 200,
    max_tool_message_chars: int = 30_000,
    max_message_chars: int = 60_000,
) -> tuple[dict[str, Any] | None, list[str]]:
    """Run a bounded ReAct loop with structured tool calling.

    Returns ``(write_patch_args, notes)`` or ``(None, notes)`` when no patch
    is produced.  ``write_patch_args`` is a plain dict with keys
    ``edits`` (list[dict]), ``confidence`` (float), ``rationale`` (str).

    ``file_contents`` is mutated in place as new files are read so the caller
    can see which files the agent opened.

    Read budgets are tracked separately for markdown files and artifacts so
    that artifact reads cannot starve skill/reference reading.
    """
    notes: list[str] = []
    max_artifact_lines = max(1, max_artifact_lines)
    max_tool_message_chars = max(1, max_tool_message_chars)
    max_message_chars = max(1, max_message_chars)
    markdown_reads_done = 0
    artifact_reads_done = 0
    rejected_reads: set[str] = set()
    loaded_artifact_keys: set[str] = set()  # dedup successful artifact reads
    _force_write_retries = 0  # track retries when tool_choice is not respected

    # Build tool lists -------------------------------------------------------
    max_total_reads = max_markdown_reads + max_artifact_reads

    model_write_only = model.bind_tools(
        [WritePatchParams],
        tool_choice={"type": "function", "function": {"name": _NAME_WRITE_PATCH}},
    )

    def _build_active_model():
        """Return a model bound with currently-available tools."""
        tools: list[type[BaseModel]] = []
        if markdown_reads_done < max_markdown_reads:
            tools.append(ReadFileParams)
        if artifact_reads_done < max_artifact_reads and has_artifacts and read_artifact_cb is not None:
            tools.append(ReadArtifactParams)
        tools.append(WritePatchParams)
        if len(tools) == 1:
            # Only WritePatchParams left — force it
            return model_write_only, True
        return model.bind_tools(tools), False

    # Conversation history ----------------------------------------------------
    messages: list[BaseMessage] = [
        SystemMessage(content=system_prompt),
        HumanMessage(content=user_content),
    ]

    max_turns = max_total_reads * 3 + 2  # generous cap

    for turn in range(max_turns):
        active_model, force_write = _build_active_model()

        try:
            response = active_model.invoke(_compress_message_history(messages, max_message_chars))
        except Exception:
            logger.warning("ReAct LLM call failed on turn %d", turn, exc_info=True)
            notes.append(f"LLM call failed on turn {turn}")
            break

        messages.append(response)

        # If the model returned plain text instead of a tool call, nudge or fallback.
        if not response.tool_calls:
            # When in force_write mode and model ignores tool_choice, try to
            # extract write_patch JSON from the content as a degraded fallback.
            if force_write:
                _force_write_retries += 1
                content_text = (response.content or "").strip()
                if _force_write_retries >= 2 and content_text:
                    # Last-resort: parse content as JSON (legacy path)
                    import json as _json
                    try:
                        from trace_evolver.llm import _extract_json
                        parsed = _extract_json(content_text)
                        if parsed.get("edits"):
                            notes.append(f"write_patch extracted from content fallback on turn {turn}")
                            return parsed, notes
                    except (ValueError, KeyError):
                        pass
                if _force_write_retries >= 3:
                    notes.append("force_write failed: model did not produce write_patch after retries")
                    break

            notes.append(f"turn {turn}: no tool_calls in response")
            if turn >= max_turns - 2:
                break
            messages.append(
                HumanMessage(
                    content="You MUST call the WritePatchParams tool now. Do not respond with text — use the tool."
                )
            )
            continue

        for tc in response.tool_calls:
            name = tc["name"]
            args: dict[str, Any] = tc["args"]
            tc_id = tc["id"]

            # ---- write_patch (terminal) ------------------------------------
            if name == _NAME_WRITE_PATCH:
                notes.append(f"write_patch on turn {turn}")
                raw_edits = args.get("edits", [])
                edits = [
                    e if isinstance(e, dict) else (e.model_dump() if hasattr(e, "model_dump") else dict(e))
                    for e in raw_edits
                ]
                return {
                    "edits": edits,
                    "confidence": args.get("confidence", 0.6),
                    "rationale": args.get("rationale", ""),
                }, notes

            # ---- read_file -------------------------------------------------
            elif name == _NAME_READ_FILE:
                file_path = str(args.get("file", ""))
                reason = str(args.get("reason", ""))

                if file_path in rejected_reads or file_path in file_contents:
                    msg = f"ERROR: Already loaded or previously rejected: {file_path}"
                    rejected_reads.add(file_path)
                    notes.append(f"invalid/duplicate read: {file_path}")
                elif file_path not in known_paths:
                    msg = f"ERROR: Not in catalog: {file_path}"
                    rejected_reads.add(file_path)
                    notes.append(f"invalid read (not in catalog): {file_path}")
                elif markdown_reads_done >= max_markdown_reads:
                    msg = f"ERROR: Markdown read budget exhausted ({max_markdown_reads}/{max_markdown_reads}). Call WritePatchParams now."
                    notes.append(f"rejected read {file_path}: markdown budget exhausted")
                else:
                    content, token_count = read_file_cb(file_path)
                    if content is None:
                        msg = f"ERROR: Could not read {file_path}"
                        rejected_reads.add(file_path)
                        notes.append(f"could not read {file_path}")
                    elif used_tokens + token_count > hard_budget_tokens:
                        msg = f"ERROR: Reading {file_path} would exceed token budget"
                        rejected_reads.add(file_path)
                        notes.append(f"skipped {file_path}: budget exceeded")
                    else:
                        file_contents[file_path] = content
                        used_tokens += token_count
                        markdown_reads_done += 1
                        msg = (
                            f"Content of {file_path}:\n```markdown\n{content}\n```\n\n"
                            f"Markdown reads remaining: {max_markdown_reads - markdown_reads_done}"
                        )
                        notes.append(f"opened {file_path} (reason: {reason}, tokens~{token_count})")

                messages.append(ToolMessage(content=_cap_tool_message(msg, max_tool_message_chars), tool_call_id=tc_id))

            # ---- read_artifact ---------------------------------------------
            elif name == _NAME_READ_ARTIFACT and read_artifact_cb is not None:
                art_id = str(args.get("art_id", ""))
                # Safe int conversion — models may return null/strings
                try:
                    offset = max(0, int(args.get("offset", 0)))
                except (TypeError, ValueError):
                    offset = 0
                try:
                    limit = min(max_artifact_lines, max(1, int(args.get("limit", 80))))
                except (TypeError, ValueError):
                    limit = min(max_artifact_lines, 80)
                reason = str(args.get("reason", ""))
                art_key = f"{art_id}:{offset}-{offset + limit}"

                if art_key in rejected_reads or art_key in loaded_artifact_keys:
                    msg = f"ERROR: Already loaded or rejected: {art_key}"
                    notes.append(f"duplicate/rejected artifact read: {art_key}")
                elif artifact_reads_done >= max_artifact_reads:
                    msg = f"ERROR: Artifact read budget exhausted ({max_artifact_reads}/{max_artifact_reads}). Call WritePatchParams now."
                    notes.append(f"rejected artifact {art_key}: artifact budget exhausted")
                else:
                    content, token_count = read_artifact_cb(art_id, offset, limit)
                    if content is None:
                        msg = f"ERROR: Artifact not found: {art_id}"
                        rejected_reads.add(art_key)
                        notes.append(f"artifact not found: {art_id}")
                    elif used_tokens + token_count > hard_budget_tokens:
                        msg = f"ERROR: Would exceed token budget"
                        rejected_reads.add(art_key)
                        notes.append(f"skipped artifact {art_key}: budget exceeded")
                    else:
                        used_tokens += token_count
                        artifact_reads_done += 1
                        loaded_artifact_keys.add(art_key)
                        msg = (
                            f"Artifact {art_id} (lines {offset}\u2013{offset + limit}):\n"
                            f"```\n{content}\n```\n\n"
                            f"Artifact reads remaining: {max_artifact_reads - artifact_reads_done}"
                        )
                        notes.append(
                            f"loaded artifact {art_key} (reason: {reason}, tokens~{token_count})"
                        )

                messages.append(ToolMessage(content=_cap_tool_message(msg, max_tool_message_chars), tool_call_id=tc_id))

            # ---- unknown tool ----------------------------------------------
            else:
                messages.append(
                    ToolMessage(
                        content=f"Unknown tool: {name}. Use ReadFileParams, ReadArtifactParams, or WritePatchParams.",
                        tool_call_id=tc_id,
                    )
                )
                notes.append(f"unknown tool call: {name}")

    notes.append("ReAct loop ended without producing a patch")
    return None, notes


def _cap_tool_message(text: str, max_chars: int) -> str:
    return compress_text_for_llm(text, max_chars, label="tool message")


def _compress_message_history(messages: list[BaseMessage], max_chars: int) -> list[BaseMessage]:
    """Apply a final per-message cap before LangChain sends a request."""
    bounded: list[BaseMessage] = []
    for message in messages:
        content = message.content
        if isinstance(content, str):
            bounded.append(
                message.model_copy(
                    update={
                        "content": compress_text_for_llm(
                            content,
                            max_chars,
                            label=message.type,
                        )
                    }
                )
            )
        else:
            bounded.append(message)
    return bounded
