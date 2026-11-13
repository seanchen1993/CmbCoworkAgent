#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read and validate the compact, PRD-owned external source context.

记录单位是文件：一份外部资料对应一个 ``SRC-NNN`` 和一个快照文件，不再向下
拆条目、行、列或段落。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple


SOURCE_CONTEXT_FILE = "source-context.json"
SOURCE_ID_RE = re.compile(r"^SRC-\d{3}$")
SOURCE_ID_SCAN_RE = re.compile(r"\bSRC-\d{3}\b")
VALID_AVAILABILITY = {"live", "snapshot_only", "never_provided"}
VALID_READ_STATUS = {"complete", "partial", "unreadable"}
VALID_FRESHNESS = {"current", "stale", "unknown"}


def source_context_path(feature_dir: Path) -> Path:
    return feature_dir / SOURCE_CONTEXT_FILE


def referenced_source_ids(text: str) -> Set[str]:
    return set(SOURCE_ID_SCAN_RE.findall(text))


def load_source_context(feature_dir: Path) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    path = source_context_path(feature_dir)
    if not path.is_file() or path.stat().st_size <= 0:
        return None, []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return None, ["source-context.json 无法读取: %s" % exc]
    if not isinstance(data, dict):
        return None, ["source-context.json 顶层必须是对象"]
    return data, []


def source_index(data: Optional[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """按 SRC-NNN 索引每份资料，下游只透传这些字段。"""
    result = {}  # type: Dict[str, Dict[str, Any]]
    if not isinstance(data, dict):
        return result
    sources = data.get("sources")
    if not isinstance(sources, list):
        return result
    for source in sources:
        if not isinstance(source, dict):
            continue
        source_id = source.get("id")
        if not isinstance(source_id, str):
            continue
        result[source_id] = {
            "id": source_id,
            "name": source.get("name"),
            "sourcePath": source.get("path"),
            "availability": source.get("availability"),
            "readStatus": source.get("readStatus"),
            "freshness": source.get("freshness", "unknown"),
        }
    return result


def _safe_snapshot_path(feature_dir: Path, source_id: str, raw_path: Any) -> Tuple[Optional[Path], Optional[str]]:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None, "%s 缺少快照 path" % source_id
    path = Path(raw_path)
    if path.is_absolute():
        return None, "%s.path 必须是 Feature 目录相对路径" % source_id
    candidate = (feature_dir / path).resolve(strict=False)
    base = feature_dir.resolve(strict=False)
    try:
        relative = candidate.relative_to(base)
    except ValueError:
        return None, "%s.path 越出 Feature 目录" % source_id
    parts = relative.parts
    if len(parts) < 3 or parts[0] != "sources" or parts[1] != source_id:
        return None, "%s.path 必须位于 sources/%s/" % (source_id, source_id)
    if not candidate.is_file() or candidate.stat().st_size <= 0:
        return None, "%s 快照不存在或为空: %s" % (source_id, raw_path)
    return candidate, None


def validate_source_context(
    feature_dir: Path,
    expected_source_ids: Optional[Set[str]] = None,
) -> Tuple[List[str], List[str]]:
    """校验 source-context.json，返回 (errors, warnings)。

    errors 只保留会让下游引用悬空的项：ID 可解析、
    PRD 与 json 的来源集合一致。其余字段下游只做透传渲染，一律降级为
    warnings，避免 discuss 阶段的严格度阻断 Plan / Code。
    """
    data, load_errors = load_source_context(feature_dir)
    errors = list(load_errors)  # type: List[str]
    warnings = []  # type: List[str]
    if data is None:
        if expected_source_ids:
            errors.append(
                "PRD 登记了外部资料，必须生成 source-context.json；"
                "修复：运行 source_context.py sync --feature-dir <Feature 目录>"
            )
        return errors, warnings

    if data.get("version") != 1:
        errors.append("source-context.json.version 必须为 1；修复：把 version 字段设为整数 1")
    sources = data.get("sources")
    if not isinstance(sources, list) or not sources:
        errors.append(
            "source-context.json.sources 必须是非空数组；"
            "修复：运行 source_context.py sync --feature-dir <Feature 目录> 依据 PRD 来源表重建"
        )
        return errors, warnings

    seen_sources = set()  # type: Set[str]

    for source_index_position, source in enumerate(sources):
        context = "sources[%d]" % source_index_position
        if not isinstance(source, dict):
            errors.append("%s 必须是对象" % context)
            continue
        source_id = source.get("id")
        if not isinstance(source_id, str) or SOURCE_ID_RE.fullmatch(source_id) is None:
            errors.append("%s.id 格式非法；修复：改为 SRC-001 形式的三位编号" % context)
            continue
        if source_id in seen_sources:
            errors.append(
                "source-context.json 来源 ID 重复: %s；修复：保留一条，其余改用未使用的 SRC-NNN"
                % source_id
            )
        seen_sources.add(source_id)

        name = source.get("name")
        if not isinstance(name, str) or not name.strip():
            warnings.append("%s.name 缺失" % source_id)
        availability = source.get("availability")
        if availability not in VALID_AVAILABILITY:
            warnings.append(
                "%s.availability 非法；可选值: %s"
                % (source_id, "/".join(sorted(VALID_AVAILABILITY)))
            )
        read_status = source.get("readStatus")
        if read_status not in VALID_READ_STATUS:
            warnings.append(
                "%s.readStatus 非法；可选值: %s"
                % (source_id, "/".join(sorted(VALID_READ_STATUS)))
            )
        elif availability != "never_provided" and read_status != "complete":
            warnings.append("%s 尚未完整读取（readStatus=%s）" % (source_id, read_status))
        if source.get("freshness", "unknown") not in VALID_FRESHNESS:
            warnings.append(
                "%s.freshness 非法；可选值: %s"
                % (source_id, "/".join(sorted(VALID_FRESHNESS)))
            )
        if availability == "never_provided":
            warnings.append(
                "%s 标记为从未提供；出口只有三个：当场提供资料、移除该依赖、或暂停等待材料"
                % source_id
            )
            continue

        _, path_error = _safe_snapshot_path(feature_dir, source_id, source.get("path"))
        if path_error:
            warnings.append(
                "%s；修复：运行 source_context.py sync 自动写入快照路径" % path_error
            )

    if expected_source_ids is not None:
        missing = sorted(expected_source_ids - seen_sources)
        unknown = sorted(seen_sources - expected_source_ids)
        if missing:
            errors.append(
                "source-context.json 缺少 PRD 来源: %s；"
                "修复：运行 source_context.py sync 依据 PRD 来源表补齐" % ", ".join(missing)
            )
        if unknown:
            errors.append(
                "source-context.json 存在 PRD 未登记来源: %s；"
                "修复：在 PRD 的「外部资料与实现约束」补登记，或从 json 中移除"
                % ", ".join(unknown)
            )
    return errors, warnings


def _snapshot_for_source(feature_dir: Path, source_id: str, declared: Any) -> Optional[Path]:
    """定位来源快照：优先用已登记的 path，否则取 sources/SRC-NNN/ 下的第一个文件。"""
    candidate, error = _safe_snapshot_path(feature_dir, source_id, declared)
    if error is None and candidate is not None:
        return candidate
    source_dir = feature_dir / "sources" / source_id
    if not source_dir.is_dir():
        return None
    files = sorted(
        entry for entry in source_dir.iterdir()
        if entry.is_file() and not entry.name.startswith(".") and entry.stat().st_size > 0
    )
    return files[0] if files else None


def sync_source_context(feature_dir: Path, only: Optional[str] = None) -> Tuple[int, List[str]]:
    """依据 PRD 来源表与 sources/ 快照重建 source-context.json。

    全部字段都是机械投影：快照路径来自 sources/ 目录。
    """
    try:
        from hooks.source_references import extract_source_references, has_source_section
    except ImportError:  # 直接以脚本方式运行时，仓库根目录不在 sys.path 上
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from hooks.source_references import extract_source_references, has_source_section

    messages = []  # type: List[str]
    prd = feature_dir / "PRD.md"
    if not prd.is_file():
        print(
            "ERROR: 未找到 %s。修复：先生成 PRD.md，再运行 sync。" % prd,
            file=sys.stderr,
        )
        return 1, messages
    content = prd.read_text(encoding="utf-8")
    if not has_source_section(content):
        print(
            "ERROR: PRD.md 缺少「外部资料与实现约束」章节。"
            "修复：先在 PRD.md 增加该章节并登记 SRC-NNN，没有外部资料时正文写「无」。",
            file=sys.stderr,
        )
        return 1, messages
    references = extract_source_references(content)
    if not references:
        messages.append("PRD 未登记外部资料，无需生成 source-context.json")
        return 0, messages

    data, load_errors = load_source_context(feature_dir)
    if load_errors:
        print("ERROR: %s 修复：修正 JSON 语法或删除该文件后重跑 sync。" % load_errors[0], file=sys.stderr)
        return 1, messages
    existing_by_id = {}  # type: Dict[str, Dict[str, Any]]
    if isinstance(data, dict) and isinstance(data.get("sources"), list):
        for source in data["sources"]:
            if isinstance(source, dict) and isinstance(source.get("id"), str):
                existing_by_id[source["id"]] = source

    sources = []  # type: List[Dict[str, Any]]
    for reference in references:
        source_id = reference.source_id
        if only and source_id != only:
            if source_id in existing_by_id:
                sources.append(existing_by_id[source_id])
            continue
        previous = existing_by_id.get(source_id, {})
        snapshot = _snapshot_for_source(feature_dir, source_id, previous.get("path"))
        source = {
            "id": source_id,
            "name": reference.name or previous.get("name") or source_id,
            "availability": previous.get("availability") or "snapshot_only",
            "readStatus": previous.get("readStatus") or "complete",
            "freshness": previous.get("freshness", "unknown"),
        }
        if snapshot is None:
            source["availability"] = "never_provided"
            source["readStatus"] = "unreadable"
            sources.append(source)
            messages.append(
                "%s 未找到快照（sources/%s/ 为空）：请提供资料、移除该依赖或暂停" % (source_id, source_id)
            )
            continue
        relative = snapshot.resolve(strict=False).relative_to(feature_dir.resolve(strict=False))
        source["path"] = "/".join(relative.parts)
        messages.append("%s: 快照 %s" % (source_id, source["path"]))
        sources.append(source)

    payload = {"version": 1, "sources": sources}
    source_context_path(feature_dir).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    messages.append("已写入 %s" % source_context_path(feature_dir))
    return 0, messages


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="外部资料快照辅助工具")
    subparsers = parser.add_subparsers(dest="command")
    sync_parser = subparsers.add_parser(
        "sync", help="依据 PRD 来源表与 sources/ 快照生成 source-context.json 的机械字段"
    )
    sync_parser.add_argument("--feature-dir", required=True)
    sync_parser.add_argument("--source", default=None, help="只同步指定的 SRC-NNN")
    args = parser.parse_args(argv)

    if args.command != "sync":
        parser.print_help(sys.stderr)
        return 2
    code, messages = sync_source_context(Path(args.feature_dir), args.source)
    for message in messages:
        print(message)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
