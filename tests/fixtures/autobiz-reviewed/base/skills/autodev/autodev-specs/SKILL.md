---
name: autodev-specs
description: 将需求转为 proposal 与按能力拆分的行为规格，供后续设计、计划和验收使用。
version: v1.18.0917
---

# /autodev-specs — Proposal + Behavior Specs

本阶段回答为什么做、系统应表现为什么行为，只生成 `proposal.md` 和 `specs/<capability>/spec.md`。

产物目录：`${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/`。

## 读取与澄清

- 读取 `PRD.md`和相关代码、接口、测试。没有 PRD 时以用户需求为输入。
- 存在 `source-context.json` 时，读取其中登记的资料及对应 `sources/SRC-NNN/` 快照；已保存的资料即认为用户已经提供。
- 读取 `IMPLEMENTATION_SCOPE.json`：`backend_only` 只描述后端可实现、可验证的行为；`frontend_only` 只描述前端行为，后端作为外部依赖；缺失时兼容为 `full_stack`。
- 仅澄清影响行为、范围或验收结果的缺口与矛盾，按 `${pluginPath}/skills/references/ask-user-question.md` 提问。复用用户已确认的信息，不重复确认；不能把未确认的关键行为写成定论。
- 对齐后的领域术语按 `${pluginPath}/skills/references/domain-context.md` 回写会话工作区 `CONTEXT.md`。

开始生成时更新状态：

```bash
python -X utf8 "${pluginPath}/hooks/update_checkpoint.py" --checkpoint specs_in_progress
```
## Explore 协议

进入探索模式。先把需求、现状、隐性约束和行为边界想清楚，再生成 specs。

使用 task 工具，指定 Explore-autodev-spec 角色进行探索。子代理按下面的要求生成子代理提示语。

探索时必须：

- 从PRD.md提取目标、用户角色、主流程、验收标准、非目标。
- 从 `source-context.json` 提取全部 `SRC-NNN`。`snapshot_only` 使用已保存快照，不重新索取；只有 `never_provided` 且影响行为时才列入信息缺口。
- 阅读现有代码，识别与需求相关的已有接口、数据模型。
- 将PRD.md改写为外部可观察行为，不要把实现猜测写成需求。
- 识别 capabilities：一组可以独立命名、独立验收的能力边界，例如 `order-export`、`approval-reminder`。
- 与用户对齐了术语或规范代码名时，按 `${pluginPath}/skills/references/domain-context.md` 当场回写会话工作区 `CONTEXT.md`；只收已对齐术语。

接口/数据决策讨论触发：

- 如果新增或修改 HTTP/API、函数入口、请求响应、错误码，但接口形态在你看来从PRD.md中还不准确形成，生成待讨论项目返回主代理。
- 如果涉及表、字段、状态、枚举、索引、唯一约束、迁移、回滚、数据保留、历史兼容，但数据语义还不准确，生成待讨论项目返回主代理。
- 生成待讨论问题时只提出影响实现路径或验收结果的关键问题，并给出当前建议、备选方案和影响面；不要机械问卷。

探索结束时先生成待确认问题清单。PRD.md中的「待补充」「待提供」「后续给出」如影响行为契约，逐项列入；无待确认项时写「无」并继续生成产物。
```

## 生成 proposal 与 specs

先确定 capability 清单，再按proposal 模板(${pluginPath}/skills/autodev/autodev-specs/templates/proposal.md) 和 spec 模板(${pluginPath}/skills/autodev/autodev-specs/templates/templates/spec.md) 生成产物。

- proposal 默认写 Why、What Changes、Capabilities、Impact；影响面基于实际调研。Capabilities 使用 `- capability-name: 说明` 列表，名称为 kebab-case，与 `specs/<capability>/spec.md` 双向对应。
- 非目标、关键取舍、问题记录和来源引用按需添加，没有内容直接省略。关键行为决定落实到 Requirement/Scenario；需要供设计引用的取舍可在 `## Decision Log` 下使用 `### DEC-NNN: 标题`，已有 DEC 引用保持稳定。
- 每个 capability 一个 spec，只描述可验证的外部行为，不写实现步骤、类名、SQL 或任务拆分。
- Requirement 使用 `### Requirement REQ-NNN: 标题`；其所属 Scenario 使用 `#### Scenario SCN-NNN: 标题`，说明 WHEN 触发条件和 THEN 预期结果。
- REQ/SCN 使用三位数字，在同一 feature 内分别全局唯一；新编号使用未占用值，既有编号不重排、不复用。
- 每条 Requirement 至少一个 Scenario。覆盖需求涉及的角色、主流程及有意义的异常和权限分支；相同行为不为不同角色重复抄写。
- `ADDED / MODIFIED / REMOVED Requirements` 章节按需使用，无内容省略。修改写完整的新行为；移除描述旧入口触发时的预期响应，必要时说明原因及兼容方式，不要求固定字段。
- 外部资料影响实现或验收时，在对应 spec 添加 `## Source References / 外部资料引用` 表，将稳定 `SRC-NNN` 映射到受影响的 `REQ-NNN / SCN-NNN`；Plan 会据此自动把资料快照投影给相关 Task。仅作背景且不约束任何行为的资料可以不映射，不为凑表重复需求。

## UI 上下文

保留 `UI_CONTEXT.json` 作为前端范围事实源，按 `${pluginPath}/skills/autobiz/references/ui-context.md` 维护。缺失时依据已确认范围补齐，不从关键词猜测前端范围。

- 生成或修改统一使用 `${pluginPath}/hooks/ui_context_writer.py`。
- `uiRequired=true` 时至少有一个独立 UI capability，其 `specRefs` 回链真实 REQ/SCN；有高保真输入才绑定真实 VIS，无则 `visualSourceRefs=[]`。
- `uiRequired=false` 时不生成 UI capability，并填写 `notApplicableReason`。
- specs 完成时锁定 UI 决策：`decisionStatus=locked`、`lockedAtCheckpoint=specs_done`。

## 检查与完成

按 `${pluginPath}/skills/references/review-protocol-specs.md` 核对需求覆盖、行为一致性和实现范围，修正明确遗漏；需要用户取舍的事项先澄清。

完成后推进状态：

```bash
python -X utf8 "${pluginPath}/hooks/update_checkpoint.py" --checkpoint specs_done
```

校验失败时按返回的产物与问题修复后重试且只重试一次；需要行为裁定的先问用户，不通过补空表或改状态词绕过问题。连续出现相同失败时报告具体阻塞，不重复尝试。

完成后简要汇报本轮工作与产物位置。

技能完成后，读取并遵循 `${pluginPath}/skills/references/ui-continuation-guide.md`。
