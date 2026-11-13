"""JSON-backed state store with STATE.md as a generated view."""

from __future__ import annotations

import json
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict

from board_core.contracts import (
    BoardConfigError,
    load_board_config,
    load_record_workflow_contracts,
    load_workflow_contracts,
)
from board_core.workflow_compiler import (
    BASE_WORKFLOW_PROFILE,
    BASE_WORKFLOW_TEMPLATE,
    WorkflowCompileError,
    normalize_workflow_decisions,
    normalize_workflow_profile,
    normalize_workflow_skipped_nodes,
    normalize_workflow_template,
    workflow_template_uses_nodes,
)
from board_core.workflow import find_current_node


ROOT = Path(__file__).resolve().parents[1]
BOARD_CONFIG_PATH = ROOT / "board_core" / "board_config.json"
STATE_SCHEMA_VERSION = "autobizdevops.state.v3"
STATE_RELATIVE_PATH = Path(".autobizdevops") / "STATE.md"
STATE_JSON_RELATIVE_PATH = Path(".autobizdevops") / "state.json"
STATE_COLUMNS = ("Feature", "负责人", "checkpoint", "阶段", "迭代", "最后更新")
EMPTY_CELL = "—"
LEGACY_CHECKPOINT_ALIASES = {
    "discuss_in_progress": "prd_in_progress",
    "discuss_done": "prd_in_progress",
}
LEGACY_WORKFLOW_NODE_ALIASES = {
    "biz.discuss": "biz.prd",
}

BOARD_CONFIG = load_board_config(BOARD_CONFIG_PATH)
WORKFLOW_CONTRACTS = load_workflow_contracts(BOARD_CONFIG_PATH)
KNOWN_CHECKPOINTS = WORKFLOW_CONTRACTS.known_checkpoints
DEFAULT_STAGE_BY_CHECKPOINT = WORKFLOW_CONTRACTS.stage_labels

StateRecord = Dict[str, Any]
StateRecords = Dict[str, StateRecord]


@dataclass(frozen=True)
class StateLoadResult:
    records: StateRecords
    errors: list[str]
    exists: bool
    source: str
    raw_records: dict[str, Any] = field(default_factory=dict)
    record_errors: dict[str, list[str]] = field(default_factory=dict)
    fatal_errors: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class StateSyncResult:
    ok: bool
    records: StateRecords
    errors: list[str]
    state_exists: bool
    changed: bool
    state_path: Path
    state_json_path: Path
    raw_records: dict[str, Any] = field(default_factory=dict)
    record_errors: dict[str, list[str]] = field(default_factory=dict)


def get_state_path(workspace: Path) -> Path:
    return workspace.resolve() / STATE_RELATIVE_PATH


def get_state_json_path(workspace: Path) -> Path:
    return workspace.resolve() / STATE_JSON_RELATIVE_PATH


def _clean(value: Any, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text if text else default


def _is_separator_row(cells: list[str]) -> bool:
    return all(cell and set(cell) <= {"-", ":"} for cell in cells)


def _split_table_cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _migrate_workflow_nodes(value: Any) -> Any:
    if not isinstance(value, list):
        return value
    migrated: list[Any] = []
    for item in value:
        normalized = LEGACY_WORKFLOW_NODE_ALIASES.get(item, item) if isinstance(item, str) else item
        if normalized not in migrated:
            migrated.append(normalized)
    return migrated


def _migrate_skipped_nodes(value: Any) -> Any:
    if not isinstance(value, list):
        return value
    return [item for item in value if item != "biz.discuss"]


def _contracts_for_record(workspace: Path | None, record: dict):
    workflow_profile = record.get("workflowProfile", BASE_WORKFLOW_PROFILE)
    workflow_template = record.get("workflowTemplate", BASE_WORKFLOW_TEMPLATE)
    workflow_decisions = record.get("workflowDecisions") or {}
    workflow_skipped = record.get("workflowSkippedNodes") or []
    if workflow_template == BASE_WORKFLOW_TEMPLATE and not workflow_decisions and not workflow_skipped:
        if workspace is None or workflow_profile == BASE_WORKFLOW_PROFILE:
            return WORKFLOW_CONTRACTS
    try:
        return load_record_workflow_contracts(ROOT, record, workspace=workspace)
    except BoardConfigError as exc:
        raise ValueError(str(exc)) from exc


def _normalize_record(
    feature: str,
    raw: Any,
    errors: list[str],
    *,
    context: str,
    workspace: Path | None = None,
) -> StateRecord | None:
    feature = _clean(feature)
    if not feature:
        errors.append(f"{context}: feature 不能为空")
        return None

    if isinstance(raw, str):
        raw_record: dict[str, Any] = {"checkpoint": raw}
    elif isinstance(raw, dict):
        raw_record = raw
    else:
        errors.append(f"{context}: Feature '{feature}' 的记录必须是对象或 checkpoint 字符串")
        return None

    record_feature = _clean(raw_record.get("feature"), feature)
    if record_feature != feature:
        errors.append(f"{context}: Feature key '{feature}' 与记录 feature '{record_feature}' 不一致")
        return None

    workflow_profile = normalize_workflow_profile(_clean(raw_record.get("workflowProfile"), BASE_WORKFLOW_PROFILE))
    workflow_template = normalize_workflow_template(_clean(raw_record.get("workflowTemplate"), BASE_WORKFLOW_TEMPLATE))
    try:
        workflow_decisions = normalize_workflow_decisions(raw_record.get("workflowDecisions", {}))
    except WorkflowCompileError as exc:
        errors.append(f"{context}: Feature '{feature}' 的 workflowDecisions 无效: {exc}")
        return None
    raw_workflow_nodes = _migrate_workflow_nodes(raw_record.get("workflowNodes"))
    try:
        workflow_skipped = normalize_workflow_skipped_nodes(
            _migrate_skipped_nodes(raw_record.get("workflowSkippedNodes"))
        )
    except WorkflowCompileError as exc:
        errors.append(f"{context}: Feature '{feature}' 的 workflowSkippedNodes 无效: {exc}")
        return None
    resolved_record = {
        "workflowProfile": workflow_profile,
        "workflowDecisions": workflow_decisions,
        "workflowTemplate": workflow_template,
        "workflowNodes": raw_workflow_nodes,
        "workflowSkippedNodes": list(workflow_skipped),
    }
    try:
        contracts = _contracts_for_record(workspace, resolved_record)
    except ValueError as exc:
        errors.append(f"{context}: Feature '{feature}' 的 workflow 配置无效: {exc}")
        return None

    raw_checkpoint = _clean(raw_record.get("checkpoint"))
    checkpoint = LEGACY_CHECKPOINT_ALIASES.get(raw_checkpoint, raw_checkpoint)
    if checkpoint not in contracts.known_checkpoints:
        errors.append(f"{context}: Feature '{feature}' 使用了未知 checkpoint: {checkpoint or '未设置'}")
        return None

    stage = (
        contracts.stage_labels.get(checkpoint, "")
        if checkpoint != raw_checkpoint
        else _clean(raw_record.get("stage"), contracts.stage_labels.get(checkpoint, ""))
    )
    record: StateRecord = {
        "feature": feature,
        "owner": _clean(raw_record.get("owner"), EMPTY_CELL),
        "checkpoint": checkpoint,
        "stage": stage,
        "iteration": _clean(raw_record.get("iteration"), EMPTY_CELL),
        "updated_at": _clean(raw_record.get("updated_at"), EMPTY_CELL),
        "workflowProfile": workflow_profile,
        "workflowDecisions": workflow_decisions,
        "workflowTemplate": workflow_template,
    }
    if checkpoint == "needs_fix":
        raw_needs_fix_from = _clean(raw_record.get("needsFixFromCheckpoint"))
        needs_fix_from = LEGACY_CHECKPOINT_ALIASES.get(raw_needs_fix_from, raw_needs_fix_from)
        if needs_fix_from:
            source_idx, _ = find_current_node(list(contracts.nodes), needs_fix_from)
            if source_idx < 0:
                errors.append(
                    f"{context}: Feature '{feature}' 的 needsFixFromCheckpoint "
                    f"无法映射到节点: {needs_fix_from}"
                )
                return None
            record["needsFixFromCheckpoint"] = needs_fix_from
    if workflow_template_uses_nodes(BOARD_CONFIG, workflow_template):
        record["workflowNodes"] = [str(item).strip() for item in (raw_workflow_nodes or [])]
        # Legacy workflowExternalized is intentionally not carried over: inputs
        # whose producer is absent are dropped by the compiler instead.
    if workflow_skipped:
        record["workflowSkippedNodes"] = list(workflow_skipped)
    return record


def normalize_state_records(
    records: dict[str, Any],
    *,
    context: str = "state records",
    workspace: Path | None = None,
) -> tuple[StateRecords, list[str]]:
    normalized, record_errors = normalize_state_records_detailed(
        records,
        context=context,
        workspace=workspace,
    )
    errors = [error for feature in sorted(record_errors) for error in record_errors[feature]]
    return normalized, errors


def normalize_state_records_detailed(
    records: dict[str, Any],
    *,
    context: str = "state records",
    workspace: Path | None = None,
) -> tuple[StateRecords, dict[str, list[str]]]:
    normalized: StateRecords = {}
    record_errors: dict[str, list[str]] = {}
    for feature in sorted(records):
        errors: list[str] = []
        record = _normalize_record(feature, records[feature], errors, context=context, workspace=workspace)
        if record is not None:
            normalized[feature] = record
        if errors:
            record_errors[feature] = errors
    return normalized, record_errors


def parse_state_md_records(content: str) -> tuple[StateRecords, list[str]]:
    records: StateRecords = {}
    errors: list[str] = []

    for lineno, raw_line in enumerate(content.splitlines(), start=1):
        line = raw_line.strip()
        if not line.startswith("|"):
            continue

        cells = _split_table_cells(line)
        if len(cells) < 3:
            continue
        if cells[0] == "Feature" or _is_separator_row(cells):
            continue

        feature = cells[0]
        if not feature:
            errors.append(f"line {lineno}: Feature 为空")
            continue
        if feature in records:
            errors.append(f"line {lineno}: Feature '{feature}' 出现重复行")
            continue

        raw_record = {
            "feature": feature,
            "owner": cells[1] if len(cells) > 1 else EMPTY_CELL,
            "checkpoint": cells[2] if len(cells) > 2 else "",
            "stage": cells[3] if len(cells) > 3 else "",
            "iteration": cells[4] if len(cells) > 4 else EMPTY_CELL,
            "updated_at": cells[5] if len(cells) > 5 else EMPTY_CELL,
            "workflowProfile": BASE_WORKFLOW_PROFILE,
            "workflowDecisions": {},
            "workflowTemplate": BASE_WORKFLOW_TEMPLATE,
        }
        record = _normalize_record(feature, raw_record, errors, context=f"STATE.md line {lineno}")
        if record is not None:
            records[feature] = record

    return records, errors


def parse_state_json_records(content: str, *, workspace: Path | None = None) -> tuple[StateRecords, list[str]]:
    result = parse_state_json_records_result(content, workspace=workspace)
    return result.records, result.errors


def parse_state_json_records_result(content: str, *, workspace: Path | None = None) -> StateLoadResult:
    errors: list[str] = []
    try:
        payload = json.loads(content)
    except json.JSONDecodeError as exc:
        message = f"state.json 不是合法 JSON: {exc}"
        return StateLoadResult(
            records={},
            errors=[message],
            exists=True,
            source="state.json",
            fatal_errors=[message],
        )

    if not isinstance(payload, dict):
        message = "state.json 顶层必须是对象"
        return StateLoadResult(
            records={},
            errors=[message],
            exists=True,
            source="state.json",
            fatal_errors=[message],
        )

    if "features" in payload:
        features = payload.get("features")
        if not isinstance(features, dict):
            message = "state.json.features 必须是对象"
            return StateLoadResult(
                records={},
                errors=[message],
                exists=True,
                source="state.json",
                fatal_errors=[message],
            )
        records, record_errors = normalize_state_records_detailed(
            features,
            context="state.json.features",
            workspace=workspace,
        )
        errors.extend(error for feature in sorted(record_errors) for error in record_errors[feature])
        return StateLoadResult(
            records=records,
            errors=errors,
            exists=True,
            source="state.json",
            raw_records=dict(features),
            record_errors=record_errors,
            fatal_errors=[],
        )

    # Legacy migration format: {"feature": "checkpoint"}.
    records, record_errors = normalize_state_records_detailed(
        payload,
        context="state.json legacy map",
        workspace=workspace,
    )
    errors.extend(error for feature in sorted(record_errors) for error in record_errors[feature])
    return StateLoadResult(
        records=records,
        errors=errors,
        exists=True,
        source="state.json",
        raw_records=dict(payload),
        record_errors=record_errors,
        fatal_errors=[],
    )


def load_state_json_records_result(workspace: Path) -> StateLoadResult:
    """Read only .autobizdevops/state.json without fallback or repair."""
    workspace = workspace.resolve()
    state_json = get_state_json_path(workspace)

    if not state_json.is_file():
        return StateLoadResult(records={}, errors=[], exists=False, source="state.json")

    return parse_state_json_records_result(state_json.read_text(encoding="utf-8"), workspace=workspace)


def load_state_json_records(workspace: Path) -> tuple[StateRecords, list[str], bool]:
    """Read only .autobizdevops/state.json and return (records, errors, exists)."""
    result = load_state_json_records_result(workspace)
    return result.records, result.errors, result.exists


def _load_state_records_result(workspace: Path) -> StateLoadResult:
    workspace = workspace.resolve()
    state_md = get_state_path(workspace)

    json_result = load_state_json_records_result(workspace)
    if json_result.exists:
        return json_result

    if state_md.is_file():
        records, errors = parse_state_md_records(state_md.read_text(encoding="utf-8"))
        return StateLoadResult(
            records=records,
            errors=errors,
            exists=True,
            source="STATE.md",
            fatal_errors=list(errors),
        )

    return StateLoadResult(records={}, errors=[], exists=False, source="")


def load_state_records(workspace: Path) -> tuple[StateRecords, list[str], bool]:
    result = _load_state_records_result(workspace)
    return result.records, result.errors, result.exists


def state_rows_from_records(records: StateRecords) -> dict[str, str]:
    return {feature: record["checkpoint"] for feature, record in sorted(records.items())}


def state_json_content_from_records(records: StateRecords, *, workspace: Path | None = None) -> str:
    normalized, errors = normalize_state_records(records, workspace=workspace)
    if errors:
        raise ValueError("\n".join(errors))
    payload = {
        "schemaVersion": STATE_SCHEMA_VERSION,
        "features": {
            feature: normalized[feature]
            for feature in sorted(normalized)
        },
    }
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def state_json_content_from_records_preserving_raw(
    records: StateRecords,
    *,
    raw_records: dict[str, Any] | None = None,
    workspace: Path | None = None,
) -> str:
    normalized, errors = normalize_state_records(records, workspace=workspace)
    if errors:
        raise ValueError("\n".join(errors))

    merged: dict[str, Any] = {}
    for feature in sorted(set(raw_records or {}) | set(normalized)):
        if feature in normalized:
            merged[feature] = normalized[feature]
        else:
            merged[feature] = (raw_records or {})[feature]

    payload = {
        "schemaVersion": STATE_SCHEMA_VERSION,
        "features": merged,
    }
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def render_state_md(records: StateRecords, *, workspace: Path | None = None) -> str:
    normalized, errors = normalize_state_records(records, workspace=workspace)
    if errors:
        raise ValueError("\n".join(errors))

    updated_values = [
        record["updated_at"]
        for record in normalized.values()
        if record.get("updated_at") and record["updated_at"] != EMPTY_CELL
    ]
    last_updated = max(updated_values) if updated_values else EMPTY_CELL
    lines = [
        "# 工程状态",
        "",
        "> 本文件由 `.autobizdevops/state.json` 自动生成，请勿手工修改。请使用 `hooks/update_checkpoint.py` 推进 checkpoint。",
        "",
        "- **里程碑**: [待确定]",
        f"- **最后更新**: {last_updated}",
        "",
        "## Feature 进度",
        "",
        "| Feature | 负责人 | checkpoint | 阶段 | 迭代 | 最后更新 |",
        "|---------|--------|-----------|------|------|---------|",
    ]
    for feature in sorted(normalized):
        record = normalized[feature]
        lines.append(
            "| "
            + " | ".join(
                [
                    record["feature"],
                    record["owner"],
                    record["checkpoint"],
                    record["stage"],
                    record["iteration"],
                    record["updated_at"],
                ]
            )
            + " |"
        )
    return "\n".join(lines) + "\n"


def _atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as tmp:
            temp_name = tmp.name
            tmp.write(content)
        Path(temp_name).replace(path)
    finally:
        if temp_name:
            temp_path = Path(temp_name)
            if temp_path.exists():
                temp_path.unlink()


def write_state_records(workspace: Path, records: StateRecords) -> None:
    workspace = workspace.resolve()
    state_json = get_state_json_path(workspace)
    state_md = get_state_path(workspace)
    _atomic_write_text(state_json, state_json_content_from_records(records, workspace=workspace))
    _atomic_write_text(state_md, render_state_md(records, workspace=workspace))


def write_state_records_preserving_raw(
    workspace: Path,
    records: StateRecords,
    *,
    raw_records: dict[str, Any] | None = None,
) -> None:
    workspace = workspace.resolve()
    state_json = get_state_json_path(workspace)
    state_md = get_state_path(workspace)
    _atomic_write_text(
        state_json,
        state_json_content_from_records_preserving_raw(
            records,
            raw_records=raw_records,
            workspace=workspace,
        ),
    )
    _atomic_write_text(state_md, render_state_md(records, workspace=workspace))


def check_or_fix_state_sync(workspace: Path, *, fix: bool = True) -> StateSyncResult:
    workspace = workspace.resolve()
    state_json = get_state_json_path(workspace)
    state_md = get_state_path(workspace)
    result = _load_state_records_result(workspace)
    if not result.exists:
        return StateSyncResult(
            ok=True,
            records={},
            errors=[],
            state_exists=False,
            changed=False,
            state_path=state_md,
            state_json_path=state_json,
            raw_records={},
            record_errors={},
        )
    if result.fatal_errors:
        return StateSyncResult(
            ok=False,
            records=result.records,
            errors=result.fatal_errors,
            state_exists=True,
            changed=False,
            state_path=state_md,
            state_json_path=state_json,
            raw_records=result.raw_records,
            record_errors=result.record_errors,
        )

    expected_json = state_json_content_from_records_preserving_raw(
        result.records,
        raw_records=result.raw_records,
        workspace=workspace,
    )
    expected_md = render_state_md(result.records, workspace=workspace)
    errors: list[str] = []
    changed = False

    if not state_json.is_file() or state_json.read_text(encoding="utf-8") != expected_json:
        if fix:
            _atomic_write_text(state_json, expected_json)
            changed = True
        else:
            errors.append("state.json 缺失、为旧格式，或与规范化内容不一致")

    if not state_md.is_file() or state_md.read_text(encoding="utf-8") != expected_md:
        if fix:
            _atomic_write_text(state_md, expected_md)
            changed = True
        else:
            errors.append("STATE.md 缺失或与 state.json 生成视图不一致")

    return StateSyncResult(
        ok=not errors,
        records=result.records,
        errors=errors,
        state_exists=True,
        changed=changed,
        state_path=state_md,
        state_json_path=state_json,
        raw_records=result.raw_records,
        record_errors=result.record_errors,
    )
