"""Controlled local order requirements, never workflow state, SQL output or gate receipts."""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

sample_spec = importlib.util.spec_from_file_location(
    "autobiz_order_lifecycle_sample", Path(__file__).with_name("autobiz-creator-lifecycle-sample.py")
)
if sample_spec is None or sample_spec.loader is None:
    raise RuntimeError("original_lifecycle_input_sample_unavailable")
sample = importlib.util.module_from_spec(sample_spec)
sample_spec.loader.exec_module(sample)


def inputs(plugin: Path, workspace: Path, feature: str, step: str) -> dict:
    # Reuse the existing sample's original scope/UI writers and complete document shape.
    # This helper only authors input documents. Original hooks decide whether they pass.
    result = sample.prepare(plugin, workspace, feature, step)
    base = workspace / ".autobizdevops/features" / feature
    replacements = {
        "两个可独立实现和验证的后台计算能力": "本地五行订单的数仓模型、SQLite转换和独立质量对账",
        "对整数加一": "订单按order_id保留明细，金额按CNY整数分处理",
        "对整数乘二": "按有效订单日期汇总，paid/completed有效，cancelled排除",
        "整数计算": "订单数仓",
        "输入2时，加一得到3，乘二得到4；负数同样按整数运算。":
            "使用用户明确授权的本地五行订单样例；DWD保留5行；有效订单4行、43575分；cancelled不计入DWS。",
        "使用两个独立Python函数与真实本地测试。":
            "使用原warehouse Mods运行SQLite和独立只读质量检查；业务确认needs_review，生产未验收。",
        "本地计算能力": "本地订单数仓",
        "以可观察的小型后台能力验证模块组合。": "以明确的订单CNY口径和实际SQLite消费验证模块组合。",
        "增加加一和乘二函数，分别交付和测试。": "组合模型、SQL执行、质量Mod，逐步读取真实上游产物。",
        "整数加一": "订单明细",
        "整数乘二": "有效订单汇总",
        "输入2返回3，输入-1返回0": "保留全部5条订单，按order_id粒度，整数分金额",
        "输入2返回4，输入-1返回-2": "paid/completed共4条、43575分，排除cancelled，按日期汇总",
    }
    documents = [base / "PRD.md", base / "proposal.md", *sorted((base / "specs").glob("**/*.md"))]
    for path in documents:
        if not path.is_file():
            continue
        text = path.read_text("utf-8")
        for original, replacement in replacements.items():
            text = text.replace(original, replacement)
        path.write_text(text, encoding="utf-8", newline="\n")
    return {**result, "inputScope": "explicit_local_five_order_CNY_sample",
            "stateWritten": False, "checksApproved": False, "businessAcceptance": "needs_review"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plugin-root", required=True, type=Path)
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--feature", required=True)
    parser.add_argument("--step", required=True, choices=["prd", "specs"])
    args = parser.parse_args()
    print(json.dumps(inputs(args.plugin_root.resolve(strict=True), args.workspace.resolve(strict=True),
                            args.feature, args.step), ensure_ascii=False))
