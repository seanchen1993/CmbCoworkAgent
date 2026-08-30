# 项目模式 Human Gate 设计

日期：2026-08-30

状态：已确认，待实施

## 1. 背景与目标

项目模式中的插件可能在执行某个阶段推进命令前，需要用户人工检查产物或代码。Human Gate 提供一个框架级审批边界：插件通过 Hook 请求审批，框架挂起当前 Agent Run，并在来源会话和 Feature 详情页展示插件提供的提示。用户批准后原命令继续执行；用户拒绝后当前 Agent Run 立即 halt。

Human Gate 不属于插件定义的阶段或 Feature 领域状态。框架不得把插件的 `in_progress`、`done` 等状态改写为等待审批，而是在 Feature 绑定记录中维护独立的 `humanGate` 字段。

V1 目标：

- 仅在项目模式生效；普通会话中的同名 Hook 返回值不触发 Human Gate。
- 仅支持 `PreToolUse` 事件中的 `execute` 工具。
- 同一个 Feature 同时最多存在一个 pending Gate。
- Gate pending 时只挂起来源 Agent Run，不阻塞应用内其他操作和其他会话运行。
- 来源属于 ManagedRun 时，批准不改变托管状态；拒绝连带取消该 ManagedRun。
- 插件可以返回一段自定义消息，显示在来源会话和 Feature 详情页的审批提示中。
- 应用在 Gate pending 期间关闭或异常退出后，下次启动统一按拒绝处理，不恢复原执行栈。

## 2. 非目标

V1 不包含：

- LangGraph 原生 HITL checkpoint 恢复。
- 多个 Human Gate 的 FIFO 队列。
- 对插件阶段状态、当前节点或领域数据进行比较。
- 产物列表、代码 Diff、勾选项、审批意见或二次确认。
- `PostToolUse`、`PostSkillUse`、`Stop` 等其他 Hook 事件。
- `edit_file`、`write_file`、MCP 工具或延迟工具的 Human Gate。
- Human Gate 超时自动批准或自动拒绝。

## 3. 核心语义

### 3.1 请求 Gate

插件的同步 Hook 在 `PreToolUse(execute)` 返回结构化结果：

```json
{
  "decision": "human_gate",
  "systemMessage": "请检查当前阶段产物和代码，确认无误后再推进。"
}
```

`decision: "human_gate"` 扩展既有 Hook 决策枚举；`systemMessage` 是插件可控的纯文本审批文案。框架负责 trim、长度限制和按纯文本展示，不解释 Markdown/HTML。建议最大 2,000 个字符；为空或超长等非法值按 Hook 协议错误处理，不得静默批准。

框架生成 `gateId`。插件不能指定 `projectId`、`featureId`、`threadId` 或 ManagedRun 标识；这些身份必须从可信的运行上下文和 Thread metadata 推导，避免插件把 Gate 挂到其他 Feature。

只有同时满足以下条件才接受请求：

1. Hook 事件为 `PreToolUse`；
2. 工具名为 `execute`；
3. Hook 为同步 Hook；
4. 当前 Thread 带有合法的项目模式 Feature 绑定；
5. Hook 来源属于当前项目绑定的 Harness 插件；
6. 当前 Feature 不存在另一个 pending Gate。

其他 Hook event 或异步 Hook 返回 `decision: "human_gate"` 时不产生控制效果，仅保留 Hook 执行记录并写入诊断日志。同步 `PreToolUse` 中不满足工具名、项目绑定或插件来源要求时，视为不支持的 Hook 协议并 halt 当前 Agent Run。条件 6 不满足时，使用 `human_gate_conflict` halt 后续 Agent Run，并提示“该 Feature 已有待确认操作，不允许并行推进状态”。

### 3.2 挂起

Human Gate 采用当前框架 `requestApproval()` 的内存等待模型，而不是 LangGraph 原生 HITL：

```text
PreToolUse Hook 返回 decision=human_gate
→ 持久化 Feature.humanGate
→ 注册内存审批 Promise
→ 展示审批提示
→ await 用户决定
```

等待期间 `execute` 尚未运行，因此阶段推进命令不能提前产生副作用。插件必须保证返回 Human Gate 请求前不修改阶段状态；真正的推进动作必须由等待审批的 `execute` 命令完成。

当前 Agent Run 保持等待，不生成 Hook halt、成功或失败终态。用户可以切换会话、创建或运行其他会话、预览产物、打开文件以及使用其他项目功能。

### 3.3 批准

批准操作执行以下顺序：

1. 在 Feature keyed lock 内校验 `gateId` 仍为当前 pending Gate；
2. 追加 `human_gate_approved` 事件；
3. 若来源属于 ManagedRun，同时向托管事件日志追加同名事件；
4. 解析内存审批 Promise 为 approve；
5. 清除持久化的 pending Gate 并广播状态变化，但在内存中保留该 Feature 的 resolving lease；
6. PreToolUse Hook 按放行处理，原 `execute` 命令继续；
7. `execute` 完成、失败或被取消后，在 `finally` 中释放 resolving lease。

批准对 LLM 无感，不注入用户消息、不启动新 Turn，也不修改 ManagedRun 的状态、重试计数或决策基线。

为避免批准与命令真正执行之间出现空窗，pending Gate 和 resolving lease 都属于同一个 Feature 活跃 Gate。直到来源 `execute` settled 之前，新的同 Feature Gate 请求仍按冲突处理。resolving lease 只保存在内存中；此时用户已经明确批准，应用退出后不重放命令，也不恢复审批。

### 3.4 拒绝

拒绝操作执行以下顺序：

1. 校验 pending Gate；
2. 追加 `human_gate_rejected` 事件；
3. 将审批 Promise 解析为 reject；
4. Human Gate 适配层把 reject 转换为 `HookHaltError`，原 `execute` 命令永不执行；
5. 若来源属于 ManagedRun，以 `human_gate_rejected` 为原因取消该 ManagedRun；
6. 清除 pending Gate 并广播状态变化。

非托管会话只结束当前 Agent Run，不改变 Feature 的插件领域状态。

### 3.5 应用关闭与启动恢复

当前代码虽保留 `humanInTheLoopMiddleware`、`__interrupt__`、`Command({ resume })` 等 LangGraph HITL 支持，但主 Agent 明确配置 `interruptOn: undefined`。启用原生 HITL 还会影响运行中消息队列、checkpoint 审批恢复和流生命周期，超出 V1 范围。

V1 的恢复策略为 fail closed：

- 正常关闭时，现有 abort signal 尽力将内存审批解析为 reject；
- 强制关闭时进程消失，等待中的 `execute` 不会运行；
- 下次启动扫描持久化的 pending Gate，统一记录 `human_gate_rejected`，原因为 `app_closed_during_human_gate`，随后清除 Gate；
- 若 Gate 关联 ManagedRun，则取消该 Run，并在托管日志记录相同原因；
- 不尝试恢复或重新执行原 `execute` 命令。

若用户已点击批准但应用在命令完成前退出，框架不重放该命令。插件领域状态可能已经由命令部分修改，仍由插件自身的 inspect 和幂等策略解释；框架不猜测或修复领域状态。

## 4. Feature 持久化模型

V1 将 Gate 放在 `/Users/sixinjian/.cmbcoworkagent/harness-board-features.json` 对应 binding 下：

```json
{
  "projectId": "project-id",
  "featureId": "feature-id",
  "selectedDeployUnitMappings": [],
  "sessionContextInjectionSource": "plugin",
  "humanGate": {
    "gateId": "hg_xxx",
    "status": "pending",
    "sourceThreadId": "thread-id",
    "sourceManagedRunId": "mr_xxx",
    "hookId": "plugin-hook-id",
    "message": "请检查当前阶段产物和代码，确认无误后再推进。",
    "createdAt": "2026-08-30 18:00:00"
  },
  "createdAt": "2026-08-30 17:00:00",
  "updatedAt": "2026-08-30 18:00:00"
}
```

`sourceManagedRunId` 可选。时间统一使用 GMT+8 的 `YYYY-MM-DD HH:mm:ss`。

当前文件采用整文件同步覆盖写入，且 normalizer 会丢弃未知字段。实施时必须：

- 扩展 binding 类型和 normalizer，保留并校验 `humanGate`；
- 所有 binding 更新路径都保留现有 Gate；
- 使用临时文件加原子替换，避免崩溃留下半文件；
- 使用 Feature keyed lock 串行化 create/approve/reject/recover；
- 将损坏或非法 Gate 当作不可批准状态，记录错误并清除，不能默认放行。

文件格式保持 `version: 1`，`humanGate` 为向后兼容的可选字段，不对现有 binding 自动补值。

## 5. 并发策略

同 Feature 可以并行运行多个会话，但同一时间只允许一个 pending Human Gate。

```text
Run A 请求 Gate → 保存并等待
Run B 请求 Gate → human_gate_conflict → Run B halt
```

框架不判断两个 Gate 是否对应相同阶段，也不读取插件的节点或状态。冲突判定只依据 `projectId + featureId + pending humanGate`。

这一策略比 FIFO 更适合 V1：没有队列恢复、顺序展示、重复批准和过期判断；同时不会将插件领域状态耦合进框架。代价是第二个正常并发 Run 可能在最终推进点被终止，但错误原因明确，用户处理完当前 Gate 后可以重新运行。

## 6. UI 与交互

### 6.1 来源会话

来源会话展示可关闭的 Human Gate 提示弹窗：

```text
需要人工确认
<插件提供的 message>

[拒绝并终止] [批准推进]
```

弹窗可以关闭，关闭仅隐藏弹窗，不代表拒绝。会话内保留常驻 Gate 卡片或提示条，可重新打开。当前来源 Run 处于等待状态，输入框沿用运行中禁用规则。

### 6.2 Feature 详情页

Feature 详情页展示同一 Gate 和相同操作按钮。会话弹窗与 Feature 详情页共享 `gateId` 和主进程审批 API，任一入口完成审批后，另一入口立即消失。

### 6.3 项目详情页

项目详情页只在对应 Feature 卡片展示“待人工确认”状态，不提供批准或拒绝按钮。点击 Feature 后进入详情页处理。

### 6.4 非阻塞要求

Human Gate 不使用不可关闭的全局模态层。用户始终可以切换会话、打开产物预览、浏览项目及运行其他会话。

## 7. IPC 与事件

新增最小 IPC：

- `harnessBoard:approveHumanGate({ projectId, featureId, gateId })`
- `harnessBoard:rejectHumanGate({ projectId, featureId, gateId })`
- `harnessBoard:humanGateChanged` 广播

Feature 列表、Feature 详情和来源 Thread 的 ViewModel 增加可选 `humanGate` 摘要。

Human Gate 事件至少包含：

- `human_gate_requested`
- `human_gate_approved`
- `human_gate_rejected`
- `human_gate_conflict`

若来源属于 ManagedRun，批准、拒绝和冲突事件写入该 Run 的事件日志。批准只是审计事件；拒绝后 ManagedRun 状态变为 `cancelled`；冲突 Run 沿现有 Hook halt 路径进入失败。

## 8. 代码改动范围

### 8.1 Hook 协议与运行时

- `src/main/hooks/types.ts`
  - 扩展 `HookResult.decision` 的 `human_gate` 枚举，并记录可信的决策来源。
- `src/main/hooks/runner.ts`
  - 复用既有 `decision`、`systemMessage` 解析；聚合时拒绝多个 Gate 请求；异步 Hook 不允许返回 Gate。
- `src/main/agent/local-sandbox.ts`
  - 在 `PreToolUse(execute)` 的 Hook 结果与命令执行之间调用 Human Gate 服务。
  - 前台和后台 execute 必须使用同一处理函数，避免绕过。
  - 批准后以 `try/finally` 包裹 execute，确保命令 settled 后释放 Feature resolving lease。
- `src/main/agent/runtime.ts`
  - 向 LocalSandbox 注入 Human Gate approval resolver；把 Gate 等待纳入 pending approval/等待探针。
- `src/main/hooks/halt.ts`
  - 拒绝和冲突通过既有 `HookHaltError` 结束 Run，不新增通用 Hook halt 语义。

### 8.2 Feature 状态与主进程服务

- `src/shared/harness-board-types.ts`
  - 新增 Human Gate snapshot、IPC 输入和 ViewModel 字段；扩展 ManagedRun 事件类型。
- `src/main/harness-board/service.ts`
  - 扩展 `harness-board-features.json` 的读取、校验和原子写入。
- 新增 `src/main/harness-board/human-gate-service.ts`
  - 管理 Feature keyed lock、内存 resolver、冲突、批准、拒绝和启动恢复。
- `src/main/harness-board/auto-mode-controller.ts`
  - 仅提供拒绝时按指定原因取消 ManagedRun，以及写入 Human Gate 审计事件的窄接口。
- `src/main/harness-board/managed-run-store.ts`
  - 接受 Human Gate 事件类型和取消原因。
- `src/main/ipc/harness-board.ts`
  - 注册批准/拒绝 IPC，并广播 Gate 变化。
- `src/main/index.ts`
  - 启动时执行 pending Gate 的拒绝恢复。

### 8.3 Preload 与 Renderer

- `src/preload/index.ts`、`src/preload/index.d.ts`
  - 暴露 Gate 查询、批准、拒绝和变更订阅。
- `src/renderer/src/components/chat/ChatContainer.tsx` 或其独立子组件
  - 来源会话的 Gate 弹窗/常驻提示。
- `src/renderer/src/components/harness-board/HarnessBoardView.tsx`
  - Feature 详情审批提示；项目详情 Feature 卡片待确认标识。
- `src/renderer/src/lib/thread-context.tsx`
  - 若复用现有 pending approval 展示状态，增加 Human Gate 的独立类型，不能伪装成 shell sandbox approval。

### 8.4 明确不改

- 插件工作流节点、阶段状态和 nextAction 解析逻辑。
- LangGraph `interruptOn` 和 checkpoint resume 链路。
- `request_user_input` 工具及其自动解决策略。
- 普通模式下非项目会话的 Hook 行为。
- ManagedRun 状态枚举和自动决策策略。

## 9. 仅支持 execute 的范围收益

仅支持 `PreToolUse(execute)` 能明显减少 V1 改动范围：

- Human Gate 天然位于命令执行前，批准后原命令继续，拒绝时命令尚未产生副作用。
- `execute` 已由 LocalSandbox 统一触发 PreToolUse Hook，且通用 tool middleware 明确排除了 execute，避免双重触发。
- 不需要处理文件写入参数、编辑内容展示或多种工具返回形态。
- 插件可以把“阶段从 in_progress 推进到 done”的命令作为明确的 Gate 边界。
- 回归测试集中在前台 execute、后台 execute、批准、拒绝、冲突和应用恢复。

限制是插件必须确保阶段推进经由 `execute` 完成。通过 `edit_file`、`write_file`、MCP 或 Hook 自身副作用完成的状态变化不会被 V1 Gate 拦截。

## 10. 后续扩展 edit_file 的难度

如果 V1 将 Human Gate 服务设计为工具无关，并只在入口处维护 `allowedToolNames = new Set(["execute"])`，后续扩展 `edit_file` 难度为低到中等。

`edit_file` 当前已经在实际文件修改前调用 `runPreToolUseHook("edit_file", ...)`，因此不需要重建 Hook 基础设施。主要工作是：

1. 将 `edit_file` 加入允许工具集合；
2. 确保批准前不会进入文件锁和写入逻辑；
3. 不把 `oldString`、`newString` 或完整文件内容持久化到 Gate 文件，避免敏感信息和文件膨胀；
4. 验证批准后编辑只执行一次，拒绝和应用退出时不写文件；
5. 要求插件 matcher 足够精确，避免普通代码编辑频繁触发 Gate。

真正的风险不在技术接入，而在产品语义：`execute` 通常可以对应一个明确的“推进阶段”命令，`edit_file` 则是高频基础操作。插件若用宽泛 matcher，很容易在开发过程中频繁弹出审批。因此扩展能力容易，但应继续由插件显式 opt-in，并保持默认只支持 execute。

## 11. 失败模式与安全策略

- Gate 持久化失败：不执行命令，当前 Run halt。
- 没有可用主窗口：保持 pending；用户重新打开窗口后处理。
- 来源 Thread 被删除：按拒绝处理；关联 ManagedRun 取消。
- 重复批准/拒绝：`gateId` CAS 只允许第一次成功，后续返回“Gate 已变化”。
- 同 Feature Gate 冲突：后续 Run halt，现有 Gate 不受影响。
- Gate 已批准但来源 execute 尚未 settled：后续 Gate 仍按冲突处理。
- 插件消息非法：协议错误并 halt，不能使用默认文案后继续。
- 应用退出：pending Gate fail closed；下次启动按拒绝清理。
- 批准后 execute 失败：按普通工具失败处理，Human Gate 不自动重开。

## 12. 验证范围

实施后只运行涉及文件的局部 lint，不运行全项目 lint、`lint --fix` 或生产构建。

应重点验证：

- 非项目模式的相同 Hook 输出不能触发 Gate；
- 项目模式非 execute 工具不能触发 Gate；
- execute 批准前没有执行，批准后仅执行一次；
- 拒绝后 execute 未执行且 Agent Run halt；
- 批准托管 Gate 只追加事件，不改变 ManagedRun 状态；
- 拒绝托管 Gate 取消 Run 并记录原因；
- 同 Feature 第二个 Gate 触发 conflict 并 halt；
- 不同 Feature 可同时等待 Gate；
- 插件自定义消息在来源会话和 Feature 详情一致显示；
- pending 时关闭应用，重启后按拒绝清理且命令不重放；
- 现有 `harness-board-features.json` binding 在读写后不丢失字段。

根据项目约束，本设计不主动新增或改写单元测试；若实施阶段需要新增上述自动化测试，应先向用户说明并取得确认。

## 13. ADR：采用内存审批等待与启动拒绝恢复

### 决策

V1 复用现有 `requestApproval()` 的内存 Promise 模式，持久化 Feature 级 pending Gate；不启用 LangGraph 原生 HITL。应用重启时将遗留 pending Gate 视为拒绝。

### 备选方案

1. LangGraph HITL checkpoint：可跨重启原地恢复，但需要启用当前关闭的 `interruptOn`，并重新验证消息队列、stream lifecycle 和 checkpoint 审批恢复。
2. Human Gate FIFO：支持同 Feature 多个等待请求，但需要队列持久化、逐项恢复和过期判断。
3. 后续 Gate 立即冲突 halt：实现最小、行为确定，不解释插件领域状态。

### 取舍

选择内存等待和单 Gate 冲突策略，牺牲跨重启继续执行与并发 Gate 排队，换取更小的改动范围、明确的 fail-closed 行为和对插件领域状态的零耦合。
