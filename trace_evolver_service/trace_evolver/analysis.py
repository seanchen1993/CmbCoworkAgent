"""
analyst 层实现。

本模块对应设计里的 Stage 2，对齐 Trace2Skill 论文的 Parallel Multi-Agent Patch Proposal 阶段。

其中：
- SuccessAnalyst (𝒜⁺):
  单次 pass，提炼可复用的成功模式。
  遵循论文要求：Broad Coverage / Frequency Awareness / Generalization。

- ErrorAnalyst (𝒜⁻):
  对外仍然是单 analyst，对内分两阶段：
  Phase A: diagnosis + bounded markdown ReAct（论文 4-step mandatory workflow）
  Phase B: patch planning + patch writing（以 exact text edit 为主，references/ 路由为辅）

这层的最终输出不是"直接修改文件"，而是结构化 HypothesisPatch。
真正写文件由 patching.py 中的 Python patch engine 完成。

LLM 集成说明：
- 当 LLMSettings.api_key 非空时，使用真实 LLM 进行分析
- 否则降级到 V1 启发式实现
"""

from __future__ import annotations

import logging
from pathlib import Path

from trace_evolver.config import Settings
from trace_evolver.llm import LLMClient
from trace_evolver.schemas import (
    EditOp,
    Episode,
    EvidenceSpan,
    FailureHypothesis,
    HypothesisPatch,
    ImportedTrace,
    MarkdownFileMeta,
    SelectedSpan,
    SkillBundleMeta,
    SuccessPattern,
)
from trace_evolver.utils import is_allowed_markdown_relative_path, sha256_text, tokenize, trim_snippet

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

_ERROR_KEYWORDS = frozenset({
    "error", "fail", "retry", "wrong", "invalid", "mismatch", "exception", "traceback",
    "错误", "失败", "重试", "异常", "无效", "不匹配",
})

_VALID_INTENTS = frozenset({"trigger", "workflow", "guardrail", "example", "reference", "metadata"})

_ACTION_READ = "read_file"
_ACTION_WRITE = "write_patch"

_PATCH_PLACEMENT_RULES = (
    "**Patch placement rules** (critical for quality):\n"
    "- For EXISTING content that must be changed, use op=edit with old_string/new_string.\n"
    "- old_string MUST uniquely match in the visible file. If it may repeat, include more "
    "surrounding lines in old_string so the match becomes unique.\n"
    "- For inserting guidance under an existing heading, use op=edit: old_string includes "
    "existing text to anchor on, new_string includes that text plus your insertion.\n"
    "- Use op=append_file_end only for appending a brand-new section to the end of a file.\n"
    "- Use op=create only for new markdown files.\n"
    "- For niche/case-specific guidance, route to references/*.md instead of SKILL.md.\n"
    "- If you create a new references/*.md file, you MUST also add a link in SKILL.md "
    "(atomic create/link pair — keep both or drop both).\n"
)

_MARKDOWN_FORMAT_RULES = (
    "**Markdown formatting (CRITICAL)**:\n"
    "- `old_string`, `new_string`, and `content` MUST preserve markdown line breaks. "
    "Encode every newline as `\\n` in the JSON string. Never collapse multi-line sections.\n"
    "- Keep a blank line (`\\n\\n`) before and after every heading and between paragraphs/list blocks, "
    "exactly as in the source file.\n"
    "- `old_string` must be byte-identical to the source (including `\\n` line breaks).\n"
)

_EDIT_JSON_SCHEMA = (
    '  "edits": [\n'
    "    {\n"
    '      "file": "SKILL.md or references/xxx.md",\n'
    '      "op": "edit, append_file_end, or create",\n'
    '      "old_string": "required for edit; exact existing text to replace",\n'
    '      "new_string": "required for edit; replacement text",\n'
    '      "content": "required for append_file_end/create",\n'
    '      "intent": "one of: trigger, workflow, guardrail, example, reference, metadata"\n'
    "    }\n"
    "  ],\n"
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _trace_lookup(traces: list[ImportedTrace]) -> dict[str, ImportedTrace]:
    return {trace.traceId: trace for trace in traces}


def _collect_episode_traces(episode: Episode, trace_map: dict[str, ImportedTrace]) -> list[ImportedTrace]:
    return [trace_map[trace_id] for trace_id in episode.trace_ids if trace_id in trace_map]


def _read_relative_file(bundle: SkillBundleMeta, relative_path: str) -> str:
    return (Path(bundle.root_path) / relative_path).read_text(encoding="utf-8")


def _read_relative_file_safe(bundle: SkillBundleMeta, relative_path: str) -> str:
    """Read file, return empty string on failure."""
    try:
        return _read_relative_file(bundle, relative_path)
    except (FileNotFoundError, OSError):
        return ""


def _markdown_search_score(query_tokens: set[str], meta: MarkdownFileMeta) -> float:
    if not query_tokens:
        return 0.0
    haystack_tokens = tokenize(
        " ".join([meta.file_path, meta.first_paragraph_summary, *meta.heading_tree, *meta.linked_markdown_paths])
    )
    overlap = len(query_tokens & haystack_tokens)
    if not overlap:
        return 0.0
    return overlap / max(len(query_tokens), 1) + min(0.3, overlap / 10)


def _top_snippet(meta: MarkdownFileMeta, content: str, query_tokens: set[str]) -> SelectedSpan:
    for heading in meta.heading_tree:
        if tokenize(heading) & query_tokens:
            return SelectedSpan(
                file_path=meta.file_path,
                heading=heading,
                reason=f"heading overlap for {heading}",
                snippet=trim_snippet(heading),
            )
    return SelectedSpan(
        file_path=meta.file_path,
        heading=meta.heading_tree[0] if meta.heading_tree else None,
        reason="summary overlap",
        snippet=trim_snippet(content, 220),
    )


def _format_traces_for_prompt(traces: list[ImportedTrace], *, max_chars: int = 8000, prefer_errors: bool = False) -> str:
    """Serialize traces into a compact text block for LLM prompts.

    When prefer_errors=True, error-related steps are prioritized over
    the naive "last N steps" strategy, ensuring the LLM sees failure context.
    """
    parts: list[str] = []
    budget = max_chars
    # Sort: error traces first when prefer_errors
    ordered = sorted(traces, key=lambda t: (0 if prefer_errors and t.outcome != "success" else 1, t.startedAt))
    for trace in ordered:
        block = (
            f"[trace {trace.traceId[:8]}] outcome={trace.outcome} model={trace.modelId}\n"
            f"  user: {trim_snippet(trace.userMessage, 240)}\n"
        )
        if trace.errorMessage:
            block += f"  error: {trim_snippet(trace.errorMessage, 240)}\n"

        # Prioritize error-relevant steps instead of blindly taking last N
        if prefer_errors:
            steps = _select_error_relevant_steps(trace, max_steps=8)
        else:
            steps = trace.steps[-8:]

        for step in steps:
            line = f"  step[{step.index}]: {trim_snippet(step.assistantText, 160)}"
            for tool in step.toolCalls[:4]:
                result_hint = trim_snippet(tool.result or "", 100) if tool.result else ""
                line += f"\n    tool({tool.name}): {result_hint}"
            block += line + "\n"
        if len(block) > budget:
            block = block[:budget]
        parts.append(block)
        budget -= len(block)
        if budget <= 0:
            break
    return "\n".join(parts)


def _select_error_relevant_steps(trace: ImportedTrace, max_steps: int = 8) -> list:
    """Select steps most relevant to understanding failures.

    Strategy: include all error-containing steps + surrounding context,
    then fill remaining budget from the tail of the trace.
    """
    error_indices: set[int] = set()
    for i, step in enumerate(trace.steps):
        text = (step.assistantText or "").lower()
        tool_text = " ".join((t.result or "") for t in step.toolCalls).lower()
        if any(kw in text or kw in tool_text for kw in _ERROR_KEYWORDS):
            error_indices.add(i)
            # Include one step before and after for context
            if i > 0:
                error_indices.add(i - 1)
            if i < len(trace.steps) - 1:
                error_indices.add(i + 1)

    selected_indices = sorted(error_indices)[:max_steps]
    # Fill remaining budget from tail
    remaining = max_steps - len(selected_indices)
    if remaining > 0:
        tail_indices = [i for i in range(len(trace.steps) - 1, -1, -1) if i not in set(selected_indices)]
        selected_indices = sorted(set(selected_indices) | set(tail_indices[:remaining]))

    return [trace.steps[i] for i in selected_indices if i < len(trace.steps)]


def _has_llm(settings: Settings) -> bool:
    return bool(settings.llm.api_key)


def _get_llm(settings: Settings) -> LLMClient:
    return LLMClient(settings.llm)


def _build_heading_tree_text(bundle: SkillBundleMeta) -> str:
    """Build a heading-tree summary so the LLM knows existing SKILL.md structure."""
    for meta in bundle.markdown_files:
        if meta.file_path == "SKILL.md":
            return "\n".join(f"  {'#' * min(h.count('#'), 1) or '-'} {h}" for h in meta.heading_tree) if meta.heading_tree else "(no headings)"
    return "(no SKILL.md metadata)"


def _estimate_token_count(text: str) -> int:
    """Rough token estimate that works for both English and Chinese text.

    English: ~1 token per word (space-split).
    Chinese/CJK: ~1.5 tokens per character (no spaces between words).
    Mixed: sum both estimates.
    """
    if not text:
        return 1
    # Count CJK characters (Chinese, Japanese, Korean)
    cjk_chars = sum(1 for ch in text if '\u4e00' <= ch <= '\u9fff' or '\u3400' <= ch <= '\u4dbf')
    # Count space-separated words (primarily for non-CJK)
    word_count = len(text.split())
    if cjk_chars > word_count:
        # Predominantly CJK: ~1.5 tokens per CJK char + remaining words
        non_cjk_words = max(0, word_count - cjk_chars // 4)
        return max(1, int(cjk_chars * 1.5) + non_cjk_words)
    return max(1, word_count)



def _build_markdown_catalog_text(bundle: SkillBundleMeta, visible_files: list[str]) -> str:
    """Render a compact catalog view for the planner step.

    The planner only sees metadata for non-visible files. This mirrors the
    bounded ReAct contract: decide whether more context is needed from catalog
    signals, then request a full read explicitly.
    """
    visible_set = set(visible_files)
    lines: list[str] = []
    for meta in bundle.markdown_files:
        visibility = "full" if meta.file_path in visible_set else "catalog"
        headings = ", ".join(meta.heading_tree[:4]) if meta.heading_tree else "(no headings)"
        lines.append(
            f"- {meta.file_path} [{visibility}] tokens≈{meta.token_estimate} "
            f"headings={headings} summary={trim_snippet(meta.first_paragraph_summary, 120)}"
        )
    return "\n".join(lines)



# ---------------------------------------------------------------------------
# BoundedMarkdownReAct (heuristic — no LLM needed)
# ---------------------------------------------------------------------------

class BoundedMarkdownReAct:
    """
    一个受约束的 markdown 读取器。

    它不是完整 agent，也不做开放式工具探索。
    只在技能 bundle 的 markdown 文件里，逐步挑出少量最相关的文件。

    设计目标：
    - 不一次性把所有 *.md 全喂给模型
    - 但又允许在有限轮次内逐步补充上下文
    - 低分文件（score <= 0.1）不选入，避免引入噪声
    """

    MIN_RELEVANCE_SCORE = 0.1

    def __init__(self, settings: Settings):
        self.settings = settings

    def select(
        self,
        failure_surface: str,
        episode: Episode,
        bundle: SkillBundleMeta | None,
    ) -> tuple[list[str], list[SelectedSpan], list[str]]:
        if not bundle:
            return [], [], ["no target bundle available"]

        file_map = {meta.file_path: meta for meta in bundle.markdown_files}
        query_tokens = tokenize(" ".join([failure_surface, *episode.user_messages, *episode.used_skills]))
        selected_files: list[str] = []
        selected_spans: list[SelectedSpan] = []
        notes: list[str] = []
        soft_budget = self.settings.llm.markdown_soft_budget_tokens
        used_budget = 0

        if "SKILL.md" in file_map:
            selected_files.append("SKILL.md")
            content = _read_relative_file(bundle, "SKILL.md")
            selected_spans.append(_top_snippet(file_map["SKILL.md"], content, query_tokens))
            notes.append("opened SKILL.md as mandatory context")
            used_budget += file_map["SKILL.md"].token_estimate

        turns = 0
        while turns < self.settings.markdown_react_max_turns and len(selected_files) < self.settings.markdown_react_max_files:
            turns += 1
            scored = sorted(
                (
                    (_markdown_search_score(query_tokens, meta), path, meta)
                    for path, meta in file_map.items()
                    if path not in selected_files
                ),
                reverse=True,
            )
            if not scored or scored[0][0] <= self.MIN_RELEVANCE_SCORE:
                notes.append("no more relevant markdown files (below score threshold)")
                break
            choice = None
            for score, path, meta in scored:
                if score <= self.MIN_RELEVANCE_SCORE:
                    break
                if used_budget + meta.token_estimate <= soft_budget:
                    choice = (score, path, meta)
                    break
                else:
                    notes.append(f"skipped {path} (score={score:.2f}, tokens≈{meta.token_estimate}) — exceeds soft budget")
            if choice is None:
                notes.append("no more relevant markdown files within soft budget")
                break
            score, path, meta = choice
            selected_files.append(path)
            content = _read_relative_file(bundle, path)
            selected_spans.append(_top_snippet(meta, content, query_tokens))
            query_tokens |= tokenize(" ".join(meta.heading_tree[:2] + [meta.first_paragraph_summary]))
            used_budget += meta.token_estimate
            notes.append(f"opened {path} on turn {turns} (score={score:.2f}, used_budget={used_budget})")
        return selected_files, selected_spans, notes


# ---------------------------------------------------------------------------
# SuccessAnalyst (𝒜⁺)
# ---------------------------------------------------------------------------

class SuccessAnalyst:
    """Aligns with Trace2Skill 𝒜⁺: single-pass with Broad Coverage,
    Frequency Awareness, and Generalization requirements."""

    def __init__(self, settings: Settings):
        self.settings = settings

    def analyze(
        self,
        episode: Episode,
        traces: list[ImportedTrace],
        bundle: SkillBundleMeta | None,
    ) -> tuple[list[SuccessPattern], list[HypothesisPatch]]:
        if _has_llm(self.settings):
            return self._analyze_with_llm(episode, traces, bundle)
        return self._analyze_heuristic(episode, traces, bundle)

    # -- LLM path ----------------------------------------------------------

    def _analyze_with_llm(
        self,
        episode: Episode,
        traces: list[ImportedTrace],
        bundle: SkillBundleMeta | None,
    ) -> tuple[list[SuccessPattern], list[HypothesisPatch]]:
        llm = _get_llm(self.settings)
        traces_text = _format_traces_for_prompt(traces, prefer_errors=False)

        skill_context = ""
        heading_tree = ""
        if bundle:
            skill_context = _read_relative_file_safe(bundle, "SKILL.md")
            heading_tree = _build_heading_tree_text(bundle)

        messages = [
            {
                "role": "system",
                "content": (
                    "You are a skill-evolution analyst (Success Analyst 𝒜⁺). "
                    "Given successful agent traces, extract reusable success patterns.\n\n"
                    "Follow these principles from Trace2Skill:\n"
                    "1. **Broad Coverage** — every effective behavior in the trajectory must be captured\n"
                    "2. **Frequency Awareness** — patterns covering more instances should be listed first\n"
                    "3. **Generalization** — each pattern must describe a general mechanism, not just replay the specific trace\n\n"
                    "Use exact-text edits when you are changing existing guidance.\n\n"
                    f"{_PATCH_PLACEMENT_RULES}\n"
                    f"{_MARKDOWN_FORMAT_RULES}\n"
                    "Return JSON with exactly these fields:\n"
                    "{\n"
                    '  "patterns": [\n'
                    "    {\n"
                    '      "title": "string — concise pattern title",\n'
                    '      "description": "string — 2-3 sentences describing the reusable pattern",\n'
                    '      "frequency_hint": "string — how common this pattern is across the traces"\n'
                    "    }\n"
                    "  ],\n"
                    f"{_EDIT_JSON_SCHEMA}"
                    '  "confidence": "float between 0.5 and 0.95",\n'
                    '  "rationale": "string — why these patterns are worth capturing"\n'
                    "}\n"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"## Episode\n"
                    f"User messages: {'; '.join(episode.user_messages[:3])}\n"
                    f"Skills used: {', '.join(episode.used_skills)}\n"
                    f"Tool signature: {', '.join(episode.tool_signature[:10])}\n\n"
                    f"## Traces\n{traces_text}\n\n"
                    f"## Current SKILL.md heading structure\n{heading_tree}\n\n"
                    f"## Current SKILL.md content\n{skill_context}\n\n"
                    "Analyze the successful episode and return the JSON."
                ),
            },
        ]

        try:
            result = llm.chat_json(messages, temperature=0.3)
        except Exception:
            logger.warning("LLM call failed for SuccessAnalyst, falling back to heuristic", exc_info=True)
            return self._analyze_heuristic(episode, traces, bundle)

        # Build SuccessPatterns
        evidence = _collect_evidence(traces, prefer_errors=False)
        raw_patterns = result.get("patterns", [])
        patterns = [
            SuccessPattern(
                pattern_title=p.get("title", "Success pattern"),
                pattern_description=p.get("description", ""),
                evidence_spans=evidence,
            )
            for p in raw_patterns[:5]
        ]
        if not patterns:
            patterns = [SuccessPattern(
                pattern_title="Success pattern",
                pattern_description=result.get("rationale", ""),
                evidence_spans=evidence,
            )]

        if not bundle:
            return patterns, []

        # Build EditOps from LLM response
        ops = _build_ops_from_llm_edits(result.get("edits", []), bundle, ["SKILL.md"])
        if not ops:
            return patterns, []

        patch = HypothesisPatch(
            patch_id=f"patch-{sha256_text(episode.episode_id + 'success')[:12]}",
            source_kind="success",
            target_skill_id=bundle.skill_id,
            family_id="",
            source_trace_ids=episode.trace_ids,
            source_thread_ids=[episode.thread_id],
            base_bundle_hash=bundle.bundle_hash,
            visible_files=["SKILL.md"],
            ops=ops,
            confidence=float(result.get("confidence", 0.72)),
            rationale=result.get("rationale", "LLM-extracted success pattern."),
            evidence_spans=evidence,
        )
        return patterns, [patch]

    # -- Heuristic fallback -------------------------------------------------

    def _analyze_heuristic(
        self,
        episode: Episode,
        traces: list[ImportedTrace],
        bundle: SkillBundleMeta | None,
    ) -> tuple[list[SuccessPattern], list[HypothesisPatch]]:
        last_trace = traces[-1]
        evidence = _collect_evidence(traces, prefer_errors=False)
        title = trim_snippet(last_trace.userMessage, 80)
        pattern = SuccessPattern(
            pattern_title=f"Success pattern: {title}",
            pattern_description=(
                "The trace converged after following a stable tool sequence and explicit verification. "
                "Capture the sequence as reusable guidance."
            ),
            evidence_spans=evidence,
        )

        if bundle:
            content = (
                f"## Trace-Grounded Success Pattern: {title}\n\n"
                f"- When this kind of request appears: {trim_snippet(last_trace.userMessage, 160)}\n"
                f"- Favor the successful tool sequence observed in these traces.\n"
                f"- Re-check results before concluding, especially after multi-step edits.\n"
            )
            ops = [
                EditOp(
                    file_path="SKILL.md",
                    action="append_file_end",
                    content=content,
                    intent="workflow",
                    source_visibility="full",
                )
            ]
            patch = HypothesisPatch(
                patch_id=f"patch-{sha256_text(episode.episode_id + 'success')[:12]}",
                source_kind="success",
                target_skill_id=bundle.skill_id,
                family_id="",
                source_trace_ids=episode.trace_ids,
                source_thread_ids=[episode.thread_id],
                base_bundle_hash=bundle.bundle_hash,
                visible_files=["SKILL.md"],
                ops=ops,
                confidence=0.72,
                rationale="Episode ended successfully and exposes a repeatable tool-and-verification pattern.",
                evidence_spans=evidence,
            )
            return [pattern], [patch]
        return [pattern], []


# ---------------------------------------------------------------------------
# ErrorAnalyst (𝒜⁻)
# ---------------------------------------------------------------------------

class ErrorAnalyst:
    """Aligns with Trace2Skill 𝒜⁻, adapted for trace-only scenario.

    Key constraint: 我们没有真实环境，无法 replay agent 链路，无法验证修复。
    因此论文的 step 3 (validate with minimal fix) 和 step 4 (re-evaluate via replay)
    被替换为 trace-only 适配版本：

    Phase A (trace-only diagnosis):
    1. Understand failure surface — identify the observable symptom from traces
    2. Trace to agent behavior — locate the causal decision in the trace steps
    3. Cross-check against SKILL.md — ask "if this guidance existed, would the agent have avoided the mistake?"
    4. Assess confidence — rate how certain this diagnosis is given trace-only evidence

    Phase B uses a ReAct-style agent loop where the LLM autonomously decides
    whether to read additional markdown files or write the final patch. This
    replaces the previous three-layer file selection pipeline (BoundedMarkdownReAct
    → _assemble_visible_file_context → _coordinate_patch_context_with_llm).
    """

    def __init__(self, settings: Settings):
        self.settings = settings

    def analyze(
        self,
        episode: Episode,
        traces: list[ImportedTrace],
        bundle: SkillBundleMeta | None,
    ) -> tuple[list[FailureHypothesis], list[HypothesisPatch], list[str]]:
        if not _has_llm(self.settings):
            return [], [], ["LLM unavailable; ErrorAnalyst requires LLM"]

        notes: list[str] = []
        try:
            failure_surface, root_cause, diag_confidence = self._diagnose(traces, bundle)
        except Exception:
            logger.warning("ErrorAnalyst diagnosis failed", exc_info=True)
            return [], [], ["diagnosis LLM call failed"]

        evidence = _collect_evidence(traces, prefer_errors=True)
        hypothesis = FailureHypothesis(
            failure_surface=failure_surface,
            suspected_root_cause=root_cause,
            evidence_spans=evidence,
            confidence=diag_confidence,
        )

        if not bundle:
            return [hypothesis], [], notes + ["no bundle; skipping patch"]

        patch, react_notes = self._react_patch_loop(episode, bundle, hypothesis)
        notes.extend(react_notes)
        return [hypothesis], [patch] if patch else [], notes

    # -- Phase A: diagnosis -------------------------------------------------

    def _diagnose(self, traces: list[ImportedTrace], bundle: SkillBundleMeta | None = None) -> tuple[str, str, float]:
        llm = _get_llm(self.settings)
        traces_text = _format_traces_for_prompt(traces, prefer_errors=True)

        skill_context = ""
        if bundle:
            skill_context = _read_relative_file_safe(bundle, "SKILL.md")

        messages = [
            {
                "role": "system",
                "content": (
                    "You are a failure analyst (Error Analyst 𝒜⁻) for an AI agent system.\n\n"
                    "IMPORTANT CONSTRAINT: You are working in a trace-only scenario. You CANNOT replay the agent, "
                    "CANNOT re-run any tools, and CANNOT validate fixes in a real environment. "
                    "All your analysis must be grounded solely in the trace evidence provided.\n\n"
                    "Follow the trace-only diagnostic workflow:\n"
                    "1. **Understand failure surface** — identify what went wrong (the observable symptom from traces)\n"
                    "2. **Trace to agent behavior** — locate the specific decision or action step in the traces "
                    "that caused or contributed to the failure\n"
                    "3. **Cross-check against SKILL.md** — compare the agent's behavior with the current skill document. "
                    "Ask: what specific guidance is MISSING or INSUFFICIENT that, if present, would have led the agent "
                    "to make a different (correct) decision at the causal step?\n"
                    "4. **Assess confidence** — rate how certain you are about this diagnosis given trace-only evidence. "
                    "If the traces are ambiguous or the causal chain is unclear, say so explicitly.\n\n"
                    "Return JSON with exactly these fields:\n"
                    "- failure_surface: string (1-2 sentences, the observable symptom, max 220 chars)\n"
                    "- root_cause: string (2-3 sentences: what specific guidance is missing/wrong in the skill document)\n"
                    "- causal_chain: string (brief: agent did X at step N → skill didn't say Y → result was Z)\n"
                    "- confidence_note: string (how confident is this diagnosis given trace-only evidence? "
                    "mention any ambiguity)\n"
                    "- diagnosis_confidence: float (0.3-0.9, your confidence level for this diagnosis)\n"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"## Agent Traces\n{traces_text}\n\n"
                    f"## Current SKILL.md\n{skill_context}\n\n"
                    "Follow the trace-only diagnostic workflow and return the JSON."
                ),
            },
        ]

        result = llm.chat_json(messages, temperature=0.2)
        failure_surface = trim_snippet(result.get("failure_surface", ""), 220)
        root_cause = result.get("root_cause", "")
        confidence = float(result.get("diagnosis_confidence", 0.55))
        if not failure_surface or not root_cause:
            raise ValueError("LLM diagnosis returned empty failure_surface or root_cause")
        return failure_surface, root_cause, confidence

    # -- Phase B: ReAct patch loop ------------------------------------------

    def _react_patch_loop(
        self,
        episode: Episode,
        bundle: SkillBundleMeta,
        hypothesis: FailureHypothesis,
    ) -> tuple[HypothesisPatch | None, list[str]]:
        """Unified ReAct loop: the LLM reads files and writes patches in one loop.

        Each turn the LLM returns one JSON action:
        - {"action": "read_file", "file": "path", "reason": "..."} — request a markdown file
        - {"action": "write_patch", "edits": [...], "confidence": float, "rationale": "..."} — terminal

        The loop enforces max reads and hard token budget.
        """
        llm = _get_llm(self.settings)
        notes: list[str] = []
        max_reads = self.settings.error_analyst_react_max_reads
        hard_budget = self.settings.llm.markdown_hard_budget_tokens

        # file_contents dict tracks visible files; insertion-ordered (Python 3.7+)
        file_contents: dict[str, str] = {}
        skill_content = _read_relative_file_safe(bundle, "SKILL.md")
        if skill_content:
            file_contents["SKILL.md"] = skill_content
        else:
            notes.append("SKILL.md not found or empty")
            return None, notes

        used_tokens = _estimate_token_count(skill_content)
        reads_done = 0
        known_paths = {m.file_path for m in bundle.markdown_files}

        heading_tree = _build_heading_tree_text(bundle)
        existing_refs = [m.file_path for m in bundle.markdown_files if m.file_path.startswith("references/")]
        refs_context = ", ".join(existing_refs) if existing_refs else "(none)"

        system_prompt = (
            "You are a skill-evolution patch writer (Error Analyst 𝒜⁻) operating in a ReAct loop.\n\n"
            "Each turn you MUST return exactly one JSON action:\n\n"
            "**Option A — read a file before patching:**\n"
            '{"action": "read_file", "file": "bundle-relative path", "reason": "why you need it"}\n\n'
            "**Option B — write the patch (terminal action):**\n"
            "{\n"
            '  "action": "write_patch",\n'
            f"{_EDIT_JSON_SCHEMA}"
            '  "confidence": "float 0.4-0.9",\n'
            '  "rationale": "why these changes prevent the failure"\n'
            "}\n\n"
            "**Rules:**\n"
            f"- You may read at most {max_reads} additional files.\n"
            "- SKILL.md is always visible; do not request it.\n"
            "- Only request files that appear in the markdown catalog.\n"
            "- When you have enough context, choose write_patch.\n\n"
            f"{_PATCH_PLACEMENT_RULES}\n"
            f"{_MARKDOWN_FORMAT_RULES}\n"
            "**Content rules**:\n"
            "- Be concise and actionable — every sentence should change agent behavior.\n"
            "- Use conditional language: 'When X happens, do Y before Z'.\n"
            "- Include verification steps: 'After doing X, verify Y by checking Z'.\n"
            "- Ground in the specific failure: reference what went wrong and how to prevent it.\n"
        )

        # The loop has two phases:
        # 1. Read phase: up to max_reads successful reads (invalid reads don't count)
        #    Protected by a generous turn cap to prevent infinite invalid-read loops.
        # 2. Write phase: always guaranteed one final write turn after reads are done.
        max_turns = max_reads * 3 + 1  # generous cap for invalid reads
        force_write = False
        rejected_reads: list[str] = []

        for turn in range(max_turns):
            reads_remaining = max_reads - reads_done
            files_context = "\n\n".join(
                f"### {path}\n```markdown\n{content}\n```"
                for path, content in file_contents.items()
            )
            catalog_text = _build_markdown_catalog_text(bundle, list(file_contents))

            user_content = (
                f"## Failure Diagnosis\n"
                f"Failure surface: {hypothesis.failure_surface}\n"
                f"Root cause: {hypothesis.suspected_root_cause}\n\n"
                f"## Episode Context\n"
                f"User messages: {'; '.join(episode.user_messages[:3])}\n"
                f"Skills used: {', '.join(episode.used_skills)}\n\n"
                f"## SKILL.md heading structure\n{heading_tree}\n\n"
                f"## Existing references/ files\n{refs_context}\n\n"
                f"## Markdown Catalog (not-yet-visible files)\n{catalog_text}\n\n"
                f"## Visible Files (full content)\n{files_context}\n\n"
                f"Reads remaining: {0 if force_write else reads_remaining}\n"
                + (f"Previously rejected reads (do not re-request): {', '.join(rejected_reads)}\n" if rejected_reads else "")
                + f"{'You MUST choose write_patch now.' if force_write else 'Choose your action.'}"
            )

            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ]

            try:
                result = llm.chat_json(messages, temperature=0.2)
            except Exception:
                logger.warning("ReAct loop LLM call failed on turn %d", turn, exc_info=True)
                notes.append(f"LLM call failed on turn {turn}")
                break

            action = str(result.get("action", _ACTION_WRITE)).strip().lower()

            # Handle read_file action (only during read phase)
            if action == _ACTION_READ and not force_write and reads_done < max_reads:
                file_path = str(result.get("file", ""))
                reason = str(result.get("reason", ""))

                if file_path not in known_paths or file_path in file_contents:
                    notes.append(f"invalid/duplicate read request: {file_path}")
                    rejected_reads.append(file_path)
                    continue  # doesn't consume a read — retry
                if not is_allowed_markdown_relative_path(file_path):
                    notes.append(f"disallowed path: {file_path}")
                    rejected_reads.append(file_path)
                    continue

                content = _read_relative_file_safe(bundle, file_path)
                if not content:
                    notes.append(f"could not read {file_path}")
                    rejected_reads.append(file_path)
                    continue

                token_count = _estimate_token_count(content)
                if used_tokens + token_count > hard_budget:
                    notes.append(f"skipped {file_path}: would exceed hard budget ({used_tokens}+{token_count}>{hard_budget})")
                    rejected_reads.append(file_path)
                    continue

                file_contents[file_path] = content
                used_tokens += token_count
                reads_done += 1
                notes.append(f"opened {file_path} (reason: {reason}, tokens~{token_count})")
                continue

            # If LLM returned read_file but reads are exhausted, force a write turn
            if action == _ACTION_READ:
                notes.append("max reads exhausted; forcing write_patch turn")
                force_write = True
                continue

            # Process write_patch action
            raw_edits = result.get("edits", [])
            if not raw_edits:
                notes.append("LLM returned write_patch with no edits")
                return None, notes

            ops = _build_ops_from_llm_edits(raw_edits, bundle, list(file_contents))
            if not ops:
                notes.append("no valid ops after validation")
                return None, notes

            patch = HypothesisPatch(
                patch_id=f"patch-{sha256_text(episode.episode_id + hypothesis.failure_surface)[:12]}",
                source_kind="error",
                target_skill_id=bundle.skill_id,
                family_id="",
                source_trace_ids=episode.trace_ids,
                source_thread_ids=[episode.thread_id],
                base_bundle_hash=bundle.bundle_hash,
                visible_files=list(file_contents),
                ops=ops,
                confidence=float(result.get("confidence", 0.6)),
                rationale=result.get("rationale", "LLM-generated patch via ReAct loop."),
                risk_flags=["budget-limited"] if any("budget" in n for n in notes) else [],
                evidence_spans=hypothesis.evidence_spans,
            )
            return patch, notes

        notes.append("ReAct loop ended without producing a patch")
        return None, notes


# ---------------------------------------------------------------------------
# Shared: build EditOps from LLM JSON edits
# ---------------------------------------------------------------------------

def _build_ops_from_llm_edits(
    raw_edits: list[dict],
    bundle: SkillBundleMeta,
    visible_files: list[str],
) -> list[EditOp]:
    """Convert LLM-generated edit dicts into validated EditOp objects.

    The write protocol is intentionally small:
    - edit(old_string/new_string) for existing markdown text
    - append_file_end for appending a brand-new section or note
    - create for new markdown files
    """
    ops: list[EditOp] = []
    created_refs: set[str] = set()
    visible_file_set = set(visible_files)

    for raw in raw_edits[:6]:  # cap at 6 ops per patch
        file_path = raw.get("file", "SKILL.md")
        if not isinstance(file_path, str):
            continue
        op_type = raw.get("op", "append_file_end")
        content = raw.get("content", "")
        old_string = raw.get("old_string")
        new_string = raw.get("new_string")
        if op_type == "edit":
            if not isinstance(old_string, str) or not old_string:
                continue
            if not isinstance(new_string, str):
                continue
        elif not content.strip():
            continue

        intent = raw.get("intent", "guardrail")
        if intent not in _VALID_INTENTS:
            intent = "guardrail"

        # Determine if this is a file creation or an edit.
        # Existing files are only writable when they were fully visible in the prompt.
        is_existing_in_bundle = file_path in {m.file_path for m in bundle.markdown_files}
        is_visible_existing = file_path in visible_file_set
        is_create = op_type == "create" and not is_existing_in_bundle

        if is_create:
            if not is_allowed_markdown_relative_path(file_path):
                continue
            ops.append(EditOp(
                file_path=file_path,
                action="create_file",
                content=content,
                intent=intent,
                source_visibility="created",
            ))
            if file_path.startswith("references/"):
                created_refs.add(file_path)
        elif op_type == "append_file_end":
            if not is_visible_existing:
                continue
            if not is_allowed_markdown_relative_path(file_path):
                continue
            ops.append(EditOp(
                file_path=file_path,
                action="append_file_end",
                content=content,
                intent=intent,
                source_visibility="full",
            ))
        elif op_type == "edit":
            if not is_visible_existing:
                continue
            if not is_allowed_markdown_relative_path(file_path):
                continue
            ops.append(EditOp(
                file_path=file_path,
                action="edit",
                content=new_string,
                old_string=old_string,
                new_string=new_string,
                intent=intent,
                source_visibility="full",
            ))
        else:
            continue

    # Atomic create/link pair: if we created references/ files, ensure SKILL.md has links
    for ref_path in created_refs:
        has_link = any(
            op.file_path == "SKILL.md" and ref_path in op.content
            for op in ops
        )
        if not has_link:
            link_content = f"\n- See [{ref_path}]({ref_path}) for case-specific guidance.\n"
            ops.append(EditOp(
                file_path="SKILL.md",
                action="append_file_end",
                content=link_content,
                intent="reference",
                source_visibility="full",
            ))

    return ops


# ---------------------------------------------------------------------------
# Evidence collection (shared)
# ---------------------------------------------------------------------------

def _collect_evidence(traces: list[ImportedTrace], prefer_errors: bool) -> list[EvidenceSpan]:
    evidence: list[EvidenceSpan] = []
    iterable = list(reversed(traces)) if prefer_errors else traces
    for trace in iterable:
        if trace.errorMessage:
            evidence.append(
                EvidenceSpan(
                    trace_id=trace.traceId,
                    kind="error_message",
                    snippet=trim_snippet(trace.errorMessage, 180),
                )
            )
        for step in trace.steps:
            text = step.assistantText.strip()
            if text and any(keyword in text.lower() for keyword in _ERROR_KEYWORDS):
                evidence.append(
                    EvidenceSpan(
                        trace_id=trace.traceId,
                        step_index=step.index,
                        kind="assistant_text",
                        snippet=trim_snippet(text, 180),
                    )
                )
            for tool in step.toolCalls:
                if tool.result and any(keyword in tool.result.lower() for keyword in _ERROR_KEYWORDS):
                    evidence.append(
                        EvidenceSpan(
                            trace_id=trace.traceId,
                            step_index=step.index,
                            kind="tool_call",
                            snippet=trim_snippet(f"{tool.name}: {tool.result}", 180),
                        )
                    )
    if len(evidence) < 2 and traces:
        last_trace = traces[-1]
        for step in last_trace.steps[-2:]:
            evidence.append(
                EvidenceSpan(
                    trace_id=last_trace.traceId,
                    step_index=step.index,
                    kind="assistant_text",
                    snippet=trim_snippet(step.assistantText or "trace step without explicit text", 180),
                )
            )
    deduped: list[EvidenceSpan] = []
    seen: set[str] = set()
    for item in evidence:
        key = sha256_text(f"{item.trace_id}:{item.step_index}:{item.kind}:{item.snippet}")
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
        if len(deduped) >= 6:
            break
    return deduped
