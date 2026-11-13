#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Incrementally write UI_CONTEXT.json."""

from __future__ import annotations

import argparse
import shutil
import sys
import uuid
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.json_writer_common import (  # noqa: E402
    WriterResult,
    artifact_path,
    atomic_write_json,
    fail,
    fail_if_artifact_exists,
    load_json,
    next_numbered_id,
    parse_json_value,
    render_result,
    resolve_feature,
    resolve_workspace,
    with_result_data,
)
from hooks.ui_context import (  # noqa: E402
    DECISION_SOURCES,
    FRONTEND_ROUTES,
    UI_CONTEXT_VERSION,
    validate_ui_context_data,
    visual_source_bundle_sha256,
    visual_source_content_sha256,
)


UI_CONTEXT_FILE = "UI_CONTEXT.json"
STATUS_ORDER = {"defaulted": 0, "confirmed": 1, "locked": 2}


def _path(workspace: Path, feature: str) -> Path:
    return artifact_path(workspace, feature, UI_CONTEXT_FILE)


def _load(workspace: Path, feature: str) -> dict[str, Any]:
    return load_json(_path(workspace, feature), default=_initial(feature))


def _initial(feature: str) -> dict[str, Any]:
    return {
        "version": UI_CONTEXT_VERSION,
        "featureId": feature,
        "uiRequired": False,
        "decisionStatus": "defaulted",
        "decisionSource": "default_false",
        "notApplicableReason": "未识别 UI 范围",
        "pages": [],
        "interactions": [],
        "visualSources": [],
        "capabilities": [],
    }


STRUCTURE_ALLOWED_ERRORS = {
    "ui_context_required_without_ui_scope",
    "ui_context_not_applicable_reason_missing",
}


def _structure_errors(data: dict[str, Any], feature: str) -> list[str]:
    return [
        error
        for error in validate_ui_context_data(data, feature_id=feature)
        if error not in STRUCTURE_ALLOWED_ERRORS
    ]


def _visual_source_type_zh(source_type: str) -> str:
    """将visualSource类型转换为中文"""
    type_map = {
        "high_fidelity_html": "高保真HTML",
        "standard_html": "标准HTML",
        "design_link": "设计链接",
        "prototype_link": "原型链接",
        "image": "图片",
        "other": "其他"
    }
    return type_map.get(source_type, source_type)


def _load_plan_tasks(workspace: Path, feature: str) -> list[dict[str, Any]]:
    """Best-effort load of formal Plan tasks for the generated Markdown view."""
    feature_dir = _path(workspace, feature).parent
    plan_path = feature_dir / "plan.json"
    if not plan_path.is_file():
        return []

    try:
        root = load_json(plan_path)
    except Exception:
        return []
    if not isinstance(root, dict):
        return []

    # Compatibility with the former monolithic plan format.
    root_tasks = root.get("tasks")
    if isinstance(root_tasks, list):
        return [task for task in root_tasks if isinstance(task, dict)]

    tasks: list[dict[str, Any]] = []
    batches = root.get("batches")
    if not isinstance(batches, list):
        return tasks
    for batch in batches:
        if not isinstance(batch, dict):
            continue
        batch_id = batch.get("id")
        if not isinstance(batch_id, str) or not batch_id.startswith("B") or not batch_id[1:].isdigit():
            continue
        try:
            batch_plan = load_json(feature_dir / "plans" / batch_id / "plan.json")
        except Exception:
            continue
        if not isinstance(batch_plan, dict):
            continue
        batch_tasks = batch_plan.get("tasks")
        if isinstance(batch_tasks, list):
            tasks.extend(task for task in batch_tasks if isinstance(task, dict))
    return tasks


def _task_display_for_visual_source(tasks: list[dict[str, Any]], source_id: str) -> str:
    """Render exact Plan task IDs and titles bound to a visual source."""
    labels: list[str] = []
    seen_task_ids: set[str] = set()
    for task in tasks:
        ui_refs = task.get("uiRefs")
        visual_source_refs = ui_refs.get("visualSourceRefs") if isinstance(ui_refs, dict) else None
        if not isinstance(visual_source_refs, list) or source_id not in visual_source_refs:
            continue
        raw_task_id = task.get("id")
        raw_title = task.get("title")
        task_id = raw_task_id.strip() if isinstance(raw_task_id, str) else ""
        title = raw_title.strip() if isinstance(raw_title, str) else ""
        if not task_id or task_id in seen_task_ids:
            continue
        seen_task_ids.add(task_id)
        labels.append(f"{task_id}: {title}" if title else task_id)
    return "<br>".join(labels) if labels else "待Plan阶段关联"


def _generate_ui_context_md(
    data: dict[str, Any],
    feature: str,
    *,
    tasks: list[dict[str, Any]] | None = None,
) -> str:
    """生成 UI_CONTEXT.json 的人类可读视图。

    对纯后端 Feature，先明确说明 UI 不适用及其依据，避免把空的
    前端表格误读为 JSON → MD 同步失败。
    """
    lines = [
        f"# UI Context - {feature}",
        "",
        "本文档基于 UI_CONTEXT.json 生成；JSON 是 UI 范围的机器事实源。",
        "",
    ]

    ui_required = data.get("uiRequired")
    decision_status = data.get("decisionStatus", "未知")
    decision_source = data.get("decisionSource", "未知")
    ui_required_display = "是" if ui_required is True else "否" if ui_required is False else "未确定"
    lines.extend([
        "## UI 范围决策",
        "",
        f"- 是否需要 UI 实现：{ui_required_display}",
        f"- 决策状态：{decision_status}",
        f"- 决策来源：{decision_source}",
    ])
    if ui_required is False:
        reason = data.get("notApplicableReason")
        reason_display = reason.strip() if isinstance(reason, str) and reason.strip() else "未填写"
        lines.extend([
            f"- 不适用原因：{reason_display}",
            "",
            "本 Feature 不包含前端交付；无需定义页面、交互或视觉资源。",
            "",
        ])
        return "\n".join(lines)
    lines.append("")

    pages = data.get('pages', [])
    visual_sources = data.get('visualSources', [])
    capabilities = data.get('capabilities', [])
    interactions = data.get('interactions', [])
    plan_tasks = tasks or []

    # ========== 1. 视觉资源与还原路径 ==========
    lines.extend([
        "## 视觉资源与还原路径",
        "",
    ])

    if visual_sources:
        lines.extend([
            "| 资源ID | 关联任务 | 类型 | 路径 | 还原路径 | 是否必需 |",
            "| ------ | -------- | ---- | ---- | -------- | -------- |",
        ])
        for vs in visual_sources:
            source_id = vs.get('sourceId', 'N/A')
            vs_type = vs.get('type', 'N/A')
            vs_type_zh = _visual_source_type_zh(vs_type)
            path = vs.get('path', 'N/A')
            route = vs.get('route', 'N/A')
            required = '是' if vs.get('required') else '否'

            # 精确展示引用该视觉资源的正式 Plan Task。
            task_name = _task_display_for_visual_source(plan_tasks, source_id)

            lines.append(f"| {source_id} | {task_name} | {vs_type_zh} | `{path}` | `{route}` | {required} |")
        lines.append("")

        # 还原路径说明
        lines.extend([
            "### 还原路径说明",
            "",
            "- **absolute-html**: 使用高保真HTML进行像素级还原",
            "- **standard-html**: 使用标准HTML作为参考",
            "- **spec-driven-ui**: 基于需求规格说明驱动UI开发",
            "- **missing-html**: 缺少HTML资源",
            "",
        ])
    else:
        lines.extend([
            "暂无视觉资源。",
            "",
        ])

    # ========== 2. 页面与能力映射 ==========
    lines.extend([
        "## 页面与能力映射",
        "",
    ])

    if pages:
        # 构建页面到能力的映射
        page_to_capabilities = {}
        if capabilities:
            for cap in capabilities:
                cap_id = cap.get('capabilityId', '')
                page_refs = cap.get('pageRefs', [])
                for page_ref in page_refs:
                    if page_ref not in page_to_capabilities:
                        page_to_capabilities[page_ref] = []
                    page_to_capabilities[page_ref].append(cap_id)

        # 按页面组织交互列表
        interactions_by_page = {}
        for interaction in interactions:
            page_id = interaction.get('pageId', 'N/A')
            if page_id not in interactions_by_page:
                interactions_by_page[page_id] = []
            interactions_by_page[page_id].append(interaction)

        # 页面表格（包含能力列）
        lines.extend([
            "| 页面ID | 页面名称 | 页面目标 | 路由提示 | 状态 | 关联能力 | 交互 |",
            "| ------ | -------- | -------- | -------- | ---- | -------- | ---- |",
        ])

        for page in pages:
            page_id = page.get('pageId', 'N/A')
            name = page.get('name', 'N/A')
            goal = page.get('goal', 'N/A')
            route_hint = page.get('routeHint', '')
            states = page.get('states', [])

            route_hint_display = f"`{route_hint}`" if route_hint else '-'
            states_display = ', '.join(states) if states else '-'

            # 只展示稳定 capabilityId，不生成可能失真的中文映射。
            capabilities_display = '-'
            if page_id in page_to_capabilities:
                capabilities_display = '<br>'.join(page_to_capabilities[page_id])

            # 构建交互列表字符串（不显示ID，每条换行）
            interactions_display = '-'
            if page_id in interactions_by_page:
                interaction_items = []
                for interaction in interactions_by_page[page_id]:
                    summary = interaction.get('summary', 'N/A')
                    interaction_items.append(summary)
                interactions_display = '<br>'.join(interaction_items)

            lines.append(f"| {page_id} | {name} | {goal} | {route_hint_display} | {states_display} | {capabilities_display} | {interactions_display} |")

        lines.append("")
    else:
        lines.extend([
            "暂无页面定义。",
            "",
        ])

    return "\n".join(lines)


def _write_md(
    workspace: Path,
    feature: str,
    data: dict[str, Any],
    *,
    tasks: list[dict[str, Any]] | None = None,
) -> None:
    """写入UI_CONTEXT.md文件"""
    md_path = _path(workspace, feature).parent / "UI_CONTEXT.md"
    plan_tasks = _load_plan_tasks(workspace, feature) if tasks is None else tasks
    md_content = _generate_ui_context_md(data, feature, tasks=plan_tasks)
    md_path.write_text(md_content, encoding="utf-8")


def refresh_ui_context_md(
    workspace: Path,
    feature: str,
    *,
    tasks: list[dict[str, Any]] | None = None,
) -> bool:
    """Refresh UI_CONTEXT.md when UI context exists; return whether it ran."""
    context_path = _path(workspace, feature)
    if not context_path.is_file():
        return False
    data = load_json(context_path)
    if not isinstance(data, dict):
        return False
    _write_md(workspace, feature, data, tasks=tasks)
    return True


def _write(
    workspace: Path,
    feature: str,
    data: dict[str, Any],
    *,
    require_confirmed: bool = False,
    require_locked: bool = False,
) -> WriterResult:
    path = _path(workspace, feature)
    if require_confirmed or require_locked:
        errors = validate_ui_context_data(
            data,
            feature_id=feature,
            require_confirmed=require_confirmed,
            require_locked=require_locked,
        )
    else:
        errors = _structure_errors(data, feature)
    if errors:
        return WriterResult(ok=False, path=path, errors=[{"reason": error} for error in errors])
    changed = atomic_write_json(path, data)

    # 同时生成UI_CONTEXT.md
    try:
        _write_md(workspace, feature, data)
    except Exception as exc:
        # MD生成失败不影响JSON写入结果，但记录警告
        print(f"Warning: Failed to generate UI_CONTEXT.md: {exc}", file=sys.stderr)

    return WriterResult(ok=True, path=path, changed=changed)


def _find(items: list[Any], field: str, value: str) -> dict[str, Any] | None:
    for item in items:
        if isinstance(item, dict) and item.get(field) == value:
            return item
    return None


def _upsert(items: list[Any], field: str, item: dict[str, Any]) -> None:
    item_id = item[field]
    existing = _find(items, field, item_id)
    if existing is None:
        items.append(item)
    else:
        existing.update(item)


def _string_array(values: list[str] | None) -> list[str]:
    return [value.strip() for value in values or [] if value.strip()]


def _archive_visual_source(
    workspace: Path,
    feature: str,
    source_id: str,
    source_file_value: str,
    source_root_value: str | None,
) -> tuple[str, str, str, Path]:
    source_file = Path(source_file_value).expanduser().resolve()
    if not source_file.is_file():
        raise ValueError(f"visual_source_file_missing:{source_file}")
    source_root = Path(source_root_value).expanduser().resolve() if source_root_value else None
    if source_root is not None:
        if not source_root.is_dir():
            raise ValueError(f"visual_source_root_missing:{source_root}")
        try:
            entry_relative = source_file.relative_to(source_root)
        except ValueError as exc:
            raise ValueError(f"visual_source_file_outside_root:{source_file}") from exc
    else:
        entry_relative = Path(source_file.name)

    archive_parent = _path(workspace, feature).parent / "frontend-html"
    if source_root is not None:
        try:
            archive_parent.resolve().relative_to(source_root)
        except ValueError:
            pass
        else:
            raise ValueError(f"visual_source_root_contains_archive:{source_root}")
    archive_dir = archive_parent / source_id
    if archive_dir.exists():
        raise ValueError(f"archived_visual_source_immutable:{source_id}")
    archive_parent.mkdir(parents=True, exist_ok=True)
    temporary = archive_parent / f".{source_id}-{uuid.uuid4().hex[:8]}.tmp"
    try:
        if source_root is not None:
            shutil.copytree(source_root, temporary)
        else:
            temporary.mkdir()
            shutil.copy2(source_file, temporary / source_file.name)
        archived_entry = temporary / entry_relative
        if not archived_entry.is_file():
            raise ValueError(f"archived_visual_source_entry_missing:{entry_relative.as_posix()}")
        content_sha256 = visual_source_content_sha256(archived_entry)
        bundle_sha256 = visual_source_bundle_sha256(temporary)
        temporary.replace(archive_dir)
    except Exception:
        if temporary.exists():
            shutil.rmtree(temporary)
        raise
    relative_path = (Path("frontend-html") / source_id / entry_relative).as_posix()
    return relative_path, content_sha256, bundle_sha256, archive_dir


def _cmd_init(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    existing = fail_if_artifact_exists(_path(workspace, feature), force=args.force)
    if existing:
        return render_result(existing)
    data = _initial(feature)
    if args.ui_required:
        data["uiRequired"] = True
        data["decisionSource"] = args.decision_source
        data["notApplicableReason"] = ""
    return render_result(with_result_data(_write(workspace, feature, data), reset=bool(args.force)))


def _cmd_set_ui_required(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    required = args.required.lower() == "true"
    data["uiRequired"] = required
    data["decisionSource"] = args.decision_source
    if required:
        data["notApplicableReason"] = ""
    else:
        reason = (args.reason or "").strip()
        if not reason:
            return render_result(fail("missing_not_applicable_reason", "--reason 必填"))
        data["notApplicableReason"] = reason
        data["pages"] = []
        data["interactions"] = []
        data["visualSources"] = []
        data["capabilities"] = []
        if data.get("decisionStatus") == "defaulted":
            data.pop("confirmedAtCheckpoint", None)
            data.pop("lockedAtCheckpoint", None)
    return render_result(_write(workspace, feature, data))


def _cmd_add_page(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    pages = data.setdefault("pages", [])
    page_id = args.page_id or next_numbered_id(
        {item.get("pageId") for item in pages if isinstance(item, dict) and isinstance(item.get("pageId"), str)},
        "PAGE",
    )
    item = {
        "pageId": page_id,
        "name": args.name,
        "goal": args.goal,
    }
    if args.route_hint:
        item["routeHint"] = args.route_hint
    if args.state:
        item["states"] = _string_array(args.state)
    _upsert(pages, "pageId", item)
    return render_result(_write(workspace, feature, data))


def _cmd_add_interaction(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    interactions = data.setdefault("interactions", [])
    interaction_id = args.interaction_id or next_numbered_id(
        {
            item.get("interactionId")
            for item in interactions
            if isinstance(item, dict) and isinstance(item.get("interactionId"), str)
        },
        "UIX",
    )
    item = {
        "interactionId": interaction_id,
        "pageId": args.page_id,
        "summary": args.summary,
    }
    if args.state_ref:
        item["stateRefs"] = _string_array(args.state_ref)
    if args.spec_ref:
        item["specRefs"] = _string_array(args.spec_ref)
    _upsert(interactions, "interactionId", item)
    return render_result(_write(workspace, feature, data))


def _cmd_add_visual_source(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    sources = data.setdefault("visualSources", [])
    source_id = args.source_id or next_numbered_id(
        {
            item.get("sourceId")
            for item in sources
            if isinstance(item, dict) and isinstance(item.get("sourceId"), str)
        },
        "VIS",
    )
    existing = _find(sources, "sourceId", source_id)
    if args.source_file and existing is not None and existing.get("contentSha256"):
        return render_result(fail("archived_visual_source_immutable", source_id))
    if args.source_file and args.path:
        return render_result(fail("visual_source_path_conflict", "--path 与 --source-file 只能使用一个"))
    if args.source_file and args.type not in {"high_fidelity_html", "standard_html"}:
        return render_result(fail("visual_source_archive_type_invalid", args.type))
    if args.source_root and not args.source_file:
        return render_result(fail("visual_source_root_without_file", "--source-root 需要 --source-file"))
    if not args.source_file and not args.path:
        return render_result(fail("visual_source_path_missing", "--path 或 --source-file 必填"))
    if existing is not None and existing.get("contentSha256") and not args.source_file:
        return render_result(fail("archived_visual_source_immutable", source_id))

    archive_dir: Path | None = None
    if args.source_file:
        try:
            path, content_sha256, bundle_sha256, archive_dir = _archive_visual_source(
                workspace,
                feature,
                source_id,
                args.source_file,
                args.source_root,
            )
        except ValueError as exc:
            return render_result(fail("visual_source_archive_failed", str(exc)))
        item = {
            "sourceId": source_id,
            "type": args.type,
            "path": path,
            "contentSha256": content_sha256,
            "bundleSha256": bundle_sha256,
        }
    else:
        item = {
            "sourceId": source_id,
            "type": args.type,
            "path": args.path,
        }
    if args.route:
        item["route"] = args.route
    if args.required is not None:
        item["required"] = args.required.lower() == "true"
    _upsert(sources, "sourceId", item)
    result = _write(workspace, feature, data)
    if not result.ok and archive_dir is not None and archive_dir.exists():
        shutil.rmtree(archive_dir)
    return render_result(result)


def _cmd_add_capability(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    capabilities = data.setdefault("capabilities", [])
    item = {
        "capabilityId": args.capability_id,
        "pageRefs": _string_array(args.page_ref),
        "interactionRefs": _string_array(args.interaction_ref),
        "visualSourceRefs": _string_array(args.visual_source_ref),
        "specRefs": _string_array(args.spec_ref),
    }
    if args.ui_required is not None:
        item["uiRequired"] = args.ui_required.lower() == "true"
    _upsert(capabilities, "capabilityId", item)
    return render_result(_write(workspace, feature, data))


def _cmd_confirm(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    if STATUS_ORDER.get(str(data.get("decisionStatus")), -1) > STATUS_ORDER["confirmed"]:
        return render_result(fail("ui_context_status_regression", "locked 不能回退到 confirmed"))
    data["decisionStatus"] = "confirmed"
    data["confirmedAtCheckpoint"] = "prd_done"
    if args.decision_source:
        data["decisionSource"] = args.decision_source
    return render_result(_write(workspace, feature, data))


def _cmd_lock(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    if STATUS_ORDER.get(str(data.get("decisionStatus")), -1) < STATUS_ORDER["confirmed"]:
        return render_result(fail("ui_context_lock_without_confirm", "lock 前必须先 confirmed"))
    data["decisionStatus"] = "locked"
    data["lockedAtCheckpoint"] = "specs_done"
    if not data.get("confirmedAtCheckpoint"):
        data["confirmedAtCheckpoint"] = "prd_done"
    return render_result(_write(workspace, feature, data, require_locked=True))


def _cmd_validate(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    path = _path(workspace, feature)
    try:
        data = load_json(path)
    except Exception as exc:
        return render_result(fail("ui_context_load_failed", str(exc), path=path))
    if args.confirmed or args.locked:
        errors = validate_ui_context_data(
            data,
            feature_id=feature,
            require_confirmed=args.confirmed,
            require_locked=args.locked,
        )
    else:
        errors = _structure_errors(data, feature)
    return render_result(
        WriterResult(
            ok=not errors,
            path=path,
            errors=[{"reason": error} for error in errors],
            data={"validation": "gate" if args.confirmed or args.locked else "structure"},
        )
    )


def _cmd_show(args: argparse.Namespace) -> int:
    workspace, feature = _resolve(args)
    data = _load(workspace, feature)
    summary = {
        "featureId": data.get("featureId"),
        "uiRequired": data.get("uiRequired"),
        "decisionStatus": data.get("decisionStatus"),
        "pages": len(data.get("pages", [])) if isinstance(data.get("pages"), list) else 0,
        "interactions": len(data.get("interactions", [])) if isinstance(data.get("interactions"), list) else 0,
        "visualSources": len(data.get("visualSources", [])) if isinstance(data.get("visualSources"), list) else 0,
        "capabilities": len(data.get("capabilities", [])) if isinstance(data.get("capabilities"), list) else 0,
    }
    return render_result(WriterResult(ok=True, path=_path(workspace, feature), data={"summary": summary}))


def _parse_md_section(lines: list[str], start_marker: str) -> tuple[int, list[str]]:
    """提取Markdown中某个section的内容"""
    start = -1
    for i, line in enumerate(lines):
        if line.strip().startswith(start_marker):
            start = i
            break
    if start == -1:
        return -1, []

    # 找到下一个同级或更高级标题
    level = len(start_marker.split()[0])  # ## 是2级
    content = []
    for i in range(start + 1, len(lines)):
        line = lines[i]
        if line.strip().startswith("#"):
            # 检查标题级别
            header_level = len(line.split()[0])
            if header_level <= level:
                break
        content.append(line)

    return start, content


def _parse_pages_from_md(lines: list[str]) -> list[dict[str, Any]]:
    """从MD解析页面列表"""
    _, section = _parse_md_section(lines, "## 页面列表")
    if not section:
        return []

    pages = []
    current_page = None

    for line in section:
        line = line.strip()
        if line.startswith("### "):
            # 新页面: ### PAGE-001: 订单列表页
            if current_page:
                pages.append(current_page)
            parts = line[4:].split(":", 1)
            if len(parts) == 2:
                page_id = parts[0].strip()
                name = parts[1].strip()
                current_page = {"pageId": page_id, "name": name, "goal": ""}
        elif line.startswith("**目标**:") and current_page:
            current_page["goal"] = line.split(":", 1)[1].strip()
        elif line.startswith("**路由提示**:") and current_page:
            route_hint = line.split(":", 1)[1].strip().strip("`")
            if route_hint:
                current_page["routeHint"] = route_hint
        elif line.startswith("**状态**:") and current_page:
            states_str = line.split(":", 1)[1].strip()
            states = [s.strip() for s in states_str.split(",")]
            if states:
                current_page["states"] = states

    if current_page:
        pages.append(current_page)

    return pages


def _parse_interactions_from_md(lines: list[str]) -> list[dict[str, Any]]:
    """从MD解析交互列表"""
    _, section = _parse_md_section(lines, "## 交互列表")
    if not section:
        return []

    interactions = []
    current_interaction = None

    for line in section:
        line = line.strip()
        if line.startswith("### "):
            # 新交互: ### UIX-001: 点击订单行跳转到详情页
            if current_interaction:
                interactions.append(current_interaction)
            parts = line[4:].split(":", 1)
            if len(parts) == 2:
                interaction_id = parts[0].strip()
                summary = parts[1].strip()
                current_interaction = {"interactionId": interaction_id, "summary": summary, "pageId": ""}
        elif line.startswith("**所属页面**:") and current_interaction:
            current_interaction["pageId"] = line.split(":", 1)[1].strip()
        elif line.startswith("**关联状态**:") and current_interaction:
            states_str = line.split(":", 1)[1].strip()
            states = [s.strip() for s in states_str.split(",")]
            if states:
                current_interaction["stateRefs"] = states

    if current_interaction:
        interactions.append(current_interaction)

    return interactions


def _parse_capabilities_from_md(lines: list[str]) -> list[dict[str, Any]]:
    """从MD解析能力列表"""
    _, section = _parse_md_section(lines, "## 能力与资源映射关系")
    if not section:
        return []

    capabilities = []
    current_capability = None

    for line in section:
        line = line.strip()
        if line.startswith("### ") and not line.startswith("### 还原路径说明"):
            # 新能力: ### order-list-ui
            if current_capability:
                capabilities.append(current_capability)
            capability_id = line[4:].strip()
            current_capability = {
                "capabilityId": capability_id,
                "pageRefs": [],
                "interactionRefs": [],
                "visualSourceRefs": [],
                "specRefs": []
            }
        elif line.startswith("**UI需求**:") and current_capability:
            ui_req_str = line.split(":", 1)[1].strip()
            current_capability["uiRequired"] = ui_req_str == "是"
        elif line.startswith("**关联页面**:") and current_capability:
            refs = line.split(":", 1)[1].strip()
            if refs and refs != "无":
                current_capability["pageRefs"] = [r.strip() for r in refs.split(",")]
        elif line.startswith("**关联交互**:") and current_capability:
            refs = line.split(":", 1)[1].strip()
            if refs and refs != "无":
                current_capability["interactionRefs"] = [r.strip() for r in refs.split(",")]
        elif line.startswith("**视觉资源**:") and current_capability:
            refs = line.split(":", 1)[1].strip()
            if refs and not refs.startswith("无"):
                current_capability["visualSourceRefs"] = [r.strip() for r in refs.split(",")]
        elif line.startswith("**规格引用**:") and current_capability:
            refs = line.split(":", 1)[1].strip()
            if refs and refs != "无":
                current_capability["specRefs"] = [r.strip() for r in refs.split(",")]

    if current_capability:
        capabilities.append(current_capability)

    return capabilities


def _cmd_sync_from_md(args: argparse.Namespace) -> int:
    """从UI_CONTEXT.md同步内容到UI_CONTEXT.json"""
    workspace, feature = _resolve(args)

    # 读取MD文件
    md_path = _path(workspace, feature).parent / "UI_CONTEXT.md"
    if not md_path.exists():
        return render_result(fail("md_file_not_found", f"UI_CONTEXT.md 不存在: {md_path}"))

    try:
        md_content = md_path.read_text(encoding="utf-8")
        md_lines = md_content.split("\n")
    except Exception as exc:
        return render_result(fail("md_read_failed", str(exc)))

    # 读取现有JSON数据（保留MD中没有的字段）
    data = _load(workspace, feature)

    # 解析MD中的基本信息
    ui_required = None
    for line in md_lines:
        if "**UI需求**:" in line:
            ui_required = "是" in line
            break

    if ui_required is not None:
        data["uiRequired"] = ui_required

    # 解析并更新pages、interactions、capabilities
    try:
        pages = _parse_pages_from_md(md_lines)
        if pages:
            data["pages"] = pages

        interactions = _parse_interactions_from_md(md_lines)
        if interactions:
            data["interactions"] = interactions

        capabilities = _parse_capabilities_from_md(md_lines)
        if capabilities:
            data["capabilities"] = capabilities
    except Exception as exc:
        return render_result(fail("md_parse_failed", f"解析MD失败: {exc}"))

    # 写入JSON（会触发MD重新生成）
    return render_result(_write(workspace, feature, data))


def _resolve(args: argparse.Namespace) -> tuple[Path, str]:
    return resolve_workspace(args.workspace), resolve_feature(args.feature)


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--workspace")
    parser.add_argument("--feature")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Incrementally write UI_CONTEXT.json")
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init")
    _add_common(init)
    init.add_argument("--force", action="store_true")
    init.add_argument("--ui-required", action="store_true")
    init.add_argument("--decision-source", default="default_false", choices=sorted(DECISION_SOURCES))
    init.set_defaults(func=_cmd_init)

    set_ui = sub.add_parser("set-ui-required")
    _add_common(set_ui)
    set_ui.add_argument("required", choices=["true", "false"])
    set_ui.add_argument("--reason", default="")
    set_ui.add_argument("--decision-source", default="prd_inferred", choices=sorted(DECISION_SOURCES))
    set_ui.set_defaults(func=_cmd_set_ui_required)

    page = sub.add_parser("add-page")
    _add_common(page)
    page.add_argument("--page-id")
    page.add_argument("--name", required=True)
    page.add_argument("--goal", required=True)
    page.add_argument("--route-hint")
    page.add_argument("--state", action="append")
    page.set_defaults(func=_cmd_add_page)
    update_page = sub.add_parser("update-page")
    update_page.set_defaults(func=_cmd_add_page)
    for action in (update_page,):
        _add_common(action)
        action.add_argument("--page-id", required=True)
        action.add_argument("--name", required=True)
        action.add_argument("--goal", required=True)
        action.add_argument("--route-hint")
        action.add_argument("--state", action="append")

    interaction = sub.add_parser("add-interaction")
    _add_common(interaction)
    interaction.add_argument("--interaction-id")
    interaction.add_argument("--page-id", required=True)
    interaction.add_argument("--summary", required=True)
    interaction.add_argument("--state-ref", action="append")
    interaction.add_argument("--spec-ref", action="append")
    interaction.set_defaults(func=_cmd_add_interaction)
    update_interaction = sub.add_parser("update-interaction")
    _add_common(update_interaction)
    update_interaction.add_argument("--interaction-id", required=True)
    update_interaction.add_argument("--page-id", required=True)
    update_interaction.add_argument("--summary", required=True)
    update_interaction.add_argument("--state-ref", action="append")
    update_interaction.add_argument("--spec-ref", action="append")
    update_interaction.set_defaults(func=_cmd_add_interaction)

    visual = sub.add_parser("add-visual-source")
    _add_common(visual)
    visual.add_argument("--source-id")
    visual.add_argument("--type", required=True)
    visual.add_argument("--path")
    visual.add_argument("--source-file")
    visual.add_argument("--source-root")
    visual.add_argument("--route", choices=sorted(FRONTEND_ROUTES - {"none"}))
    visual.add_argument("--required", choices=["true", "false"])
    visual.set_defaults(func=_cmd_add_visual_source)
    update_visual = sub.add_parser("update-visual-source")
    _add_common(update_visual)
    update_visual.add_argument("--source-id", required=True)
    update_visual.add_argument("--type", required=True)
    update_visual.add_argument("--path")
    update_visual.add_argument("--source-file")
    update_visual.add_argument("--source-root")
    update_visual.add_argument("--route", choices=sorted(FRONTEND_ROUTES - {"none"}))
    update_visual.add_argument("--required", choices=["true", "false"])
    update_visual.set_defaults(func=_cmd_add_visual_source)

    capability = sub.add_parser("add-capability")
    _add_common(capability)
    capability.add_argument("--capability-id", required=True)
    capability.add_argument("--page-ref", action="append")
    capability.add_argument("--interaction-ref", action="append")
    capability.add_argument("--visual-source-ref", action="append")
    capability.add_argument("--spec-ref", action="append")
    capability.add_argument("--ui-required", choices=["true", "false"])
    capability.set_defaults(func=_cmd_add_capability)
    update_capability = sub.add_parser("update-capability")
    _add_common(update_capability)
    update_capability.add_argument("--capability-id", required=True)
    update_capability.add_argument("--page-ref", action="append")
    update_capability.add_argument("--interaction-ref", action="append")
    update_capability.add_argument("--visual-source-ref", action="append")
    update_capability.add_argument("--spec-ref", action="append")
    update_capability.add_argument("--ui-required", choices=["true", "false"])
    update_capability.set_defaults(func=_cmd_add_capability)

    confirm = sub.add_parser("confirm")
    _add_common(confirm)
    confirm.add_argument("--decision-source", choices=sorted(DECISION_SOURCES))
    confirm.set_defaults(func=_cmd_confirm)

    lock = sub.add_parser("lock")
    _add_common(lock)
    lock.set_defaults(func=_cmd_lock)

    validate = sub.add_parser("validate")
    _add_common(validate)
    validate.add_argument("--structure", action="store_true")
    validate.add_argument("--confirmed", action="store_true")
    validate.add_argument("--locked", action="store_true")
    validate.set_defaults(func=_cmd_validate)

    show = sub.add_parser("show")
    _add_common(show)
    show.add_argument("--summary", action="store_true")
    show.set_defaults(func=_cmd_show)

    sync = sub.add_parser("sync-from-md")
    _add_common(sync)
    sync.set_defaults(func=_cmd_sync_from_md)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except Exception as exc:
        return render_result(fail("ui_context_writer_failed", str(exc)))


if __name__ == "__main__":
    raise SystemExit(main())
