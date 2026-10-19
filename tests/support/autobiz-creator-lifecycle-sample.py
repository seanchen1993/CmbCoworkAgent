"""Real backend-only sample inputs; never writes workflow state or check receipts.

Called against a private copy of the selected plugin. All structural materialization
uses that plugin's original writers. Code implementation/test/evidence is separate.
These are controlled sample deliverables, not assertions of model quality.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def prepare(plugin: Path, workspace: Path, feature: str, action: str) -> dict:
    sys.path.insert(0, str(plugin))
    base = workspace / ".autobizdevops/features" / feature
    if not base.is_dir():
        raise ValueError("original_feature_initialization_required")
    if action == "metadata":
        from board_core.contracts import load_record_workflow_contracts
        record = json.loads((workspace / ".autobizdevops/state.json").read_text("utf-8"))["features"][feature]
        contracts = load_record_workflow_contracts(plugin, record, workspace=workspace)
        return {"checkpoint": record["checkpoint"], "nodes": [node["id"] for node in contracts.nodes],
                "skills": [{"skill": skill, "checkpoints": list(contract.checkpoints)}
                           for skill, contract in contracts.skill_contracts.items()]}
    if action == "prd":
        from hooks.implementation_scope import write_scope
        from hooks.ui_context_writer import main as ui_writer
        write(base / "PRD.md", """# 需求摘要

## 当前实现范围
- 实现范围：backend_only
## 1.需求概述
### 1.1.背景、痛点、改进思路及价值
演示两个可独立实现和验证的后台计算能力，保护输入知识和原流程检查。
## 2.需求解析
### 2.6. 功能清单
| 类型 | 功能名称 | 功能描述 |
| --- | --- | --- |
| 新增 | cap | 对整数加一 |
| 新增 | next | 对整数乘二 |
#### 2.6.1. 功能详情
##### FR1: 整数计算
###### 验收标准
输入2时，加一得到3，乘二得到4；负数同样按整数运算。
### 2.7. 外部资料与实现约束
无
## 当前已确认结论
使用两个独立Python函数与真实本地测试。
## 问题清单与处理状态
| 序号 | 重要性 | 检查项 | 处理状态 |
| --- | --- | --- | --- |
| 1 | P2 - 优化建议 | 执行边界 | 已确认仅本地样本 |
## 待确认事项
无（本轮已全部消解）。
## 假设与风险
本样本不代表企业业务认可或远程模型生成质量。
## 历次讨论记录
2026-10-17：受控验收确定后台计算范围。
## 讨论补充资料
采用已装载的本地知识来源。
""")
        write_scope(base, "backend_only", source="user_confirmed")
        code = ui_writer(["init", "--workspace", str(workspace), "--feature", feature])
        if code != 0:
            raise ValueError("original_ui_context_writer_rejected_sample")
    elif action == "specs":
        from hooks.ui_context_writer import main as ui_writer
        if not (base / "PRD.md").is_file():
            raise ValueError("missing_prd_input")
        write(base / "proposal.md", """# Proposal: 本地计算能力
## Why
以可观察的小型后台能力验证模块组合。
## What Changes
增加加一和乘二函数，分别交付和测试。
## Capabilities
### New Capabilities
- `cap`: 整数加一。
- `next`: 整数乘二。
### Modified Capabilities
- 无
### Removed Capabilities
- 无
## Impact
仅受控本地计算仓库。
## Out of Scope
不访问企业服务。
## Decision Log
以真实本地测试验证。
## Open Questions
无。
""")
        for name, number, behavior in (("cap", "001", "输入2返回3，输入-1返回0"),
                                      ("next", "002", "输入2返回4，输入-1返回-2")):
            write(base / f"specs/{name}/spec.md", f"""# {name}
## ADDED Requirements
### Requirement REQ-{number}: 整数计算
#### Scenario SCN-{number}: 正数和负数计算
- **WHEN** 调用本地计算函数
- **THEN** {behavior}。
""")
        for operation in ("confirm", "lock"):
            if ui_writer([operation, "--workspace", str(workspace), "--feature", feature]) != 0:
                raise ValueError("original_ui_context_confirmation_failed")
    elif action == "design":
        from hooks.design_contract_lock import sync_design_contract_lock
        if not (base / "specs/cap/spec.md").is_file() or not (base / "specs/next/spec.md").is_file():
            raise ValueError("missing_specs_input")
        write(base / "design.md", """# Design: 本地计算
## Context / 输入上下文
读取proposal及cap/next规格，保留知识中的负数测试要求。
## Code Evidence
新增cap.py和next.py；两个模块独立，无共享可变状态。
## Spec Traceability
REQ-001/SCN-001对应加一；REQ-002/SCN-002对应乘二。
## API Decisions
x-auto-no-http-api: true
无HTTP接口。
## Data Decisions
x-auto-no-sql: true
无数据库。
## Technical Design
| ID | Decision |
| --- | --- |
| D-001 | 纯Python整数函数，各模块独立测试，合并后执行联合测试。 |
## Risks / Open Questions
仅验证受控样本；无外部副作用。
""")
        result = sync_design_contract_lock(workspace, feature)
        if not result.ok:
            raise ValueError(json.dumps(result.errors, ensure_ascii=False))
    elif action == "cicd":
        evidence = base / "evidence/EVIDENCE.jsonl"
        if not evidence.is_file() or not evidence.stat().st_size:
            raise ValueError("real_code_evidence_required")
        write(base / "CICD_CHECKLIST.md", "# 本地交付检查\n已执行两模块及合并后的本地测试；证据引用evidence/EVIDENCE.jsonl。\n")
        write(base / "PR_BODY.md", "# 受控计算交付\n两个独立worktree实现并合并，原检查和知识边界保持。\n")
    else:
        raise ValueError("unsupported_sample_step")
    return {"prepared": action, "feature": feature, "stateWritten": False,
            "checksApproved": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["metadata", "prd", "specs", "design", "cicd"])
    parser.add_argument("--plugin-root", required=True, type=Path)
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--feature", required=True)
    args = parser.parse_args()
    result = prepare(args.plugin_root.resolve(strict=True), args.workspace.resolve(strict=True),
                     args.feature, args.action)
    print("SAMPLE_RESULT=" + json.dumps(result, ensure_ascii=False))
