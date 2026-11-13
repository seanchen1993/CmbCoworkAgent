---
name: autodev-design
description: Dev 阶段技术设计生成与定稿。
version: v1.1.0905
---

# /autodev-design - Technical Design

本技能只负责探索、澄清、生成并定稿 `design.md`，并生成与其一致的 `.design-contract.lock.json`。

进入本技能时先使用 `write_todos` 建立任务清单：`探索澄清` / `生成 design.md` / `裁定未决项并校验设计` / `锁定设计契约并推进 design_done`。

## 探索与准入

先读取当前 Feature 状态、上游产物和相关代码现实：

```bash
python -X utf8 "${pluginPath}/read_state_json.py" --feature "${feature}"
```

- 读取 `proposal.md`、`specs/**/*.md`、`UI_CONTEXT.json`、已有 `design.md`（如有），以及相关代码、测试、配置和接口定义。
- 探索只用于澄清和调查，不得修改业务代码、测试、配置或迁移脚本。
- 将需求目标、范围、非目标、现有代码约束、集成点、接口、数据模型、验证边界与用户讨论。未确认且影响实现路径的事项不得自行假设。
- 稳定 ID：Requirement `REQ-001`、Scenario `SCN-001`、API `API-001`、Data `DATA-001`、技术决策 `D-001`。`D-NNN` 是本阶段输出的技术决策；规格决策 `DEC-001` 仅来自 proposal 中可选的 `## Decision Log`，本阶段只引用、不新增 `DEC-NNN`。没有规格决策时追踪表的 Decision 写「无」。
- 如果新增或改变可观察行为，写进 `design.md`。
- 回检发现缺失或矛盾的 REQ/SCN（例如某能力没有行为契约）时，立即停止并向用户询问；按照用户回答更新对应产物。

探索足以支持设计时，先给出目标、影响范围、已确认事实、待确认事项和代码证据的简短结论，再使用 `request_user_input` 询问是否进入设计生成。按 `${pluginPath}/skills/references/ask-user-question.md` 执行：未拿到明确答复前，不得写入 `design_in_progress` 或生成 `design.md`。用户直接补充实质信息时吸收后继续探索，不机械重复同一选择。

用户确认后进入本节点：

```bash
python -X utf8 "${pluginPath}/hooks/update_checkpoint.py" --checkpoint design_in_progress --stage "技术设计（来源: Specs）"
```

## 生成 design.md

在 `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/design.md` 生成稳定技术设计契约。使用 `${pluginPath}/skills/autodev/autodev-design/templates/design.md` 的结构；行为契约仍以 `specs/**/*.md` 为准。

至少包含以下真实内容：

- **Context / 输入上下文**：proposal、specs、UI 范围、现有代码和约束。
- **Code Evidence**：实际打开的代码、测试或配置锚点；不能凭印象写路径。
- **Spec Traceability**：Requirement / Scenario 与设计覆盖关系。`Decision` 列只引用 `DEC-NNN`，`Design Coverage` 列使用 `D-NNN`。
- **API Decisions**：无 HTTP/API 时写 `x-auto-no-http-api: true` 和原因；有 API 时记录入口、请求、响应、错误、Auth/Tenant/Audit 和确认状态。
- **Data Decisions**：无数据变更时写 `x-auto-no-sql: true` 和原因；有数据变更时记录模型、字段、索引、迁移、回滚与状态。
- **Technical Design**：模块边界、技术决策、备选方案、集成点和验证思路。每个 `D-NNN` 必须被后续任务真正引用；不要按任务编号机械生成 `D-NNN`。
- **Risks / Open Questions**：明确风险、信息缺口和其影响，不能把会改变实现路径的未知事项留给下一阶段。

不得把未确认的接口字段、数据约束或外部依赖写成硬约束。不要写「实现时再决定」「以实际接口为准」等延后占位语。

## 未决项裁定

展示设计的 API / Data / Technical Design / Risks 关键内容后，只裁定真正未决的条目；裁定完成后直接进入产物校验。

### 待确认项逐条裁定

- 范围为 Status/Type 为「待确认」或「读码差异」的 API / DATA / D / R 条目；没有时直接进入产物校验。
- 裁定即消解：对应行必须回写为「已确认」，且采纳的方案、链接、字段或约束已经写入设计实体；信息实体必须先落盘再标记确认。声称拥有 ≠ 提供。
- 用 `request_user_input` 逐条提问，每轮最多 3 项；选项只能是「按当前设计确认 (Recommended)」「采纳备选：<具体方案>」「需要调整」以及信息缺口型条目的「调整设计移除该依赖」「暂停，拿到材料后继续」。
- 信息缺口型条目中，用户在「其他」提供实体后，立即写入 design.md 再回写「已确认」。不存在「先假设 / 先按默认方案 / 先占位」后推进的出口，不得以任何措辞重新引入。
- 选项 label 或 description 不得含「待确认」「先占位」「后续补充」「稍后提供」「编码阶段再」等延后语义；探索期的「后续补充并继续」模板禁止搬进裁定门。
- 展示不等于裁定。全部条目逐条裁定后做消解自查：design.md 不得再含待确认、读码差异、TBD、待补充、待提供、占位或对缺失材料的引用；否则继续裁定，不能进入产物校验。

未决项全部消解后，`design.md` 即为下一阶段的只读事实源。锁定后 `.design-contract.lock.json` 是 Plan 的机器读取快照，包含 Design 已校验的 SHA、API/DATA/D ID 与 no-API/no-SQL 标记。

```bash
python -X utf8 "${pluginPath}/hooks/design_contract_lock.py" sync --feature "${feature}"
python -X utf8 "${pluginPath}/hooks/stage_gate.py" validate --stage dev.design --feature "${feature}"
```

读取全部失败项，按返回的 `artifact` / `target` / `problem` / `action` / `route` 一次性修复；`ask_user` 必须回到用户确认。通过前不得推进 checkpoint。

## 回检与完成

按 `${pluginPath}/skills/references/review-protocol-design.md` 派发 `critic-autodev-design-zh` 回检：必须先读取并完整遵循该文件，不得凭记忆执行本节。

回检导致设计变化时，重新完成受影响的未决项裁定、重新锁定设计契约并重跑产物契约预检（机器校验）。完成后立即调用统一 checkpoint 更新脚本推进 `design_done`；不得自行增加文本确认或绕过该命令。项目会话会在这条命令执行前由平台触发 Human Gate，Auto 托管会话须等用户在该门禁中批准后再进入下游阶段：

```bash
python -X utf8 "${pluginPath}/hooks/design_contract_lock.py" sync --feature "${feature}"
python -X utf8 "${pluginPath}/hooks/stage_gate.py" validate --stage dev.design --feature "${feature}"
python -X utf8 "${pluginPath}/hooks/update_checkpoint.py" --checkpoint design_done
```

技能完成后，读取并遵循 `${pluginPath}/skills/references/ui-continuation-guide.md`。
