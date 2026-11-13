#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Resolve a code task's plan/spec/design context from artifact workspace."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.json_writer_common import (  # noqa: E402
    WriterError,
    WriterResult,
    fail,
    feature_dir,
    render_result,
    resolve_feature,
    resolve_workspace,
    with_result_data,
)
from hooks.plan_json import (  # noqa: E402
    batch_plan_path,
    defer_to_test_stages_enabled,
    load_plan,
    validate_batch_plan_data,
    validate_plan_data,
)
from hooks.repository_snapshot import (  # noqa: E402
    REQUIRED_IGNORED_RUNTIME_PATHS,
    RepositorySnapshotError,
    resolve_repositories,
    unignored_runtime_artifact_paths,
)
from hooks.spec_contract import spec_heading  # noqa: E402
from hooks.source_context import load_source_context, source_index  # noqa: E402


PLAN_FILE = "plan.json"
ANCHOR_RE = re.compile(r"^(REQ|SCN|API|DATA|D)-\d{3}$")


def _split_ref(ref: str) -> tuple[str, str]:
    path_part, marker, anchor = ref.partition("#")
    if not marker or not anchor.strip():
        raise WriterError(f"引用缺少 anchor: {ref}")
    anchor = anchor.strip()
    if not ANCHOR_RE.fullmatch(anchor):
        raise WriterError(f"引用 anchor 格式非法: {ref}")
    return path_part.strip(), anchor


def _inside_base(candidate: Path, base: Path) -> bool:
    try:
        candidate.relative_to(base)
        return True
    except ValueError:
        return False


def _safe_ref_path(base: Path, raw_path: str, ref: str) -> Path:
    if not raw_path:
        raise WriterError(f"引用缺少相对路径: {ref}")
    path = Path(raw_path)
    if path.is_absolute():
        raise WriterError(f"引用必须是产物目录相对路径，不允许绝对路径: {ref}")
    candidate = (base / path).resolve(strict=False)
    resolved_base = base.resolve(strict=False)
    if not _inside_base(candidate, resolved_base):
        raise WriterError(f"引用路径越界: {ref}")
    return candidate


def _line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _find_unique_anchor_file(base: Path, anchor: str, *, design: bool) -> Path:
    if design:
        return base / "design.md"
    candidates = sorted((base / "specs").glob("**/*.md"))
    matches: list[Path] = []
    for candidate in candidates:
        try:
            text = candidate.read_text(encoding="utf-8")
        except OSError:
            continue
        if _extract_spec_snippet(text, anchor) is not None:
            matches.append(candidate)
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise WriterError(f"短引用未找到 anchor: #{anchor}")
    raise WriterError(f"短引用 anchor 不唯一: #{anchor}")


def _resolve_path(base: Path, ref: str, anchor: str, *, design: bool) -> Path:
    raw_path, _ = _split_ref(ref)
    if not raw_path:
        return _find_unique_anchor_file(base, anchor, design=design).resolve(strict=False)
    return _safe_ref_path(base, raw_path, ref)


def _extract_spec_snippet(text: str, anchor: str) -> tuple[str, int] | None:
    if not anchor.startswith(("REQ-", "SCN-")):
        return None
    match = spec_heading(text, anchor)
    if not match:
        return None
    # Stop at the next peer or enclosing section, including mixed ID styles.
    end_re = re.compile(r"^#{1,4}\s+\S", re.MULTILINE)
    end_match = end_re.search(text, match.end())
    end = end_match.start() if end_match else len(text)
    snippet = text[match.start() : end].strip()
    return snippet, _line_number(text, match.start())


def _extract_design_snippet(text: str, anchor: str) -> tuple[str, int] | None:
    lines = text.splitlines()
    row_re = re.compile(rf"^\|\s*{re.escape(anchor)}\s*\|")
    for index, line in enumerate(lines):
        if not row_re.match(line):
            continue
        heading = index
        while heading > 0 and not re.match(r"^#{2,}\s+", lines[heading]):
            heading -= 1
        start = min(max(heading, 0), max(index - 2, 0))
        end = min(len(lines), index + 1)
        return "\n".join(lines[start:end]).strip(), index + 1
    return None


def _relative_to_base(path: Path, base: Path) -> str:
    try:
        return path.resolve(strict=False).relative_to(base.resolve(strict=False)).as_posix()
    except ValueError:
        return str(path)


def _resolve_refs(base: Path, refs: list[str], *, design: bool) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    resolved: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    seen: set[str] = set()
    for ref in refs:
        if ref in seen:
            continue
        seen.add(ref)
        try:
            raw_path, anchor = _split_ref(ref)
            if design and not (anchor.startswith("API-") or anchor.startswith("DATA-") or anchor.startswith("D-")):
                raise WriterError(f"designRefs 只允许 API/DATA/D anchor: {ref}")
            if not design and not (anchor.startswith("REQ-") or anchor.startswith("SCN-")):
                raise WriterError(f"specRefs 只允许 REQ/SCN anchor: {ref}")
            path = _resolve_path(base, ref, anchor, design=design)
        except WriterError as exc:
            errors.append({"reason": "invalid_artifact_ref", "detail": f"{ref}: {exc}"})
            resolved.append({"ref": ref, "found": False, "error": "invalid_artifact_ref"})
            continue

        item: dict[str, Any] = {
            "ref": ref,
            "path": _relative_to_base(path, base),
            "absolutePath": str(path),
            "anchor": anchor,
            "found": False,
        }
        if not path.is_file():
            errors.append({"reason": "missing_ref_file", "detail": ref})
            item["error"] = "missing_ref_file"
            resolved.append(item)
            continue

        text = path.read_text(encoding="utf-8")
        extracted = _extract_design_snippet(text, anchor) if design else _extract_spec_snippet(text, anchor)
        if extracted is None:
            errors.append({"reason": "missing_ref_anchor", "detail": ref})
            item["error"] = "missing_ref_anchor"
            resolved.append(item)
            continue
        snippet, line = extracted
        item.update({"found": True, "line": line, "text": snippet, "sourcePathWasExplicit": bool(raw_path)})
        resolved.append(item)
    return resolved, errors


def resolve_task_refs(base: Path, task: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, str]]]:
    spec_refs = [ref for ref in task.get("specRefs", []) if isinstance(ref, str)]
    design_refs = [ref for ref in task.get("designRefs", []) if isinstance(ref, str)]
    for field in ("apiIds", "dataIds", "decisionIds"):
        design_refs.extend(f"design.md#{value}" for value in task.get(field, []) if isinstance(value, str))
    resolved_specs, spec_errors = _resolve_refs(base, spec_refs, design=False)
    resolved_design, design_errors = _resolve_refs(base, design_refs, design=True)
    return resolved_specs, resolved_design, spec_errors + design_errors


def _context_argv(
    workspace: Path,
    feature: str,
    task_id: str,
    code_workspaces: list[Path],
) -> list[str]:
    argv = [
        sys.executable,
        "-X",
        "utf8",
        str(Path(__file__).resolve()),
        "--workspace",
        str(workspace),
        "--feature",
        feature,
        "--task-id",
        task_id,
    ]
    for code_workspace in code_workspaces:
        argv.extend(["--code-workspace", str(code_workspace)])
    return argv


def _start_argv(workspace: Path, feature: str, task_id: str, code_workspace: Path | None) -> list[str]:
    argv = [
        sys.executable,
        "-X",
        "utf8",
        str(Path(__file__).with_name("task_runner.py").resolve()),
        "start",
        "--workspace",
        str(workspace),
        "--feature",
        feature,
        "--task-id",
        task_id,
    ]
    if code_workspace is not None:
        argv.extend(["--code-workspace", str(code_workspace)])
    return argv


def build_context(
    *,
    workspace: Path,
    feature: str,
    task_id: str,
    code_workspaces: list[Path] | None = None,
) -> WriterResult:
    base = feature_dir(workspace, feature)
    plan_path = base / PLAN_FILE
    try:
        data = load_plan(plan_path)
    except ValueError as exc:
        return fail("invalid_plan_json", str(exc), path=plan_path)

    structure_errors = validate_plan_data(data)
    if structure_errors:
        return WriterResult(
            ok=False,
            path=plan_path,
            errors=[{"reason": "invalid_plan_json", "detail": ",".join(structure_errors)}],
        )

    active_batch_id = data.get("activeBatchId")
    if not isinstance(active_batch_id, str):
        next_batch_id = data.get("nextBatchId")
        # Parallel Code runs intentionally leave the activeBatchId
        # pointer empty.  Resolve the task's owning unfinished batch locally
        # instead of forcing a serial pointer into the root Plan.
        candidates = [
            str(item.get("id"))
            for item in data.get("batches", [])
            if isinstance(item, dict)
            and isinstance(item.get("id"), str)
            and item.get("status") not in {"done", "failed"}
            and task_id in (item.get("taskIds") or [])
        ]
        if len(candidates) != 1:
            return fail("no_active_batch", str(next_batch_id or ""), path=plan_path)
        active_batch_id = candidates[0]
    active_entry = next(
        (item for item in data.get("batches", []) if isinstance(item, dict) and item.get("id") == active_batch_id),
        None,
    )
    if not isinstance(active_entry, dict):
        return fail("active_batch_not_found", active_batch_id, path=plan_path)
    if task_id not in active_entry.get("taskIds", []):
        known_task_ids = {
            value
            for entry in data.get("batches", [])
            if isinstance(entry, dict)
            for value in entry.get("taskIds", [])
            if isinstance(value, str)
        }
        reason = "task_not_in_active_batch" if task_id in known_task_ids else "task_not_found"
        return fail(reason, task_id, path=plan_path)

    active_plan_path = batch_plan_path(base, active_batch_id)
    try:
        active_plan = load_plan(active_plan_path)
    except ValueError as exc:
        return fail("invalid_batch_plan", str(exc), path=active_plan_path)
    known_task_ids = {
        value
        for entry in data.get("batches", [])
        if isinstance(entry, dict)
        for value in entry.get("taskIds", [])
        if isinstance(value, str)
    }
    batch_errors = validate_batch_plan_data(
        active_plan,
        expected_feature_id=feature,
        expected_batch_id=active_batch_id,
        known_task_ids=known_task_ids,
        # Deferred validation permits task repair after a sealed Batch. Batch
        # compilation is no longer part of that execution contract.
        defer_to_test_stages=defer_to_test_stages_enabled(data),
    )
    if batch_errors:
        return WriterResult(
            ok=False,
            path=active_plan_path,
            errors=[{"reason": "invalid_batch_plan", "detail": ",".join(batch_errors)}],
        )

    task = None
    for item in active_plan.get("tasks", []):
        if isinstance(item, dict) and item.get("id") == task_id:
            task = item
            break
    if task is None:
        return fail("task_not_found", task_id, path=plan_path)

    resolved_specs, resolved_design, errors = resolve_task_refs(base, task)
    source_refs = task.get("sourceRefs", [])
    resolved_sources: list[dict[str, Any]] = []
    if not isinstance(source_refs, list):
        errors.append({"reason": "plan_source_refs_invalid", "detail": "sourceRefs_must_be_array"})
        source_refs = []
    elif source_refs:
        source_context, source_errors = load_source_context(base)
        known_sources = source_index(source_context)
        for ref in source_refs:
            source = known_sources.get(ref) if isinstance(ref, str) else None
            if source is None:
                resolved_sources.append({
                    "id": ref,
                    "resolution": "source_context_unavailable" if source_errors else "not_registered",
                    "detail": "; ".join(source_errors) if source_errors else "未在 source-context.json 登记",
                })
            else:
                resolved = dict(source)
                source_path = resolved.get("sourcePath")
                candidate = (base / source_path).resolve() if isinstance(source_path, str) else None
                if resolved.get("availability") == "never_provided":
                    resolved["resolution"] = "never_provided"
                elif candidate is None or not _inside_base(candidate, base.resolve()) or not candidate.is_file():
                    resolved["resolution"] = "snapshot_missing"
                else:
                    resolved["resolution"] = "available"
                resolved_sources.append(resolved)

    data_out = {
        "feature": feature,
        "batchId": active_batch_id,
        "executionLane": active_entry.get("executionLane"),
        "batch": {
            "id": active_batch_id,
            "title": active_plan.get("title"),
            "status": active_plan.get("status"),
            "taskIds": active_entry.get("taskIds", []),
            "deliveryKind": active_entry.get("deliveryKind"),
            "atomicGroupId": active_entry.get("atomicGroupId"),
            "batchRationale": active_entry.get("batchRationale"),
            "completedTaskCount": active_plan.get("completedTaskCount"),
            "taskCount": active_plan.get("taskCount"),
        },
        "taskId": task_id,
        "artifactWorkspace": str(workspace),
        "artifactFeatureDir": str(base),
        "refResolution": {
            "base": "artifactFeatureDir",
            "specRefs": "relative-to-artifactFeatureDir",
            "designRefs": "relative-to-artifactFeatureDir",
            "sourceRefs": "optional source-context.json metadata; missing sources are returned with resolution state",
            "codeWorkspace": "current working directory / project repository",
        },
        "task": task,
        "taskContract": {
            "goal": task.get("goal"),
            "scope": task.get("scope"),
            # These are the machine facts the Batch agent uses to decide
            # whether the frontend Route protocol applies to this Task.
            "uiRequired": task.get("uiRequired") is True,
            "uiRefs": task.get("uiRefs") if isinstance(task.get("uiRefs"), dict) else {},
            "workspaceRef": task.get("workspaceRef"),
            "acceptanceCriteria": task.get("acceptanceCriteria"),
            "implementationPoints": task.get("implementationPoints", []),
            "testPoints": task.get("testPoints", []),
            "validationBoundary": task.get("validationBoundary"),
            "verificationIntent": task.get("verificationIntent"),
            "sourceRefs": source_refs,
            "testIntent": {
                "verificationIntent": task.get("verificationIntent"),
                "testPoints": task.get("testPoints", []),
            },
        },
        "resolvedSpecRefs": resolved_specs,
        "resolvedDesignRefs": resolved_design,
        "resolvedSourceRefs": resolved_sources,
    }
    if code_workspaces:
        try:
            repositories = resolve_repositories(code_workspaces)
            runtime_ignore_issues = [
                {
                    "repositoryId": repository_id,
                    "repositoryRoot": str(repository_root),
                    "path": path,
                    "code": "runtime_artifact_path_not_ignored",
                    "expected": "git_ignored",
                }
                for repository_id, repository_root in repositories.items()
                for path in unignored_runtime_artifact_paths(repository_root)
            ]
        except RepositorySnapshotError as exc:
            return with_result_data(
                fail("code_workspace_resolution_failed", str(exc), path=active_plan_path),
                requiredAction="repair_code_workspace_and_retry_context",
                retryContextArgv=_context_argv(workspace, feature, task_id, code_workspaces),
                implementationAllowed=False,
                startAllowed=False,
            )
        if runtime_ignore_issues:
            return WriterResult(
                ok=False,
                path=active_plan_path,
                errors=[
                    *errors,
                    {
                        "reason": "runtime_artifact_path_not_ignored",
                        "detail": ",".join(
                            f"{item['repositoryId']}:{item['path']}" for item in runtime_ignore_issues
                        ),
                    },
                ],
                data={
                    **data_out,
                    "requiredAction": "configure_git_ignore_and_retry_context",
                    "runtimeIgnoreIssues": runtime_ignore_issues,
                    "runtimeIgnoreRequirements": {
                        "requiredPaths": list(REQUIRED_IGNORED_RUNTIME_PATHS),
                        "allowedFiles": [".gitignore", ".git/info/exclude"],
                    },
                    "retryContextArgv": _context_argv(workspace, feature, task_id, code_workspaces),
                    "implementationAllowed": False,
                    "startAllowed": False,
                },
            )
    start_allowed = not errors and bool(code_workspaces)
    data_out["requiredAction"] = (
        "start_task"
        if start_allowed
        else "provide_code_workspace_and_retry_context"
        if not code_workspaces
        else "repair_context_errors_before_start"
    )
    data_out["retryContextArgv"] = _context_argv(workspace, feature, task_id, code_workspaces or [])
    data_out["startArgv"] = _start_argv(
        workspace,
        feature,
        task_id,
        code_workspaces[0] if code_workspaces else None,
    )
    data_out["implementationAllowed"] = start_allowed
    data_out["startAllowed"] = start_allowed
    return WriterResult(ok=not errors, path=active_plan_path, errors=errors, data=data_out)


def _cmd_context(args: argparse.Namespace) -> int:
    try:
        workspace = resolve_workspace(args.workspace)
        feature = resolve_feature(args.feature)
        code_workspaces = [Path(item).expanduser().resolve() for item in (args.code_workspace or [])]
        result = build_context(
            workspace=workspace,
            feature=feature,
            task_id=args.task_id,
            code_workspaces=code_workspaces,
        )
    except WriterError as exc:
        result = fail("path_resolution_failed", str(exc))
    return render_result(result)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Resolve a plan task into code-stage context.")
    parser.add_argument("--workspace", help="产物工作区根目录，默认由 PLUGIN_WORKSPACE/PROJECT_DIR 推导")
    parser.add_argument("--feature", help="Feature ID，默认读取 FEATURE_ID")
    parser.add_argument("--task-id", required=True, help="Task ID，例如 T001")
    parser.add_argument("--code-workspace", action="append", help="业务代码仓库路径，可重复传入")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    return _cmd_context(parser.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
