# Harness Project Workflow MVP Implementation Plan

**Status:** Implemented and locally verified on 2026-08-14.

**Goal:** 在 Harness 项目 Workflow 会话中，由一份通用 `harness-project.workflow.js` 根据 `feature_status` 自动推进插件阶段；普通阶段由单 Agent 执行，需要新会话或独立角色的阶段使用串行 Cycle 展开为同级 Agent。

**MVP Architecture:** `feature_status` 是节点路由与 execution strategy 的唯一来源。当前由受限 Inspect relay Agent 执行插件已有命令，Workflow JS 解析原始 JSON。字段缺失默认 `single-agent-v1`；`serial-cycle-v1` 使用 Prepare → ordered Execute → Finalize。Workflow 不解析 Autobiz `plan.json`，不感知 PLAN Task，不实现 DAG、并行或 Shell。

**Target plugin:** `/Users/sixinjian/autobiz_kanban`

## 1. 实施约束

- 设计依据：`docs/plans/2026-08-13-harness-project-workflow-design.md` 的“2026-08-14 MVP 实施基线”。
- 不修改旧 `.cmbcoworkagent/plugins/...` 安装目录。
- 普通会话、项目 normal 模式和插件无控制信封时的传统 Skill 行为保持不变。
- 不增加 Workflow runtime Shell/command bridge，不修改 Workflow Engine、Sandbox、Tool 或 Renderer。
- Workflow 叶子保持 `disableSubagents:true`，不启用 `request_user_input`。
- 不实现 `task-dag-v1`、DAG Manifest、dependency scheduler 或 `parallel()`。
- Autobiz Code 的一个 Execute Agent 负责一个完整 Batch，而不是一个 PLAN Task。
- Feature 相对产物必须以 `## Skills Runtime Context` 中的 `FEATURE_DIR` 为基准；Workflow 不重复计算路径。
- 保留当前两个仓库已有修改，不 reset、不覆盖无关文件。

## 2. 框架改动

### 2.1 项目 Workflow 叶子上下文

文件：`src/main/agent/runtime.ts`

- Launcher 只在 `runtimePolicy.isProjectMode && isWorkflowMode` 时可见。
- 只在项目模式向 Workflow 叶子传递插件路径、workspace、Feature、项目、Harness 节点、`pluginPromptInject`、`harnessAgentsPrompt`、AGENTS 映射等上下文。
- 每个叶子创建前刷新 Harness 当前节点显示信息。
- 继承父运行 Hook scope；保持 `agentMode:"normal"`、`disableSubagents:true`。
- 普通会话和非项目 Workflow 不展开这些项目字段。

### 2.2 Inspect raw relay

文件：`skills/harness-project-workflow/workflow/harness-project.workflow.js`

Inspect Agent 优先执行当前平台 `workflow_feature_status`，旧插件未配置时回退 `feature_status`，并只返回：

```json
{
  "stdout": "{...feature_status JSON...}",
  "stderr": "",
  "exitCode": 0
}
```

它只能读取 `board_config.json`、选择当前平台 `inspectCommands.feature_status`、按现有环境变量映射执行一次并透传结果。不得读取 Skill、Feature 产物、checkpoint 文件或自行解释路由。

Workflow JS 实现 `parseFeatureStatus()`，确定当前节点和状态、当前状态的 `nextAction`、后继 `actionNodeId`、terminal/runnable，以及动作节点的 `execution.strategy`。

Autobiz 的 `workflow_feature_status` 使用 `inspect_state.py --mode run ... --workflow-minimal`。该标志先调用原 `build_run_payload()`，再做纯字段裁剪；不传标志时 `--mode run` 的完整 JSON 逐字段保持原样。

兼容规则：

```text
execution 缺失                  => single-agent-v1
strategy=single-agent-v1        => single-agent-v1
strategy=serial-cycle-v1        => serial-cycle-v1
其他值                           => fail closed
```

### 2.3 Single Agent 阶段

- 调用 `phase(actionNodeId)`。
- 启动一个 Stage Agent，label 为 `<node>:Stage:<stage-sequence>`。
- Prompt 要求只执行当前 Skill、保留 Hook/产物/状态迁移、以 `FEATURE_DIR` 解析产物、不得进入下一插件阶段。
- Agent 返回后重新 Inspect；状态无推进即失败。
- Stage Agent 不强制结构化输出，完成事实只来自 Inspect。

### 2.4 Serial Cycle 阶段

Prepare schema：

```json
{
  "outcome": "ready | complete | blocked",
  "cycleId": "B001",
  "executeUnits": ["B001"],
  "message": "..."
}
```

Execute schema：

```json
{
  "unitId": "B001",
  "outcome": "completed | blocked | failed",
  "result": "完整业务结果",
  "blockers": []
}
```

Finalize schema：

```json
{
  "outcome": "complete | continue | blocked",
  "message": "...",
  "blockers": []
}
```

调度规则：

1. `phase(actionNodeId)`；
2. Prepare Agent 使用 `protocol="serial-cycle-v1" mode="prepare"`；
3. 校验 `cycleId` 和所有 unit ID 为短安全标识符，executeUnits 唯一且保持原顺序；
4. 使用普通 `for...of` 逐项启动同级 Execute Agent，不调用 `parallel()`；
5. Finalize Agent 接收有界的 Execute 结果；
6. 重新 Inspect；
7. Inspect 已推进则结束阶段；未推进且 Finalize=`continue` 则进入下一 Cycle；未推进且 Finalize=`complete` 则失败；
8. `blocked/failed/null` 立即停止；`maxStageCycles` 防止无限循环。

所有 Agent 都属于动作节点动态 Phase。Prepare 运行前尚不知道插件将返回的 cycleId，因此使用 `<node>:Prepare:C01`；返回后 Execute/Finalize 使用 `<node>:Execute:B001` 和 `<node>:Finalize:B001`。不修改 UI 来回填 Prepare label。

### 2.5 Launcher

文件：`skills/harness-project-workflow/SKILL.md`

启动参数收敛为：

```json
{
  "maxStages": 32,
  "maxStageCycles": 32
}
```

保留固定脚本复制、`scriptPath` 启动和 `resumeFromRunId` 恢复规则。删除 DAG、并行和 `maxStageAttempts` 说明。

## 3. 插件改动

### 3.1 execution 配置

文件：`/Users/sixinjian/autobiz_kanban/board_core/board_config.json`

为 darwin/linux/win32 注册 `workflow_feature_status`，保留原 `feature_status` 不变。

仅为 `dev.code` 和 `dev.review` 增加：

```json
"execution": { "strategy": "serial-cycle-v1" }
```

其他节点不声明 execution，默认 single。现有 `build_workflow_shell()` 已透传公开节点字段，不新增 Harness 专用投影代码。

### 3.2 Code Skill

文件：`/Users/sixinjian/autobiz_kanban/skills/autodev/autodev-code/SKILL.md`

只增加受控制信封触发的“项目 Workflow 托管边界”；无信封时执行现有完整正文。

Prepare：

- 执行原准入和必要的 `code_in_progress`；
- 调用原 `task_runner.py code-session`；
- active/compile/repair 状态投影当前 Batch Cycle；
- `code_done_ready` 投影 `CODE-REVIEW` Cycle；
- 不实现 Task、不编译、不推进 `code_done`。

Execute：

- `unit-id=Bxxx`：执行该 Batch 内全部 PLAN Task，保持原选择、依赖、探索、runner、Evidence 和写入边界；所有 Task 到 `implemented` 后停止，不执行 batch compile；
- `CODE-EXPLORE-REVIEW`：执行原 Explore 回检；
- `CODE-QUALITY-REVIEW`：执行原 code reviewer；
- `CODE-SIMPLIFY-REVIEW`：执行原 report-only simplifier；
- 不执行其他 Batch/单元，不推进 `code_done`。

Finalize：

- Batch Cycle：执行原唯一 batch compile 和最多三轮 repair；成功后保留原 `BATCH_HANDOFF.json`/`awaiting_next_conversation` 并返回 `continue`；不消费下一 Batch handoff；
- `CODE-REVIEW`：按原协议分类三个结果、输出结论、回填词汇表、运行 stage gate、推进 `code_done`；
- 人工裁定或非恢复性错误返回 `blocked`。

不新增 `workflow-manifest`，不修改 `task_runner.py`，不从 Workflow 解析 `plan.json`。

### 3.3 Reviewer Skill

文件：`/Users/sixinjian/autobiz_kanban/skills/autodev/autodev-reviewer/SKILL.md`

Prepare：准入、`requirements_eval_in_progress`、刷新 `completion-proposal.json`，返回 `REQUIREMENTS-REVIEWER`。

Execute：作为同级独立 reviewer 执行 `references/reviewer-agent.md`，只写 `REQUIREMENTS_EVAL.md`，不修改源码、不推进 checkpoint。

Finalize：

- PASS/PASS_WITH_WARNINGS：推进 `requirements_eval_done`，返回 complete；
- FAIL：只修 blockers、更新 proposal，返回 continue，下一 Cycle 必须重新执行独立 reviewer；
- DEGRADED、越界修复或人工裁定：blocked。

Workflow 模式不进入 `inline_main_agent` 的用户确认分支。

### 3.4 其他阶段

- `autodev-utest`：保留已有 task 不可用时的同会话串行 fallback，不适配 Cycle。
- `autodev-e2e`、`autodev-verify`、`autoops-archive`：默认 single。
- `autoops-cicd` 当前包含必须用户确认的完成门；标准流程完全无人值守到 archived 需要后续定义可证明的非交互完成策略，不能由 Workflow 伪造外部流水线事实。

## 4. 验证

### 4.1 框架

- Workflow 脚本通过现有 parser/validator；
- ESLint 检查本次 TS/JS；
- Node typecheck；
- 相关 Workflow/runtime 测试；
- dry-run 覆盖 single、两 Batch Cycle、Code review Cycle、Reviewer FAIL→复审、blocked、未知 strategy、maxStageCycles 和动态 Phase 顺序。

### 4.2 插件

- `board_config.json` JSON 校验；
- `build_workflow_shell()` 确认 execution 随节点透传；
- 现有 board config/workflow/task runner/reviewer tests；
- Skill 静态检查确认控制信封只在项目 Workflow 生效；
- Code dry-run 验证 B001 implement → compile/handoff → B002 → compile → code review → code_done；
- Reviewer dry-run 验证 Prepare → independent review → PASS complete，以及 FAIL fix → continue → fresh review。

## 5. 明确不修改

- `/Users/sixinjian/.cmbcoworkagent/plugins/AutobizDevOps_Plugin_Kanban_latest`
- Workflow Engine/Sandbox/Tool/Renderer
- `task_runner.py` 和 `utest_assignment_router.py`
- 普通会话执行协议
- 插件节点、checkpoint、产物、Hook 和 runner 的业务语义
