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

from trace_evolver.artifacts import (
    format_artifact_catalog,
    format_artifact_summary_line,
    get_artifact_content,
)
from trace_evolver.config import Settings
from trace_evolver.llm import LLMClient
from trace_evolver.schemas import (
    EditOp,
    Episode,
    EvidenceSpan,
    FailureHypothesis,
    FeedbackDigest,
    HypothesisPatch,
    ImportedTrace,
    MarkdownFileMeta,
    SelectedSpan,
    SkillBundleMeta,
    SuccessPattern,
)
from trace_evolver.utils import compress_text_for_llm, is_allowed_markdown_relative_path, sha256_text, tokenize, trim_snippet

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

_ERROR_KEYWORDS = frozenset({
    "error", "fail", "retry", "wrong", "invalid", "mismatch", "exception", "traceback",
    "错误", "失败", "重试", "异常", "无效", "不匹配",
})

_VALID_INTENTS = frozenset({"trigger", "workflow", "guardrail", "example", "reference", "metadata"})

import re as _re

# Detect clearly truncated / incomplete content — NOT legitimate uses of
# "...", "TODO", etc. in documentation or code examples.
# Matches only: a line that is *nothing but* dots/ellipsis, or explicit
# truncation markers like "…(truncated)", "<!-- placeholder -->".
_TRUNCATION_RE = _re.compile(
    r"^\s*\.{3,}\s*$"                  # line consisting only of "..."
    r"|^\s*…\s*$"                      # line consisting only of "…"
    r"|\.\.\.\s*\(truncated\)"         # ...(truncated)
    r"|…\s*\(truncated\)"             # …(truncated)
    r"|<!--\s*placeholder\s*-->"       # <!-- placeholder -->
    r"|<\s*placeholder\s*/?\s*>",      # <placeholder/> or <placeholder>
    _re.IGNORECASE | _re.MULTILINE,
)


def _has_placeholder(text: str) -> str | None:
    """Return a reason string if text contains truncation/placeholder markers, else None.

    Only flags clearly incomplete content (bare ellipsis lines, explicit truncation
    markers).  Legitimate uses of '...' in code examples, TODO in task descriptions,
    or FIXME in comments are intentionally NOT matched.
    """
    m = _TRUNCATION_RE.search(text)
    if m:
        return f"truncation marker detected: {m.group()!r}"
    return None


_ACTION_READ = "read_file"
_ACTION_READ_ARTIFACT = "read_artifact"
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
# Feedback extraction (pure Python, no LLM)
# ---------------------------------------------------------------------------

# Correction signal words — user is pointing out a mistake or giving a requirement
_CORRECTION_SIGNALS_ZH = frozenset({
    "不", "没有", "没", "不要", "冲突", "同步", "覆写", "覆盖",
    "不对", "错", "问题", "重叠", "缺少", "漏", "忘",
})
_CORRECTION_SIGNALS_EN = frozenset({
    "not", "don't", "didn't", "doesn't", "wrong", "shouldn't", "never",
    "missing", "forgot", "conflict", "override", "sync", "mismatch",
    "broken", "fail", "overlap",
})

# Requirement signal words — user is stating what should happen
_REQUIREMENT_SIGNALS_ZH = frozenset({
    "要", "必须", "应该", "需要", "先", "之前", "同时", "按照", "遵循",
})
_REQUIREMENT_SIGNALS_EN = frozenset({
    "must", "should", "always", "before", "first", "together", "follow",
    "ensure", "require", "simultaneously",
})

# Technical detail signals — likely needs artifact inspection to understand
_ARTIFACT_QUESTION_SIGNALS = frozenset({
    "重叠", "overlap", "截断", "truncat", "乱码", "garble",
    "报错", "stack", "traceback", "截图", "screenshot",
})


def _extract_feedback_digest(
    episode: Episode,
    traces: list[ImportedTrace] | None = None,
) -> FeedbackDigest:
    """Extract structured feedback from episode user messages.

    Skips the first message (initial task request) and treats subsequent
    messages as corrections/feedback.  Pure heuristic — no LLM call.
    """
    complaints: list[str] = []
    requirements: list[str] = []
    artifact_questions: list[str] = []

    # Subsequent messages (after the first) are typically corrections
    correction_messages = episode.user_messages[1:] if len(episode.user_messages) > 1 else []

    for msg in correction_messages:
        msg_lower = msg.lower()
        msg_tokens = set(msg_lower.split())

        is_complaint = bool(
            msg_tokens & _CORRECTION_SIGNALS_EN
            or any(sig in msg for sig in _CORRECTION_SIGNALS_ZH)
        )
        is_requirement = bool(
            msg_tokens & _REQUIREMENT_SIGNALS_EN
            or any(sig in msg for sig in _REQUIREMENT_SIGNALS_ZH)
        )
        needs_artifact = bool(
            msg_tokens & _ARTIFACT_QUESTION_SIGNALS
            or any(sig in msg_lower for sig in _ARTIFACT_QUESTION_SIGNALS)
        )

        if is_complaint:
            complaints.append(msg)
        if is_requirement:
            requirements.append(msg)
        if needs_artifact and not is_complaint:
            artifact_questions.append(msg)

    # Find repeated themes across traces (keywords that appear in 2+ trace userMessages)
    repeated_themes: list[str] = []
    if len(correction_messages) >= 2:
        from collections import Counter
        # Extract meaningful correction keywords from each message
        all_keywords: list[str] = []
        for msg in correction_messages:
            msg_lower = msg.lower()
            for sig in _CORRECTION_SIGNALS_ZH | _REQUIREMENT_SIGNALS_ZH:
                if sig in msg:
                    all_keywords.append(sig)
            for sig in _CORRECTION_SIGNALS_EN | _REQUIREMENT_SIGNALS_EN:
                if sig in msg_lower.split():
                    all_keywords.append(sig)
        counts = Counter(all_keywords)
        repeated_themes = [kw for kw, count in counts.most_common() if count >= 2]

    # Infer likely skill gaps from complaints — domain-agnostic patterns only.
    # We detect *structural* gap types (missed pre-read, sync violation, override
    # violation) without assuming which files, frameworks, or languages are involved.
    skill_gaps: list[str] = []
    all_complaints_text = " ".join(complaints).lower()

    # Gap: agent skipped reading a mandatory reference file
    if any(x in all_complaints_text for x in [
        "没有读", "没读", "没看", "didn't read", "没有看", "not read",
        "you didn't", "你都没有", "没有按照", "没按照",
    ]):
        skill_gaps.append("agent skipped a mandatory pre-read step mentioned by the user")

    # Gap: agent failed to keep related outputs in sync
    if any(x in all_complaints_text for x in [
        "同步", "sync", "不同步", "没有完全同步", "not in sync", "out of sync",
        "inconsistent", "不一致",
    ]):
        skill_gaps.append("related outputs were not kept in sync after changes")

    # Gap: agent violated an explicit constraint / overrode protected defaults
    if any(x in all_complaints_text for x in [
        "覆写", "override", "覆盖", "overwrite", "冲突", "conflict",
        "硬规则", "hard rule", "违反", "violat",
    ]):
        skill_gaps.append("agent violated an explicit constraint or overrode protected defaults")

    return FeedbackDigest(
        user_complaints=complaints,
        explicit_requirements=requirements,
        repeated_themes=repeated_themes,
        likely_skill_gaps=skill_gaps,
        artifact_questions=artifact_questions,
    )


def _format_feedback_for_prompt(digest: FeedbackDigest) -> str:
    """Render a FeedbackDigest into a prompt section."""
    if not any([digest.user_complaints, digest.explicit_requirements, digest.repeated_themes, digest.likely_skill_gaps]):
        return ""
    parts: list[str] = ["## Highest Priority: User Feedback\n"]
    if digest.user_complaints:
        parts.append("**User complaints (verbatim):**")
        for c in digest.user_complaints:
            parts.append(f"- \"{c}\"")
        parts.append("")
    if digest.explicit_requirements:
        parts.append("**Explicit requirements:**")
        for r in digest.explicit_requirements:
            parts.append(f"- \"{r}\"")
        parts.append("")
    if digest.likely_skill_gaps:
        parts.append("**Likely skill gaps (inferred):**")
        for g in digest.likely_skill_gaps:
            parts.append(f"- {g}")
        parts.append("")
    if digest.repeated_themes:
        parts.append(f"**Repeated themes across traces:** {', '.join(digest.repeated_themes)}")
        parts.append("")
    parts.append(
        "You MUST address every user complaint above. "
        "If a complaint already identifies a missing workflow rule, write a concrete, "
        "executable skill-level guardrail — not an abstract checklist.\n"
    )
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _trace_lookup(traces: list[ImportedTrace]) -> dict[str, ImportedTrace]:
    return {trace.traceId: trace for trace in traces}


def _collect_episode_traces(episode: Episode, trace_map: dict[str, ImportedTrace]) -> list[ImportedTrace]:
    return [trace_map[trace_id] for trace_id in episode.trace_ids if trace_id in trace_map]


def _read_relative_file(bundle: SkillBundleMeta, relative_path: str) -> str:
    return (Path(bundle.root_path) / relative_path).read_text(encoding="utf-8")


def _read_relative_file_safe(
    bundle: SkillBundleMeta,
    relative_path: str,
    *,
    max_chars: int | None = None,
) -> str:
    """Read file, return empty string on failure."""
    try:
        content = _read_relative_file(bundle, relative_path)
    except (FileNotFoundError, OSError):
        return ""
    if max_chars is not None:
        return compress_text_for_llm(content, max_chars, label=relative_path)
    return content


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
        # Append artifact summary if available
        art_line = format_artifact_summary_line(trace.artifact_index)
        if art_line:
            block += f"  artifacts: {art_line}\n"
        if len(block) > budget:
            block = compress_text_for_llm(block, budget, label=f"trace:{trace.traceId}")
        parts.append(block)
        budget -= len(block)
        if budget <= 0:
            break
    return compress_text_for_llm("\n".join(parts), max_chars, label="trace prompt")


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
        traces_text = _format_traces_for_prompt(
            traces,
            max_chars=self.settings.llm_max_trace_chars,
            prefer_errors=False,
        )

        skill_context = ""
        heading_tree = ""
        if bundle:
            skill_context = _read_relative_file_safe(
                bundle,
                "SKILL.md",
                max_chars=self.settings.llm_max_skill_file_chars,
            )
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
        ops, _rej = _build_ops_from_llm_edits(result.get("edits", []), bundle, ["SKILL.md"])
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

        # Pre-LLM: extract structured user feedback
        feedback = _extract_feedback_digest(episode, traces)

        notes: list[str] = []
        try:
            failure_surface, root_cause, diag_confidence = self._diagnose(traces, bundle, feedback)
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

        patch, react_notes = self._react_patch_loop(episode, bundle, hypothesis, traces, feedback)
        notes.extend(react_notes)
        return [hypothesis], [patch] if patch else [], notes

    # -- Phase A: diagnosis -------------------------------------------------

    def _diagnose(
        self,
        traces: list[ImportedTrace],
        bundle: SkillBundleMeta | None = None,
        feedback: FeedbackDigest | None = None,
    ) -> tuple[str, str, float]:
        llm = _get_llm(self.settings)
        traces_text = _format_traces_for_prompt(
            traces,
            max_chars=self.settings.llm_max_trace_chars,
            prefer_errors=True,
        )

        skill_context = ""
        if bundle:
            skill_context = _read_relative_file_safe(
                bundle,
                "SKILL.md",
                max_chars=self.settings.llm_max_skill_file_chars,
            )

        feedback_section = ""
        if feedback:
            feedback_section = _format_feedback_for_prompt(feedback)

        messages = [
            {
                "role": "system",
                "content": (
                    "You are a failure analyst (Error Analyst 𝒜⁻) for an AI agent system.\n\n"
                    "IMPORTANT CONSTRAINT: You are working in a trace-only scenario. You CANNOT replay the agent, "
                    "CANNOT re-run any tools, and CANNOT validate fixes in a real environment. "
                    "All your analysis must be grounded solely in the trace evidence provided.\n\n"
                    "**Evidence priority:**\n"
                    "1. USER FEEDBACK (highest) — user corrections and complaints directly identify what went wrong.\n"
                    "2. AGENT BEHAVIOR — what the agent did (or failed to do) in the trace steps.\n"
                    "3. TRACE DETAILS — specific step content, tool results, error messages.\n\n"
                    "Follow the trace-only diagnostic workflow:\n"
                    "1. **Start from user feedback** — if user complaints exist, they ARE the failure surface. "
                    "Do not re-derive what the user already told you.\n"
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
                    (f"{feedback_section}\n" if feedback_section else "")
                    + f"## Agent Traces\n{traces_text}\n\n"
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
        traces: list[ImportedTrace] | None = None,
        feedback: FeedbackDigest | None = None,
    ) -> tuple[HypothesisPatch | None, list[str]]:
        """Bounded ReAct loop using LangChain structured tool calling.

        Delegates the LLM interaction to :mod:`react_agent` which uses
        ``ChatOpenAI.bind_tools()`` for robust tool-call parsing, while
        constraint enforcement (read budget, token budget, path whitelist)
        is handled via callbacks defined here.
        """
        from trace_evolver.react_agent import create_chat_model, run_react_loop

        notes: list[str] = []
        max_markdown_reads = self.settings.error_analyst_max_markdown_reads
        max_artifact_reads = self.settings.error_analyst_max_artifact_reads
        hard_budget = self.settings.llm.markdown_hard_budget_tokens

        # file_contents dict tracks visible files; insertion-ordered (Python 3.7+)
        file_contents: dict[str, str] = {}
        skill_content = _read_relative_file_safe(
            bundle,
            "SKILL.md",
            max_chars=self.settings.llm_max_skill_file_chars,
        )
        if skill_content:
            file_contents["SKILL.md"] = skill_content
        else:
            notes.append("SKILL.md not found or empty")
            return None, notes

        used_tokens = _estimate_token_count(skill_content)
        known_paths = {m.file_path for m in bundle.markdown_files}

        heading_tree = _build_heading_tree_text(bundle)
        existing_refs = [m.file_path for m in bundle.markdown_files if m.file_path.startswith("references/")]
        refs_context = ", ".join(existing_refs) if existing_refs else "(none)"

        # Build artifact catalog from traces
        artifact_catalog = format_artifact_catalog(traces or [])
        has_artifacts = artifact_catalog != "(none)"

        # System prompt — evidence-priority-aware
        system_prompt = (
            "You are a skill-evolution patch writer (Error Analyst 𝒜⁻) operating in a ReAct loop.\n\n"
            "You have access to tools:\n"
            "- **ReadFileParams** — read a markdown file from the skill bundle.\n"
            + ("- **ReadArtifactParams** — read a file artifact written by the agent during the trace.\n" if has_artifacts else "")
            + "- **WritePatchParams** — submit the final patch (terminal action, ends the loop).\n\n"
            "**Evidence priority (CRITICAL — this determines patch quality):**\n"
            "1. **USER FEEDBACK (highest)** — user corrections, complaints, and explicit requirements. "
            "If feedback already identifies a missing workflow rule, write a concrete, executable "
            "skill-level guardrail directly. Do not dilute into abstract checklists.\n"
            "2. **AGENT BEHAVIOR** — what the agent did wrong (skipped steps, wrong order, missing verification). "
            "Prefer concrete workflow steps with specific commands over abstract checklists.\n"
            "3. **ARTIFACT CONTENT (lowest)** — only read artifacts when the patch depends on concrete "
            "generated content details. Do not spend read budget on artifacts unless necessary.\n\n"
            "**Read budget:**\n"
            f"- Markdown files: up to {max_markdown_reads} reads\n"
            + (f"- Artifacts: up to {max_artifact_reads} reads (use only when needed for technical specifics)\n" if has_artifacts else "")
            + "- SKILL.md is already visible — do not request it.\n"
            "- Only request files from the markdown catalog or artifact catalog.\n"
            "- When you have enough context, call WritePatchParams.\n\n"
            f"{_PATCH_PLACEMENT_RULES}\n"
            f"{_MARKDOWN_FORMAT_RULES}\n"
            "**Content rules**:\n"
            "- Be concise and actionable — every sentence should change agent behavior.\n"
            "- Write concrete workflow steps with specific actions, not abstract checklists.\n"
            "- Use imperative language: 'Read required reference files first', "
            "'Keep related outputs consistent in the same workflow'.\n"
            "- Include verification steps with specific commands when possible.\n"
            "- Ground in the specific failure: reference what went wrong and how to prevent it.\n"
            "- NEVER use placeholder text like '...', 'TODO', or 'results must be empty'.\n"
        )

        # User content — feedback first, then diagnosis, then context
        feedback_section = ""
        if feedback:
            feedback_section = _format_feedback_for_prompt(feedback)

        catalog_text = _build_markdown_catalog_text(bundle, list(file_contents))
        files_context = "\n\n".join(
            f"### {path}\n```markdown\n{content}\n```"
            for path, content in file_contents.items()
        )
        files_context = compress_text_for_llm(
            files_context,
            self.settings.llm_max_visible_file_chars,
            label="visible markdown files",
        )
        artifact_section = ""
        if has_artifacts:
            artifact_section = f"## Trace Artifacts (files written by agent)\n{artifact_catalog}\n\n"

        # Build episode context with corrections marked
        if len(episode.user_messages) > 1:
            ep_context_lines = [f"- Initial request: \"{episode.user_messages[0]}\""]
            for msg in episode.user_messages[1:]:
                ep_context_lines.append(f"- **Correction/feedback**: \"{msg}\"")
            ep_context = "\n".join(ep_context_lines)
        else:
            ep_context = f"User message: {episode.user_messages[0] if episode.user_messages else '(none)'}"

        user_content = (
            (f"{feedback_section}\n" if feedback_section else "")
            + f"## Failure Diagnosis\n"
            f"Failure surface: {hypothesis.failure_surface}\n"
            f"Root cause: {hypothesis.suspected_root_cause}\n\n"
            f"## Episode Context\n"
            f"{ep_context}\n"
            f"Skills used: {', '.join(episode.used_skills)}\n\n"
            f"## SKILL.md heading structure\n{heading_tree}\n\n"
            f"## Existing references/ files\n{refs_context}\n\n"
            f"## Markdown Catalog (not-yet-visible files)\n{catalog_text}\n\n"
            + artifact_section
            + f"## Visible Files (full content)\n{files_context}\n\n"
            "Address every user complaint above. Write concrete workflow rules, not abstract checklists."
        )

        # Callbacks for react_agent tool implementations
        def read_file_cb(path: str) -> tuple[str | None, int]:
            if not is_allowed_markdown_relative_path(path):
                return None, 0
            content = _read_relative_file_safe(
                bundle,
                path,
                max_chars=self.settings.llm_max_visible_file_chars,
            )
            if not content:
                return None, 0
            return content, _estimate_token_count(content)

        def read_artifact_cb(art_id: str, offset: int, limit: int) -> tuple[str | None, int]:
            for trace in (traces or []):
                for art in trace.artifact_index:
                    if art.art_id == art_id:
                        safe_limit = max(1, min(limit, self.settings.llm_max_artifact_lines))
                        content = get_artifact_content(
                            trace,
                            art,
                            offset=offset,
                            limit=safe_limit,
                            max_chars=self.settings.llm_max_artifact_chars,
                        )
                        if content:
                            return content, _estimate_token_count(content)
                        return None, 0
            return None, 0

        # Run the LangChain bounded ReAct loop
        model = create_chat_model(self.settings.llm)
        result, react_notes = run_react_loop(
            model,
            system_prompt,
            user_content,
            max_markdown_reads=max_markdown_reads,
            max_artifact_reads=max_artifact_reads,
            hard_budget_tokens=hard_budget,
            file_contents=file_contents,
            used_tokens=used_tokens,
            known_paths=known_paths,
            read_file_cb=read_file_cb,
            read_artifact_cb=read_artifact_cb if has_artifacts else None,
            has_artifacts=has_artifacts,
            max_artifact_lines=self.settings.llm_max_artifact_lines,
            max_tool_message_chars=self.settings.llm_max_tool_message_chars,
            max_message_chars=self.settings.llm.max_message_chars,
        )
        notes.extend(react_notes)

        if result is None:
            return None, notes

        # Process write_patch result into HypothesisPatch
        raw_edits = result.get("edits", [])
        if not raw_edits:
            notes.append("write_patch returned no edits")
            return None, notes

        ops, op_rejected = _build_ops_from_llm_edits(raw_edits, bundle, list(file_contents))
        if op_rejected:
            notes.extend(f"rejected edit: {r}" for r in op_rejected)
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


# ---------------------------------------------------------------------------
# Shared: build EditOps from LLM JSON edits
# ---------------------------------------------------------------------------

def _build_ops_from_llm_edits(
    raw_edits: list[dict],
    bundle: SkillBundleMeta,
    visible_files: list[str],
) -> tuple[list[EditOp], list[str]]:
    """Convert LLM-generated edit dicts into validated EditOp objects.

    Returns ``(ops, rejected_reasons)`` — rejected_reasons lists human-readable
    strings explaining why individual edits were dropped (useful for diagnostics).

    The write protocol is intentionally small:
    - edit(old_string/new_string) for existing markdown text
    - append_file_end for appending a brand-new section or note
    - create for new markdown files
    """
    ops: list[EditOp] = []
    rejected_reasons: list[str] = []
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

        # Reject truncated / incomplete content
        _check_text = new_string if op_type == "edit" else content
        if _check_text:
            _placeholder_reason = _has_placeholder(_check_text)
            if _placeholder_reason:
                rejected_reasons.append(f"op on {file_path}: {_placeholder_reason}")
                continue

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

    return ops, rejected_reasons


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
