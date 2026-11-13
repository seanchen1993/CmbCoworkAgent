---
name: autodev-plan
description: 将已确认的需求与技术设计收敛为可调度的任务计划。
version: v3.0
---

# /autodev-plan — Delivery Plan

Plan 的职责是确定交付结果、仓库归属、真实依赖、主要实现要点和测试要点。它不提前指定实现文件、类/方法、测试命令、测试目录或 Batch 编号；这些由 Code、UTest 和 writer 在拥有真实代码上下文时决定。

## 开始

读取状态与当前 Feature 的 `proposal.md`、`specs/**/*.md`、`UI_CONTEXT.json`、`design.md`、`.design-contract.lock.json`。同时读取已有的 `IMPLEMENTATION_SCOPE.json`（含本期/后续分区）。仓库归属、复用能力或真实依赖不明确时，可定向查看相关代码；不要为了预测文件清单做全面探索。

首次发布前不要预读 writer、门禁或校验器源码来猜机器规则。正常输入只以本 skill、模板和上游产物为准；直接发布，让结构化错误指出具体契约缺口，再只检查与该错误对应的单一规则。不要把十多个插件源码文件的防御性预读变成 Plan 的常规成本。

```bash
python -X utf8 "${pluginPath}/read_state_json.py" --feature "${feature}"
python -X utf8 "${pluginPath}/hooks/inspect_skill_contract.py" autodev-plan --feature "${feature}" --plain
python -X utf8 "${pluginPath}/hooks/update_checkpoint.py" --checkpoint plan_in_progress --stage "执行计划"
```

## 唯一模型输入

模型只生成一份 `autodev.plan.v2`。完整模板在 `templates/task-groups.json`。每个 Task 只需要：

- `outcome`：一个用户或系统可观察的交付结果；
- `id`：唯一的 `TNNN`，不要求连续编号，数组顺序不表达依赖；
- `workspace`：仓库逻辑 ID，不是路径；单仓库可用 `default`，多仓库用 Git 根目录名，分别通过可重复的 `--code-workspace` 绑定真实路径；
- `dependsOn`：确实存在的前置交付；
- `refs.requirements`、`refs.scenarios`：上游行为引用；
- `sourceRefs` 不属于模型输入。对实现或验收有约束的外部资料，先在对应 Spec 的 `## Source References / 外部资料引用` 表把 `SRC-NNN` 映射到 REQ/SCN；writer 会把它投影到命中该行为的 Task。`source-context.json` 或快照缺失、资料从未提供时仍可发布，Code 会收到该资料的不可用状态而非假定内容；
- `refs.api` / `refs.design` / `refs.data`：仅在任务确实依赖相应设计时填写；`D-NNN` 只能写在 `refs.decisions`，表示它的主交付任务；
- `implementationPoints`：只列交付这个 `outcome` 所需的主要实现方向和边界，不写文件、类或方法；若其中一条本身可形成独立交付结果，就拆成另一个 Task；
- `testPoints`：只列证明同一个 `outcome` 的行为、边界或失败路径，不写测试命令或文件；若某项验证的是另一个可单独交付的能力，就拆成另一个 Task；同一行为的正常、边界、失败和权限分支应保留在一起；
- `verification.intent`：希望后续测试验证的行为；
- UI Task 才填写来自 `UI_CONTEXT.json` 的 `ui.pages`、`ui.interactions` 和 `ui.route`（只读页面的 interactions 可为空）；writer 按任务命中的全部 capability 自动投影 `visualSourceRefs` 并集。

不要预测实现文件、目录、方法、`writeSet`、`scope.paths`、`expectedFiles`、`nonGoals`、测试命令、命令 cwd、Batch、验收 ID、测试资产或 `PLAN.md`。实现要点和测试要点只说明目标与边界，不能伪装成文件或命令清单。已确认的公开 API 路径、协议名与业务数据字段可以引用，它们不等于锁定实现文件或方法。

场景引用仍必须逐条写成 `specs/<capability>/spec.md#SCN-NNN`；这是覆盖计算的机器事实。场景、API 或页面的数量不是拆分门槛，也不应成为合并理由。一个 Task 必须让 Code 交付一个连贯、可独立评审的行为变化，并让 UTest 用一条完整的验证叙事证明它；如果其中包含多个可分别交付的结果、分别服务不同交付能力的测试目标，或不属于同一行为边界的状态变化，就拆分。共享仓库、接口或页面不构成合并理由，且不按固定数量阈值拆分。

写 body 前，先用 `outcome`、`implementationPoints` 和 `testPoints` 做一次拆分判断：每个候选 Task 都应能用“触发条件 → 可观察结果”说明 `verification.intent`，可包含同一闭环必要的多个步骤。实现要点和测试要点是发现独立交付切片的证据，不是把多个切片打包进同一 Task 的清单。

写 body 前，先在本轮推理中列一张简短的决策归属矩阵：每个 `D-NNN` 选一个主交付 Task，按可观察行为的落点决定归属，而不是按它调用的接口决定。页面交互通常由前端任务负责；公共函数按实际职责归属，不能仅凭“公共”一词判定前后端；跨端协作的其他任务引用 API/Data/Scenario 即可，不重复占有同一个 `D-NNN`。

优先拆成小而完整的行为切片：同一页面的查询、修改、导出等可分别交付时分开；跨仓库必须分开；不要把整个子系统或多条状态流只包进一句笼统 outcome。即使只有一个总目标，若包含多个可单独评审和验证的业务子流程，也应按子流程拆开并写真实依赖。同一行为所需的接口、校验、持久化及失败处理可在同仓库的一项任务内完成；不能按文件、方法或每条测试断言机械拆分。具体例子见 `references/task-planning.md`。

`implementationPoints` 是实现指导，不是固定算法或步骤。Code 可以依据真实仓库调整内部实现、必要文件和局部步骤；保持已确认行为、公开契约、仓库归属与依赖，记录有意义的偏差即可。

## 生成、回检与发布

先提交完整输入，原子生成供 Critic 审查的 `plan.json` 与 Batch 计划；此时不得生成 `PLAN.md`：

```bash
python -X utf8 "${pluginPath}/hooks/plan_writer.py" prepare-plan \
  --feature "${feature}" \
  --code-workspace "<ACTUAL_CODE_WORKSPACE>" \
  --body-stdin
```

writer 负责验证引用、覆盖、Design ID、仓库绑定和 DAG，保留输入 Task ID，并生成 Batch 身份、运行时 workspace roots、验收记录、测试意图、外部资料投影与 Batch。生成失败时按结构化错误修正对应 Plan v2 字段；来源映射或上游契约有误时修对应上游；不要补造实现文件清单来通过校验。

对 `plan.json` 与它引用的 Batch 计划运行 Plan Critic。回检发现可修问题时，修正 Plan v2 输入后再次执行 `prepare-plan` 覆盖这份 review plan，再回检；不要直接编辑 writer 产物。此时 `plan.json.taskSetStatus=reviewing`，尚未定稿，因此不得触发 Plan rollback。

回检收敛且没有阻断项后，才将机器事实源 `plan.json` 原子定稿为 `finalized`，并投影其人类视图 `PLAN.md`：

```bash
python -X utf8 "${pluginPath}/hooks/plan_writer.py" publish-plan \
  --feature "${feature}"
```

`PLAN.md` 只是已定稿 `plan.json` 的人类视图，不能独立维护，也不承载计划状态。定稿后的 `plan.json` 若需求或计划需要变化，才通过 Plan rollback 回到 `plan_in_progress`，重新走“生成 JSON → Critic → 投影 Markdown”流程。依赖就绪的隔离工作树可乐观并行；真实文件冲突由 Merge Train 处理。

未出错且输入未变时不重复生成。已经执行的计划由 Code workflow 的受控恢复处理。

## 完成

Plan 回检检查：本期行为是否覆盖、任务归属和依赖是否可信、任务是否过大或碎片化，以及任务结果是否足够让 Code 结合上游契约实施。它不要求提前指定文件、方法、测试类或实现步骤。

运行「产物契约预检（机器校验）」只验证引用、覆盖、仓库绑定和 DAG 等机器事实；失败时修正对应 Plan v2 字段或上游映射，不增加实现细节来绕过校验。

回检协议在 `${pluginPath}/skills/references/review-protocol-plan.md`，必须先读取并完整遵循该文件，不得凭记忆执行本节。

```bash
python -X utf8 "${pluginPath}/hooks/stage_gate.py" validate --stage dev.plan --feature "${feature}"
python -X utf8 "${pluginPath}/hooks/update_checkpoint.py" --checkpoint plan_done
```

技能完成后，读取并遵循 `${pluginPath}/skills/references/ui-continuation-guide.md`。
