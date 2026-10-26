"""Read-only rules extracted from hooks/artifact_ref_validator.py. See provenance.json."""
from __future__ import annotations
import hashlib
import re
from pathlib import Path
from typing import Any
from hooks.spec_contract import spec_heading

ANCHOR_RE = re.compile(r"^(REQ|SCN|API|DATA|D)-\d{3}$")


DESIGN_API_DEF_RE = re.compile(r"^\|\s*(API-\d{3})\s*\|", re.MULTILINE)


DESIGN_DATA_DEF_RE = re.compile(r"^\|\s*(DATA-\d{3})\s*\|", re.MULTILINE)


DESIGN_DECISION_DEF_RE = re.compile(r"^\|\s*(D-\d{3})\s*\|", re.MULTILINE)


PENDING_CELL_RE = re.compile(r"\|\s*(待确认|读码差异)\s*\|")


def design_marker_value(text: str, marker: str) -> bool | None:
    """Read a boolean Design marker without accepting template placeholders.

    The marker is a line-level contract. Stripping Markdown bold markers first
    makes both ``- **marker:** false`` and plain ``- marker: false`` valid,
    while a template value such as ``[true/false]`` cannot backtrack into a
    false positive.
    """
    marker_re = re.compile(rf"^{re.escape(marker)}\s*:\s*(true|false)$", re.IGNORECASE)
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if len(line) >= 2 and line[0] in "-*+" and line[1].isspace():
            line = line[2:].strip()
        line = line.replace("**", "")
        match = marker_re.fullmatch(line)
        if match:
            return match.group(1).lower() == "true"
    return None


def _contract_error(reason: str, detail: str = "", suggestion: str = "") -> dict[str, Any]:
    issue: dict[str, Any] = {
        "reason": reason,
        "repairTarget": "design_revision",
        "repairable": False,
    }
    if detail:
        issue["detail"] = detail
    if suggestion:
        issue["repairSuggestion"] = suggestion
    return issue


def load_design_contract(base: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Load the confirmed design as the sole source of Plan reference IDs."""

    path = base / "design.md"
    empty = {
        "sha256": "",
        "ids": {"API": set(), "DATA": set(), "D": set()},
        "noHttpApi": False,
        "noSql": False,
    }
    if not path.is_file() or path.stat().st_size <= 0:
        return empty, [_contract_error(
            "missing_design",
            suggestion="需要先创建 design.md 文件，包含 API Decisions 和 Data Decisions 表格"
        )]
    try:
        raw = path.read_bytes()
        text = raw.decode("utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return empty, [_contract_error(
            "invalid_design_contract",
            detail=f"error={exc}",
            suggestion="检查 design.md 文件编码是否为 UTF-8，文件是否损坏"
        )]

    api_ids = DESIGN_API_DEF_RE.findall(text)
    data_ids = DESIGN_DATA_DEF_RE.findall(text)
    decision_ids = DESIGN_DECISION_DEF_RE.findall(text)
    errors: list[dict[str, Any]] = []
    for ids, reason in (
        (api_ids, "duplicate_design_api_id"),
        (data_ids, "duplicate_design_data_id"),
        (decision_ids, "duplicate_design_decision_id"),
    ):
        if len(ids) != len(set(ids)):
            duplicates = [id_ for id_ in set(ids) if ids.count(id_) > 1]
            errors.append(_contract_error(
                reason,
                detail=f"duplicates={','.join(duplicates)}",
                suggestion=f"在 design.md 中删除重复的 ID 定义：{', '.join(duplicates)}"
            ))

    no_http_api = design_marker_value(text, "x-auto-no-http-api")
    no_sql = design_marker_value(text, "x-auto-no-sql")
    if no_http_api is None:
        errors.append(_contract_error(
            "missing_design_api_marker",
            suggestion="在 design.md 中添加 API 标记行：`- x-auto-no-http-api: false` 或 `true`"
        ))
    if no_sql is None:
        errors.append(_contract_error(
            "missing_design_data_marker",
            suggestion="在 design.md 中添加数据标记行：`- x-auto-no-sql: false` 或 `true`"
        ))
    if no_http_api is True and api_ids:
        errors.append(_contract_error(
            "design_api_marker_conflicts_with_definitions",
            "x-auto-no-http-api=true cannot coexist with API Decisions rows",
            suggestion=f"将 x-auto-no-http-api 改为 false，或删除 API Decisions 表格中的 {len(api_ids)} 行定义"
        ))
    if no_sql is True and data_ids:
        errors.append(_contract_error(
            "design_data_marker_conflicts_with_definitions",
            "x-auto-no-sql=true cannot coexist with Data Decisions rows",
            suggestion=f"将 x-auto-no-sql 改为 false，或删除 Data Decisions 表格中的 {len(data_ids)} 行定义"
        ))
    pending_matches = PENDING_CELL_RE.findall(text)
    pending_count = len(pending_matches)
    if pending_count:
        # 提取待确认项所在的行号和上下文
        lines = text.splitlines()
        pending_locations = []
        for i, line in enumerate(lines, 1):
            if PENDING_CELL_RE.search(line):
                pending_locations.append(f"第 {i} 行")
                if len(pending_locations) >= 5:  # 最多展示前5个位置
                    pending_locations.append(f"...还有 {pending_count - 5} 处")
                    break

        location_info = "，位置：" + "、".join(pending_locations) if pending_locations else ""
        errors.append(_contract_error(
            "design_has_pending_cells",
            f"count={pending_count}",
            suggestion=f"design.md 中有 {pending_count} 个单元格包含「待确认」或「读码差异」{location_info}。请逐条与用户确认后，将单元格内容改为具体值并标记为「已确认」"
        ))

    return {
        "sha256": hashlib.sha256(raw).hexdigest(),
        "ids": {
            "API": set(api_ids),
            "DATA": set(data_ids),
            "D": set(decision_ids),
        },
        "noHttpApi": no_http_api is True,
        "noSql": no_sql is True,
    }, errors


def design_contract_snapshot(contract: dict[str, Any]) -> dict[str, Any]:
    ids = contract.get("ids") if isinstance(contract.get("ids"), dict) else {}
    return {
        "sha256": contract.get("sha256"),
        "apiIds": sorted(ids.get("API", set())),
        "dataIds": sorted(ids.get("DATA", set())),
        "decisionIds": sorted(ids.get("D", set())),
        "noHttpApi": contract.get("noHttpApi") is True,
        "noSql": contract.get("noSql") is True,
    }


def _unknown_design_id_issue(
    task_id: str,
    field: str,
    index: int,
    value: str,
    kind: str,
    repair_target: str,
) -> dict[str, Any]:
    kind_label = {"API": "接口", "DATA": "数据", "D": "决策"}.get(kind, kind)
    return {
        "reason": f"unknown_plan_json_{kind.lower()}_ref",
        "detail": f"task={task_id};id={value};design_is_source_of_truth;repair_plan_not_design",
        "taskIds": [task_id],
        "field": f"{field}[{index}]",
        "currentValue": value,
        "repairTarget": repair_target,
        "designMutationAllowed": False,
        "repairSuggestion": f"任务 {task_id} 引用了 design.md 中不存在的{kind_label} ID：{value}。请在 Plan v2 输入的 refs 中删除该引用，或先在 design.md 的对应表格中添加该 ID 定义"
    }


def _reference_validation_contract(
    contract: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Return a contract that is safe for typed-reference validation.

    Callers report an invalid or missing Design lock separately.  Reference
    validation must nevertheless remain total: a partial lock used to raise a
    KeyError and hid every actionable bad reference behind the first failure.
    Treat an unusable snapshot as an empty, non-marker contract, so each
    supplied typed ID is reported as unresolved while the lock diagnostic is
    preserved by the caller.
    """

    if contract is None:
        return None
    ids = contract.get("ids") if isinstance(contract, dict) else None
    if isinstance(ids, dict) and all(
        isinstance(ids.get(kind), (set, list, tuple))
        for kind in ("API", "DATA", "D")
    ):
        return contract
    return {
        "ids": {"API": set(), "DATA": set(), "D": set()},
        "noHttpApi": False,
        "noSql": False,
    }


def validate_task_design_contract(
    contract: dict[str, Any],
    task: dict[str, Any],
) -> list[dict[str, Any]]:
    """Validate task-owned typed references against the confirmed Design."""

    contract = _reference_validation_contract(contract) or {
        "ids": {"API": set(), "DATA": set(), "D": set()},
        "noHttpApi": False,
        "noSql": False,
    }
    task_id = str(task.get("id", "task"))
    errors: list[dict[str, Any]] = []
    field_contracts = (
        ("apiIds", "API", "api", "task_group"),
        ("dataIds", "DATA", "data", "task_detail"),
        ("decisionIds", "D", "decision", "task_detail"),
    )
    for field, id_kind, reason_kind, repair_target in field_contracts:
        values = task.get(field) if isinstance(task.get(field), list) else []
        for index, value in enumerate(values):
            if not isinstance(value, str):
                continue
            if id_kind == "API" and contract.get("noHttpApi") is True:
                errors.append({
                    "reason": "plan_api_ref_forbidden_by_design_marker",
                    "detail": f"task={task_id};id={value};x-auto-no-http-api=true",
                    "taskIds": [task_id],
                    "field": f"{field}[{index}]",
                    "currentValue": value,
                    "repairTarget": repair_target,
                    "designMutationAllowed": False,
                })
            elif id_kind == "DATA" and contract.get("noSql") is True:
                errors.append({
                    "reason": "plan_data_ref_forbidden_by_design_marker",
                    "detail": f"task={task_id};id={value};x-auto-no-sql=true",
                    "taskIds": [task_id],
                    "field": f"{field}[{index}]",
                    "currentValue": value,
                    "repairTarget": repair_target,
                    "designMutationAllowed": False,
                })
            elif value not in contract["ids"][id_kind]:
                errors.append(_unknown_design_id_issue(
                    task_id, field, index, value, reason_kind, repair_target
                ))
    return errors


def _design_ids_from_refs(task: dict[str, Any]) -> dict[str, set[str]]:
    result = {"API": set(), "DATA": set(), "D": set()}
    for ref in task.get("designRefs", []):
        if not isinstance(ref, str):
            continue
        _, marker, anchor = ref.partition("#")
        if not marker:
            continue
        if anchor.startswith("API-"):
            result["API"].add(anchor)
        elif anchor.startswith("DATA-"):
            result["DATA"].add(anchor)
        elif anchor.startswith("D-"):
            result["D"].add(anchor)
    return result


def validate_plan_design_coverage(
    contract: dict[str, Any],
    tasks: list[dict[str, Any]],
    *,
    included_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Require every in-scope Design ID to be covered without inventing new IDs.

    ``included_ids`` is the slice this round delivers; IDs a later round owns are
    not missing coverage, so the Design keeps them instead of being edited down.
    """

    contract = _reference_validation_contract(contract) or {
        "ids": {"API": set(), "DATA": set(), "D": set()},
        "noHttpApi": False,
        "noSql": False,
    }
    covered = {"API": set(), "DATA": set(), "D": set()}
    for task in tasks:
        covered["API"].update(
            item for item in task.get("apiIds", []) if isinstance(item, str)
        )
        covered["DATA"].update(
            item for item in task.get("dataIds", []) if isinstance(item, str)
        )
        covered["D"].update(
            item for item in task.get("decisionIds", []) if isinstance(item, str)
        )
        refs = _design_ids_from_refs(task)
        for kind in covered:
            # A designRef is only coverage evidence after it resolves to an
            # ID that the current Design actually defines. Invalid anchors
            # must never make a Design row appear covered.
            covered[kind].update(refs[kind] & contract["ids"][kind])

    errors: list[dict[str, Any]] = []
    coverage_rules = (
        ("API", "api", contract.get("noHttpApi") is True, "task_group"),
        ("DATA", "data", contract.get("noSql") is True, "task_detail"),
        ("D", "decision", False, "task_detail"),
    )
    for id_kind, reason_kind, disabled, repair_target in coverage_rules:
        known = contract["ids"][id_kind]
        if disabled and not known:
            continue
        if id_kind in {"API", "DATA"} and not known:
            errors.append({
                "reason": f"missing_design_{reason_kind}_id",
                "repairTarget": "design_revision",
                "repairable": False,
            })
            continue
        required = known if included_ids is None else known & included_ids
        for value in sorted(required - covered[id_kind]):
            errors.append({
                "reason": f"missing_plan_json_{reason_kind}_coverage",
                "detail": f"id={value};design_is_source_of_truth;attach_existing_id_to_relevant_task",
                "field": "apiIds" if id_kind == "API" else "dataIds" if id_kind == "DATA" else "decisionIds",
                "currentValue": value,
                "repairTarget": repair_target,
                "designMutationAllowed": False,
            })
    return errors


class ArtifactRefError(Exception):
    """Raised when an artifact reference is invalid."""

    def __init__(self, reason: str, detail: str):
        self.reason = reason
        self.detail = detail
        super().__init__(f"{reason}: {detail}")


def _split_ref(ref: str) -> tuple[str, str]:
    """Split reference into path and anchor, raising if format is invalid."""
    path_part, marker, anchor = ref.partition("#")
    if not marker:
        raise ArtifactRefError(
            "invalid_artifact_ref_format",
            f"引用缺少 # 符号: {ref}",
        )
    anchor = anchor.strip()
    if not anchor:
        raise ArtifactRefError(
            "invalid_artifact_ref_format",
            f"引用缺少 anchor: {ref}",
        )
    if not ANCHOR_RE.fullmatch(anchor):
        raise ArtifactRefError(
            "invalid_artifact_ref_format",
            f"引用 anchor 格式非法: {ref} (期望格式: REQ-001, SCN-002, API-003, DATA-004, D-005)",
        )
    return path_part.strip(), anchor


def _inside_base(candidate: Path, base: Path) -> bool:
    try:
        candidate.relative_to(base)
        return True
    except ValueError:
        return False


def _safe_ref_path(base: Path, raw_path: str, ref: str) -> Path:
    """Resolve reference path safely within base directory."""
    if not raw_path:
        raise ArtifactRefError(
            "invalid_artifact_ref_format",
            f"引用缺少相对路径: {ref}",
        )
    path = Path(raw_path)
    if path.is_absolute():
        raise ArtifactRefError(
            "invalid_artifact_ref_format",
            f"引用必须是产物目录相对路径，不允许绝对路径: {ref}",
        )
    candidate = (base / path).resolve(strict=False)
    resolved_base = base.resolve(strict=False)
    if not _inside_base(candidate, resolved_base):
        raise ArtifactRefError(
            "invalid_artifact_ref_format",
            f"引用路径越界: {ref}",
        )
    return candidate


def _find_unique_anchor_file(base: Path, anchor: str, *, design: bool) -> Path:
    """Find the unique file containing the anchor."""
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
        raise ArtifactRefError(
            "missing_ref_anchor",
            f"短引用未找到 anchor: #{anchor}",
        )
    raise ArtifactRefError(
        "ambiguous_ref_anchor",
        f"短引用 anchor 不唯一: #{anchor} (在 {len(matches)} 个文件中找到)",
    )


def _extract_spec_snippet(text: str, anchor: str) -> str | None:
    """Extract spec snippet for REQ/SCN anchors."""
    if not anchor.startswith(("REQ-", "SCN-")):
        return None
    match = spec_heading(text, anchor)
    return text[match.start():match.end()] if match else None


def _extract_design_snippet(text: str, anchor: str) -> str | None:
    """Extract design snippet for API/DATA/D anchors from table rows."""
    lines = text.splitlines()
    row_re = re.compile(rf"^\|\s*{re.escape(anchor)}\s*\|")

    for line in lines:
        if row_re.match(line):
            return line

    return None


def validate_artifact_ref(
    base: Path,
    ref: str,
    *,
    design: bool,
    cache: dict[str, bool] | None = None,
) -> None:
    """Validate a single artifact reference.

    Args:
        base: Feature directory base path
        ref: Reference string (e.g., "design.md#API-001" or "#REQ-001")
        design: True for designRefs, False for specRefs
        cache: Optional cache dict (NOT USED - reserved for future safe implementation)

    Raises:
        ArtifactRefError: If reference is invalid, file missing, or anchor not found

    Note: Cache parameter is accepted but not used. Format and type checks must always
    run; file existence and anchor presence can change between validations. A safe cache
    would need: refType + resolvedPath + fileSha256 + anchor as the key.
    """
    # Parse format (always validate - cannot be cached safely)
    raw_path, anchor = _split_ref(ref)

    # Check anchor type matches ref type (always validate - cannot be cached safely)
    if design and not (anchor.startswith("API-") or anchor.startswith("DATA-") or anchor.startswith("D-")):
        raise ArtifactRefError(
            "invalid_artifact_ref_type",
            f"designRefs 只允许 API/DATA/D anchor: {ref}",
        )
    if not design and not (anchor.startswith("REQ-") or anchor.startswith("SCN-")):
        raise ArtifactRefError(
            "invalid_artifact_ref_type",
            f"specRefs 只允许 REQ/SCN anchor: {ref}",
        )

    # Resolve path (always resolve - path resolution can change)
    if raw_path:
        path = _safe_ref_path(base, raw_path, ref)
    else:
        path = _find_unique_anchor_file(base, anchor, design=design)

    # Check file exists (always check - file can be deleted)
    if not path.is_file():
        raise ArtifactRefError(
            "missing_ref_file",
            f"引用文件不存在: {ref} (解析为 {path})",
        )

    # Check anchor exists in file (always check - file content can change)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ArtifactRefError(
            "missing_ref_file",
            f"无法读取引用文件: {ref} ({exc})",
        )

    extracted = _extract_design_snippet(text, anchor) if design else _extract_spec_snippet(text, anchor)
    if extracted is None:
        raise ArtifactRefError(
            "missing_ref_anchor",
            f"引用 anchor 不存在: {ref} (文件 {path.name} 中未找到 {anchor})",
        )


def validate_task_artifact_refs(
    base: Path,
    task: dict[str, Any],
    cache: dict[str, bool] | None = None,
    design_contract: dict[str, Any] | None = None,
    *,
    check_design_artifact: bool = True,
) -> list[dict[str, Any]]:
    """Validate all artifact references in a task.

    Args:
        cache: Accepted but not used (reserved for future safe implementation)

    Returns:
        List of error dicts with 'reason' and 'detail' keys
    """
    errors: list[dict[str, Any]] = []
    task_id = str(task.get("id", "task"))

    contract = _reference_validation_contract(design_contract)

    # Validate designRefs.  Design owns validation of design.md itself.  Plan
    # consumes the locked contract snapshot and therefore can validate the
    # logical ref shape/ID without reopening the Design artifact.
    for index, ref in enumerate(task.get("designRefs", [])):
        if not isinstance(ref, str):
            continue
        try:
            raw_path, anchor = _split_ref(ref)
            if not (anchor.startswith("API-") or anchor.startswith("DATA-") or anchor.startswith("D-")):
                raise ArtifactRefError("invalid_artifact_ref_type", f"designRefs 只允许 API/DATA/D anchor: {ref}")
            if not check_design_artifact and raw_path not in {"", "design.md"}:
                raise ArtifactRefError("invalid_artifact_ref_format", f"designRefs 必须引用 design.md: {ref}")
            if check_design_artifact:
                validate_artifact_ref(base, ref, design=True, cache=None)
        except ArtifactRefError as exc:
            errors.append({
                "reason": exc.reason,
                "detail": f"task={task_id};ref={ref};{exc.detail}",
                "taskIds": [task_id],
                "field": f"designRefs[{index}]",
                "currentValue": ref,
                "repairTarget": "task_detail",
            })
            continue
        kind = "API" if anchor.startswith("API-") else "DATA" if anchor.startswith("DATA-") else "D"
        if contract is not None:
            if kind == "API" and contract.get("noHttpApi") is True:
                errors.append({
                    "reason": "plan_api_ref_forbidden_by_design_marker",
                    "detail": f"task={task_id};ref={ref};x-auto-no-http-api=true",
                    "taskIds": [task_id],
                    "field": f"designRefs[{index}]",
                    "currentValue": ref,
                    "repairTarget": "task_detail",
                    "designMutationAllowed": False,
                })
            elif kind == "DATA" and contract.get("noSql") is True:
                errors.append({
                    "reason": "plan_data_ref_forbidden_by_design_marker",
                    "detail": f"task={task_id};ref={ref};x-auto-no-sql=true",
                    "taskIds": [task_id],
                    "field": f"designRefs[{index}]",
                    "currentValue": ref,
                    "repairTarget": "task_detail",
                    "designMutationAllowed": False,
                })
            elif anchor not in contract["ids"][kind]:
                errors.append(_unknown_design_id_issue(
                    task_id,
                    "designRefs",
                    index,
                    anchor,
                    kind.lower(),
                    "task_detail",
                ))

    # Validate specRefs (beyond basic structure - only format and file existence)
    for index, ref in enumerate(task.get("specRefs", [])):
        if not isinstance(ref, str):
            continue
        try:
            validate_artifact_ref(base, ref, design=False, cache=None)
        except ArtifactRefError as exc:
            errors.append({
                "reason": exc.reason,
                "detail": f"task={task_id};ref={ref};{exc.detail}",
                "taskIds": [task_id],
                "field": f"specRefs[{index}]",
                "currentValue": ref,
                "repairTarget": "task_group",
            })

    # sourceRefs is writer-owned and records source IDs projected from Specs.
    # Source availability is deliberately non-blocking: an external document
    # may legitimately be absent or never have been supplied.
    source_refs = task.get("sourceRefs", [])
    if not isinstance(source_refs, list):
        errors.append({
            "reason": "plan_source_refs_invalid",
            "detail": f"task={task_id};sourceRefs_must_be_array",
            "taskIds": [task_id],
            "field": "sourceRefs",
            "repairTarget": "task_group",
        })
    if contract is not None:
        errors.extend(validate_task_design_contract(contract, task))

    return errors
