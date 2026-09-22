"""Use the pinned upstream compiler and initializer, not hand-invented workflow data."""
import contextlib
import io
import json
import sys
from pathlib import Path

plugin, output = map(Path, sys.argv[1:3])
sys.path.insert(0, str(plugin))
from board_core.workflow_compiler import load_record_effective_board_config
from hooks.init_workspace import init_workspace, create_feature
from board_core.state_store import load_state_json_records, write_state_records

variants = {}
for template, profile, decision in [
    ("standard", profile, decision)
    for profile in ["standard", "frontend_before_specs"]
    for decision in ["", "enabled", "skipped"]
] + [("lean", "standard", "")]:
    record = {"workflowTemplate": template, "workflowProfile": profile}
    if decision:
        record["workflowDecisions"] = {"detail_design_before_code": decision}
    config = load_record_effective_board_config(repo_root=plugin, record=record)
    nodes = []
    for node in config["workflow"]["nodes"]:
        states = []
        for state in node.get("states", []):
            action = state.get("nextAction", {}) if isinstance(state, dict) else {}
            states.append({
                "nodeStatus": state.get("nodeStatus", state.get("id")),
                "nextAction": {"slashSkill": action.get("slashSkill", "")}
            })
        artifacts = {}
        for kind in ("inputs", "outputs"):
            artifacts[kind] = [
                {"path": item.get("path", ""), "required": item.get("required") is True}
                for item in (node.get("artifacts", {}).get(kind, []) or [])
                if isinstance(item, dict)
            ]
        nodes.append({
            "id": node.get("id"), "label": node.get("label"),
            "skill": node.get("skill"), "checkpoints": node.get("checkpoints", []),
            "states": states, "artifacts": artifacts, "validators": node.get("validators", [])
        })
    variants["|".join([template, profile, decision])] = nodes
target = plugin / "hooks" / "kanban" / "workflow.generated.ts"
target.write_text("// Generated from pinned upstream board_core compiler.\nexport const variants = " +
                  json.dumps(variants, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")

demo = output / "demo-project"
demo.mkdir()
with contextlib.redirect_stdout(io.StringIO()):
    init_workspace(demo)
    create_feature(demo, "order-export")
records, errors, exists = load_state_json_records(demo)
assert exists and not errors, errors
records["order-export"]["checkpoint"] = "requirements_eval_in_progress"
records["order-export"]["stage"] = "需求实现评审"
write_state_records(demo, records)
feature = demo / ".autobizdevops" / "features" / "order-export"
(feature / "specs" / "order-export").mkdir(parents=True, exist_ok=True)
for name, content in {
    "proposal.md": "# 演示提案\n订单导出应排除已取消订单并正确计算含税总额。\n",
    "design.md": "# 演示设计\nexportOrders 接受订单列表，输出编号与含税金额。\n",
    "PLAN.md": "# 演示计划\n- [x] 实现导出函数\n- [ ] 代码评审与真实测试尚未完成\n",
    "specs/order-export/spec.md": "# 演示规格\n仅导出 active 订单。含税金额 = amount * (1 + taxRate)。\n",
}.items():
    (feature / name).write_text(content, encoding="utf-8")
(demo / "src").mkdir()
(demo / "src" / "export-orders.ts").write_text(
    "// 演示缺陷：没有排除 cancelled；错误地相加税率。\n"
    "export function exportOrders(orders) {\n"
    "  return orders.map(o => ({ id: o.id, total: o.amount + o.taxRate }))\n}\n", encoding="utf-8")
(demo / "README.md").write_text(
    "# Mods 演示项目（合成业务数据）\n"
    "状态使用上游初始化器生成；为展示评审场景设为 requirements_eval_in_progress。\n"
    "文档是演示内容，不代表原 Python 语义门禁通过。\n"
    "打开本目录作为普通项目会话，运行 /kanban、/kanban-check order-export。\n"
    "可选 /kanban-review src/export-orders.ts 会调用你已配置的模型并产生用量。\n",
    encoding="utf-8")
print("Exported 7 upstream workflow variants and a synthetic demo project.")
