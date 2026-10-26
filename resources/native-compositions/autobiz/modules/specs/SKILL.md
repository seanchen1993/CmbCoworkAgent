---
name: autobiz-native-specs
description: 从PRD建立可独立验证的能力和行为规格
---

读取需求文件与 `PRD.bundle.json` 中的真实文档，保留来源、范围和验收约束。
输出 `SPECS.bundle.json`：`{feature,stage:"specs",files:{文件名:文本}}`。
包含 `proposal.md`、`specs/<kebab-case-capability>/spec.md` 及更新后的 `UI_CONTEXT.json`。
不要重写上游 PRD 或需求文件。

proposal 的 `## Capabilities` 下按 `- capability-name: 说明` 列出能力，与 specs 目录双向对应。
必要的规格决策在 `## Decision Log` 中用 `### DEC-001: 名称` 定义。
每份规格采用 `### Requirement REQ-001: 名称` 和其下的 `#### Scenario SCN-001: 名称`。
使用三位、任务内唯一的ID。每项要求必须有场景，每个场景必须位于所属要求之下，
覆盖正常、边界和失败情况，不用编号代替可观察的预期。

UI_CONTEXT 保持原范围，将 decisionStatus 设为 locked 并补齐实际 REQ/SCN 引用。
锁定是业务范围事实，不能冒充用户对设计成果的批准。校验失败按结构化原因修复；
不得省略能力、场景、UI范围或来源来使检查通过。

## 可直接核对的结构约束

files 的值必须都是文本。仅允许 proposal.md、UI_CONTEXT.json、`specs/<kebab-case-capability>/spec.md`；不要将 PRD、scope、source-context 或来源快照复制进本阶段 files，它们由原检查器从已固定 PRD bundle 合并读取。能力名必须由小写英文/数字和单短横线组成，不能中文目录、下划线、空格或多层目录。每个内层文本最多20000 UTF-8字节，整个 bundle 最多28000字节。

proposal 的 `## Capabilities` 必须是该字面标题，每个能力定义必须位于该节内、下一同级标题之前。`## Decision Log` 内的 `### DEC-NNN: ...` 才能被后续设计引用；没有规格决策时写“无”，不要生成假的决策来凑数。REQ 和 SCN 分别在整个任务全部 spec.md 中唯一，不能按能力从001重新编号。标题必须实际出现在正文，不用表格、列表、代码块包装代替；SCN 必须嵌套在所属 REQ 下，不能用新的 `##` 标题隔断。

下面只是语法示例，**不是当前需求或验收结论**。据真实 PRD 制定业务能力和各类场景，不能直接用示例覆盖需求：

<!-- autobiz-specs-proposal:start -->
```markdown
# 能力提案
## Capabilities
- example-capability: 结构示例能力
## Decision Log
### DEC-001: 结构示例决策
实际编写已确认的取舍、依据与影响。
```
<!-- autobiz-specs-proposal:end -->

<!-- autobiz-specs-document:start -->
```markdown
# 结构示例能力
## ADDED Requirements
### Requirement REQ-001: 结构示例要求
实际编写可观察的业务规则。
#### Scenario SCN-001: 结构示例场景
Given 明确前置状态 When 实际动作 Then 可独立验证的结果。
```
<!-- autobiz-specs-document:end -->

UI_CONTEXT 沿用 PRD 的 version/featureId、真实 UI 决策及页面/交互/视觉资料。只有 decisionStatus 改为 locked 并补真实引用，不创建新的 UI 范围。若原 uiRequired=false 且四个数组为空，保持空数组与原 notApplicableReason 即可锁定。若有 capability，**每一项**必须保留 pageRefs、interactionRefs（均为数组），specRefs 至少同时含一个实际 REQ 和一个实际 SCN；即使 capability.uiRequired=false 也适用。interaction 的 specRefs 若填写，同样同时含两类 ID 且都可解析；它可以省略。

锁定 UI 结构示例（所有示例 ID 必须按你的实际规格替换；不表示本插件 Code 已支持前端）：

<!-- autobiz-specs-ui-locked:start -->
```json
{"version":1,"featureId":"example-feature","uiRequired":true,"decisionStatus":"locked","decisionSource":"user_confirmed","pages":[{"pageId":"PAGE-001","name":"结构示例页面","goal":"结构示例目标"}],"interactions":[{"interactionId":"UIX-001","pageId":"PAGE-001","summary":"结构示例交互"}],"visualSources":[],"capabilities":[{"capabilityId":"example-capability","uiRequired":true,"pageRefs":["PAGE-001"],"interactionRefs":["UIX-001"],"visualSourceRefs":[],"specRefs":["specs/example-capability/spec.md#REQ-001","specs/example-capability/spec.md#SCN-001"]}]}
```
<!-- autobiz-specs-ui-locked:end -->
