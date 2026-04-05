from __future__ import annotations

from pathlib import Path

from trace_evolver.analysis import BoundedMarkdownReAct, ErrorAnalyst, SuccessAnalyst, _build_ops_from_llm_edits
from trace_evolver.catalog import scan_skill_roots
from trace_evolver.config import LLMSettings, Settings
from trace_evolver.db import create_session_factory
from trace_evolver.episodes import build_episodes
from trace_evolver.patching import PatchEngine
from trace_evolver.service import TraceEvolutionService
from trace_evolver.schemas import (
    EditOp,
    EvidenceSpan,
    Episode,
    FailureHypothesis,
    HypothesisPatch,
    ImportedTrace,
    TraceStep,
    TraceToolCall,
)


def _build_bundle(root: Path) -> Path:
    bundle = root / "validation-skill"
    (bundle / "references").mkdir(parents=True, exist_ok=True)
    (bundle / "SKILL.md").write_text(
        "---\n"
        "name: Validation Skill\n"
        "description: Helps debug validation flows.\n"
        "---\n\n"
        "# Validation Skill\n\n"
        "## Workflow\n\n"
        "- Start from the failing path.\n",
        encoding="utf-8",
    )
    (bundle / "references" / "troubleshooting.md").write_text(
        "# Troubleshooting\n\n" + ("resolver mismatch " * 5000),
        encoding="utf-8",
    )
    (bundle / "notes.txt").write_text("plain text\n", encoding="utf-8")
    return bundle


def _make_trace(
    *,
    trace_id: str,
    thread_id: str,
    started_at: str,
    ended_at: str,
    user_message: str,
    outcome: str,
    used_skills: list[str],
    tool_names: list[str],
) -> ImportedTrace:
    return ImportedTrace(
        traceId=trace_id,
        threadId=thread_id,
        startedAt=started_at,
        endedAt=ended_at,
        durationMs=60_000,
        userMessage=user_message,
        modelId="test-model",
        steps=[
            TraceStep(
                index=0,
                startedAt=started_at,
                assistantText=user_message,
                toolCalls=[TraceToolCall(name=name) for name in tool_names],
            )
        ],
        totalToolCalls=len(tool_names),
        outcome=outcome,
        usedSkills=used_skills,
        source_path="/tmp/source",
        local_path="/tmp/source",
        ingested_at="2025-01-01T00:00:00Z",
    )


def test_llm_edit_builder_only_allows_visible_existing_markdown(tmp_path: Path) -> None:
    _build_bundle(tmp_path)
    bundle = scan_skill_roots([str(tmp_path)])[0]

    ops = _build_ops_from_llm_edits(
        [
            {
                "file": "references/troubleshooting.md",
                "op": "edit",
                "old_string": "Validation mismatch troubleshooting for submit and resolver paths.",
                "new_string": "Updated troubleshooting guidance.",
                "intent": "reference",
            },
            {
                "file": "notes.txt",
                "op": "create",
                "content": "Should be ignored because it is not markdown.",
                "intent": "reference",
            },
            {
                "file": "references/new-note.md",
                "op": "create",
                "content": "# New note\n\nCase-specific guidance.\n",
                "intent": "reference",
            },
        ],
        bundle,
        ["SKILL.md"],
    )

    files = [op.file_path for op in ops]
    assert "references/troubleshooting.md" not in files
    assert "notes.txt" not in files
    assert "references/new-note.md" in files
    assert "SKILL.md" in files


def test_patch_engine_rejects_non_markdown_write_even_if_patch_slips_through(tmp_path: Path) -> None:
    bundle_root = _build_bundle(tmp_path / "skills")
    bundle = scan_skill_roots([str(tmp_path / "skills")])[0]
    engine = PatchEngine()

    patch = HypothesisPatch(
        patch_id="patch-1",
        source_kind="error",
        target_skill_id=bundle.skill_id,
        family_id="fam-1",
        source_trace_ids=["trace-1"],
        source_thread_ids=["thread-1"],
        base_bundle_hash=bundle.bundle_hash,
        visible_files=["SKILL.md"],
        ops=[
            EditOp(
                file_path="notes.txt",
                action="create_file",
                content="bad write\n",
                intent="reference",
                source_visibility="created",
            )
        ],
        confidence=0.7,
        rationale="test",
    )

    result = engine.apply("cand-1", [patch], bundle, tmp_path / "candidate")
    assert result.candidate.unresolved_ops
    assert "markdown whitelist" in result.candidate.unresolved_ops[0]
    assert (Path(result.candidate.full_bundle_path) / "notes.txt").read_text(encoding="utf-8") == "plain text\n"


def test_bounded_markdown_react_respects_dynamic_budget(tmp_path: Path) -> None:
    _build_bundle(tmp_path)
    bundle = scan_skill_roots([str(tmp_path)])[0]
    settings = Settings(
        llm=LLMSettings(
            api_key="",
            context_window_tokens=32_000,
            trace_budget_tokens=8_000,
            system_reserve_tokens=4_000,
            output_reserve_tokens=4_000,
            markdown_soft_cap_tokens=2_000,
            markdown_hard_cap_tokens=4_000,
        )
    )
    react = BoundedMarkdownReAct(settings)
    episode = Episode(
        episode_id="ep-1",
        thread_id="thread-1",
        trace_ids=["trace-1"],
        start_ts="2025-01-01T10:00:00Z",
        end_ts="2025-01-01T10:01:00Z",
        summary="resolver mismatch",
        used_skills=["validation-skill"],
        tool_signature=["edit_file"],
        outcomes=["error"],
        user_messages=["Fix the resolver mismatch in troubleshooting flow"],
    )

    selected_files, _, notes = react.select("resolver mismatch", episode, bundle)
    assert selected_files == ["SKILL.md"]
    assert any("soft budget" in note for note in notes)


def test_error_analyst_can_request_full_read_before_writing_patch(tmp_path: Path, monkeypatch) -> None:
    _build_bundle(tmp_path)
    bundle = scan_skill_roots([str(tmp_path)])[0]
    settings = Settings(llm=LLMSettings(api_key="test-key"))
    analyst = ErrorAnalyst(settings)

    episode = Episode(
        episode_id="ep-2",
        thread_id="thread-2",
        trace_ids=["trace-2"],
        start_ts="2025-01-01T10:00:00Z",
        end_ts="2025-01-01T10:03:00Z",
        summary="resolver mismatch",
        used_skills=["validation-skill"],
        tool_signature=["read_file", "edit_file"],
        outcomes=["error"],
        user_messages=["Fix the resolver mismatch in troubleshooting flow"],
    )
    hypothesis = FailureHypothesis(
        failure_surface="Submit still fails after UI validation passes.",
        suspected_root_cause="The workflow did not call out resolver-specific checks.",
        evidence_spans=[
            EvidenceSpan(trace_id="trace-2", kind="assistant_text", step_index=1, snippet="I only checked the UI path."),
            EvidenceSpan(trace_id="trace-2", kind="tool_call", step_index=2, snippet="resolver mismatch"),
        ],
        confidence=0.8,
    )

    class FakeLLM:
        def __init__(self) -> None:
            self.calls = 0

        def chat_json(self, messages, temperature=None, max_tokens=None):  # noqa: ANN001
            self.calls += 1
            if self.calls == 1:
                return {
                    "action": "read_more",
                    "read_requests": [
                        {
                            "file": "references/troubleshooting.md",
                            "reason": "Need the troubleshooting guidance before patching it.",
                        }
                    ],
                    "notes": ["need one more reference file"],
                }
            return {
                "edits": [
                    {
                        "file": "references/troubleshooting.md",
                        "op": "append_file_end",
                        "content": "## Resolver-first check\n\n- Verify resolver behavior before concluding the UI fix is enough.\n",
                        "intent": "reference",
                    }
                ],
                "confidence": 0.77,
                "rationale": "Adds the missing resolver-specific reminder where the troubleshooting note already lives.",
            }

    fake_llm = FakeLLM()
    monkeypatch.setattr("trace_evolver.analysis._get_llm", lambda settings: fake_llm)

    patch = analyst._write_patch_with_llm(  # noqa: SLF001 - unit test the internal coordinator path directly
        episode,
        bundle,
        hypothesis,
        ["SKILL.md"],
        [],
    )

    assert patch is not None
    assert "references/troubleshooting.md" in patch.visible_files
    assert any(op.file_path == "references/troubleshooting.md" for op in patch.ops)


def test_build_episodes_does_not_merge_only_on_repair_transition(tmp_path: Path) -> None:
    traces = [
        _make_trace(
            trace_id="trace-a",
            thread_id="thread-1",
            started_at="2025-01-01T10:00:00Z",
            ended_at="2025-01-01T10:01:00Z",
            user_message="Fix the login validation mismatch",
            outcome="error",
            used_skills=["login-skill"],
            tool_names=["edit_file"],
        ),
        _make_trace(
            trace_id="trace-b",
            thread_id="thread-1",
            started_at="2025-01-01T10:02:00Z",
            ended_at="2025-01-01T10:03:00Z",
            user_message="Summarize the PDF export issues",
            outcome="success",
            used_skills=["pdf-skill"],
            tool_names=["read_pdf"],
        ),
    ]

    episodes = build_episodes(traces, gap_minutes=30)
    assert len(episodes) == 2
    assert episodes[0].trace_ids == ["trace-a"]
    assert episodes[1].trace_ids == ["trace-b"]


def test_patch_engine_append_file_end_adds_new_skill_section(tmp_path: Path) -> None:
    _build_bundle(tmp_path / "skills")
    bundle = scan_skill_roots([str(tmp_path / "skills")])[0]
    engine = PatchEngine()

    patch = HypothesisPatch(
        patch_id="patch-skill-append",
        source_kind="error",
        target_skill_id=bundle.skill_id,
        family_id="fam-1",
        source_trace_ids=["trace-1"],
        source_thread_ids=["thread-1"],
        base_bundle_hash=bundle.bundle_hash,
        visible_files=["SKILL.md"],
        ops=[
            EditOp(
                file_path="SKILL.md",
                action="append_file_end",
                content="## Trace-Grounded Note\n\n- Safe fallback append.\n",
                intent="reference",
                source_visibility="full",
            )
        ],
        confidence=0.7,
        rationale="test",
    )

    result = engine.apply("cand-skill-append", [patch], bundle, tmp_path / "candidate")
    assert not result.candidate.unresolved_ops
    skill_text = (Path(result.candidate.full_bundle_path) / "SKILL.md").read_text(encoding="utf-8")
    assert "## Trace-Grounded Note" in skill_text


def test_patch_engine_edit_replaces_unique_visible_text(tmp_path: Path) -> None:
    _build_bundle(tmp_path / "skills")
    bundle = scan_skill_roots([str(tmp_path / "skills")])[0]
    engine = PatchEngine()

    patch = HypothesisPatch(
        patch_id="patch-edit-unique",
        source_kind="error",
        target_skill_id=bundle.skill_id,
        family_id="fam-1",
        source_trace_ids=["trace-1"],
        source_thread_ids=["thread-1"],
        base_bundle_hash=bundle.bundle_hash,
        visible_files=["SKILL.md"],
        ops=[
            EditOp(
                file_path="SKILL.md",
                action="edit",
                old_string="- Start from the failing path.",
                new_string="- Compare UI validation, resolver, and submit path before patching.",
                content="- Compare UI validation, resolver, and submit path before patching.",
                intent="workflow",
                source_visibility="full",
            )
        ],
        confidence=0.8,
        rationale="test",
    )

    result = engine.apply("cand-edit-unique", [patch], bundle, tmp_path / "candidate")
    assert not result.candidate.unresolved_ops
    skill_text = (Path(result.candidate.full_bundle_path) / "SKILL.md").read_text(encoding="utf-8")
    assert "Compare UI validation, resolver, and submit path before patching." in skill_text
    assert "- Start from the failing path." not in skill_text


def test_patch_engine_edit_requires_unique_old_string(tmp_path: Path) -> None:
    bundle_path = _build_bundle(tmp_path / "skills")
    skill_md = bundle_path / "SKILL.md"
    skill_md.write_text(
        skill_md.read_text(encoding="utf-8") + "\n- Start from the failing path.\n",
        encoding="utf-8",
    )
    bundle = scan_skill_roots([str(tmp_path / "skills")])[0]
    engine = PatchEngine()

    patch = HypothesisPatch(
        patch_id="patch-edit-duplicate",
        source_kind="error",
        target_skill_id=bundle.skill_id,
        family_id="fam-1",
        source_trace_ids=["trace-1"],
        source_thread_ids=["thread-1"],
        base_bundle_hash=bundle.bundle_hash,
        visible_files=["SKILL.md"],
        ops=[
            EditOp(
                file_path="SKILL.md",
                action="edit",
                old_string="- Start from the failing path.",
                new_string="- Compare every path before patching.",
                content="- Compare every path before patching.",
                intent="workflow",
                source_visibility="full",
            )
        ],
        confidence=0.8,
        rationale="test",
    )

    result = engine.apply("cand-edit-duplicate", [patch], bundle, tmp_path / "candidate")
    assert result.candidate.unresolved_ops
    assert "not unique" in result.candidate.unresolved_ops[0]
    skill_text = (Path(result.candidate.full_bundle_path) / "SKILL.md").read_text(encoding="utf-8")
    assert skill_text.count("- Start from the failing path.") == 2


def test_merge_batch_adds_skill_link_for_created_markdown(tmp_path: Path, monkeypatch) -> None:
    settings = Settings(state_dir=tmp_path / "state", llm=LLMSettings(api_key="test-key"))
    service = TraceEvolutionService(settings, create_session_factory(settings))

    patch_a = HypothesisPatch(
        patch_id="patch-a",
        source_kind="error",
        target_skill_id="skill-a",
        family_id="fam-1",
        source_trace_ids=["trace-a"],
        source_thread_ids=["thread-a"],
        base_bundle_hash="bundle-hash",
        visible_files=["SKILL.md"],
        ops=[
            EditOp(
                file_path="SKILL.md",
                action="append_file_end",
                content="- Existing context.\n",
                intent="guardrail",
                source_visibility="full",
            )
        ],
        confidence=0.7,
        rationale="test",
    )
    patch_b = HypothesisPatch(
        patch_id="patch-b",
        source_kind="error",
        target_skill_id="skill-a",
        family_id="fam-1",
        source_trace_ids=["trace-b"],
        source_thread_ids=["thread-b"],
        base_bundle_hash="bundle-hash",
        visible_files=["SKILL.md"],
        ops=[
            EditOp(
                file_path="SKILL.md",
                action="append_file_end",
                content="- Existing context 2.\n",
                intent="guardrail",
                source_visibility="full",
            )
        ],
        confidence=0.8,
        rationale="test 2",
    )

    class FakeLLM:
        def chat_json(self, messages, temperature=None, max_tokens=None):  # noqa: ANN001
            return {
                "reasoning": "Create a dedicated reference note.",
                "edits": [
                    {
                        "file": "references/generated-note.md",
                        "op": "create",
                        "content": "# Generated note\n\nExtra guidance.\n",
                        "intent": "reference",
                    }
                ],
                "confidence": 0.8,
            }

    monkeypatch.setattr(service, "_get_llm", lambda: FakeLLM())

    merged = service._llm_merge_batch([patch_a, patch_b])  # noqa: SLF001 - test merge post-processing directly
    assert merged is not None
    assert any(op.file_path == "references/generated-note.md" and op.action == "create_file" for op in merged.ops)
    assert any(
        op.file_path == "SKILL.md" and "references/generated-note.md" in op.content
        for op in merged.ops
    )


def test_error_analyst_llm_can_emit_exact_text_edit(tmp_path: Path, monkeypatch) -> None:
    _build_bundle(tmp_path)
    bundle = scan_skill_roots([str(tmp_path)])[0]
    settings = Settings(llm=LLMSettings(api_key="test-key"))
    analyst = ErrorAnalyst(settings)

    episode = Episode(
        episode_id="ep-edit",
        thread_id="thread-edit",
        trace_ids=["trace-edit"],
        start_ts="2025-01-01T10:00:00Z",
        end_ts="2025-01-01T10:03:00Z",
        summary="resolver mismatch",
        used_skills=["validation-skill"],
        tool_signature=["read_file", "edit_file"],
        outcomes=["error"],
        user_messages=["Fix the resolver mismatch in troubleshooting flow"],
    )
    hypothesis = FailureHypothesis(
        failure_surface="Submit still fails after UI validation passes.",
        suspected_root_cause="The workflow did not call out resolver-specific checks.",
        evidence_spans=[
            EvidenceSpan(trace_id="trace-edit", kind="assistant_text", step_index=1, snippet="I only checked the UI path."),
            EvidenceSpan(trace_id="trace-edit", kind="tool_call", step_index=2, snippet="resolver mismatch"),
        ],
        confidence=0.8,
    )

    class FakeLLM:
        def __init__(self) -> None:
            self.calls = 0

        def chat_json(self, messages, temperature=None, max_tokens=None):  # noqa: ANN001
            self.calls += 1
            if self.calls == 1:
                return {"action": "write_patch", "read_requests": [], "notes": []}
            return {
                "edits": [
                    {
                        "file": "SKILL.md",
                        "op": "edit",
                        "old_string": "- Start from the failing path.",
                        "new_string": "- Start from the failing path.\n- Compare UI validation, resolver, and submit path before patching.",
                        "intent": "workflow",
                    }
                ],
                "confidence": 0.81,
                "rationale": "Tightens the workflow with the missing resolver check.",
            }

    fake_llm = FakeLLM()
    monkeypatch.setattr("trace_evolver.analysis._get_llm", lambda settings: fake_llm)

    patch = analyst._write_patch_with_llm(  # noqa: SLF001
        episode,
        bundle,
        hypothesis,
        ["SKILL.md"],
        [],
    )

    assert patch is not None
    assert patch.ops[0].action == "edit"
    assert patch.ops[0].old_string == "- Start from the failing path."
    assert "Compare UI validation" in (patch.ops[0].new_string or "")


def test_success_analyst_llm_can_emit_exact_text_edit(tmp_path: Path, monkeypatch) -> None:
    _build_bundle(tmp_path)
    bundle = scan_skill_roots([str(tmp_path)])[0]
    settings = Settings(llm=LLMSettings(api_key="test-key"))
    analyst = SuccessAnalyst(settings)

    episode = Episode(
        episode_id="ep-success-edit",
        thread_id="thread-success",
        trace_ids=["trace-success"],
        start_ts="2025-01-01T10:00:00Z",
        end_ts="2025-01-01T10:03:00Z",
        summary="successful validation fix",
        used_skills=["validation-skill"],
        tool_signature=["read_file", "edit_file", "verify"],
        outcomes=["success"],
        user_messages=["Fix the validation mismatch in the troubleshooting flow"],
    )
    traces = [
        _make_trace(
            trace_id="trace-success",
            thread_id="thread-success",
            started_at="2025-01-01T10:00:00Z",
            ended_at="2025-01-01T10:01:00Z",
            user_message="Fix the validation mismatch in the troubleshooting flow",
            outcome="success",
            used_skills=["validation-skill"],
            tool_names=["read_file", "edit_file", "verify"],
        )
    ]

    class FakeLLM:
        def chat_json(self, messages, temperature=None, max_tokens=None):  # noqa: ANN001
            return {
                "patterns": [
                    {
                        "title": "Resolver-aware validation workflow",
                        "description": "Successful runs compare UI validation and resolver paths before patching.",
                        "frequency_hint": "common",
                    }
                ],
                "edits": [
                    {
                        "file": "SKILL.md",
                        "op": "edit",
                        "old_string": "- Start from the failing path.",
                        "new_string": "- Start from the failing path.\n- Compare UI validation and resolver checks before patching.",
                        "intent": "workflow",
                    }
                ],
                "confidence": 0.82,
                "rationale": "Captures the reusable validation fix pattern.",
            }

    monkeypatch.setattr("trace_evolver.analysis._get_llm", lambda settings: FakeLLM())

    patterns, patches = analyst._analyze_with_llm(episode, traces, bundle)  # noqa: SLF001
    assert patterns
    assert len(patches) == 1
    assert patches[0].ops[0].action == "edit"
    assert patches[0].ops[0].old_string == "- Start from the failing path."


def test_merge_batch_can_emit_exact_text_edit(tmp_path: Path, monkeypatch) -> None:
    settings = Settings(state_dir=tmp_path / "state", llm=LLMSettings(api_key="test-key"))
    service = TraceEvolutionService(settings, create_session_factory(settings))

    patch_a = HypothesisPatch(
        patch_id="patch-a",
        source_kind="success",
        target_skill_id="skill-a",
        family_id="fam-1",
        source_trace_ids=["trace-a"],
        source_thread_ids=["thread-a"],
        base_bundle_hash="bundle-hash",
        visible_files=["SKILL.md"],
        ops=[
            EditOp(
                file_path="SKILL.md",
                action="edit",
                old_string="- Start from the failing path.",
                new_string="- Start from the failing path.\n- Verify resolver behavior before concluding the fix worked.",
                content="- Start from the failing path.\n- Verify resolver behavior before concluding the fix worked.",
                intent="workflow",
                source_visibility="full",
            )
        ],
        confidence=0.8,
        rationale="test",
    )
    patch_b = patch_a.model_copy(update={"patch_id": "patch-b", "source_trace_ids": ["trace-b"], "source_thread_ids": ["thread-b"]})

    class FakeLLM:
        def chat_json(self, messages, temperature=None, max_tokens=None):  # noqa: ANN001
            return {
                "reasoning": "Keep the exact replacement edit because both patches agree.",
                "edits": [
                    {
                        "source_op_id": "P1-A",
                        "file": "SKILL.md",
                        "op": "edit",
                        "new_string": "- Start from the failing path.\n- Verify resolver behavior before concluding the fix worked.",
                        "intent": "workflow",
                        "prevalence": 2,
                    }
                ],
                "confidence": 0.86,
            }

    monkeypatch.setattr(service, "_get_llm", lambda: FakeLLM())

    merged = service._llm_merge_batch([patch_a, patch_b])  # noqa: SLF001
    assert merged is not None
    assert len(merged.ops) == 1
    assert merged.ops[0].action == "edit"
    # old_string is transparently passed through from the original patch, not from LLM output
    assert merged.ops[0].old_string == "- Start from the failing path."
