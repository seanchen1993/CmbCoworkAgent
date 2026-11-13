#!/usr/bin/env python3
"""Block business-code writes until task and route gates authorize them."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from board_core.state_store import load_state_json_records_result  # noqa: E402
from paths import get_plugin_output_workspace, resolve_project_dir  # noqa: E402
from resolve_frontend_html_route import (  # noqa: E402
    FrontendRouteError,
    ROUTE_ABSOLUTE,
    ROUTE_MISSING,
    ROUTE_NONE,
    ROUTE_SPEC_DRIVEN,
    ROUTE_STANDARD,
    evidence_path,
    feature_dir,
    read_json,
    resolve_frontend_route,
)
from hooks.task_run_integrity import strict_task_run_integrity_error  # noqa: E402
from hooks.plan_write_ownership import is_test_asset_path  # noqa: E402
from ui_context import UIContextError, load_ui_context  # noqa: E402


BLOCK_EXIT_CODE = 2
PATH_KEYS = {
    "filePath",
    "file_path",
    "path",
    "filename",
    "absolutePath",
    "relativePath",
}
FRONTEND_CODE_SUFFIXES = {
    ".tsx",
    ".jsx",
    ".vue",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".styl",
    ".ts",
    ".js",
    ".mjs",
    ".cjs",
}
BACKEND_CODE_SUFFIXES = {
    ".java",
    ".kt",
    ".kts",
    ".groovy",
    ".scala",
    ".py",
    ".go",
    ".rs",
    ".cs",
    ".rb",
    ".php",
    ".xml",
    ".sql",
    ".properties",
    ".yaml",
    ".yml",
    ".json",
}
BUSINESS_CODE_SUFFIXES = FRONTEND_CODE_SUFFIXES | BACKEND_CODE_SUFFIXES


def read_stdin_text() -> str:
    raw = sys.stdin.buffer.read()
    if not raw:
        return ""
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode(sys.stdin.encoding or "utf-8", errors="replace")


def path_from_uri(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme != "file":
        return value
    return unquote(parsed.path)


def normalize_path(path: str, cwd: Path) -> Path:
    normalized = Path(path_from_uri(path).replace("\\", "/")).expanduser()
    if not normalized.is_absolute():
        normalized = cwd / normalized
    return normalized.resolve(strict=False)


def extract_candidate_paths(value: object) -> list[str]:
    if not isinstance(value, dict):
        return []
    paths: list[str] = []
    for key in PATH_KEYS:
        raw = value.get(key)
        if isinstance(raw, str) and raw.strip():
            paths.append(raw)
        elif isinstance(raw, list):
            paths.extend(item for item in raw if isinstance(item, str) and item.strip())
    return paths


def workspace_from_payload(payload: dict) -> Path | None:
    plugin_workspace = str(os.environ.get("PLUGIN_WORKSPACE") or "").strip()
    project_code = resolve_project_dir(os.environ)
    if plugin_workspace and project_code and "/" not in project_code and "\\" not in project_code:
        return (Path(plugin_workspace).expanduser() / project_code).resolve(strict=False)
    try:
        return get_plugin_output_workspace()
    except ValueError:
        workspace = os.environ.get("WORKSPACE_PATH") or payload.get("cwd")
        return Path(workspace).resolve(strict=False) if workspace else None


def current_feature() -> str:
    return str(os.environ.get("FEATURE_ID") or "").strip()


def current_checkpoint(workspace: Path, feature: str) -> str:
    result = load_state_json_records_result(workspace)
    if not result.exists or result.fatal_errors:
        return ""
    record = result.records.get(feature)
    if not isinstance(record, dict):
        return ""
    checkpoint = record.get("checkpoint", "")
    return checkpoint if isinstance(checkpoint, str) else ""


def block(reason: str, *, system_message: str | None = None) -> int:
    print(reason, file=sys.stderr)
    json.dump(
        {
            "decision": "block",
            "reason": reason,
            "systemMessage": system_message or (
                "前端代码生成必须先进入 with-absolute-html 或 with-standard-html：运行 route resolver、"
                "完整读取 route SKILL.md，创建 route write_todos，并由 route SKILL 转交 parser 后再写前端源码。"
            ),
        },
        sys.stdout,
        ensure_ascii=False,
    )
    return BLOCK_EXIT_CODE


def is_frontend_code_path(path: Path) -> bool:
    return path.suffix.lower() in FRONTEND_CODE_SUFFIXES


def is_business_code_path(path: Path) -> bool:
    return path.suffix.lower() in BUSINESS_CODE_SUFFIXES


def is_managed_task_run_path(path: Path, workspace: Path, feature: str) -> bool:
    managed_root = (feature_dir(workspace, feature) / ".task-runs").resolve(strict=False)
    try:
        path.resolve(strict=False).relative_to(managed_root)
        return True
    except ValueError:
        return False


def is_any_task_run_artifact_path(path: Path) -> bool:
    parts = path.resolve(strict=False).parts
    for index, part in enumerate(parts):
        if part != ".autobizdevops":
            continue
        if index + 3 < len(parts) and parts[index + 1] == "features":
            return ".task-runs" in parts[index + 3:]
    return False


def missing_protocol_flags(evidence: dict) -> list[str]:
    required = ("routeSkillReadComplete", "routeTodosCreated", "parserRead")
    return [flag for flag in required if evidence.get(flag) is not True]


def protocol_next_step(feature: str, missing: list[str]) -> str:
    if "routeSkillReadComplete" in missing:
        return (
            "read route SKILL.md to EOF, then run "
            f"`python hooks/resolve_frontend_html_route.py --feature {feature} "
            "--mark route-skill-read-complete --json`"
        )
    if "routeTodosCreated" in missing:
        return (
            "create route write_todos, then run "
            f"`python hooks/resolve_frontend_html_route.py --feature {feature} "
            "--mark route-todos-created --json`"
        )
    if "parserRead" in missing:
        return (
            "read delegated parser, then run "
            f"`python hooks/resolve_frontend_html_route.py --feature {feature} "
            "--mark parser-read --json`"
        )
    return "rerun frontend route protocol"


def validate_frontend_write(workspace: Path, feature: str) -> int:
    try:
        ui_context = load_ui_context(workspace / ".autobizdevops" / "features" / feature)
    except UIContextError as exc:
        return block(f"UI_CONTEXT.json 非法，无法解析前端 route: {exc}")
    if isinstance(ui_context, dict) and ui_context.get("uiRequired") is False:
        return block("UI_CONTEXT.json 标记 uiRequired=false，当前任务不允许写前端业务代码")

    evidence_file = evidence_path(workspace, feature)
    evidence = read_json(evidence_file)
    if not evidence:
        try:
            resolved = resolve_frontend_route(workspace, feature, write_evidence=False)
        except FrontendRouteError as exc:
            return block(f"UI_CONTEXT.json 非法，无法解析前端 route: {exc}")
        if resolved.get("source") == "UI_CONTEXT.json" and resolved.get("route") == ROUTE_NONE:
            return block("UI_CONTEXT.json 标记 uiRequired=false，当前任务不允许写前端业务代码")
        if resolved.get("triggered"):
            return block(f"写前端代码前缺少 FRONTEND_ROUTE.json: {evidence_file}")
        return 0

    route = evidence.get("route")
    if route == ROUTE_NONE and evidence.get("source") == "UI_CONTEXT.json":
        return block("UI_CONTEXT.json 标记 uiRequired=false，当前任务不允许写前端业务代码")
    if route == ROUTE_SPEC_DRIVEN:
        return 0
    if route == ROUTE_MISSING and evidence.get("source") == "UI_CONTEXT.json":
        return 0
    if route not in {ROUTE_ABSOLUTE, ROUTE_STANDARD}:
        return block(f"当前 frontend route 不允许写前端代码: {route}")
    missing = missing_protocol_flags(evidence)
    if missing:
        return block(
            "frontend route protocol incomplete: "
            f"missing={','.join(missing)}; next={protocol_next_step(feature, missing)}"
        )
    if evidence.get("routeSkillReadComplete") is not True:
        return block("写前端代码前必须完整读取对应 route SKILL.md")
    if evidence.get("routeTodosCreated") is not True:
        return block("写前端代码前必须按 route SKILL.md 创建 write_todos 清单")
    if evidence.get("parserRead") is not True:
        return block("写前端代码前必须由 route SKILL 转交并读取对应 parser 文档")
    return 0


def _path_within(path: Path, root: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(root.resolve(strict=False))
        return True
    except ValueError:
        return False


def _active_runs_for_write_target(
    active_runs: list[tuple[Path, dict]],
    target_path: Path | None,
) -> list[tuple[Path, dict]]:
    """Return the most-specific active runs that own ``target_path``.

    Native Git worktrees for parallel Batches can live below the primary
    checkout.  A simple ancestor match could therefore select both a legacy
    primary-checkout run and the Batch run.  Keep only the deepest matching
    ``codeWorkspace`` so a write in one worktree is authorized by its own
    task run, never by a sibling Batch or a parent checkout.
    """
    if target_path is None:
        return active_runs
    matches: list[tuple[Path, dict, Path]] = []
    for run_path, run in active_runs:
        raw_workspace = run.get("codeWorkspace")
        if not isinstance(raw_workspace, str) or not raw_workspace.strip():
            continue
        code_workspace = Path(raw_workspace).expanduser().resolve(strict=False)
        if _path_within(target_path, code_workspace):
            matches.append((run_path, run, code_workspace))
    if not matches:
        return []
    deepest = max(len(item[2].parts) for item in matches)
    return [(run_path, run) for run_path, run, root in matches if len(root.parts) == deepest]


def _test_stage_worktrees(manifest: dict) -> list[tuple[str, Path, dict, str]]:
    """Return test-authorized worktrees declared by one runtime manifest.

    Delivery Batches own UTest in ``test``.  The one post-merge validation
    Batch owns E2E in ``e2e_test`` and can have one worktree per repository.
    Neither is a global workflow checkpoint.
    """

    candidates: list[tuple[str, Path, dict, str]] = []
    for batch_id, batch in (manifest.get("batches") or {}).items():
        if not isinstance(batch_id, str) or not isinstance(batch, dict):
            continue
        worktree = batch.get("worktreePath")
        if isinstance(worktree, str) and worktree.strip():
            candidates.append((batch_id, Path(worktree).expanduser().resolve(strict=False), batch, "test"))
    for batch_id, batch in (manifest.get("validationBatches") or {}).items():
        if not isinstance(batch_id, str) or not isinstance(batch, dict):
            continue
        worktrees = batch.get("worktrees")
        if not isinstance(worktrees, dict):
            continue
        for worktree in worktrees.values():
            if isinstance(worktree, str) and worktree.strip():
                candidates.append((batch_id, Path(worktree).expanduser().resolve(strict=False), batch, "e2e_test"))
    return candidates


def _test_write_owner(
    workspace: Path,
    feature: str,
    target_path: Path,
) -> tuple[str, Path, dict, str] | None:
    """Find the deepest runtime Worktree that owns a test-asset write."""

    manifests = (feature_dir(workspace, feature) / ".parallel-runs").glob("*/manifest.json")
    matches: list[tuple[str, Path, dict, str]] = []
    for manifest_path in manifests:
        manifest = read_json(manifest_path)
        for batch_id, worktree, batch, stage in _test_stage_worktrees(manifest):
            if not _path_within(target_path, worktree):
                continue
            relative = target_path.resolve(strict=False).relative_to(worktree)
            if is_test_asset_path(relative.as_posix()):
                matches.append((batch_id, worktree, batch, stage))
    if not matches:
        return None
    depth = max(len(worktree.parts) for _, worktree, _, _ in matches)
    deepest = [item for item in matches if len(item[1].parts) == depth]
    return deepest[0] if len(deepest) == 1 else None


def validate_test_asset_write(workspace: Path, feature: str, *, target_path: Path) -> int:
    """Authorize test writes only during their owning Batch test substage."""

    owner = _test_write_owner(workspace, feature, target_path)
    if owner is None:
        return block(
            f"test asset write is outside an active Batch Worktree: {target_path}",
            system_message="测试资产只能在当前 Batch 的原生 Worktree 且 test 子阶段运行时写入。",
        )
    batch_id, worktree, batch, stage = owner
    states = batch.get("stageStates") if isinstance(batch.get("stageStates"), dict) else {}
    stage_state = states.get(stage)
    if not isinstance(stage_state, dict) or stage_state.get("status") != "running":
        actual = stage_state.get("status") if isinstance(stage_state, dict) else None
        return block(
            f"test asset write requires {stage} stage=running for Batch {batch_id}: found={actual}",
            system_message="测试资产写入必须由固定 Code Workflow 启动对应 Batch 的测试子阶段授权。",
        )
    if stage == "test":
        review = states.get("review")
        if not isinstance(review, dict) or review.get("status") != "passed":
            return block(
                f"test asset write requires review=passed for Batch {batch_id}",
                system_message="UTest 只能在当前 Batch 的生产代码 Review 通过后执行。",
            )
    del worktree
    return 0


def validate_code_task_run_write(
    workspace: Path,
    feature: str,
    *,
    target_path: Path | None = None,
) -> int:
    target = feature_dir(workspace, feature)
    active_runs: list[tuple[Path, dict]] = []
    for path in (target / ".task-runs").glob("T*/*.json"):
        payload = read_json(path)
        if (
            payload.get("featureId") == feature
            and payload.get("status") not in {"implemented", "done", "failed", "aborted"}
        ):
            active_runs.append((path, payload))
    authorized_runs = _active_runs_for_write_target(active_runs, target_path)
    if len(authorized_runs) != 1:
        location = f" for write target {target_path}" if target_path is not None else ""
        return block(
            "business code write requires exactly one active task run"
            f"{location}: found={len(authorized_runs)}; totalActive={len(active_runs)}; "
            "next=run task_runner.py start",
            system_message="业务代码写入前必须存在一个由 task_runner 创建的活动 run。",
        )
    run_path, run = authorized_runs[0]
    integrity_error = strict_task_run_integrity_error(run)
    if integrity_error is not None:
        return block(
            f"active task run authorization invalid: {integrity_error}",
            system_message="活动 task run 不是完整且可验证的 v2 runner 产物，禁止据此授权写代码。",
        )
    if run_path.parent.name != run.get("taskId") or run_path.stem != run.get("runId"):
        return block(
            "active task run path identity mismatch",
            system_message="活动 task run 的路径身份与密封内容不一致，禁止据此授权写代码。",
        )
    if run.get("status") != "started":
        return block(
            f"task run status={run.get('status')} does not authorize source writes",
            system_message="只有 started 状态的活动 task run 可以授权业务源码写入。",
        )
    execution_mode = run.get("executionMode")
    if execution_mode != "code":
        return block(
            f"executionMode={execution_mode} does not permit business source writes",
            system_message="verified_existing 与 external_dependency 任务不得写入业务源码。",
        )
    return 0


def main() -> int:
    raw_input = read_stdin_text()
    if not raw_input.strip():
        return 0
    payload = json.loads(raw_input)
    cwd = Path(payload.get("cwd") or Path.cwd()).resolve(strict=False)
    candidate_paths = [
        normalize_path(raw_path, cwd)
        for raw_path in extract_candidate_paths(payload.get("tool_input", {}))
    ]
    if any(is_any_task_run_artifact_path(path) for path in candidate_paths):
        return block(
            ".task-runs artifacts are runner-owned and cannot be edited directly",
            system_message=".task-runs 只能由 task_runner 原子写入，禁止手工创建或修改。",
        )
    feature = current_feature()
    if not feature:
        return 0
    workspace = workspace_from_payload(payload)
    if workspace is None or current_checkpoint(workspace, feature) != "code_in_progress":
        return 0

    for target_path in candidate_paths:
        # A unified Code checkpoint spans implementation, review, UTest and
        # final E2E.  Test assets therefore need their own runtime-stage
        # authorization before extension-based production-code checks.
        if is_test_asset_path(target_path.as_posix()):
            result = validate_test_asset_write(workspace, feature, target_path=target_path)
            if result:
                return result
            continue
        if is_frontend_code_path(target_path):
            result = validate_frontend_write(workspace, feature)
            if result:
                return result
        if is_business_code_path(target_path):
            result = validate_code_task_run_write(workspace, feature, target_path=target_path)
            if result:
                return result
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
