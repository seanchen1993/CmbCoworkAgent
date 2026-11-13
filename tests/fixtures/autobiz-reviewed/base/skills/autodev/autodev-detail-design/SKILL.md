---
name: autodev-detail-design
description: Autodev dynamic detailed design node.
version: v1.2.08311
---

# /autodev-detail-design - 详细计划

本 skill 只回答：

- 本次实现预计新增、修改或删除哪些文件。
- 每个文件的改动逻辑是什么。
- 模块之间如何调用。
- 接口、数据、状态和异常流程如何串起来。
- 后续编码时应重点遵守哪些设计约束。

本 skill 不做：

- 不修改业务代码、测试代码、配置、迁移脚本或已有阶段产物。
- 不重写 `proposal.md`、`specs/**/*.md`、`design.md`、`PLAN.md`。

输出产物：

- ${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/DETAIL_DESIGN.md

## 准入与上下文

读取当前 Feature 快照判断是否已进入本动态节点：

```
python -X utf8 "${pluginPath}/read_state_json.py" --feature "${feature}"
```

每次需要当前 checkpoint 时，运行上面的脚本读取，不得从 `hooks.ndjson` 等其他文件推断。

如当前 checkpoint 仍为 `plan_done` 且用户选择需要详细设计，先使用统一状态脚本启用 dynamic stage 并进入本节点：

```
python -X utf8 "${pluginPath}/hooks/update_checkpoint.py" --checkpoint detail_design_in_progress --workflow-decision detail_design_before_code=enabled
```

读取动态节点输入产物：

```
python -X utf8 "${pluginPath}/hooks/inspect_skill_contract.py" autodev-detail-design --feature "${feature}" --plain
```

读取输入：

- 按需读取proposal.md、specs/**/*.md、design.md、PLAN.md（如有）。
- 与本 Feature 相关的现有业务代码、测试、配置和接口定义

本 skill 不补写上游产物。

## 工作原则

- **扎根代码现实。** 文件清单必须来自实际代码探索、PLAN.md 任务、design.md 决策和现有项目结构，不要凭空发明路径。
- **比 PLAN 更具体，但仍不编码。** 可以写文件级改动说明、伪代码、流程图和调用链；不得直接改实现文件。
- **保留不确定性。** 无法确认的文件路径、接口字段、权限、数据模型、状态流可以与用户确认，不要写成硬结论。
- **面向读者。**DETAIL_DESIGN.md 是给用户和后续编码者读的，应清楚说明“为什么改这里、怎么改、怎么流转、怎么验证”。
- **按动态节点推进流程。** 完成后必须调用 update_checkpoint.py 推进到 `detail_design_done`。

## 生成 DETAIL_DESIGN.md

建议结构如 ${pluginPath}/skills/autodev/autodev-detail-design/reference/template.md

## 完成条件

- `${feature}/DETAIL_DESIGN.md` 已写入。
- 文件改动清单覆盖 `PLAN.md` 中所有待编码任务，或明确说明某任务无需文件改动。
- 每个文件级改动都能追溯到 specs、design 或 PLAN.md。
- 仍不确定的路径、字段、接口、权限、数据或状态流已标为待确认。
- 已调用 `python -X utf8 "${pluginPath}/hooks/update_checkpoint.py" --checkpoint detail_design_done`，且未修改业务代码。

技能完成后，读取并遵循 `${pluginPath}/skills/references/ui-continuation-guide.md`。
