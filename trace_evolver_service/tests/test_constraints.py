from __future__ import annotations

from pathlib import Path

from trace_evolver.analysis import BoundedMarkdownReAct, ErrorAnalyst, _build_ops_from_llm_edits
from trace_evolver.catalog import scan_skill_roots
from trace_evolver.config import LLMSettings, Settings
from trace_evolver.patching import PatchEngine
from trace_evolver.schemas import (
    EditOp,
    EvidenceSpan,
    Episode,
    FailureHypothesis,
    HypothesisPatch,
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


def test_llm_edit_builder_only_allows_visible_existing_markdown(tmp_path: Path) -> None:
    _build_bundle(tmp_path)
    bundle = scan_skill_roots([str(tmp_path)])[0]

    ops = _build_ops_from_llm_edits(
        [
            {
                "file": "references/troubleshooting.md",
                "op": "insert_after",
                "target_section": "Troubleshooting",
                "content": "Should be ignored because the file was not fully visible.",
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
                        "op": "insert_after",
                        "target_section": "Troubleshooting",
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
