#!/usr/bin/env python3
"""Shared checkpoint parsing, transition, and guard helpers."""

from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
AUTODEV_HOOKS_DIR = ROOT / "skills" / "autodev" / "hooks"
if str(AUTODEV_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(AUTODEV_HOOKS_DIR))

from board_core.contracts import (  # noqa: E402
    BoardConfigError,
    load_board_config,
    load_record_workflow_contracts,
    load_repo_workflow_contracts,
    load_workflow_contracts,
)
from board_core.workflow_compiler import (  # noqa: E402
    BASE_WORKFLOW_PROFILE,
    BASE_WORKFLOW_TEMPLATE,
    normalize_workflow_decisions,
)
from board_core.workflow import find_current_node  # noqa: E402
from artifact_check import run_postcheck, run_precheck  # noqa: E402
from paths import ensure_dir, get_feature_hook_log_path  # noqa: E402


STATE_PATH_SUFFIX = (".autobizdevops", "STATE.md")
STATE_JSON_PATH_SUFFIX = (".autobizdevops", "state.json")
BLOCK_EXIT_CODE = 2
LOG_PATH = Path(tempfile.gettempdir()) / "check_state_done_hook.log"
BOARD_CONFIG_PATH = ROOT / "board_core" / "board_config.json"
PLUGIN_ID = "AUTOBIZDEVOPS-PLUGIN"
WORKFLOW_CONTRACTS = load_workflow_contracts(BOARD_CONFIG_PATH)
KNOWN_CHECKPOINTS = WORKFLOW_CONTRACTS.known_checkpoints
ALLOWED_NEXT = WORKFLOW_CONTRACTS.allowed_next
INITIAL_CHECKPOINTS = WORKFLOW_CONTRACTS.initial_checkpoints
DEFAULT_STAGE_BY_CHECKPOINT = WORKFLOW_CONTRACTS.stage_labels
START_CHECKPOINT_TO_SKILL = WORKFLOW_CONTRACTS.start_checkpoint_to_skill
END_CHECKPOINT_TO_SKILL = WORKFLOW_CONTRACTS.end_checkpoint_to_skill


def is_separator_row(cells: list[str]) -> bool:
    return all(cell and set(cell) <= {"-", ":"} for cell in cells)


def parse_state_record_table(content: str) -> tuple[dict[str, dict[str, str]], list[str]]:
    result: dict[str, dict[str, str]] = {}
    errors: list[str] = []

    for lineno, raw_line in enumerate(content.splitlines(), start=1):
        line = raw_line.strip()
        if not line.startswith("|"):
            continue

        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) < 3:
            continue
        if cells[0] == "Feature" or is_separator_row(cells):
            continue

        feature = cells[0]
        checkpoint = cells[2]
        if not feature:
            errors.append(f"line {lineno}: Feature 为空")
            continue
        if checkpoint not in KNOWN_CHECKPOINTS:
            errors.append(f"line {lineno}: Feature '{feature}' 使用了未知 checkpoint: {checkpoint}")
            continue
        if feature in result:
            errors.append(f"line {lineno}: Feature '{feature}' 出现重复行")
            continue
        result[feature] = {
            "feature": feature,
            "owner": cells[1] if len(cells) > 1 else "",
            "checkpoint": checkpoint,
            "stage": cells[3] if len(cells) > 3 else "",
            "iteration": cells[4] if len(cells) > 4 else "",
            "updated_at": cells[5] if len(cells) > 5 else "",
        }

    return result, errors


def parse_state_table(content: str) -> tuple[dict[str, str], list[str]]:
    records, errors = parse_state_record_table(content)
    return {feature: row["checkpoint"] for feature, row in records.items()}, errors


def parse_state_rows(content: str) -> dict[str, str]:
    rows: dict[str, str] = {}
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) < 3:
            continue
        if cells[0] == "Feature" or is_separator_row(cells):
            continue
        if cells[0]:
            rows[cells[0]] = cells[2]
    return rows


def read_stdin_text() -> str:
    raw = sys.stdin.buffer.read()
    if not raw:
        return ""
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode(sys.stdin.encoding or "utf-8", errors="replace")


def hook_log(message: str) -> None:
    try:
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().isoformat(timespec='seconds')}] {message}\n")
    except Exception:
        # 日志不能影响 hook 本身执行
        pass


def load_workflow_nodes(
    *,
    workspace_root: Path | None = None,
    workflow_profile: str = BASE_WORKFLOW_PROFILE,
    workflow_decisions: dict[str, str] | None = None,
) -> list[dict]:
    if workspace_root is not None or workflow_profile != BASE_WORKFLOW_PROFILE or workflow_decisions:
        try:
            return list(
                load_repo_workflow_contracts(
                    ROOT,
                    workspace=workspace_root,
                    profile=workflow_profile,
                    workflow_decisions=workflow_decisions,
                ).nodes
            )
        except BoardConfigError:
            return []
    try:
        config = load_board_config(BOARD_CONFIG_PATH)
        nodes = config.get("workflow", {}).get("nodes", [])
        return nodes if isinstance(nodes, list) else []
    except Exception:
        return []


def checkpoint_node_id(
    checkpoint: str | None,
    *,
    workspace_root: Path | None = None,
    workflow_profile: str = BASE_WORKFLOW_PROFILE,
    workflow_decisions: dict[str, str] | None = None,
) -> str:
    if not checkpoint:
        return ""
    _, node_id = find_current_node(
        load_workflow_nodes(
            workspace_root=workspace_root,
            workflow_profile=workflow_profile,
            workflow_decisions=workflow_decisions,
        ),
        checkpoint,
    )
    return node_id or ""


def safe_feature_slug(feature: str) -> bool:
    path = Path(feature)
    return bool(feature) and not path.is_absolute() and ".." not in path.parts


def append_feature_hook_log(
    workspace_root: Path,
    feature: str,
    checkpoint: str | None,
    *,
    event_id: str,
    event_status: str,
    message: str,
    workflow_profile: str = BASE_WORKFLOW_PROFILE,
    workflow_decisions: dict[str, str] | None = None,
) -> None:
    if not safe_feature_slug(feature):
        return
    record = {
        "ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "source": "hook",
        "sessionId": os.environ.get("SESSION_ID") or os.environ.get("session_id", ""),
        "pluginId": PLUGIN_ID,
        "featureId": feature,
        "eventId": event_id,
        "eventStatus": event_status,
        "message": message,
        "nodeId": checkpoint_node_id(
            checkpoint,
            workspace_root=workspace_root,
            workflow_profile=workflow_profile,
            workflow_decisions=workflow_decisions,
        ),
    }
    try:
        path = get_feature_hook_log_path(workspace_root, feature)
        ensure_dir(path.parent)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    except Exception:
        hook_log(f"feature hook log write failed for feature={feature!r}")


def append_checkpoint_hook_logs(
    workspace_root: Path,
    changes: list[tuple[str, str | None, str | None]],
    *,
    event_id: str | None = None,
    hook_id: str | None = None,
    label: str,
    errors: list[str],
    event_status: str | None = None,
    exit_code: int | None = None,
    message: str | None = None,
    workflow_profiles: dict[str, str] | None = None,
    workflow_decisions: dict[str, dict[str, str]] | None = None,
) -> None:
    if not changes:
        return
    resolved_event_id = event_id or hook_id or ""
    resolved_event_status = event_status or ("blocked" if errors else "success")
    summary = "\n".join(errors) if errors else f"{label} 通过"
    for feature, old_checkpoint, new_checkpoint in changes:
        transition = f"{old_checkpoint or 'empty'} -> {new_checkpoint or 'empty'}"
        append_feature_hook_log(
            workspace_root,
            feature,
            new_checkpoint or old_checkpoint,
            event_id=resolved_event_id,
            event_status=resolved_event_status,
            message=message or f"{transition}: {summary}",
            workflow_profile=(workflow_profiles or {}).get(feature, BASE_WORKFLOW_PROFILE),
            workflow_decisions=(workflow_decisions or {}).get(feature),
        )


def normalize_path(path: str, cwd: Path | None = None) -> Path:
    cwd = cwd or Path.cwd()
    normalized = Path(path.replace("\\", "/"))
    if not normalized.is_absolute():
        normalized = cwd / normalized
    return normalized.resolve()


def has_path_suffix(path: Path, suffix: tuple[str, ...]) -> bool:
    parts = tuple(part for part in str(path).replace("\\", "/").split("/") if part and part != ".")
    return parts[-len(suffix) :] == suffix


def has_state_path_suffix(path: Path) -> bool:
    return has_path_suffix(path, STATE_PATH_SUFFIX)


def has_state_json_path_suffix(path: Path) -> bool:
    return has_path_suffix(path, STATE_JSON_PATH_SUFFIX)


def is_state_path(path: str, cwd: Path | None = None) -> bool:
    if not path:
        return False
    return has_state_path_suffix(normalize_path(path, cwd))


def is_managed_state_path(path: str, cwd: Path | None = None) -> bool:
    if not path:
        return False
    normalized = normalize_path(path, cwd)
    return has_state_path_suffix(normalized) or has_state_json_path_suffix(normalized)


def get_current_content(state_path: Path) -> str:
    return state_path.read_text(encoding="utf-8") if state_path.exists() else ""


def build_new_content(
    payload: dict,
    state_path: Path,
    *,
    error_subject: str = "checkpoint 转移",
    include_state_in_missing_error: bool = True,
) -> tuple[str, list[str]]:
    tool_name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input", {})

    if tool_name in {"write_file", "WriteFile"}:
        return tool_input.get("content", ""), []

    def missing_old_error(tool_label: str) -> str:
        target = f"STATE.md {error_subject}" if include_state_in_missing_error else error_subject
        return f"{tool_label} 缺少 old，无法验证 {target}"

    if tool_name in {"edit_file", "StrReplaceFile"}:
        content = get_current_content(state_path)

        if "oldString" in tool_input or "newString" in tool_input:
            old = tool_input.get("oldString", "")
            new = tool_input.get("newString", "")
            replace_all = bool(tool_input.get("replaceAll"))
            if not old:
                target = f"STATE.md {error_subject}" if include_state_in_missing_error else error_subject
                return content, [f"edit_file 缺少 oldString，无法验证 {target}"]
            if old not in content:
                return content, [f"edit_file 的 oldString 未在当前 STATE.md 中找到，无法验证 {error_subject}"]
            return (content.replace(old, new) if replace_all else content.replace(old, new, 1)), []

        for edit in tool_input.get("edit", []):
            old = edit.get("old", "")
            new = edit.get("new", "")
            if not old:
                return content, [missing_old_error("edit_file.edit")]
            if old not in content:
                return content, [f"edit_file.edit 的 old 未在当前 STATE.md 中找到，无法验证 {error_subject}"]
            content = content.replace(old, new, 1)
        return content, []

    return "", []


def _record_for_feature(
    feature: str,
    old_records: dict[str, dict] | None,
    new_records: dict[str, dict] | None,
) -> dict:
    for records in (new_records, old_records):
        if not records:
            continue
        record = records.get(feature)
        if record:
            return record
    return {}


def _contracts_for_record(
    workspace_root: Path | None,
    record: dict,
    repo_root: Path,
):
    profile = record.get("workflowProfile") or BASE_WORKFLOW_PROFILE
    template = record.get("workflowTemplate") or BASE_WORKFLOW_TEMPLATE
    decisions = record.get("workflowDecisions") or {}
    skipped = record.get("workflowSkippedNodes") or []
    if (
        workspace_root is None
        and profile == BASE_WORKFLOW_PROFILE
        and template == BASE_WORKFLOW_TEMPLATE
        and not decisions
        and not skipped
    ):
        return WORKFLOW_CONTRACTS
    return load_record_workflow_contracts(repo_root, record, workspace=workspace_root)


def validate_transitions(
    old_map: dict[str, str],
    new_map: dict[str, str],
    *,
    workspace_root: Path | None = None,
    old_records: dict[str, dict[str, str]] | None = None,
    new_records: dict[str, dict[str, str]] | None = None,
    repo_root: Path = ROOT,
) -> list[str]:
    errors: list[str] = []

    for feature in sorted(set(old_map) | set(new_map)):
        old_cp = old_map.get(feature)
        new_cp = new_map.get(feature)
        record = _record_for_feature(feature, old_records, new_records)
        try:
            contracts = _contracts_for_record(workspace_root, record, repo_root)
        except BoardConfigError as exc:
            errors.append(f"Feature '{feature}' workflow 配置无法编译: {exc}")
            continue

        if old_cp is None:
            if new_cp not in contracts.initial_checkpoints:
                allowed = " / ".join(sorted(contracts.initial_checkpoints))
                errors.append(f"Feature '{feature}' 是新增行，只允许从空状态进入 {allowed}，当前为 {new_cp}")
            continue

        if new_cp is None:
            errors.append(f"Feature '{feature}' 被从 STATE.md 删除")
            continue

        if old_cp == new_cp:
            continue

        allowed_next = contracts.allowed_next.get(old_cp, set())
        if new_cp not in allowed_next:
            allowed = ", ".join(sorted(allowed_next)) if allowed_next else "无"
            errors.append(f"Feature '{feature}' 非法转移: {old_cp} -> {new_cp}；允许的下一个状态: {allowed}")

    return errors


def changed_rows(old_rows: dict[str, str], new_rows: dict[str, str]) -> list[tuple[str, str | None, str | None]]:
    changes: list[tuple[str, str | None, str | None]] = []
    for slug in sorted(set(old_rows) | set(new_rows)):
        old_checkpoint = old_rows.get(slug)
        new_checkpoint = new_rows.get(slug)
        if old_checkpoint != new_checkpoint:
            changes.append((slug, old_checkpoint, new_checkpoint))
    return changes


def check_stage_inputs(
    root: Path,
    slug: str,
    skill: str,
    repo_root: Path = ROOT,
    *,
    workflow_profile: str = BASE_WORKFLOW_PROFILE,
    workflow_decisions: dict[str, str] | None = None,
    workflow_record: dict | None = None,
) -> str | None:
    code, message = run_precheck(
        repo_root,
        root,
        skill,
        slug,
        workflow_profile=workflow_profile,
        workflow_decisions=workflow_decisions,
        workflow_record=workflow_record,
    )
    if code != 0:
        return message
    return None


def check_stage_outputs(
    root: Path,
    slug: str,
    skill: str,
    repo_root: Path = ROOT,
    *,
    workflow_profile: str = BASE_WORKFLOW_PROFILE,
    workflow_decisions: dict[str, str] | None = None,
    workflow_record: dict | None = None,
    target_checkpoint: str | None = None,
) -> str | None:
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        code, message = run_postcheck(
            repo_root,
            root,
            skill,
            slug,
            workflow_profile=workflow_profile,
            workflow_decisions=workflow_decisions,
            workflow_record=workflow_record,
            target_checkpoint=target_checkpoint,
        )
    if code != 0:
        detail = output.getvalue().strip()
        return f"{message}\n{detail}" if detail else message
    return None


def validate_lifecycle(
    root: Path,
    old_rows: dict[str, str],
    new_rows: dict[str, str],
    repo_root: Path = ROOT,
    *,
    old_records: dict[str, dict[str, str]] | None = None,
    new_records: dict[str, dict[str, str]] | None = None,
) -> list[str]:
    errors: list[str] = []
    for slug, old_checkpoint, new_checkpoint in changed_rows(old_rows, new_rows):
        record = _record_for_feature(slug, old_records, new_records)
        try:
            contracts = _contracts_for_record(root, record, repo_root)
        except BoardConfigError as exc:
            errors.append(f"Feature '{slug}' workflow 配置无法编译: {exc}")
            continue
        workflow_profile = record.get("workflowProfile") or BASE_WORKFLOW_PROFILE
        workflow_decisions = record.get("workflowDecisions") or {}
        # A physically assembled workflow can finish at any selected business
        # node. Its final done transition has no later stage to trigger the
        # normal leave-stage checks, so validate the actual outputs now.
        final_node = contracts.nodes[-1] if contracts.nodes else {}
        final_checkpoints = final_node.get("checkpoints", [])
        final_done = next((cp for cp in final_checkpoints if cp.endswith("_done")), None)
        if (new_checkpoint == final_done and old_checkpoint != new_checkpoint
                and final_node.get("skill")):
            error = check_stage_outputs(
                root, slug, final_node["skill"], repo_root,
                workflow_profile=workflow_profile, workflow_decisions=workflow_decisions,
                workflow_record=record or None, target_checkpoint=new_checkpoint)
            if error:
                errors.append(error)
            if final_node["skill"] == "autobiz-requirement-discuss":
                env = {**os.environ, "PLUGIN_WORKSPACE": str(root.parent), "PROJECT_DIR": root.name}
                try:
                    result = subprocess.run(
                        [sys.executable, "-B", "-X", "utf8",
                         str(repo_root / "skills/autobiz/hooks/biz_validate.py"),
                         "prd", "--feature", slug, "--json", "--draft"],
                        cwd=repo_root, env=env, capture_output=True, text=True,
                        encoding="utf-8", timeout=60, check=False)
                    if result.returncode:
                        errors.append(f"biz-prd-validate: {result.stdout.strip()} {result.stderr.strip()}")
                except (OSError, subprocess.TimeoutExpired) as error:
                    errors.append(f"biz-prd-validate failed: {error}")
        if new_checkpoint:
            start_skill = contracts.start_checkpoint_to_skill.get(new_checkpoint)
            if start_skill:
                error = check_stage_inputs(
                    root,
                    slug,
                    start_skill,
                    repo_root,
                    workflow_profile=workflow_profile,
                    workflow_decisions=workflow_decisions,
                    workflow_record=record or None,
                )
                if error:
                    errors.append(error)

        if old_checkpoint and old_checkpoint != new_checkpoint:
            end_skill = contracts.end_checkpoint_to_skill.get(old_checkpoint)
            if end_skill:
                error = check_stage_outputs(
                    root,
                    slug,
                    end_skill,
                    repo_root,
                    workflow_profile=workflow_profile,
                    workflow_decisions=workflow_decisions,
                    workflow_record=record or None,
                    target_checkpoint=new_checkpoint,
                )
                if error:
                    errors.append(error)

    return errors


def payload_state_path(payload: dict) -> Path | None:
    tool_input = payload.get("tool_input", {})
    file_path = tool_input.get("filePath") or tool_input.get("file_path") or tool_input.get("path", "")
    cwd = Path(payload.get("cwd") or Path.cwd())
    if not is_state_path(str(file_path), cwd):
        return None
    return normalize_path(str(file_path), cwd)


def payload_managed_state_path(payload: dict) -> Path | None:
    tool_input = payload.get("tool_input", {})
    file_path = tool_input.get("filePath") or tool_input.get("file_path") or tool_input.get("path", "")
    cwd = Path(payload.get("cwd") or Path.cwd())
    if not is_managed_state_path(str(file_path), cwd):
        return None
    return normalize_path(str(file_path), cwd)


def block(reason: str, system_message: str) -> int:
    print(reason, file=sys.stderr)
    json.dump(
        {
            "decision": "block",
            "reason": reason,
            "systemMessage": system_message,
        },
        sys.stdout,
        ensure_ascii=False,
    )
    return BLOCK_EXIT_CODE


def run_state_done(payload: dict) -> int:
    tool_input = payload.get("tool_input", {})
    file_path = tool_input.get("filePath") or tool_input.get("file_path") or tool_input.get("path", "")
    cwd = Path(payload.get("cwd") or Path.cwd())
    hook_log(f"file_path={file_path!r}")
    hook_log(f"cwd={cwd}")

    managed_state_path = payload_managed_state_path(payload)
    if managed_state_path is None:
        hook_log("not managed state path, skip")
        return 0
    hook_log(f"managed_state_path={managed_state_path}")

    reason = (
        "状态文件不允许通过 edit_file/write_file 直接修改；"
        "state.json 是主事实源，STATE.md 是自动生成视图。请使用 hooks/update_checkpoint.py 推进 checkpoint。"
    )
    hook_log(f"direct_state_edit_blocked tool_name={payload.get('tool_name', '')!r}")
    return block(reason, reason)


def run_autodev_lifecycle(payload: dict) -> int:
    state_path = payload_state_path(payload)
    if state_path is None:
        return 0

    workspace_root = state_path.parent.parent
    old_content = get_current_content(state_path)
    new_content, edit_errors = build_new_content(payload, state_path)
    old_rows = parse_state_rows(old_content)
    new_rows = parse_state_rows(new_content)
    changes = changed_rows(old_rows, new_rows)
    errors = list(edit_errors)
    if not errors:
        errors.extend(validate_lifecycle(workspace_root, old_rows, new_rows))

    if errors:
        append_checkpoint_hook_logs(
            workspace_root,
            changes,
            hook_id="autodev-lifecycle",
            label="Autodev 产物校验",
            errors=errors,
            exit_code=BLOCK_EXIT_CODE,
        )
        return block(
            "\n".join(errors),
            "Autodev artifact hook failed. Fix the stage artifacts, then retry hooks/update_checkpoint.py.",
        )
    append_checkpoint_hook_logs(
        workspace_root,
        changes,
        hook_id="autodev-lifecycle",
        label="Autodev 产物校验",
        errors=[],
        exit_code=0,
    )
    return 0


HOOK_COMMANDS = {
    "state-done": run_state_done,
    "autodev-lifecycle": run_autodev_lifecycle,
}


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 1 or argv[0] not in HOOK_COMMANDS:
        choices = " | ".join(sorted(HOOK_COMMANDS))
        print(f"usage: state_checkpoint.py <{choices}>", file=sys.stderr)
        return 1

    command = argv[0]
    hook_log("hook invoked")
    hook_log(f"process_cwd={Path.cwd()}")
    raw_input = read_stdin_text()
    hook_log(f"stdin_len={len(raw_input)}")
    hook_log(f"stdin_repr={raw_input[:1000]!r}")
    if not raw_input.strip():
        hook_log("empty stdin, skip json parse")
        return 0

    try:
        payload = json.loads(raw_input)
    except Exception as exc:
        hook_log(f"json parse failed: {type(exc).__name__}: {exc}")
        raise
    hook_log(f"payload_keys={list(payload.keys())}")
    return HOOK_COMMANDS[command](payload)


if __name__ == "__main__":
    raise SystemExit(main())
