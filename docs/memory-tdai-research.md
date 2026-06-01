# Context Offload 借鉴可行性调研（基于本仓现有压缩链路）

> 版本：v3.1 · 日期：2026-05-23 · 状态：查漏补缺稿
>
> **范围**：评估 TencentDB-Agent-Memory `src/offload/` 中哪些机制**值得在本仓现有压缩方案之上额外引入**。
> 长期记忆 L0–L3 不在本文范围（已有独立分支处理）。
>
> 参考来源：
> - 源码：`C:\ai\TencentDB-Agent-Memory\src\offload\` v0.3.5（MIT，~8.6k LOC）
> - 本仓现有压缩相关代码（见 §2）

---

## 0. 结论先行

**本仓已有 5 层成体系的上下文压缩链路**（输入截断 → tool evict → args 截断 → 整体总结 → routing guard），覆盖了 TencentDB offload 中 **mild / aggressive / emergency + inline 写盘** 的绝大多数功能。

直接整套移植 offload 不划算，会产生功能重叠。**真正值得借鉴的只有 2 个独有特性**：

| TencentDB offload 独有的 | 本仓有没有 | 是否值得借 |
|---|---|---|
| **Mermaid 任务画布**（持续更新的符号化结构图） | ❌ 完全没有 | ✅✅ **强烈建议** |
| **score-cascade + node_id 回查**（选择性、可逆压缩） | ❌ 当前 summarization 不可逆 | ⚠️ 视效果再决 |
| Mild/Aggressive/Emergency 三档阈值 | ✅ summarizationMiddleware 75% 触发 + emergency 兜底 | 不借 |
| Inline 大 tool result 写盘 | 🟡 非 read-file 已 evict，read_file 已裁剪 | 不借 |
| 历史 args 截断 | ✅ `truncateArgsSettings` | 不借 |
| L1 LLM 生成摘要 | ✅ `summarizationMiddleware` 整段总结 | 不借 |

**推荐方案：聚焦"Mermaid 任务画布"单点突破**，约 4.5 人日，给本仓加一个 summarization 之上的"任务结构感"补充层，而不是平推一套压缩系统。

v3.1 校勘后需要修正 3 个关键点：

1. **MMD 注入不能用 `beforeModel` 返回 `messages`。**LangChain 的 `beforeModel` 是 state update 钩子，返回的 `messages` 会进入 graph state/checkpoint。若要"只对本次模型请求可见、不污染历史"，应使用 `wrapModelCall` 修改 `request.systemMessage` 或 `request.messages`。
2. **本仓现有 summary / 大结果"落盘"大多是 DeepAgents 虚拟 filesystem。**`.cmbdevclaw/conversation_history/...`、`/large_tool_results/...` 是 `StateBackend` 中的虚拟路径，随 LangGraph checkpoint 持久化，不是用户主目录下可直接浏览的物理文件。若新增 `~/.cmbcoworkagent/task-mmd`，这是额外的物理持久化层。
3. **如果要还原 TencentDB/OpenClaw 的全局工具轨迹，必须覆盖 main agent 和 subagent。**只在 main middleware 记录，只能看到一次 `task` 工具调用及其最终输出，看不到 subagent 内部的 `read_file`、`execute`、`edit_file` 等链路。

---

## 1. 本仓现有压缩链路（5 层）

| # | 层 | 触发 | 策略 | 关键代码 |
|---|---|---|---|---|
| L1 | **read_file 输入端裁剪** | 每次 read_file 调用 | 行数上限 `READ_FILE_DEFAULT_LIMIT=2000` / 字符上限 `4 × toolTokenLimitBeforeEvict ≈ 80KB`；超出加 `[Output truncated…]` 提示 | [read-file-output.ts:130](../src/main/agent/read-file-output.ts#L130) `trimReadFileOutputLines` / `truncateReadFileOutputByChars` + [read-file-tool.ts:60](../src/main/agent/read-file-tool.ts#L60) `patchRuntimeReadFileTool` |
| L2 | **tool result evict**（DeepAgents 内置） | 单条非 filesystem 工具 result > `toolTokenLimitBeforeEvict` | 写到 filesystem backend，message 中只剩引用（"~80KB before evicting a tool result to the filesystem"）；`read_file` 等 filesystem 工具被 DeepAgents 排除，靠本仓 L1 裁剪 | [runtime.ts:2086](../src/main/agent/runtime.ts#L2086) `toolEvictLimit = min(20000, max(maxTokens × 0.08, 6000))` |
| L3 | **历史 args 截断**（DeepAgents 内置） | 老消息中的 tool_use args 超过 `maxLength=2000` 字符 | 截断保留前缀 | [runtime.ts:2089](../src/main/agent/runtime.ts#L2089) `truncateArgsSettings` |
| L4 | **summarizationMiddleware**（DeepAgents 内置） | 累积 tokens ≥ `maxTokens × 0.75` | LLM 生成段落式总结替换大部分历史，保最近 `max(maxTokens × 0.1, 4000)` tokens；总结输入裁到 `min(700K, maxTokens × 0.65)`；写入 DeepAgents 虚拟路径 `.cmbdevclaw/conversation_history/` | [runtime.ts:1011](../src/main/agent/runtime.ts#L1011) `createSummarizationMiddleware(summarizationOptions)` + [runtime.ts:395](../src/main/agent/runtime.ts#L395) `CMB_COWORK_SUMMARY_PROMPT`（7 段式 coding-agent handoff 模板） |
| L5 | **routing 上下文 guard** | 选模型时 `inputTokens ≥ 0.75 × maxTokens` | 让出给更大窗口的模型 | [routing/index.ts:683](../src/main/routing/index.ts#L683) `CONTEXT_CAPACITY_RATIO = 0.75` |

### 1.1 触发顺序

```
                   ┌───────────────┐
read_file call →  │ L1 输入裁剪   │ → tool message 进入 state
                   └───────────────┘
                          ↓
                   ┌───────────────┐
                   │ L2 tool evict │ → 单条仍过大就写盘
                   └───────────────┘
                          ↓
每轮 LLM 调用前  →  ┌───────────────┐
                   │ L3 args 截断  │ → 历史 tool_use args 截短
                   └───────────────┘
                          ↓
                   ┌───────────────┐
                   │ L4 summarize  │ → 累积 ≥75% maxTokens：LLM 总结
                   └───────────────┘
                          ↓
                   ┌───────────────┐
                   │ L5 routing    │ → 仍 ≥75%：让位给大窗口模型
                   └───────────────┘
```

### 1.2 落盘机制对照

| 项 | 本仓 | TencentDB offload |
|---|---|---|
| 落盘介质 | DeepAgents `StateBackend` 虚拟 filesystem，随 LangGraph checkpoint 持久化 | 用户主目录物理文件 |
| 路径 | `.cmbdevclaw/conversation_history/...`、`/large_tool_results/...` | `~/.openclaw/context-offload/refs/<id>.md` |
| 粒度 | **整段对话** summary；非 read-file 大工具结果单独 evict | **单条 tool result** 落盘 |
| 回查 | agent 可通过 `read_file` 读取已暴露路径；用户不能直接按 OS 文件浏览这些虚拟路径 | `node_id` / `result_ref` 引用，agent 可通过工具调取 |
| 用途 | 失败回滚 / 续作 handoff / agent 自读虚拟文件 | 同上 + agent 推理时主动钻取 |

---

## 2. TencentDB Offload 与本仓压缩的功能差异矩阵

| TencentDB offload 功能 | 本仓覆盖度 | 注释 |
|---|---|---|
| **触发分三档**：mild ≥50% / aggressive ≥85% / emergency ≥95% | 🟢 等效 | 本仓只有 75% 触发 summarization，但其实际行为 ≈ aggressive；触发更激进的 emergency 兜底是 L5 routing 做的 |
| **大 tool result 立即落盘**（inline） | 🟡 部分等效 | 非 read-file 大结果由 L2 evict；`read_file` 走 L1 行级/字符裁剪，不是 evict |
| **历史 tool_use args 截短** | 🟢 等效 | L3 `truncateArgsSettings` |
| **整段历史 LLM 总结** | 🟢 等效 | L4 `summarizationMiddleware` + 自定义 `CMB_COWORK_SUMMARY_PROMPT` 已经是 coding-agent handoff 模板 |
| **score-cascade 选择性替换** | 🟡 部分 | 本仓总结是"整段一次性"，offload 是"逐条按 score 选择性"。理论上选择性更精细，但需要先跑一轮 LLM 给每条打 score（成本翻倍） |
| **node_id + refs/*.md 钻取** | 🟡 部分 | L4 有虚拟 conversation history 路径，非 read-file 大结果也有虚拟引用；但没有按 `node_id` 回查单个 tool call 的工具 |
| **Mermaid 任务画布** | 🔴 完全缺 | 这是 offload 独有的"任务结构感"机制，本仓没有等价物 |
| **L1.5 任务边界判定**（"上一任务结束没？这是新任务还是延续？"） | 🔴 完全缺 | 本仓没有任务粒度概念，整 thread 是一个 conversation |
| **MMD 注入到 prompt**（task graph 注入） | 🔴 完全缺 | 依附于 Mermaid 画布 |

### 2.1 视觉对比

```
─── 本仓现有 ─────────────────────────────────────────────
  read_file 大输出
    ↓ trim 到 80KB
  state.messages = [user1, ai1, tool1, user2, ai2, tool2, ..., user20, ai20, tool20]
                                                                   ↑ 累积 75% maxTokens
                                                                   ↓ summarize
  state.messages = [SystemSummary, user20, ai20, tool20]   ←─ 不可逆，agent 看不到 tool1..19 细节


─── 加上 Mermaid 画布后 ───────────────────────────────────
  同上 + 持续维护 ~/.cmbcoworkagent/task-mmd/<threadId>.mmd:

    graph LR
      N1["读 rollback.ts<br/>status:done"] --> N2["分析依赖<br/>status:done"]
      N2 --> N3["改 manifest<br/>status:doing"]
      N3 -.-> N4["遇到阻塞<br/>status:blocked"]

  每轮 prompt 注入这张图（~200 token），agent 始终知道"做到哪一步"
  即使 summarize 把 N1/N2 细节丢了，画布还在
```

---

## 3. 真正值得借鉴的：Mermaid 任务画布

### 3.1 它解决的问题

本仓 L4 `summarizationMiddleware` 触发后，agent 看到的是**一段散文式总结**。问题：
- 总结**没结构**：用户无法快速看出"现在跑到哪了"
- agent **方向感弱**：长任务里多步走偏，summarize 后更容易跑歪（"我刚才做到哪了？"）
- 用户体验差：50 步任务用户看屏幕只能滚消息找进度，不能一眼瞄全貌

Mermaid 任务画布的核心价值：
1. **结构化** —— 节点 + 边表达任务步骤，状态字段 `done/doing/paused/blocked`
2. **持续更新** —— 不依赖 summarize 触发，每攒够 N 个 tool call 就更新一次
3. **token 极省** —— 一张图 ~200 token，覆盖 30+ 步任务的方向感
4. **可视化** —— Customize 面板里可以渲染成图，比读文字总结直观

补充：TencentDB 的 L2 prompt 要求只记录已发生事实，不写未执行的未来计划。因此本仓的 task-mmd 也应避免把"待办 todo"写成图节点；后续建议可以放在普通 summary 或 UI 面板中，而不是混入 MMD 历史事实图。

### 3.2 复用 / 重写边界

源 [pipelines/l2-mermaid.ts](C:\ai\TencentDB-Agent-Memory\src\offload\pipelines\l2-mermaid.ts) 是核心算法（286 LOC），关键流程：

```
input:  OffloadEntry[] (累积的 tool 调用记录，每条有 summary)
        + 可能存在的旧 mmd 文件（增量更新场景）
output: mmd 文件 + 每条 entry 回填 node_id
```

需要的依赖：
- `OffloadEntry` 类型 → ✅ 拷 `src/offload/types.ts` 即可
- LLM 调用生成 graph → ⚠️ 改用本仓 `ChatOpenAI` + routing
- 节点 ID 解析 `001-N3` 之类 → ✅ 拷 `mmd-meta.ts` (66 LOC)
- 文件读写 → ✅ 拷 `src/offload/storage.ts` 中 mmd 部分

不需要的依赖：
- ❌ `state-manager.ts`（OffloadStateManager 是 OpenClaw session 级状态，本仓改用 threadId-scoped 简单 Map）
- ❌ `after-tool-call.ts` / `before-prompt-build.ts`（OpenClaw hook 形态，本仓换中间件）
- ❌ mild/aggressive/emergency 三档（本仓 L4 已覆盖）
- ❌ `l3-helpers.ts` 中替换 ToolMessage 的部分（本仓不做选择性替换）

---

## 4. 推荐方案：Mermaid 任务画布最小增量

### 4.1 目录

```
src/main/agent/task-mmd/
├── types.ts                 # OffloadEntry-lite + MmdState（精简版）
├── entry-recorder.ts        # 累积 tool call summary 到 entries.jsonl
├── mmd-compiler.ts          # entries.jsonl → mmd 文件（移植 l2-mermaid 主逻辑）
├── mmd-injector.ts          # 把 mmd 注入到 system prompt 末尾
├── middleware.ts            # createTaskMmdMiddleware()
└── storage.ts               # ~/.cmbcoworkagent/task-mmd/<threadId>/
```

### 4.2 中间件接入点

```ts
// runtime.ts 现有中间件链（伪代码）
middleware: [
  todoListMiddleware(),
  createFsMiddleware(),
  ...toolHookMiddleware ? [toolHookMiddleware] : [],
  toolErrorMiddleware,
  createSubAgentMiddleware(...),
  createSummarizationMiddleware(summarizationOptions),
  anthropicPromptCachingMiddleware(...),
  createPatchToolCallsMiddleware()
]

// 增加：main 与 subagent 都挂；建议在 createFsMiddleware() 之后、summarization 之前
const subagentMiddleware = [
  todoListMiddleware(),
  createFsMiddleware(),
  createTaskMmdMiddleware({ threadId, scope: "subagent", ... }),
  ...,
  createSummarizationMiddleware(summarizationOptions),
  ...
]

const mainMiddleware = [
  todoListMiddleware(),
  createFsMiddleware(),
  createTaskMmdMiddleware({ threadId, scope: "main", ... }),
  ...toolHookMiddleware ? [toolHookMiddleware] : [],
  toolErrorMiddleware,
  createSubAgentMiddleware({ subagents }),
  createSummarizationMiddleware(summarizationOptions),
  ...
]
```

中间件做两件事：

```ts
// task-mmd/middleware.ts 伪代码
export const createTaskMmdMiddleware = (opts) => createMiddleware({
  name: "taskMmdMiddleware",
  
  // 1) tool 调用后累计记录
  wrapToolCall: async (request, handler) => {
    const result = await handler(request)
    // 异步（不阻塞）：把 (toolName, args, result 摘要 100 字) append 到 entries.jsonl
    fireAndForget(() => entryRecorder.append(opts.threadId, request.toolCall, result))
    // 累积 ≥ 4 条且没正在编译 → 后台触发 mmd-compiler
    if (entryRecorder.shouldCompile(opts.threadId)) {
      fireAndForget(() => mmdCompiler.compile(opts.threadId))
    }
    return result
  },
  
  // 2) 每轮模型调用时临时注入当前 mmd
  wrapModelCall: async (request, handler) => {
    const mmd = await loadActiveMmd(request.runtime.context.threadId)
    if (!mmd) return handler(request)

    return handler({
      ...request,
      // 推荐：作为 system suffix 注入，不写回 state.messages
      systemMessage: request.systemMessage.concat(renderTaskMmdSystemBlock(mmd)),
    })
  }
})
```

关键修正：

- 不要用 `beforeModel` 返回追加后的 `messages`。它会成为 LangGraph state update，进入 checkpoint。
- 如果确实要模拟源项目的"近 user message 插入"，也应在 `wrapModelCall` 里修改 `request.messages`，并避免切断 tool_call / tool_result 相邻结构。
- LangChain 的 `wrapToolCall` 按 middleware 列表组合，越靠前越外层。`createTaskMmdMiddleware` 放在 `createFsMiddleware()` 之后时，recorder 会先看到原始工具结果，再由 filesystem middleware evict，所以 recorder 必须只保存裁剪摘要，不保存完整大结果。

### 4.3 关键决策点

| 决策 | 选项 | 推荐 |
|---|---|---|
| MMD 编译触发 | A. 累积 N 条工具调用  /  B. 时间窗口  /  C. 二者取 OR | C，参考源项目（`l2NullThreshold=4` 或 `l2TimeoutSeconds=300`） |
| 编译用的 LLM | A. 复用 chat 模型  /  B. routing 中 economy | B，加 `taskSource: "task_mmd"` |
| MMD 注入位置 | A. `wrapModelCall` 拼到 system prompt 末尾  /  B. `wrapModelCall` 临时插入近 user 处 | 源项目用 B（更鲜活）；本仓推荐 A（不污染消息流，与 summarization 不冲突） |
| 注入是否复用 system prompt cache | A. 是  /  B. 否 | A — `anthropicPromptCachingMiddleware` 已在用 prompt cache，把 MMD 放尾巴保持前缀稳定（参考源 `mmdMaxTokenRatio=0.2`） |
| 任务边界判定 (L1.5) | A. 引入  /  B. 简化为 thread 级（一 thread 一个 mmd） | **B 作为 MVP**；但 thread 不是严格任务边界，需提供手动清空，后续可加轻量 L1.5 |
| 用户编辑 mmd 后怎么处理 | A. 锁定不再覆盖  /  B. 警告但覆盖 | A，加 `userEdited: true` 标志位 |
| main/subagent 覆盖 | A. 只挂 main  /  B. main + subagent 都挂 | B，否则看不到 subagent 内部工具链 |

### 4.4 数据布局

```
~/.cmbcoworkagent/task-mmd/
└── <threadId>/
    ├── entries.jsonl         # tool 调用累积记录
    ├── active.mmd            # 当前活跃的 Mermaid 文本
    └── state.json            # { lastCompiledAt, entryCount, userEdited, mmdCounter }
```

配置建议落在 `~/.cmbcoworkagent/task-mmd-settings.json`，通过 `src/main/storage.ts` 暴露：

```ts
type TaskMmdSettings = {
  enabled: boolean              // 默认 false
  compileModelTier: "economy"
  l2NullThreshold: number       // 默认 4
  l2TimeoutSeconds: number      // 默认 300
  maxEntriesPerCompile: number  // 默认 20
}
```

物理文件写入需要 thread 级 append lock / compile lock，并使用 temp file + rename，避免 parallel tool calls 同时追加或编译导致 `entries.jsonl` / `active.mmd` 损坏。

### 4.5 与现有 5 层压缩的协作

| 现有层 | 与 task-mmd 的关系 |
|---|---|
| L1 read_file 截断 | 不冲突。task-mmd 只看 tool name + args + result 前 N 字符做摘要 |
| L2 tool evict | 不冲突。非 read-file 大 result 会被 evict；task-mmd 记录用 result 摘要而非全文 |
| L3 args 截断 | 不冲突。task-mmd 在模型调用历史 args 截断**前**就已 append 到 entries.jsonl；但 append 时仍要主动脱敏和裁剪 |
| L4 summarization | **互补**。summarize 散文式总结 + MMD 结构图，两者注入不同位置 |
| L5 routing guard | 不冲突。MMD ~200 token 的占用不影响 routing 决策 |

**重点**：task-mmd 不接管 messages 的修改权，只读 + 注入，对现有 5 层零侵入。

### 4.6 UI / IPC 补充

`CustomizeView` 目前是全局设置入口，已有 `currentThreadId`，可以先加 "Task MMD" tab 展示当前线程图；但更自然的长期形态是 chat 侧边栏/线程检查器，因为 task-mmd 本质是线程状态，不是全局偏好。

需要补充的文件：

```text
src/main/ipc/task-mmd.ts                 # getCurrent / clear / updateSettings
src/main/ipc/threads.ts                  # 删除 thread 时清理 task-mmd/<threadId>
src/renderer/src/components/customize/   # 新增 TaskMmdTab
preload / renderer API 类型              # 暴露 taskMmd API
package.json                             # 新增 mermaid 依赖，renderer dynamic import
```

如果编译任务走现有 routing，还需要同步修改 `src/main/routing/index.ts` 和 `src/main/agent/trace/types.ts` 的 `taskSource` union，新增 `"task_mmd"`，并在 layer1 快速分类中按 `memory_summarize` 一样走 economy。

---

## 5. 工作量

| 阶段 | 工作量 | 交付 |
|---|---|---|
| 0 · spike | 0.5d | 验证 `wrapToolCall` 异步 fire-and-forget 不阻塞 + `wrapModelCall` 注入 SystemMessage 生效，且不写入 checkpoint |
| 1 · 骨架 + entries.jsonl | 0.5d | `entry-recorder.ts` + `storage.ts` 跑通；单测覆盖 |
| 2 · mmd-compiler | 1d | 移植 `l2-mermaid.ts` 核心算法，接 ChatOpenAI；产出 mermaid 语法可被解析 |
| 3 · middleware 接入 | 0.75d | `createTaskMmdMiddleware` 挂到 main/subagent runtime，验证 prompt 中出现 mmd 块 |
| 4 · UI 渲染 | 0.5d | Customize 加 "Task MMD" Tab，用 `mermaid@11` 渲染；点节点显示对应 entry |
| 5 · 联调 + flag | 0.5d | feature flag `taskMmd.enabled`（默认关），thread 删除清理，跑 1 个真实长 thread 验证 |
| 6 · 安全/并发/回归测试 | 0.75d | 脱敏、裁剪、tool_call_id 去重、append/compile lock、routing 类型测试 |
| **合计** | **~4.5d** | |

可选：
- 引入 score-cascade 选择性替换：+5d，但与 L4 重叠严重，**不推荐**
- 引入 node_id 回查工具 `get_task_entry(node_id)`：+1d，建议在 task-mmd 跑通后单独评估

---

## 6. 风险

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | 编译 MMD 增加 LLM 调用成本 | 中 | 强制 economy 模型；每 ≥4 条且 ≥300s 才触发一次；用户可关 |
| R2 | MMD 注入挤占 prompt cache 前缀 | 中 | 注入位置固定（system suffix），mmd 内容变化但位置稳定，cache 仍生效（同源项目 `mmdMaxTokenRatio=0.2` 思路） |
| R3 | LangGraph state 操作误把 MMD message 持久化进 checkpointer | 高 | MMD 注入用 `wrapModelCall` 临时改 request；不要在 `beforeModel` 返回 `messages` |
| R4 | mermaid 渲染包体积 | 低 | `mermaid` 包 ~600KB，dynamic import 按需加载 |
| R5 | 用户切 thread 后旧 mmd 残留 | 低 | thread 删除时清理 `task-mmd/<threadId>/`，复用现有 thread delete hook |
| R6 | tool 数量爆炸时 entries.jsonl 过大 | 低 | 单 thread 不会超过几千条，jsonl < 1MB；编译时只取最近 N 条 |
| R7 | 只记录 main agent 导致 subagent 轨迹缺失 | 中 | main/subagent 都挂 middleware，entry 里带 `scope` |
| R8 | 工具 args/result 把 secret 二次落盘 | 高 | sanitizer 脱敏 `apiKey/token/password/Authorization/.env` 等；只存 bounded excerpt |
| R9 | parallel tool calls 并发写坏文件 | 中 | thread 级 append lock + compile lock + temp file rename |

---

## 7. 关于 score-cascade 与 node_id 钻取（暂不推荐）

源项目这两个机制虽然精巧，但落到本仓重叠严重：

**Score-cascade 选择性替换**（`compressByScoreCascade`）：
- 核心思路：给每条 tool_result 打 score（"可替换性"），高 score 优先替换为摘要
- 与本仓 L4 冲突：L4 已经做了"整段 LLM 总结"，再加选择性替换等于做两遍 LLM 总结
- 真正适合 score-cascade 的场景：需要"保留部分 tool_result 原文"。但本仓 summarizationMiddleware 已经支持 `keep` 配置，保最近 N 条消息原文。
- **结论**：先观察 L4 实际效果，如果用户反馈"总结太狠丢了细节"，再考虑用 score-cascade 替代或补充 L4。

**`node_id` + `get_offload_node` 工具**：
- 核心思路：被压缩的 tool_result 写盘留底，agent 可通过 id 主动钻取
- 本仓 L2 tool evict 其实已经写盘到 backend，但没有暴露给 agent 的钻取工具
- 单独做一个 `read_evicted_tool(toolCallId)` 工具是低成本的，~0.5d
- **结论**：可作为后续增量优化，不打包到 task-mmd 一期里

---

## 8. 待你拍板

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| Q1 | 是否聚焦 task-mmd 单点突破 | A. 只做 task-mmd  /  B. task-mmd + node_id 钻取  /  C. 整套 offload 平推 | **A**（约 4.5d，性价比最高） |
| Q2 | MMD 编译模型 | A. 复用对话模型  /  B. 强制 economy | **B** |
| Q3 | MMD 注入位置 | A. `wrapModelCall` system suffix  /  B. `wrapModelCall` user message before-last | **A**（保 prompt cache，不污染 state） |
| Q4 | 默认开关 | A. 默认开  /  B. 默认关需用户启用 | **B** 灰度期 |
| Q5 | 任务粒度 | A. thread = 1 任务  /  B. 引入 L1.5 任务边界判定 | **A 作为 MVP**；必须提供手动清空，后续按效果评估 B |
| Q6 | UI 渲染 | A. Customize 新 Tab + mermaid.js  /  B. 仅在右侧面板加链接  /  C. 暂不做 UI | A |

---

## 9. 附录

### 9.1 拷贝清单（核心移植约 600 LOC，落地总量会更高）

```
✅ 直接拷
   src/offload/types.ts                                → 抽取 OffloadEntry / MmdNode / MmdMetadata
   src/offload/mmd-meta.ts                             → 拷全
   src/offload/storage.ts (mmd / refs 部分)            → 抽 mmd 部分

⚠️ 算法移植
   src/offload/pipelines/l2-mermaid.ts                 → mmd-compiler.ts（去 OffloadStateManager 耦合）
   src/offload/mmd-injector.ts (findHistoryMmdInsertionPoint 等位置工具)  → 简化版 mmd-injector.ts

✗ 不引入
   所有 hooks/*.ts
   l3-helpers.ts / l3-token-counter.ts
   state-manager.ts / state-reporter.ts / reclaimer.ts
   backend-client.ts / opik-tracer.ts / local-llm/
```

### 9.2 新增依赖

```json
{
  "dependencies": {
    "mermaid": "^11.0.0"     // UI 渲染用；mmd-compiler 自身不需要
  }
}
```

`js-tiktoken` 也不需要（不再做 token snapshot 决策，沿用 L4 自带的 counter）。

### 9.3 LICENSE

文件头标注：

```ts
/**
 * Task MMD module — Mermaid task graph derived from TencentDB-Agent-Memory v0.3.5
 *   https://github.com/Tencent/TencentDB-Agent-Memory (MIT)
 * Scope: only the Mermaid compilation algorithm is borrowed. Compression decisions
 *   are handled by existing summarizationMiddleware (DeepAgents) — see runtime.ts.
 */
```

### 9.4 最小测试清单

- storage：threadId 路径净化、原子写、删除线程时清理物理目录
- recorder：tool_call_id 去重、并发 append、结果上限裁剪、敏感字段脱敏
- compiler：解析 fenced JSON、坏 JSON fallback、`replace` / `write` 两种输出
- injection：`wrapModelCall` 注入不会把 MMD message 写进 checkpoint
- routing：`task_mmd` taskSource 类型与 economy 快速路由
- UI：无 MMD、编译中、编译失败、清空后的状态

### 9.5 参考链接

- 本仓压缩链路总枢纽：[runtime.ts:2071–2096](../src/main/agent/runtime.ts#L2071)
- summarization 自定义 prompt：[runtime.ts:395](../src/main/agent/runtime.ts#L395)
- read_file 输入截断：[read-file-output.ts](../src/main/agent/read-file-output.ts) + [read-file-tool.ts](../src/main/agent/read-file-tool.ts)
- routing context guard：[routing/index.ts:683](../src/main/routing/index.ts#L683)
- 源 MMD 核心：`C:\ai\TencentDB-Agent-Memory\src\offload\pipelines\l2-mermaid.ts`

---

> _本调研建议落地路径：先做 spike（0.5d）→ 实现 task-mmd 一期（约 4.5d）→ 在长 thread 实测 7 天观察 prompt cache 命中率与用户反馈 → 决定是否做二期（node_id 钻取）。_
