---
name: autodev-reviewer
description: 固定 Code Workflow 的内部 Review 协议。主 agent 写 completion-proposal.json，reviewer-autodev 核验真实仓库状态并落盘 REQUIREMENTS_EVAL.md；不是独立 Board 节点或 checkpoint。
version: v1.7.0917
---

## 缺失产物处理

```bash
python -X utf8 "${pluginPath}/hooks/inspect_skill_contract.py" autodev-reviewer --feature "${feature}" --plain
```


# Completion Reviewer

使用此技能来避免执行者自证完成。主 agent 负责写完成声明、按失败审查结论修复问题并重新发起审查；独立 reviewer 只负责用真实仓库状态核验声明并落盘需求评估。

reviewer 没有隐式用户对话上下文。所有可审查上下文必须来自 completion proposal、feature 目录产物（proposal.md、specs/**/*.md、design.md、PLAN.md、存在时的 PRD.md、source-context.json 与 sources/ 快照）、启动 prompt 和真实 repo 状态。跨仓库任务中，当前 workspace 是协调仓库，业务仓库由 proposal 的 `affected_repositories` 显式列出。

## 严格职责边界

| 角色                | 职责                                                         | 禁止                                                         |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 主 agent / Executor | 写 completion-proposal.json；启动 reviewer；FAIL 时修复 blockers 并重新 review；最后摘要 verdict | 在同一回合同时执行 reviewer 与 executor 角色；替 reviewer 改评估；未经重新 review 就宣称完成 |
| `reviewer-autodev`  | 通过 shell/git/read/search 独立核验 proposal；只允许写 `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/REQUIREMENTS_EVAL.md` | 修改源码、测试、配置、依赖、锁文件；运行任何写操作命令；修复问题 |

reviewer 的只读命令白名单、禁止清单、审查流程、finding 准入和 verdict 规则由 `reviewer-autodev` 角色自带，主 agent 不重复下发。如果 reviewer 无法用 shell/git 获取真实状态、无法访问 required 仓库或无法写报告文件，本次 review 不成立，verdict 记 `DEGRADED`。平台禁用 task 工具时允许主 agent 内联执行 reviewer 角色，但必须显式记录 `inline_main_agent` 模式并通过用户确认把 reviewer 与 executor 分隔到不同回合；不得把该模式包装成独立 review。

## 执行步骤

### 1. 准入
```bash
python -X utf8 "${pluginPath}/read_state_json.py" --feature "${feature}"
```

读取 Feature 状态；每次需要当前 checkpoint 时，运行上面脚本读取，不得从 `hooks.ndjson` 等其他文件推断。


只能在固定 Code Workflow 已启动当前 Batch 的 `review` 子阶段后开始审查。全局 checkpoint 保持 `code_in_progress`；不得创建 `requirements_eval_in_progress` 或 `requirements_eval_done`。

### 2. 写 completion proposal

按 references/schemas.md 创建 `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/completion-proposal.json`，描述任务、规格输入、受影响仓库、改动、声称的验证、已知限制和未完成事项。两个输入入口：

- **PRD**：Feature 目录存在 `PRD.md` 时，无论用户是否在当前回合再次点名，都必须自动写入 `prd_references`；用户另外提供的 PRD 路径也逐项原样写入，支持多个。所有路径只记录文件位置与说明，不用主 agent 摘要替代原件。Feature PRD 的 `外部资料与实现约束` 是 reviewer 的强制来源索引，不因 specs 只保留 WHAT 而降级为可选背景；Feature PRD 不存在且用户也未提供时才写空数组。
- **来源上下文**：存在 `source-context.json` 时，读取其中登记的资料及对应 `sources/` 快照。与本次评审相关的 `SRC-NNN` 出现在 `REQUIREMENTS_EVAL.md` 的来源契约证据或 finding 中；`snapshot_only` 直接以快照为准。
- **跨仓库**：跨仓库任务必须写 `affected_repositories`（字段规则和示例见 references/schemas.md），且 `files_changed` 每项带 `repository_id`；单仓库任务省略，reviewer 会把当前 cwd 当作唯一仓库。用户主动输入的仓库必须以 `source: "user_input"` 记录并转写依据到 `source_evidence`。

### 3. 启动 reviewer 角色

先检查当前平台是否提供 task 工具，然后二选一执行：

- **`independent_task`**：task 工具可用时，使用 task 工具指定 `reviewer-autodev` 角色。reviewer 返回后，主 agent 在同一回合继续执行第 4 步。
- **`inline_main_agent`**：task 工具被平台禁用或不可用时，主 agent 读取 `${pluginPath}/agents/reviewer.md`，按其审查流程切换为 source-read-only reviewer 角色内联完成审查。`REQUIREMENTS_EVAL.md` 落盘后必须停止当前回合，明确告知用户本次为主 agent 内联 review，并请用户确认是否切回 executor 角色继续。未获得确认前，不得在同一回合读取 verdict 分支、修复问题或推进 checkpoint。

审查流程、只读边界、finding 准入和 verdict 规则由角色自带，task prompt 不要粘贴角色指令，只附带：

- `Feature directory:` `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}`。
- `Review execution mode:` `independent_task` 或 `inline_main_agent`。
- `Stage contract:` Review 位于 Code 之后、UTest/E2E 之前；PLAN 中 TASK 的 `testPoints` 与 `verificationIntent` 是下游生成测试代码时的验证意图。reviewer 不执行这些命令，也不生成测试命令，不检查目标测试目录或测试文件是否存在，不因测试资产尚未生成将其记为验证错误、`test_gap`、`requirement_gap` 或 `unfinished_work`，也不形成 blocker、warning 或交给 executor 修复。只核对验证意图是否完整对应 specs 的 Requirement / Scenario。completion proposal 声称已执行的测试、lint、build 仍必须核验真实证据。
- `PRD references:` completion proposal 中的 Feature PRD 与用户提供 PRD 路径列表；没有则写 none。
- `User repository references:`（可选）仅当流程需要 reviewer 核对用户主动输入的仓库是否被 proposal 遗漏时附带；否则省略，reviewer 只以 proposal 和真实仓库状态为依据。

reviewer 自己通过工具获取真实仓库状态并直接写 `REQUIREMENTS_EVAL.md`；不要替它预生成 diff snapshot 或规格摘要。

### 4. 读取 verdict 并分支

`independent_task` 返回后，或 `inline_main_agent` 在后续回合获得用户明确确认后，主 agent 读取 `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/REQUIREMENTS_EVAL.md` 中的 verdict。不要接受自由文本的 "looks good" 作为 review 结果。

| Verdict | 含义 | 主 agent 动作 |
| --- | --- | --- |
| `PASS` | review 收敛 | 进入第 5 步 |
| `PASS_WITH_WARNINGS` | review 收敛，遗留非阻塞问题 | 进入第 5 步；最终回复必须摘要 warnings |
| `FAIL` | 修复与复审的中间态 | 按下方修复规则处理后回到第 3 步 |
| `DEGRADED` | 独立审查未成立的阻断态 | 停止，说明缺失的能力或证据，等待用户；不要当作可修复代码问题自动处理 |

FAIL 修复规则：

- finding 若仅因 PLAN 的测试意图当前缺少 UTest/E2E 尚未生成的测试资产而成立，该 verdict 违反 `Stage contract`；不修改源码、PLAN 或测试，携带原 `Stage contract` 重新启动 reviewer 一次。同一结论再次出现时停止，报告 reviewer 契约失败，不记为代码 blocker。
- 只修复 `REQUIREMENTS_EVAL.md` 中使 verdict 变为 FAIL 的 blockers 或明确 must fix 项。
- 不要替 reviewer 改写 `REQUIREMENTS_EVAL.md`；修复后必须重新指定 `reviewer-autodev` 角色生成新版评估。
- 每轮修复后必须更新 `completion-proposal.json`，使 files_changed、behavior_changed、verification、known_limitations 与真实状态一致。
- 如果修复需要超出当前任务范围、缺少信息、工具不可用或存在人工决策点，停止并报告 blocker，不要伪造 PASS。

### 5. 收口 Review 子阶段

verdict 为 `PASS` 或 `PASS_WITH_WARNINGS` 后，由固定 Code Workflow 收口当前 Batch 的 `review` 子阶段并继续 UTest；不得由本技能更新全局 checkpoint。

### 6. 最终回复

使用这个形状：

```
审查已完成。
Verdict: <PASS | PASS_WITH_WARNINGS | FAIL | DEGRADED>
交接文件:
- ${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/REQUIREMENTS_EVAL.md
摘要: <一句话说明最终结果；如 PASS_WITH_WARNINGS，摘要 warnings>

<PASS/PASS_WITH_WARNINGS 时说明 review 已收敛；FAIL/DEGRADED 时说明为什么无法继续>
```

只有最终 verdict 是 `PASS` 或 `PASS_WITH_WARNINGS` 时，本 skill 才算完成。

技能完成后，读取并遵循 `${pluginPath}/skills/references/ui-continuation-guide.md`。

## 参考文件

- 写 completion-proposal.json 或读取 REQUIREMENTS_EVAL.md 时，读取 references/schemas.md（两份文件的字段规则与模板）。
