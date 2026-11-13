#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
autobiz 统一校验脚本
用法:
    python3 "${pluginPath}/skills/autobiz/hooks/biz_validate.py" prd --feature "<slug>"
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

_HOOKS_DIR = Path(__file__).resolve().parent
if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))

# 将项目根目录加入 sys.path，以便导入 hooks.paths
_REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO_ROOT))

from hooks.paths import (
    contains_workspace_argument,
    get_features_active_dir,
    get_plugin_output_workspace,
)
from board_core.artifact_paths import resolve_exact_relative_path
from board_core.contracts import BoardConfigError, SkillContract, load_record_workflow_contracts
from board_core.state_store import check_or_fix_state_sync
from hooks.implementation_scope import load_scope, scope_path
from hooks.source_context import validate_source_context
from hooks.source_references import (
    extract_source_references,
    has_source_section,
    split_source_reference_section,
)

# 必需段落与待确认标记的单一事实源在 prd_rules.py。
from prd_rules import (  # noqa: F401  （re-export，供外部按原名引用）
    FORMAL_SECTION_MAX_LEVEL,
    PENDING_MARKER,
    REQUIRED_PRD_SECTIONS,
    iter_headings,
    pending_marker_lines,
)


BIZ_VALIDATE_WORKSPACE_ARGUMENT_ERROR = (
    "biz_validate.py 不接受 --workspace/-w；路径由 PLUGIN_WORKSPACE/PROJECT_DIR 环境变量决定。"
)


def _resolve_feature_context(feature: str, workspace: Path):
    """Load the feature's state record and workflow contracts.

    校验范围以本 Feature 契约为准：节点不在链中则整段校验跳过，
    被 drop 的输入不做存在性检查。
    Returns (record, contracts, errors).
    """
    errors: List[str] = []
    sync_result = check_or_fix_state_sync(workspace, fix=True)
    if not sync_result.state_exists:
        errors.append(f"state.json 不存在且无法从 STATE.md 迁移: {sync_result.state_json_path}")
        return None, None, errors
    if sync_result.errors:
        errors.extend(sync_result.errors)
        return None, None, errors
    record = sync_result.records.get(feature)
    if record is None and sync_result.record_errors.get(feature):
        errors.extend(sync_result.record_errors[feature])
        return None, None, errors
    if record is None:
        errors.append(f"state.json 中 Feature '{feature}' 不存在")
        return None, None, errors
    try:
        contracts = load_record_workflow_contracts(_REPO_ROOT, record, workspace=workspace)
    except BoardConfigError as exc:
        errors.append(f"Feature '{feature}' 的 workflow 契约无法解析: {exc}")
        return record, None, errors
    return record, contracts, errors


def _skill_contract_or_none(contracts, skill: str) -> Optional[SkillContract]:
    try:
        return contracts.contract_for_skill(skill)
    except BoardConfigError:
        # 节点未被选入当前工作流，或已被中途跳过。
        return None


def _check_done_checkpoint(
    record: Dict[str, Any], contract: SkillContract, warnings: List[str]
) -> None:
    """checkpoint 只作提示。

    技能正文要求先写 `*_done` 再跑校验，若把 checkpoint 当阻断项，
    模型就必须"先声明完成才能验证是否完成"，结构反馈只能出现在最后一轮。
    """
    expected_cp = next((cp for cp in contract.checkpoints if cp.endswith("_done")), None)
    if not expected_cp:
        return
    feature = record.get("feature", "")
    actual_cp = record.get("checkpoint")
    if actual_cp != expected_cp:
        warnings.append(
            f"Feature '{feature}' 的 checkpoint 当前为 {actual_cp or '未设置'}，尚未到 {expected_cp}；"
            f"修复：产物定稿后运行 update_checkpoint.py --checkpoint {expected_cp}（产物结构本身不受影响）"
        )


def resolve_feature_dir(feature: Optional[str], workspace: Path) -> Optional[Path]:
    features_dir = get_features_active_dir(workspace)
    if feature:
        d = resolve_exact_relative_path(features_dir, feature)
        return d if d is not None and d.is_dir() else None
    # 自动检测：若只有一个子目录，则使用该目录
    if features_dir.exists():
        subs = [d for d in features_dir.iterdir() if d.is_dir()]
        if len(subs) == 1:
            return subs[0]
    return None


def exact_file(feature_dir: Path, name: str) -> Optional[Path]:
    path = resolve_exact_relative_path(feature_dir, name)
    return path if path is not None and path.is_file() else None


def _implementation_scope_errors(feature_dir: Path, content: Optional[str] = None) -> List[str]:
    """Validate the optional scope contract and its visible document marker."""

    if not scope_path(feature_dir).is_file():
        return []
    _, errors = load_scope(feature_dir, required=True)
    if content is not None and "当前实现范围" not in content:
        errors.append(
            "PRD.md 缺少必要章节: 当前实现范围；"
            "修复：在 PRD.md 增加 `## 当前实现范围` 并写明 full_stack / backend_only / frontend_only"
        )
    return errors


def _fail(message: str, details: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    result = {"ok": False, "message": message}
    if details:
        result.update(details)
    return result


def _ok(message: str, details: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    result = {"ok": True, "message": message}
    if details:
        result.update(details)
    return result


def validate_prd(
    feature: Optional[str], workspace: Path, draft: bool = False
) -> Dict[str, Any]:
    feature_dir = resolve_feature_dir(feature, workspace)
    if not feature_dir:
        return _fail(f"未找到 feature 目录: feature={feature}")

    slug = feature_dir.name
    record, contracts, errors = _resolve_feature_context(slug, workspace)
    warnings: List[str] = []
    if errors:
        return _fail("prd 阶段产出物校验未通过", {"feature": slug, "errors": errors})

    contract = _skill_contract_or_none(contracts, "autobiz-requirement-discuss")
    if contract is None:
        return _ok(
            "prd 校验跳过：PRD 生成节点不在当前工作流链中",
            {"feature": slug, "skipped": True},
        )

    prd_md = exact_file(feature_dir, "PRD.md")

    if prd_md is None:
        errors.append(
            f"PRD.md 不存在: {feature_dir / 'PRD.md'}；"
            "修复：按技能正文的模板在该路径生成 PRD.md 后重跑校验"
        )
    else:
        content = prd_md.read_text(encoding="utf-8")
        errors.extend(_implementation_scope_errors(feature_dir, content))

        all_headings = iter_headings(content)
        # 必备段落必须是正式章节标题；功能详情里的深层同名标题不算数
        section_headings = [
            heading.text for heading in all_headings
            if heading.level <= FORMAL_SECTION_MAX_LEVEL
        ]
        bolds = re.findall(r"\*\*(.+?)\*\*", content)
        markers = section_headings + bolds
        missing = [s for s in REQUIRED_PRD_SECTIONS if not any(s in m for m in markers)]
        if missing:
            errors.append(
                "PRD.md 缺少必要段落: %s；修复：新增同名章节标题（层级不深于 %d 级），"
                "没有外部资料时该章节正文写「无」"
                % (", ".join(missing), FORMAL_SECTION_MAX_LEVEL)
            )

        pending_lines = pending_marker_lines(content)
        if pending_lines:
            shown = "、".join(str(line) for line in pending_lines[:10])
            more = "" if len(pending_lines) <= 10 else f"（共 {len(pending_lines)} 处）"
            errors.append(
                f"PRD.md 第 {shown} 行仍含 {PENDING_MARKER}{more}；"
                "修复：就地向用户取得裁定，把具体结论写回该处正文后删除标记；"
                "不得靠删除整段待确认内容通过校验"
            )
        if has_source_section(content):
            section_errors, section_warnings = split_source_reference_section(content)
            errors.extend(section_errors)
            warnings.extend(section_warnings)
            source_ids = {
                reference.source_id
                for reference in extract_source_references(content)
            }
            if source_ids:
                source_errors, source_warnings = validate_source_context(
                    feature_dir, source_ids
                )
                errors.extend(source_errors)
                warnings.extend(source_warnings)

    if not draft:
        _check_done_checkpoint(record, contract, warnings)

    if errors:
        return _fail(
            "prd 阶段产出物校验未通过",
            {"feature": slug, "errors": errors, "warnings": warnings},
        )
    return _ok("prd 阶段产出物校验通过", {"feature": slug, "warnings": warnings})


def main(argv: Optional[List[str]] = None) -> int:
    raw_args = list(sys.argv[1:] if argv is None else argv)
    if contains_workspace_argument(raw_args):
        print(BIZ_VALIDATE_WORKSPACE_ARGUMENT_ERROR, file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser(description="autobiz 统一校验脚本")
    parser.add_argument(
        "stage",
        choices=["prd"],
        help="校验阶段",
    )
    parser.add_argument("--feature", "-f", default=None, help="feature slug（如不传则自动检测）")
    parser.add_argument("--json", action="store_true", help="仅输出 JSON，不输出可读文本")
    parser.add_argument(
        "--draft",
        action="store_true",
        help="只校验产物结构，跳过 checkpoint 提示；产物成型过程中可随时自检",
    )
    args = parser.parse_args(raw_args)

    try:
        workspace = get_plugin_output_workspace()
    except ValueError as exc:
        print(f"biz_validate.py 校验失败: {exc}", file=sys.stderr)
        return 1

    if args.stage == "prd":
        result = validate_prd(args.feature, workspace, draft=args.draft)
    else:
        result = _fail("未知 stage")

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        status = "通过" if result["ok"] else "未通过"
        print(f"[{status}] {result['message']}")
        if "feature" in result:
            print(f"   feature: {result['feature']}")
        for err in result.get("errors", []):
            print(f"   - {err}")
        warnings = result.get("warnings") or []
        if warnings:
            print(f"   提示（不阻断，共 {len(warnings)} 条）:")
            for warning in warnings:
                print(f"   ~ {warning}")

    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
