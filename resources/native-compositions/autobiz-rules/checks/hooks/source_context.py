"""Read-only rules extracted from hooks/source_context.py. See provenance.json."""
from __future__ import annotations
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

SOURCE_CONTEXT_FILE = "source-context.json"


SOURCE_ID_RE = re.compile(r"^SRC-\d{3}$")


VALID_AVAILABILITY = {"live", "snapshot_only", "never_provided"}


VALID_READ_STATUS = {"complete", "partial", "unreadable"}


VALID_FRESHNESS = {"current", "stale", "unknown"}


def source_context_path(feature_dir: Path) -> Path:
    return feature_dir / SOURCE_CONTEXT_FILE


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
