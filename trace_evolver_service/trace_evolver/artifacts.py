"""Artifact extraction and retrieval from agent traces.

Traces contain a ``modelCalls`` array with full tool call arguments,
including the complete content of ``write_file`` and ``edit_file`` operations.
This module extracts a lightweight index at ingestion time and provides
on-demand, line-range content retrieval for the analyst layer.
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import PurePosixPath

from trace_evolver.schemas import ImportedTrace, TraceArtifact

logger = logging.getLogger(__name__)

_WRITE_TOOLS = frozenset({"write_file", "write_to_file"})
_EDIT_TOOLS = frozenset({"edit_file", "apply_diff", "replace_in_file"})


def _make_art_id(trace_id: str, seq: int) -> str:
    """Generate a short, collision-resistant artifact ID.

    Uses sha256(traceId + seq) truncated to 10 hex chars.  With ~11 artifacts
    per trace and ~100 traces per run, 10 hex chars (40 bits) gives a collision
    probability of ~10⁻⁹ per run.
    """
    raw = f"{trace_id}:{seq}"
    return hashlib.sha256(raw.encode()).hexdigest()[:10]


def build_artifact_index(trace: ImportedTrace) -> list[TraceArtifact]:
    """Scan ``modelCalls`` for file-writing tool calls and build a metadata index.

    Does **not** store file content — only paths, sizes, and position indices
    so that content can be retrieved on demand via :func:`get_artifact_content`.
    """
    model_calls: list[dict] = getattr(trace, "modelCalls", None) or []
    artifacts: list[TraceArtifact] = []
    global_seq = 0  # global counter for unique art_id
    path_seq: dict[str, int] = {}  # per-file_path counter for seq field

    for mc_idx, mc in enumerate(model_calls):
        tool_calls: list[dict] = mc.get("toolCalls") or []
        for tc_idx, tc in enumerate(tool_calls):
            name = tc.get("name", "")
            args = tc.get("args") or {}

            if name in _WRITE_TOOLS:
                file_path = args.get("file_path") or args.get("filePath") or ""
                content = args.get("content", "")
                if not file_path:
                    continue
                file_name = PurePosixPath(file_path).name
                art_id = _make_art_id(trace.traceId, global_seq)
                global_seq += 1
                file_seq = path_seq.get(file_path, 0)
                path_seq[file_path] = file_seq + 1
                artifacts.append(TraceArtifact(
                    art_id=art_id,
                    file_path=file_path,
                    file_name=file_name,
                    artifact_type="write",
                    model_call_index=mc_idx,
                    tool_call_index=tc_idx,
                    content_chars=len(content),
                    total_lines=len(content.split("\n")),
                    seq=file_seq,
                ))

            elif name in _EDIT_TOOLS:
                file_path = args.get("file_path") or args.get("filePath") or ""
                old_string = args.get("old_string") or args.get("oldString") or ""
                new_string = args.get("new_string") or args.get("newString") or ""
                if not file_path:
                    continue
                file_name = PurePosixPath(file_path).name
                diff = f"--- old ---\n{old_string}\n+++ new +++\n{new_string}"
                art_id = _make_art_id(trace.traceId, global_seq)
                global_seq += 1
                file_seq = path_seq.get(file_path, 0)
                path_seq[file_path] = file_seq + 1
                artifacts.append(TraceArtifact(
                    art_id=art_id,
                    file_path=file_path,
                    file_name=file_name,
                    artifact_type="edit",
                    model_call_index=mc_idx,
                    tool_call_index=tc_idx,
                    content_chars=len(new_string) + len(old_string),
                    total_lines=len(diff.split("\n")),
                    seq=file_seq,
                ))

    # Mark the last artifact per file_path as latest (last event on this path),
    # and separately mark the last *write* artifact as latest_snapshot (last
    # full-content snapshot).  The distinction matters because reading an edit
    # artifact returns only the diff, not the full file — so latest_snapshot
    # tells the model which artifact actually has the complete final content.
    last_idx_by_path: dict[str, int] = {}
    last_write_idx_by_path: dict[str, int] = {}
    for i, art in enumerate(artifacts):
        last_idx_by_path[art.file_path] = i
        if art.artifact_type == "write":
            last_write_idx_by_path[art.file_path] = i
    for i in last_idx_by_path.values():
        artifacts[i].latest = True
    for i in last_write_idx_by_path.values():
        artifacts[i].latest_snapshot = True

    return artifacts


def _raw_artifact_content(trace: ImportedTrace, artifact: TraceArtifact) -> str | None:
    """Retrieve raw content of an artifact from ``modelCalls``."""
    model_calls: list[dict] = getattr(trace, "modelCalls", None) or []
    if artifact.model_call_index >= len(model_calls):
        return None
    mc = model_calls[artifact.model_call_index]
    tool_calls: list[dict] = mc.get("toolCalls") or []
    if artifact.tool_call_index >= len(tool_calls):
        return None
    args = tool_calls[artifact.tool_call_index].get("args") or {}

    if artifact.artifact_type == "write":
        return args.get("content")

    # edit — return formatted diff
    old_string = args.get("old_string") or args.get("oldString") or ""
    new_string = args.get("new_string") or args.get("newString") or ""
    if not old_string and not new_string:
        return None
    return f"--- old ---\n{old_string}\n+++ new +++\n{new_string}"


_DEFAULT_WRITE_LIMIT = 80


def get_artifact_content(
    trace: ImportedTrace,
    artifact: TraceArtifact,
    *,
    offset: int = 0,
    limit: int = 0,
) -> str | None:
    """Retrieve artifact content with line-range pagination.

    *offset* and *limit* work like ``read_file`` pagination:
    - ``offset=0, limit=80`` → first 80 lines
    - ``offset=50, limit=80`` → lines 50-129

    Both values are clamped to non-negative; *limit* defaults to
    ``_DEFAULT_WRITE_LIMIT`` for ``write`` artifacts to prevent
    accidentally dumping an entire large file into the prompt.

    For ``edit`` artifacts the full diff is always returned (they're small).
    The caller (ReAct loop) is responsible for enforcing token budgets.
    """
    raw = _raw_artifact_content(trace, artifact)
    if raw is None:
        return None

    # edit diffs are typically small — always return in full
    if artifact.artifact_type == "edit":
        return raw

    lines = raw.split("\n")
    total = len(lines)

    # Clamp to non-negative; default limit for write artifacts
    offset = max(0, offset)
    limit = max(0, limit) or _DEFAULT_WRITE_LIMIT

    start = min(offset, total)
    end = min(start + limit, total)
    selected = lines[start:end]

    header = f"[Lines {start + 1}-{end} of {total}]"
    if end < total:
        header += f" Use offset={end} to read more."
    return header + "\n" + "\n".join(selected)


def _short_path(file_path: str, max_parts: int = 3) -> str:
    """Return the last *max_parts* path components, e.g. ``src/pages/index.html``."""
    parts = PurePosixPath(file_path).parts
    return "/".join(parts[-max_parts:]) if len(parts) > max_parts else file_path


def format_artifact_catalog(traces: list[ImportedTrace]) -> str:
    """Build a compact artifact catalog for LLM prompts.

    Each line shows: art_id, short path (last 3 segments), type, size, and
    line count.  The art_id is the unique key for ``read_artifact``.
    """
    lines: list[str] = []
    for trace in traces:
        if not trace.artifact_index:
            continue
        for art in trace.artifact_index:
            tags: list[str] = []
            if art.latest_snapshot:
                tags.append("[latest-snapshot]")
            elif art.latest:
                tags.append("[latest-event]")
            tag_str = " " + " ".join(tags) if tags else ""
            lines.append(
                f"  {art.art_id} | {_short_path(art.file_path)} | {art.artifact_type} "
                f"seq={art.seq} | {art.content_chars}ch | {art.total_lines} lines{tag_str}"
            )
    if not lines:
        return "(none)"
    return "\n".join(lines)


def format_artifact_summary_line(artifacts: list[TraceArtifact]) -> str:
    """One-liner summary of artifacts for inline trace formatting.

    Example: ``customer-approval.html(write,20400ch), customer-approval.vue(write,17464ch)``
    """
    if not artifacts:
        return ""
    parts: list[str] = []
    # Group by file_name to show counts
    by_file: dict[str, list[TraceArtifact]] = {}
    for art in artifacts:
        by_file.setdefault(art.file_name, []).append(art)
    for fname, arts in by_file.items():
        writes = [a for a in arts if a.artifact_type == "write"]
        edits = [a for a in arts if a.artifact_type == "edit"]
        desc_parts: list[str] = []
        if writes:
            last_write = writes[-1]
            desc_parts.append(f"write{'x' + str(len(writes)) if len(writes) > 1 else ''},{last_write.content_chars}ch")
        if edits:
            desc_parts.append(f"edit x{len(edits)}")
        parts.append(f"{fname}({', '.join(desc_parts)})")
    return ", ".join(parts)
