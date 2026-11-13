#!/usr/bin/env python3
"""Pre-tool guard that validates workspace init before reading plugin files."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

from board_core.state_store import load_state_json_records_result
from init_validate import validate_precheck
from paths import get_plugin_output_workspace, resolve_project_dir
from resolve_frontend_html_route import (
    PARSERS,
    ROUTE_ABSOLUTE,
    ROUTE_SPEC_DRIVEN,
    ROUTE_SKILLS,
    ROUTE_STANDARD,
    evidence_path as frontend_evidence_path,
    read_json as read_frontend_evidence,
    write_json as write_frontend_evidence,
)
from ui_context import UIContextError, load_ui_context


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
BLOCK_EXIT_CODE = 2
PATH_KEYS = {
    "filePath",
    "file_path",
    "path",
    "filename",
    "absolutePath",
    "relativePath",
}


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


def is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


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


def plugin_read_paths(payload: dict, plugin_root: Path = PLUGIN_ROOT) -> list[Path]:
    tool_input = payload.get("tool_input", {})
    cwd = Path(payload.get("cwd") or Path.cwd()).resolve(strict=False)
    root = plugin_root.resolve(strict=False)

    matches: list[Path] = []
    for raw_path in extract_candidate_paths(tool_input):
        candidate = normalize_path(raw_path, cwd)
        if is_relative_to(candidate, root):
            matches.append(candidate)
    return matches


def workspace_from_payload(payload: dict) -> Path:
    plugin_workspace = str(os.environ.get("PLUGIN_WORKSPACE") or "").strip()
    project_code = resolve_project_dir(os.environ)
    if plugin_workspace and project_code and "/" not in project_code and "\\" not in project_code:
        return (Path(plugin_workspace).expanduser() / project_code).resolve(strict=False)

    try:
        return get_plugin_output_workspace()
    except ValueError:
        workspace = os.environ.get("WORKSPACE_PATH") or payload.get("cwd")
        return Path(workspace).resolve(strict=False)


def workspace_from_payload_or_none(payload: dict) -> Path | None:
    try:
        return workspace_from_payload(payload)
    except (OSError, ValueError, TypeError):
        return None


def format_precheck_reason(result: dict) -> str:
    lines = [result.get("message", "前置检查未通过")]
    lines.extend(str(error) for error in result.get("errors", []))
    return "\n".join(lines)


def block(reason: str, workspace: Path, system_message: str | None = None) -> int:
    print(reason, file=sys.stderr)
    init_script = f"{PLUGIN_ROOT}/hooks/init_workspace.py"
    json.dump(
        {
            "decision": "block",
            "reason": reason,
            "systemMessage": system_message or f"继续任务前需要先执行python {init_script} {workspace}",
        },
        sys.stdout,
        ensure_ascii=False,
    )
    return BLOCK_EXIT_CODE


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


def same_path(left: Path, right: Path) -> bool:
    return str(left.resolve(strict=False)).lower() == str(right.resolve(strict=False)).lower()


def frontend_route_for_skill(path: Path) -> str:
    for route, skill_path in ROUTE_SKILLS.items():
        if same_path(path, skill_path):
            return route
    return ""


def frontend_route_for_parser(path: Path) -> str:
    for route, parser_path in PARSERS.items():
        if same_path(path, parser_path):
            return route
    return ""


def numeric_tool_value(value: object, default: int | None = None) -> int | None:
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def read_span(tool_input: dict) -> tuple[int, int] | None:
    offset = numeric_tool_value(tool_input.get("offset"), 0)
    limit = numeric_tool_value(tool_input.get("limit"), None)
    if offset is None:
        offset = 0
    if limit is None or limit <= 0:
        return None
    return offset, offset + limit


def file_text_length(path: Path) -> int:
    try:
        return len(path.read_text(encoding="utf-8", errors="ignore"))
    except OSError:
        return 0


def merged_ranges(ranges: list[list[int]]) -> list[list[int]]:
    normalized = sorted(
        [item for item in ranges if isinstance(item, list) and len(item) == 2],
        key=lambda item: item[0],
    )
    merged: list[list[int]] = []
    for start, end in normalized:
        if not merged or start > merged[-1][1]:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)
    return merged


def range_covers_file(ranges: list[list[int]], path: Path) -> bool:
    length = file_text_length(path)
    if length <= 0:
        return False
    merged = merged_ranges(ranges)
    return bool(merged and merged[0][0] <= 0 and merged[0][1] >= length)


def base_frontend_evidence(route: str) -> dict:
    return {
        "version": 1,
        "triggered": True,
        "route": route,
        "routeSkillPath": str(ROUTE_SKILLS[route]),
        "parserPath": str(PARSERS[route]),
        "routeSkillRead": False,
        "routeSkillReadComplete": False,
        "routeTodosCreated": False,
        "routeTodosCompleted": False,
        "parserRead": False,
    }


def mark_route_skill_read(workspace: Path, feature: str, route: str, path: Path, tool_input: dict) -> None:
    evidence_file = frontend_evidence_path(workspace, feature)
    evidence = read_frontend_evidence(evidence_file) or base_frontend_evidence(route)
    if evidence.get("route") != route:
        evidence = base_frontend_evidence(route)
    evidence["routeSkillRead"] = True
    span = read_span(tool_input)
    if span is None:
        evidence["routeSkillReadComplete"] = True
    else:
        ranges = evidence.get("routeSkillReadRanges", [])
        ranges = ranges if isinstance(ranges, list) else []
        ranges.append([span[0], span[1]])
        evidence["routeSkillReadRanges"] = merged_ranges(ranges)
        evidence["routeSkillReadComplete"] = range_covers_file(evidence["routeSkillReadRanges"], path)
    write_frontend_evidence(evidence_file, evidence)


def mark_parser_read(workspace: Path, feature: str, route: str) -> None:
    evidence_file = frontend_evidence_path(workspace, feature)
    evidence = read_frontend_evidence(evidence_file)
    evidence["parserRead"] = True
    evidence["parserPath"] = str(PARSERS[route])
    write_frontend_evidence(evidence_file, evidence)


def block_frontend_route(reason: str, workspace: Path) -> int:
    return block(
        reason,
        workspace,
        "前端 HTML 路线未按规定进入。请先运行 resolve_frontend_html_route.py；若 route 为 HTML 路线，"
        "完整读取对应 route SKILL.md，并按该 SKILL.md 的 write_todos 建立可见清单后再继续。",
    )


def enforce_parser_read(workspace: Path, feature: str, route: str) -> int:
    evidence = read_frontend_evidence(frontend_evidence_path(workspace, feature))
    if not evidence:
        return block_frontend_route("读取 parser 前缺少 FRONTEND_ROUTE.json", workspace)
    if evidence.get("route") != route:
        return block_frontend_route(
            f"读取的 parser 与 FRONTEND_ROUTE.json route 不一致: expected={evidence.get('route')} actual={route}",
            workspace,
        )
    if evidence.get("routeSkillReadComplete") is not True:
        return block_frontend_route("读取 parser 前必须完整读取对应 route SKILL.md", workspace)
    if evidence.get("routeTodosCreated") is not True:
        return block_frontend_route("读取 parser 前必须先按 route SKILL.md 创建 write_todos 清单", workspace)
    mark_parser_read(workspace, feature, route)
    return 0


def enforce_html_read(workspace: Path, feature: str) -> int:
    if current_checkpoint(workspace, feature) != "code_in_progress":
        return 0
    try:
        ui_context = load_ui_context(workspace / ".autobizdevops" / "features" / feature)
    except UIContextError as exc:
        return block_frontend_route(f"UI_CONTEXT.json 非法，无法解析前端 route: {exc}", workspace)
    if isinstance(ui_context, dict) and ui_context.get("uiRequired") is False:
        return block_frontend_route("UI_CONTEXT.json 标记 uiRequired=false，当前任务不允许读取 HTML 作为实现依据", workspace)
    evidence = read_frontend_evidence(frontend_evidence_path(workspace, feature))
    if not evidence:
        return block_frontend_route("code 阶段读取 HTML 前必须先解析并记录 frontend route", workspace)
    if evidence.get("route") == ROUTE_SPEC_DRIVEN:
        return block_frontend_route("当前 route=spec-driven-ui，没有 HTML 输入，不允许读取 HTML 作为实现依据", workspace)
    if evidence.get("route") not in {ROUTE_ABSOLUTE, ROUTE_STANDARD}:
        return block_frontend_route(f"当前 frontend route 不允许读取 HTML: {evidence.get('route')}", workspace)
    if evidence.get("routeSkillReadComplete") is not True:
        return block_frontend_route("读取 HTML 前必须完整读取对应 route SKILL.md", workspace)
    if evidence.get("routeTodosCreated") is not True:
        return block_frontend_route("读取 HTML 前必须先按 route SKILL.md 创建 write_todos 清单", workspace)
    return 0


def enforce_frontend_route_reads(payload: dict, paths: list[Path], workspace: Path) -> int:
    feature = current_feature()
    if not feature:
        return 0
    tool_input = payload.get("tool_input", {})
    for path in paths:
        route = frontend_route_for_skill(path)
        if route:
            mark_route_skill_read(workspace, feature, route, path, tool_input)
            continue

        route = frontend_route_for_parser(path)
        if route:
            blocked = enforce_parser_read(workspace, feature, route)
            if blocked:
                return blocked
            continue

        if path.suffix.lower() in {".html", ".htm"}:
            blocked = enforce_html_read(workspace, feature)
            if blocked:
                return blocked
    return 0


def main() -> int:
    raw_input = read_stdin_text()
    if not raw_input.strip():
        return 0

    payload = json.loads(raw_input)
    matches = plugin_read_paths(payload)
    if matches:
        workspace = workspace_from_payload(payload)
        result = validate_precheck(workspace)
        if not result.get("ok"):
            return block(format_precheck_reason(result), workspace)
        route_result = enforce_frontend_route_reads(payload, matches, workspace)
        if route_result:
            return route_result
    else:
        # Non-plugin HTML reads still need the frontend route gate while code is in progress.
        if not current_feature():
            return 0
        workspace = workspace_from_payload_or_none(payload)
        if workspace is None:
            return 0
        tool_input = payload.get("tool_input", {})
        cwd = Path(payload.get("cwd") or Path.cwd()).resolve(strict=False)
        candidate_paths = [normalize_path(raw, cwd) for raw in extract_candidate_paths(tool_input)]
        route_result = enforce_frontend_route_reads(payload, candidate_paths, workspace)
        if route_result:
            return route_result
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
