#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""UI 专用：以参数方式定位并跳过工作流节点（不依赖环境变量）。

看板 UI 在对话/skill 上下文之外触发节点跳过，没有 PLUGIN_WORKSPACE /
PROJECT_DIR / FEATURE_ID 环境变量，因此通过 --plugin-workspace / --project /
--feature 三个参数显式定位（分别镜像那三个环境变量）。底层跳过逻辑与状态写入
复用 update_checkpoint.py 的现成函数，本脚本只负责参数式入口。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.paths import get_plugin_output_workspace  # noqa: E402
from hooks.update_checkpoint import (  # noqa: E402
    prepare_skip_update,
    write_result_json,
    write_skip_hook_logs,
)
from board_core.state_store import write_state_records  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="UI 直调：跳过工作流节点（参数式定位，不依赖环境变量）",
        allow_abbrev=False,
    )
    parser.add_argument(
        "--plugin-workspace",
        required=True,
        help="项目集合工作区路径（对应 PLUGIN_WORKSPACE 环境变量）",
    )
    parser.add_argument(
        "--project",
        required=True,
        help="项目目录名（对应 PROJECT_DIR 环境变量）",
    )
    parser.add_argument(
        "--feature",
        "-f",
        required=True,
        help="feature slug（对应 FEATURE_ID 环境变量）",
    )
    parser.add_argument(
        "--skip-node",
        action="append",
        default=[],
        required=True,
        help="要跳过的工作流节点 id（如 dev.code）；可重复",
    )
    parser.add_argument("--dry-run", action="store_true", help="只校验不写入")
    parser.add_argument(
        "--json",
        dest="json",
        action="store_true",
        default=True,
        help="输出 JSON 结果（默认开启，前端直调使用）",
    )
    parser.add_argument(
        "--no-json",
        dest="json",
        action="store_false",
        help="改为输出人类可读文本（默认 JSON）",
    )
    args = parser.parse_args(list(sys.argv[1:] if argv is None else argv))

    try:
        workspace = get_plugin_output_workspace(
            env={
                "PLUGIN_WORKSPACE": args.plugin_workspace,
                "PROJECT_DIR": args.project,
            }
        )
    except ValueError as exc:
        print(f"skip 失败: {exc}", file=sys.stderr)
        return 0

    feature = args.feature.strip()
    if not feature:
        print("skip 失败: --feature 不能为空", file=sys.stderr)
        return 0

    result = prepare_skip_update(
        workspace=workspace,
        feature=feature,
        skip_nodes=args.skip_node,
    )

    if args.json:
        write_result_json(
            result,
            feature=feature,
            checkpoint=result.new_checkpoint or "",
            dry_run=args.dry_run,
            skip_nodes=args.skip_node,
            errors_as_message=True,
        )
    elif not result.ok:
        print("skip 失败:", file=sys.stderr)
        for error in result.errors:
            print(f"  - {error}", file=sys.stderr)
    elif args.dry_run:
        print(
            f"DRY_RUN skip: feature={feature} nodes={','.join(args.skip_node)} "
            f"checkpoint={result.new_checkpoint}"
        )
    else:
        print(
            f"workflow nodes skipped: feature={feature} nodes={','.join(args.skip_node)} "
            f"checkpoint={result.new_checkpoint}"
        )

    if not result.ok:
        if not args.dry_run:
            write_skip_hook_logs(result, workspace=workspace, feature=feature, skip_nodes=args.skip_node)
        return 0
    if not args.dry_run:
        write_state_records(workspace, result.records)
        write_skip_hook_logs(result, workspace=workspace, feature=feature, skip_nodes=args.skip_node)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
