from __future__ import annotations

import json
from pathlib import Path

import frontmatter
from fastapi.testclient import TestClient

from trace_evolver.config import LLMSettings, Settings
from trace_evolver.main import create_app


def _write_trace(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload) + "\n", encoding="utf-8")


def _build_error_trace(trace_id: str, thread_id: str, started_at: str) -> dict:
    return {
        "traceId": trace_id,
        "threadId": thread_id,
        "startedAt": started_at,
        "endedAt": "2025-01-01T10:01:00Z",
        "durationMs": 60_000,
        "userMessage": "Fix the validation mismatch in the troubleshooting flow.",
        "modelId": "test-model",
        "steps": [
            {
                "index": 0,
                "startedAt": started_at,
                "assistantText": "The validation check failed and the result looks wrong.",
                "toolCalls": [
                    {
                        "name": "edit_file",
                        "args": {"path": "SKILL.md"},
                        "result": "error: mismatch remains after the edit",
                        "durationMs": 120,
                    }
                ],
            }
        ],
        "totalToolCalls": 1,
        "outcome": "error",
        "errorMessage": "validation mismatch remained after the first edit",
        "usedSkills": ["validation-skill"],
        "metadata": {"workspacePath": "/tmp/workspace"},
    }


def _build_skill_bundle(root: Path, version: str | None = None) -> Path:
    bundle = root / "validation-skill"
    (bundle / "references").mkdir(parents=True, exist_ok=True)
    (bundle / "notes.txt").write_text("keep me\n", encoding="utf-8")
    version_line = f"version: {version}\n" if version else ""
    (bundle / "SKILL.md").write_text(
        "---\n"
        "name: Validation Skill\n"
        "description: Helps debug validation flows.\n"
        f"{version_line}"
        "---\n\n"
        "# Validation Skill\n\n"
        "## Workflow\n\n"
        "- Start from the failing path.\n",
        encoding="utf-8",
    )
    (bundle / "references" / "troubleshooting.md").write_text(
        "# Troubleshooting\n\n"
        "Validation mismatch troubleshooting for submit and resolver paths.\n",
        encoding="utf-8",
    )
    return bundle


def test_run_exports_candidate_bundle(tmp_path: Path) -> None:
    input_root = tmp_path / "traces"
    skills_root = tmp_path / "skills"
    output_root = tmp_path / "output"
    state_dir = tmp_path / "state"

    _build_skill_bundle(skills_root)
    _write_trace(
        input_root / "thread-a" / "trace-1.jsonl",
        _build_error_trace("trace-1", "thread-a", "2025-01-01T10:00:00Z"),
    )

    app = create_app(Settings(state_dir=state_dir, llm=LLMSettings(api_key="")))
    client = TestClient(app)

    create_response = client.post(
        "/runs",
        json={
            "input_path": str(input_root.resolve()),
            "skills_roots": [str(skills_root.resolve())],
            "output_root": str(output_root.resolve()),
        },
    )
    assert create_response.status_code == 200, create_response.text

    run_id = create_response.json()["run_id"]
    run_detail = client.get(f"/runs/{run_id}")
    assert run_detail.status_code == 200
    assert run_detail.json()["status"] == "exported"
    assert run_detail.json()["candidate_count"] == 1

    candidates_response = client.get(f"/runs/{run_id}/candidates")
    assert candidates_response.status_code == 200
    candidates = candidates_response.json()
    assert len(candidates) == 1
    candidate = candidates[0]
    assert "SKILL.md" in candidate["files_changed"]

    diff_response = client.get(f"/runs/{run_id}/candidates/{candidate['candidate_id']}/diff")
    assert diff_response.status_code == 200
    assert "SKILL.md" in diff_response.text

    skill_md_response = client.get(f"/runs/{run_id}/candidates/{candidate['candidate_id']}/bundle/SKILL.md")
    assert skill_md_response.status_code == 200
    assert "Trace-Grounded Failure Pattern" in skill_md_response.text
    skill_post = frontmatter.loads(skill_md_response.text)
    assert skill_post.metadata["version"] == "v1.0.1"

    passthrough_response = client.get(f"/runs/{run_id}/candidates/{candidate['candidate_id']}/bundle/notes.txt")
    assert passthrough_response.status_code == 200
    assert passthrough_response.text == "keep me\n"

    evaluation_path = output_root / "runs" / run_id / "candidates" / candidate["candidate_id"] / "evaluation.json"
    assert evaluation_path.exists()


def test_run_rejects_relative_input_path(tmp_path: Path) -> None:
    app = create_app(Settings(state_dir=tmp_path / "state", llm=LLMSettings(api_key="")))
    client = TestClient(app)

    response = client.post(
        "/runs",
        json={
            "input_path": "relative/path",
            "skills_roots": [str((tmp_path / "skills").resolve())],
            "output_root": str((tmp_path / "output").resolve()),
        },
    )
    assert response.status_code == 400
    assert "path must be absolute" in response.json()["detail"]


def test_run_bumps_existing_skill_version(tmp_path: Path) -> None:
    input_root = tmp_path / "traces"
    skills_root = tmp_path / "skills"
    output_root = tmp_path / "output"
    state_dir = tmp_path / "state"

    _build_skill_bundle(skills_root, version="v1.2.3")
    _write_trace(
        input_root / "thread-a" / "trace-1.jsonl",
        _build_error_trace("trace-1", "thread-a", "2025-01-01T10:00:00Z"),
    )

    app = create_app(Settings(state_dir=state_dir, llm=LLMSettings(api_key="")))
    client = TestClient(app)

    create_response = client.post(
        "/runs",
        json={
            "input_path": str(input_root.resolve()),
            "skills_roots": [str(skills_root.resolve())],
            "output_root": str(output_root.resolve()),
        },
    )
    assert create_response.status_code == 200, create_response.text

    run_id = create_response.json()["run_id"]
    candidates = client.get(f"/runs/{run_id}/candidates").json()
    candidate = candidates[0]
    skill_md_response = client.get(f"/runs/{run_id}/candidates/{candidate['candidate_id']}/bundle/SKILL.md")
    skill_post = frontmatter.loads(skill_md_response.text)
    assert skill_post.metadata["version"] == "v1.2.4"
