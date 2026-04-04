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
  Phase B: patch planning + patch writing（支持 heading-level 落点 + references/ 路由）

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
    AnchorSpec,
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
from trace_evolver.utils import is_allowed_markdown_relative_path, sha256_text, slugify, tokenize, trim_snippet

logger = logging.getLogger(__name__)


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
    error_keywords = {"error", "fail", "retry", "wrong", "invalid", "mismatch", "exception", "traceback"}
    error_indices: set[int] = set()
    for i, step in enumerate(trace.steps):
        text = (step.assistantText or "").lower()
        tool_text = " ".join((t.result or "") for t in step.toolCalls).lower()
        if any(kw in text or kw in tool_text for kw in error_keywords):
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


def _assemble_visible_file_context(
    bundle: SkillBundleMeta,
    selected_files: list[str],
    hard_budget_tokens: int,
) -> tuple[list[str], dict[str, str], list[str]]:
    """
    把候选文件收敛到真正进入 prompt 的"完整可见文件"集合。

    规则：
    - 已经选中的文件，仍然要经过 hard budget 控制
    - 只有真正进入 prompt 的文件，才允许后续 patch 修改
    - 超预算的文件会被剔除，而不是截断后继续当作 full-visible
    """
    full_visible_files: list[str] = []
    file_contents: dict[str, str] = {}
    notes: list[str] = []
    used_tokens = 0

    for path in selected_files:
        content = _read_relative_file_safe(bundle, path)
        if not content:
            continue
        token_count = _estimate_token_count(content)
        if full_visible_files and used_tokens + token_count > hard_budget_tokens:
            notes.append(f"skipped {path} because it would exceed markdown hard budget")
            continue
        full_visible_files.append(path)
        file_contents[path] = content
        used_tokens += token_count

    return full_visible_files, file_contents, notes


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


def _normalize_read_requests(raw_requests: list[dict], bundle: SkillBundleMeta, visible_files: list[str]) -> list[str]:
    """Validate planner requests and keep only bundle-local markdown paths.

    The coordinator may let the model decide *what else it wants to read*, but
    the system decides whether the request is valid and actionable.
    """
    known_paths = {meta.file_path for meta in bundle.markdown_files}
    visible_set = set(visible_files)
    normalized: list[str] = []
    for raw in raw_requests[:4]:
        path = raw.get("file")
        if not isinstance(path, str):
            continue
        if path in visible_set:
            continue
        if path not in known_paths:
            continue
        if not is_allowed_markdown_relative_path(path):
            continue
        normalized.append(path)
    return normalized


def _expand_visible_file_context(
    bundle: SkillBundleMeta,
    current_visible_files: list[str],
    current_contents: dict[str, str],
    requested_files: list[str],
    *,
    hard_budget_tokens: int,
    max_files: int,
) -> tuple[list[str], dict[str, str], list[str]]:
    """Promote planner-approved files from catalog visibility to full visibility."""
    visible_files = list(current_visible_files)
    contents = dict(current_contents)
    notes: list[str] = []
    used_tokens = sum(_estimate_token_count(text) for text in contents.values())

    for path in requested_files:
        if path in contents:
            continue
        if len(visible_files) >= max_files:
            notes.append(f"skipped {path} because markdown file limit was reached")
            continue
        content = _read_relative_file_safe(bundle, path)
        if not content:
            notes.append(f"skipped {path} because the file could not be read")
            continue
        token_count = _estimate_token_count(content)
        if used_tokens + token_count > hard_budget_tokens:
            notes.append(f"skipped {path} because it would exceed markdown hard budget")
            continue
        visible_files.append(path)
        contents[path] = content
        used_tokens += token_count
        notes.append(f"opened {path} after planner request")

    return visible_files, contents, notes


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
                    "You must propose WHERE in the skill document each insight belongs.\n"
                    "Look at the existing heading structure and decide:\n"
                    "- If a relevant section exists → insert under that heading (use target_section)\n"
                    "- If no relevant section exists → create a new ## section\n\n"
                    "Return JSON with exactly these fields:\n"
                    "{\n"
                    '  "patterns": [\n'
                    "    {\n"
                    '      "title": "string — concise pattern title",\n'
                    '      "description": "string — 2-3 sentences describing the reusable pattern",\n'
                    '      "frequency_hint": "string — how common this pattern is across the traces"\n'
                    "    }\n"
                    "  ],\n"
                    '  "edits": [\n'
                    "    {\n"
                    '      "file": "SKILL.md or references/*.md",\n'
                    '      "target_section": "heading text to insert after, or null for new section at end",\n'
                    '      "content": "markdown content to insert",\n'
                    '      "intent": "one of: trigger, workflow, guardrail, example, reference, metadata"\n'
                    "    }\n"
                    "  ],\n"
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
        raw_patterns = result.get("patterns", [])
        patterns = [
            SuccessPattern(
                pattern_title=p.get("title", "Success pattern"),
                pattern_description=p.get("description", ""),
                evidence_spans=_collect_evidence(traces, prefer_errors=False),
            )
            for p in raw_patterns[:5]
        ]
        if not patterns:
            patterns = [SuccessPattern(
                pattern_title="Success pattern",
                pattern_description=result.get("rationale", ""),
                evidence_spans=_collect_evidence(traces, prefer_errors=False),
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
            evidence_spans=_collect_evidence(traces, prefer_errors=False),
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
                    action="insert_after",
                    anchor=AnchorSpec(anchor_type="file_end", text_hint="append at file end"),
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

    Phase B generates structured patches with heading-level placement
    and references/ routing for low-prevalence patterns.
    """

    def __init__(self, settings: Settings):
        self.settings = settings
        self.react = BoundedMarkdownReAct(settings)

    def analyze(
        self,
        episode: Episode,
        traces: list[ImportedTrace],
        bundle: SkillBundleMeta | None,
    ) -> tuple[list[FailureHypothesis], list[HypothesisPatch], list[str]]:
        failure_surface, root_cause = self._diagnose(traces, bundle)
        evidence = _collect_evidence(traces, prefer_errors=True)
        selected_files, selected_spans, notes = self.react.select(failure_surface, episode, bundle)

        hypothesis = FailureHypothesis(
            failure_surface=failure_surface,
            suspected_root_cause=root_cause,
            evidence_spans=evidence,
            confidence=min(0.9, 0.55 + 0.07 * len(evidence)),
        )

        if len(evidence) < 2:
            return [hypothesis], [], notes + ["insufficient evidence spans"]

        patch = self._write_patch(episode, bundle, hypothesis, selected_files, selected_spans)
        return [hypothesis], [patch] if patch else [], notes

    # -- Phase A: diagnosis -------------------------------------------------

    def _diagnose(self, traces: list[ImportedTrace], bundle: SkillBundleMeta | None = None) -> tuple[str, str]:
        if _has_llm(self.settings):
            return self._diagnose_with_llm(traces, bundle)
        return self._diagnose_heuristic(traces)

    def _diagnose_with_llm(self, traces: list[ImportedTrace], bundle: SkillBundleMeta | None = None) -> tuple[str, str]:
        llm = _get_llm(self.settings)
        traces_text = _format_traces_for_prompt(traces, prefer_errors=True)

        # Include current SKILL.md so LLM can identify what guidance is missing
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

        try:
            result = llm.chat_json(messages, temperature=0.2)
            failure_surface = trim_snippet(result.get("failure_surface", ""), 220)
            root_cause = result.get("root_cause", "")
            if failure_surface and root_cause:
                return failure_surface, root_cause
        except Exception:
            logger.warning("LLM call failed for ErrorAnalyst._diagnose, falling back to heuristic", exc_info=True)

        return self._diagnose_heuristic(traces)

    def _diagnose_heuristic(self, traces: list[ImportedTrace]) -> tuple[str, str]:
        primary = next((trace for trace in reversed(traces) if trace.outcome != "success"), traces[-1])
        failure_surface = trim_snippet(
            primary.errorMessage
            or next((step.assistantText for step in reversed(primary.steps) if step.assistantText.strip()), "")
            or f"Run ended with outcome={primary.outcome}",
            220,
        )
        all_tools = " ".join(tool.name for trace in traces for step in trace.steps for tool in step.toolCalls).lower()
        if any(token in all_tools for token in ("write", "edit", "patch", "apply")):
            root_cause = (
                "The workflow changed content without enough verification or boundary checks, so the skill should add "
                "explicit decision points and post-change checks."
            )
        else:
            root_cause = (
                "The workflow lacked explicit guidance for choosing the next investigation step, so the skill should "
                "make the diagnosis order and verification criteria more concrete."
            )
        return failure_surface, root_cause

    # -- Phase B: patch writing ---------------------------------------------

    def _write_patch(
        self,
        episode: Episode,
        bundle: SkillBundleMeta | None,
        hypothesis: FailureHypothesis,
        selected_files: list[str],
        selected_spans: list[SelectedSpan],
    ) -> HypothesisPatch | None:
        if _has_llm(self.settings) and bundle:
            result = self._write_patch_with_llm(episode, bundle, hypothesis, selected_files, selected_spans)
            if result is not None:
                return result
        return self._write_patch_heuristic(episode, bundle, hypothesis, selected_files, selected_spans)

    def _write_patch_with_llm(
        self,
        episode: Episode,
        bundle: SkillBundleMeta,
        hypothesis: FailureHypothesis,
        selected_files: list[str],
        selected_spans: list[SelectedSpan],
    ) -> HypothesisPatch | None:
        llm = _get_llm(self.settings)

        full_visible_files, file_contents, budget_notes = _assemble_visible_file_context(
            bundle,
            selected_files,
            self.settings.llm.markdown_hard_budget_tokens,
        )
        if "SKILL.md" not in full_visible_files:
            logger.warning("SKILL.md was not fully visible after budget filtering; falling back to heuristic patch writing")
            return None

        full_visible_files, file_contents, planning_notes = self._coordinate_patch_context_with_llm(
            episode,
            bundle,
            hypothesis,
            full_visible_files,
            file_contents,
            selected_spans,
        )

        files_context = "\n\n".join(
            f"### {path}\n```markdown\n{content}\n```"
            for path, content in file_contents.items()
        )

        heading_tree = _build_heading_tree_text(bundle)

        # List existing references/ files so LLM knows what's available
        existing_refs = [m.file_path for m in bundle.markdown_files if m.file_path.startswith("references/")]
        refs_context = ", ".join(existing_refs) if existing_refs else "(none)"

        messages = [
            {
                "role": "system",
                "content": (
                    "You are a skill-evolution patch writer (Error Analyst 𝒜⁻, Phase B).\n\n"
                    "Based on a trace-only failure diagnosis (NOT validated via replay) and the current skill bundle, "
                    "generate patch operations. Your patches are hypotheses grounded in trace evidence, not proven fixes.\n\n"
                    "**Patch placement rules** (critical for quality):\n"
                    "- Look at the existing heading structure. If a relevant section exists, insert UNDER that heading "
                    "(set target_section to the heading text). Do NOT always append to file end.\n"
                    "- If no existing section fits, create a new ## section with a descriptive name.\n"
                    "- For niche/case-specific guidance that doesn't belong in the main workflow, route to "
                    "references/*.md instead of SKILL.md.\n"
                    "- If you create a new references/*.md file, you MUST also add a link to it in SKILL.md "
                    "(atomic create/link pair — keep both or drop both).\n\n"
                    "**Content rules**:\n"
                    "- Be concise and actionable — every sentence should change agent behavior\n"
                    "- Use conditional language: 'When X happens, do Y before Z'\n"
                    "- Include verification steps: 'After doing X, verify Y by checking Z'\n"
                    "- Ground in the specific failure: reference what went wrong and how to prevent it\n\n"
                    "Return JSON:\n"
                    "{\n"
                    '  "edits": [\n'
                    "    {\n"
                    '      "file": "SKILL.md or references/xxx.md",\n'
                    '      "op": "insert_after or create",\n'
                    '      "target_section": "existing heading text to insert after, or null for file end / new file",\n'
                    '      "content": "markdown content",\n'
                    '      "intent": "one of: trigger, workflow, guardrail, example, reference, metadata"\n'
                    "    }\n"
                    "  ],\n"
                    '  "confidence": "float 0.4-0.9",\n'
                    '  "rationale": "why these changes prevent the failure"\n'
                    "}\n"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"## Failure Diagnosis\n"
                    f"Failure surface: {hypothesis.failure_surface}\n"
                    f"Root cause: {hypothesis.suspected_root_cause}\n\n"
                    f"## Episode Context\n"
                    f"User messages: {'; '.join(episode.user_messages[:3])}\n"
                    f"Skills used: {', '.join(episode.used_skills)}\n\n"
                    f"## SKILL.md heading structure\n{heading_tree}\n\n"
                    f"## Existing references/ files\n{refs_context}\n\n"
                    f"## Visible Files (full content)\n{files_context}\n\n"
                    "Generate patch operations to prevent this failure pattern."
                ),
            },
        ]

        try:
            result = llm.chat_json(messages, temperature=0.3)
        except Exception:
            logger.warning("LLM call failed for ErrorAnalyst._write_patch, falling back to heuristic", exc_info=True)
            return None

        raw_edits = result.get("edits", [])
        if not raw_edits:
            return None

        ops = _build_ops_from_llm_edits(raw_edits, bundle, full_visible_files)
        if not ops:
            return None

        return HypothesisPatch(
            patch_id=f"patch-{sha256_text(episode.episode_id + hypothesis.failure_surface)[:12]}",
            source_kind="error",
            target_skill_id=bundle.skill_id,
            family_id="",
            source_trace_ids=episode.trace_ids,
            source_thread_ids=[episode.thread_id],
            base_bundle_hash=bundle.bundle_hash,
            visible_files=list(full_visible_files),
            ops=ops,
            confidence=float(result.get("confidence", 0.6)),
            rationale=result.get("rationale", "LLM-generated patch based on trace failure analysis."),
            risk_flags=(
                ["markdown-budget-limited"] if (budget_notes or planning_notes) else []
            ),
            evidence_spans=hypothesis.evidence_spans,
        )

    def _coordinate_patch_context_with_llm(
        self,
        episode: Episode,
        bundle: SkillBundleMeta,
        hypothesis: FailureHypothesis,
        full_visible_files: list[str],
        file_contents: dict[str, str],
        selected_spans: list[SelectedSpan],
    ) -> tuple[list[str], dict[str, str], list[str]]:
        """Allow one bounded planning loop where the model can request more files.

        The model does not get to modify a file just because it knows the path.
        Instead it can request a full read, and the coordinator upgrades the
        file's visibility only if the request stays within file and token
        budgets. Patch generation always happens after this visibility pass.
        """
        llm = _get_llm(self.settings)
        notes: list[str] = []
        current_visible = list(full_visible_files)
        current_contents = dict(file_contents)

        for round_index in range(self.settings.markdown_patch_planning_max_rounds):
            visible_summary = "\n".join(f"- {path}" for path in current_visible)
            selected_span_text = "\n".join(
                f"- {span.file_path}: {span.reason}; heading={span.heading or '(none)'}"
                for span in selected_spans[:8]
            ) or "(none)"
            messages = [
                {
                    "role": "system",
                    "content": (
                        "You are a bounded markdown planning assistant.\n\n"
                        "Your job is NOT to write patches yet. First decide whether the currently visible "
                        "files are sufficient to safely write a patch for the diagnosed failure.\n"
                        "You may request additional FULL markdown files, but only when they are necessary.\n\n"
                        "Return JSON only:\n"
                        "{\n"
                        '  "action": "read_more or write_patch",\n'
                        '  "read_requests": [\n'
                        "    {\n"
                        '      "file": "bundle-local markdown path",\n'
                        '      "reason": "why full visibility is needed before editing or linking"\n'
                        "    }\n"
                        "  ],\n"
                        '  "notes": ["optional short planning notes"]\n'
                        "}\n"
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"## Failure Diagnosis\n"
                        f"Failure surface: {hypothesis.failure_surface}\n"
                        f"Root cause: {hypothesis.suspected_root_cause}\n\n"
                        f"## Episode Context\n"
                        f"User messages: {'; '.join(episode.user_messages[:3])}\n"
                        f"Skills used: {', '.join(episode.used_skills)}\n\n"
                        f"## Currently Visible Files\n{visible_summary}\n\n"
                        f"## Selected Relevant Spans\n{selected_span_text}\n\n"
                        f"## Markdown Catalog\n{_build_markdown_catalog_text(bundle, current_visible)}\n\n"
                        "If you need another file in full before writing the patch, request it now. "
                        "Otherwise return action=write_patch."
                    ),
                },
            ]

            try:
                result = llm.chat_json(messages, temperature=0.1)
            except Exception:
                logger.warning("LLM planning step failed; continuing with current visible files", exc_info=True)
                notes.append("planner failed; used current visible files")
                break

            notes.extend(str(note) for note in result.get("notes", [])[:4] if str(note).strip())
            action = str(result.get("action", "write_patch")).strip().lower()
            if action != "read_more":
                break

            requested_files = _normalize_read_requests(
                result.get("read_requests", []),
                bundle,
                current_visible,
            )
            if not requested_files:
                notes.append("planner requested more context without valid file targets")
                break

            current_visible, current_contents, expand_notes = _expand_visible_file_context(
                bundle,
                current_visible,
                current_contents,
                requested_files,
                hard_budget_tokens=self.settings.llm.markdown_hard_budget_tokens,
                max_files=self.settings.markdown_react_max_files,
            )
            notes.extend(expand_notes)

            if not any(note.startswith("opened ") for note in expand_notes):
                notes.append("planner requests could not be satisfied; continuing with current visible files")
                break

        return current_visible, current_contents, notes

    def _write_patch_heuristic(
        self,
        episode: Episode,
        bundle: SkillBundleMeta | None,
        hypothesis: FailureHypothesis,
        selected_files: list[str],
        selected_spans: list[SelectedSpan],
    ) -> HypothesisPatch | None:
        family_hint = slugify(" ".join(episode.user_messages[:1] + episode.used_skills[:2]), "trace-family")
        if bundle is None:
            skill_name = f"trace-family-{family_hint}"
            description = trim_snippet(episode.user_messages[0], 120)
            content = (
                f"---\nname: {skill_name}\ndescription: {description}\n---\n\n"
                "# Trace-Grounded Skill\n\n"
                "## Failure Surface\n\n"
                f"{hypothesis.failure_surface}\n\n"
                "## Workflow\n\n"
                f"- {hypothesis.suspected_root_cause}\n"
                "- Re-read the relevant markdown guidance before applying edits.\n"
                "- Verify the final state before concluding the run.\n"
            )
            ops = [
                EditOp(
                    file_path="SKILL.md",
                    action="create_file",
                    content=content,
                    intent="workflow",
                    source_visibility="created",
                )
            ]
            visible_files: list[str] = []
            base_bundle_hash = sha256_text("")
            target_skill_id = None
        else:
            primary_content = (
                f"## Trace-Grounded Failure Pattern: {trim_snippet(hypothesis.failure_surface, 72)}\n\n"
                f"- Failure surface: {hypothesis.failure_surface}\n"
                f"- Suspected root cause: {hypothesis.suspected_root_cause}\n"
                "- Before editing, identify the exact target and the verification step that will prove the change helped.\n"
                "- After editing, re-check the final state instead of assuming the first fix is sufficient.\n"
            )
            ops = [
                EditOp(
                    file_path="SKILL.md",
                    action="insert_after",
                    anchor=AnchorSpec(anchor_type="file_end", text_hint="append at file end"),
                    content=primary_content,
                    intent="guardrail",
                    source_visibility="full",
                )
            ]
            visible_files = list(selected_files)
            base_bundle_hash = bundle.bundle_hash
            target_skill_id = bundle.skill_id

            extra_targets = [path for path in selected_files if path != "SKILL.md"]
            if extra_targets:
                chosen = extra_targets[0]
                chosen_span = next((span for span in selected_spans if span.file_path == chosen), None)
                extra_content = (
                    f"\n## Trace-Grounded Note: {trim_snippet(hypothesis.failure_surface, 64)}\n\n"
                    f"- Why this file matters: {chosen_span.reason if chosen_span else 'selected by markdown search'}\n"
                    f"- Observed issue: {hypothesis.failure_surface}\n"
                    f"- Suggested reminder: {hypothesis.suspected_root_cause}\n"
                )
                ops.append(
                    EditOp(
                        file_path=chosen,
                        action="insert_after",
                        anchor=AnchorSpec(anchor_type="file_end", text_hint="append at file end"),
                        content=extra_content,
                        intent="reference",
                        source_visibility="full",
                    )
                )

        return HypothesisPatch(
            patch_id=f"patch-{sha256_text(episode.episode_id + hypothesis.failure_surface)[:12]}",
            source_kind="error",
            target_skill_id=target_skill_id,
            family_id="",
            source_trace_ids=episode.trace_ids,
            source_thread_ids=[episode.thread_id],
            base_bundle_hash=base_bundle_hash,
            visible_files=visible_files,
            ops=ops,
            confidence=hypothesis.confidence,
            rationale=(
                "Patch is grounded in trace-only failure evidence and adds guidance that would have made the failure "
                "surface explicit earlier in the workflow."
            ),
            risk_flags=[],
            evidence_spans=hypothesis.evidence_spans,
        )


# ---------------------------------------------------------------------------
# Shared: build EditOps from LLM JSON edits
# ---------------------------------------------------------------------------

def _build_ops_from_llm_edits(
    raw_edits: list[dict],
    bundle: SkillBundleMeta,
    visible_files: list[str],
) -> list[EditOp]:
    """Convert LLM-generated edit dicts into validated EditOp objects.

    Supports heading-level target_section anchors and references/ file creation
    with atomic create/link pair validation.
    """
    VALID_INTENTS = {"trigger", "workflow", "guardrail", "example", "reference", "metadata"}
    ops: list[EditOp] = []
    created_refs: set[str] = set()
    visible_file_set = set(visible_files)

    for raw in raw_edits[:6]:  # cap at 6 ops per patch
        file_path = raw.get("file", "SKILL.md")
        if not isinstance(file_path, str):
            continue
        content = raw.get("content", "")
        if not content.strip():
            continue

        intent = raw.get("intent", "guardrail")
        if intent not in VALID_INTENTS:
            intent = "guardrail"

        op_type = raw.get("op", "insert_after")
        target_section = raw.get("target_section")

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
        else:
            if not is_visible_existing:
                continue
            if not is_allowed_markdown_relative_path(file_path):
                continue

            # Build anchor from target_section
            anchor = _build_anchor_from_target_section(target_section)

            ops.append(EditOp(
                file_path=file_path,
                action="insert_after",
                anchor=anchor,
                content=content,
                intent=intent,
                source_visibility="full",
            ))

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
                action="insert_after",
                anchor=AnchorSpec(anchor_type="file_end", text_hint="append at file end"),
                content=link_content,
                intent="reference",
                source_visibility="full",
            ))

    return ops


def _build_anchor_from_target_section(target_section: str | None) -> AnchorSpec:
    """Convert a target_section string from LLM into an AnchorSpec.

    If target_section is a heading (e.g. "Workflow"), build a heading anchor.
    Otherwise fall back to file_end.
    """
    if not target_section or target_section.lower() in ("null", "none", "end", "file_end"):
        return AnchorSpec(anchor_type="file_end", text_hint="append at file end")

    # Strip leading # if the LLM included markdown heading syntax
    cleaned = target_section.lstrip("#").strip()
    if cleaned:
        return AnchorSpec(
            anchor_type="heading",
            heading_path=[cleaned],
            text_hint=cleaned,
        )
    return AnchorSpec(anchor_type="file_end", text_hint="append at file end")


# ---------------------------------------------------------------------------
# Evidence collection (shared)
# ---------------------------------------------------------------------------

def _collect_evidence(traces: list[ImportedTrace], prefer_errors: bool) -> list[EvidenceSpan]:
    evidence: list[EvidenceSpan] = []
    keywords = ("error", "fail", "retry", "wrong", "invalid", "mismatch", "exception", "traceback")
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
            if text and any(keyword in text.lower() for keyword in keywords):
                evidence.append(
                    EvidenceSpan(
                        trace_id=trace.traceId,
                        step_index=step.index,
                        kind="assistant_text",
                        snippet=trim_snippet(text, 180),
                    )
                )
            for tool in step.toolCalls:
                if tool.result and any(keyword in tool.result.lower() for keyword in keywords):
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
