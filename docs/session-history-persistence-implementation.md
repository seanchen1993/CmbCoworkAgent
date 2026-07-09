# 会话历史持久化根治方案实现说明

## 背景

动态工作流会产生大量 LangGraph checkpoint namespace，尤其是 `tools:*`、workflow/subagent 内部 namespace。旧实现把主线程 root namespace 和这些内部 namespace 使用同一个保留数，主线程设置为 30 后，内部 namespace 也会各自保留 30 份 checkpoint。

sql.js 会一次性把 SQLite 文件加载到内存。checkpoint 数据库超过 100MB 后，旧逻辑为了避免内存风险会把 live DB 改名为 `.bak.<timestamp>`，再创建一个新的空 DB。UI 恢复会话历史又依赖 latest checkpoint 的 `channel_values.messages`，所以 live checkpoint DB 被换新后，用户可见 transcript 也会表现为“历史不全/问题丢失”。

自动继续动态工作流是预期 feature，本方案不改变自动继续行为。

## 设计目标

1. 用户可见会话历史不能依赖 checkpoint 是否仍然完整。
2. checkpoint 继续服务运行时 resume、fork、HITL pending approval、todos 等状态。
3. 动态工作流、coordinator worker、subagent 内部消息不能污染主会话 transcript。
4. fork、导出、恢复都使用同一套可见 transcript 口径。
5. checkpoint DB 继续做体积控制，避免再次触发 100MB 换库导致的连锁问题。

## 总体方案

会话历史和运行时 checkpoint 解耦：

- 主数据库新增 `thread_messages` 表，作为用户可见 transcript 的权威存储。
- 主进程在 stream 消费路径中持续写入用户消息和主流程 assistant/system/tool 消息。
- 渲染端在 live stream flush 时，把已经过 UI 过滤和时间补全的消息批量 upsert 到主库，作为最终校准。
- 渲染端恢复历史时会合并 checkpoint transcript 和 `thread_messages`。checkpoint 能读到时提供旧历史基准，`thread_messages` 覆盖同 ID 消息并补充 checkpoint 缺失的新消息；checkpoint 读不到时才只使用 `thread_messages`。
- checkpoint 仍用于 runtime resume、fork 边界、pending approval、todos 等运行时状态。

## 数据模型

新增表位于 `src/main/db/index.ts`：

```sql
CREATE TABLE IF NOT EXISTS thread_messages (
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
  content_json TEXT NOT NULL,
  tool_calls_json TEXT,
  tool_call_id TEXT,
  name TEXT,
  status TEXT,
  is_error INTEGER,
  goal_id TEXT,
  active_window_id TEXT,
  created_at INTEGER NOT NULL,
  start_at INTEGER,
  end_at INTEGER,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(thread_id, message_id)
)
```

关键点：

- `PRIMARY KEY(thread_id, message_id)` 保证主进程和渲染端双写时幂等。
- `ordinal` 固定首次插入顺序，后续同 ID 更新不改变显示顺序。
- `content_json` 支持字符串和 content block 数组。
- `tool_calls_json`、`tool_call_id`、`name`、`status`、`is_error` 保留工具调用显示需要的元数据。
- `goal_id/active_window_id` 保留 goal 控制命令的去重身份，兼容旧数据缺少该字段时的内容和时间兜底匹配。
- `start_at/end_at` 保留 UI 时间线需要的时间信息。

`deleteThread()` 显式删除 `thread_messages`，避免主库残留孤儿 transcript。

## 写入链路

### 主进程实时落盘

位置：`src/main/ipc/agent.ts`

主进程覆盖三条主要 stream 路径：

- 普通 `agent:invoke`
- HITL resume
- interrupt approve/continue

实现方式：

- 用户消息通过 `persistVisibleUserTranscriptMessage()` 写入。
- stream 消息通过 `persistStreamTranscriptChunk()` 写入。
- 明显的 worker/subagent 内部 namespace 会跳过。
- workflow/coordinator 内部通知不会作为用户消息落盘。

自检中修正过一个边界：用户如果粘贴 workflow/coordinator 内部标记文本，主进程会把模型输入改写为“普通用户输入”的安全文本。持久 transcript 现在也保存这份去武器化后的文本，而不是保存会被 UI/导出过滤掉的内部 marker。

### 渲染端最终校准

位置：`src/renderer/src/lib/thread-context.tsx`

`flushLiveStreamAccumulator()` 生成最终 `messagesToAppend` 后调用：

```ts
window.api.threads.appendMessages(threadId, messagesToAppend)
```

这些消息已经经过现有 UI 过滤逻辑：

- internal goal prompt 不进入主 transcript。
- goal 系统提示 artifact 不进入主 transcript。
- subagent 内部 transcript 不进入主 transcript。
- message times 已补全。

主进程实时落盘解决“关闭/重启时至少有内容”，渲染端最终校准解决“最终展示口径与 UI 一致”。

## 恢复链路

位置：`src/renderer/src/lib/thread-context.tsx`

恢复顺序：

1. 读取 thread metadata、thread_values、goal events。
2. 调用 `window.api.threads.getMessages(threadId)` 读取主库 transcript。
3. 读取 latest checkpoint，恢复 checkpoint transcript、todos、HITL pending approval 等运行时状态。
4. 用 `thread_messages` 覆盖 checkpoint transcript 中同 ID 的消息，并把 checkpoint 之后或 checkpoint 缺失的新表消息追加进 transcript。
5. 如果 checkpoint 为空或不可读，则只使用 `thread_messages` 和 goal events 恢复 transcript。

这样 checkpoint 被裁剪、压缩、备份、换新，都不会再直接导致 UI 会话历史丢失。

这个合并策略也避免升级后的老线程出现“部分落库”问题：老历史仍来自 checkpoint，新一轮已写入 `thread_messages` 的消息会补进来；后续导出和 fork 使用同样思路。

## Runtime tail 对齐

位置：

- `src/main/ipc/thread-runtime-tail.ts`
- `src/main/ipc/agent.ts`
- `src/renderer/src/lib/thread-context.tsx`

`thread_messages` 可能比 latest checkpoint 更新：例如 stream 消息已经进入主库，但窗口关闭时 checkpoint 还没写完。为了避免“UI/导出看得到，模型继续时看不到”的分裂语义，普通 `agent:invoke` 在创建本轮输入前会：

1. flush 当前线程仍在内存队列中的 stream transcript。
2. 读取 latest checkpoint 的可见 message id。
3. 从 `thread_messages` 找出 checkpoint 最后一个可见消息之后的 durable tail。
4. 把这段 tail 显式转换成 LangChain `HumanMessage/AIMessage/SystemMessage/ToolMessage`，prepend 到本轮用户消息之前。

这样用户重开应用后继续提问时，模型上下文会包含 UI 已经展示的 checkpoint 后历史。workflow/coordinator 内部通知仍通过共享过滤逻辑排除，不会进入 runtime tail。

HITL resume 语义更严格：如果 checkpoint 后已经存在 durable tail，说明旧 checkpoint interrupt 对当前 UI 历史已经过期，`agent:resume` 会拒绝继续旧审批并提示重新发送请求。renderer 恢复 pending approval 时会直接把 checkpoint 后的可见 durable tail 视为过期信号；同时也把所有可见 `thread_messages` 的最新时间纳入 stale boundary notice 判定，避免恢复对当前 UI 来说已经过时的审批卡片。

## Fork 与导出

位置：`src/main/ipc/threads.ts`

fork 时仍以 checkpoint 判定稳定边界，并使用 `deriveCheckpointTranscriptIndex()` 得到可见 message id 列表。创建目标线程后，会先从 fork checkpoint 转换出边界内的可见消息，再用源线程 `thread_messages` 中同 ID 消息覆盖。checkpoint 里的 `cmb_visible_user_message` 会优先作为用户可见内容，避免把内部 goal prompt 原文写进目标线程。这样源线程即使只有部分新表消息，目标线程也不会因为新表非空而丢失 checkpoint 中的旧历史。

最新 checkpoint 后存在 durable tail 时，右键 checkpoint fork、消息级 fork 和最终 `forkThread()` 会先构造同一份只读“物化 fork tuple”：

1. 按 checkpoint 可见 message id 和主库 `ordinal` 找出真正的 durable tail。
2. 使用 runtime continuation 相同的 `HumanMessage/AIMessage/SystemMessage/ToolMessage` 转换逻辑，把尾部追加进 fork checkpoint 的 `messages` channel。
3. 更新物化 tuple 中 fork boundary 的 `lastVisibleMessageId`，但不回写、不修改源 checkpoint。
4. 右键列表、消息 resolver 和最终 fork 都从这份物化 tuple 建立稳定边界，目标 checkpoint 与目标 `thread_messages` 因而包含完全相同的 transcript。

如果尾部存在缺少 `tool_call_id` 等无法安全转换的数据，或追加后仍不是完整的 assistant/中断 tool 边界，三个入口都会统一拒绝。物化还限制为最多 1000 条、UTF-8 序列化后最多 8MB；超过上限时排除不安全的 latest、保留历史 checkpoint，避免重新制造超大 checkpoint。历史 checkpoint 不追加当前 durable tail，仍严格按用户选择的历史边界截断。

fork 复制历史 checkpoint 时按有序 `visibleMessageIds` 去重；消息集合相同但顺序不同不会误判为同一 transcript。去重或稳定性过滤移除父 checkpoint 后，子 checkpoint 的 parent 会沿原复制链重映射到最近仍被复制的祖先；找不到祖先时转为目标根节点，不会留下指向源库或已删除 checkpoint 的悬空引用。写入历史前通过 saver 公共 `getTuple()` 检查目标是否已存在，重复调用不会再次触发 prune。

默认 latest fork 的 legacy fallback 只用于真正的旧会话：只要线程 metadata 已带 `cmbForkBoundaryVersion`，或任一 root checkpoint 已出现 `cmb_fork_boundary`，未标记的 latest checkpoint 就不会被当成稳定边界。agent invoke/resume/interrupt 在创建运行 checkpoint 前会幂等写入该线程级 marker-era 标记，避免当前版本运行取消或 marker 写入失败时误走 legacy fallback。

fork overrides 会做一致性校验：`agentMode` 只能是 `normal/coordinator/workflow`；`workspacePath` override 只能是非空字符串或 `null`；目标为 `workflow/coordinator` 时必须有存在的工作区路径，避免创建成功但后续 runtime 无法启动的线程。

fork 会复制源线程的 goal state 和 goal events 到目标线程，保证 checkpoint 中隐藏的 goal runtime prompt、UI goal 面板和 goal 命令去重使用同一套状态。复制后的 goal 归属目标线程，但保留 `goal_id/active_window_id` 以维持去重身份。

导出会话时同样先按 checkpoint 的可见 message id 转成 transcript，再与 `thread_messages` 合并。checkpoint 不可用时才只导出 `thread_messages`。

## Message ID 与关闭托盘一致性

流式 assistant ID 被 provider 最终 ID 替换时，主库先在事务内完成别名迁移，renderer 收到成功结果后才更新 committed messages、live accumulator 和 stream snapshot。目标 ID 已存在时使用确定性合并：目标 ID 的最终字段优先，源消息只补充目标缺失字段，逻辑位置保持两条记录中更早的位置。跨 role 的 ID 碰撞会同时在 renderer 和主库拒绝，不删除任一行；开始时间取两者最早值、结束时间取最晚值。alias 与逻辑索引 Map/Set 均有容量上限，alias 重写使用 entries 快照，不在 Map 活跃迭代器上修改。

关闭托盘提示使用共享的 `open/dismiss` 联合事件协议。超时由主进程发送匹配 `requestId` 的 `dismiss`，renderer 只关闭同一请求；组件卸载仅注销监听，不再伪造 `cancel`。监听组件固定挂载在 renderer root，不随 `App` 的 loading/权限/正常视图分支切换而卸载。关闭或最小化前等待下一次绘制仍保留，同时增加 250ms 兜底，后台窗口不会无限等待 `requestAnimationFrame`。

## Checkpoint 体积控制

位置：

- `src/main/checkpointer/sqljs-saver.ts`
- `src/main/agent/runtime.ts`

调整内容：

- root namespace 和 non-root namespace 分开保留。
- 主线程 root namespace 只保留最近 3 个，用于 runtime resume 和最近 checkpoint fork 边界。
- non-root namespace 保留 1，避免 `tools:*`、workflow/subagent 内部 namespace 膨胀。
- oversized live DB 不再立即换新；会先尝试 integrity check、按 namespace 裁剪、`VACUUM`、原子写回。
- 只有压缩失败或超过恢复上限时，才备份 live DB 并创建新 DB。
- `SqlJsSaver.flushStrict()` 复用普通 flush 的串行化 drain 入口；并发 strict flush / close 不会提前释放 `blockAsyncWrite`，严格 flush 的持久化失败仍会向调用方抛出。
- `SqlJsSaver.list()` 使用 `try/finally` 释放 prepared statement，避免 fork checkpoint 列表/消息 fork resolver 提前 return 时泄漏 sql.js statement。

## 自我检视结论

已重点检查以下风险：

- transcript 和 checkpoint 恢复顺序：checkpoint 只提供运行时基线，主库 transcript 始终会补齐 checkpoint 后续新消息。
- fork 截断：目标线程只复制 checkpoint 可见边界内的 message id。
- fork durable tail：latest fork 会把可安全转换的 DB tail 物化进目标 runtime checkpoint；右键列表、消息 resolver、最终 fork 和目标 transcript 使用同一物化结果，无法安全转换时统一拒绝。
- fork 历史链：transcript 去重保持消息顺序语义，父 checkpoint 被过滤后会重映射到最近保留祖先，不产生悬空 parent id；重复历史写入会跳过已存在 checkpoint。
- fork marker-era：当前版本线程或已经出现 marker 的线程不会把未标记 latest checkpoint 当成稳定边界。
- fork override：目标模式和 workspacePath 会在创建目标线程前校验，避免创建不一致线程。
- fork goal：目标线程会复制 goal state/events，避免 checkpoint 内部 goal prompt 与 UI goal 状态分裂。
- fork 性能：复制 transcript 改为按 message id 查询，tail 检测改为按 ordinal 读取 checkpoint 后消息，不再为了 fork 全量加载长会话 transcript。
- fork UI 一致性：checkpoint 列表和 message resolver 复用真实 fork 的 busy 判定，workflow/coordinator 仍忙时不会把 checkpoint 展示为可 fork。
- 导出可见性：导出也按 checkpoint 可见 message id 过滤，并使用 `cmb_visible_user_message` 还原可见用户文本。
- 内部消息污染：workflow/coordinator/subagent 内部消息不会进入主 transcript。
- 部分落库：已修复恢复、导出、fork 的“新表非空即跳过 checkpoint”问题；恢复/导出会保留 checkpoint 之后的新表消息，fork 仍严格截断到 checkpoint 边界。
- 用户粘贴内部 marker：已修复为保存去武器化文本，避免恢复和导出时被误过滤。
- runtime tail 分裂：已修复“DB transcript 已落盘但 checkpoint 未落盘”时的继续上下文缺口；普通 invoke 会补入 checkpoint 后 tail，旧 HITL resume 会被失效化。
- goal 命令重复：`thread_messages` 已保存 `goal_id/active_window_id`；同时去重逻辑在单侧缺少旧元数据时会按命令内容和时间兜底匹配，避免升级旧数据重复显示。
- checkpoint flush 并发：`flushStrict()` 已串行化并补并发 strict flush/close 回归测试。
- 删除线程：同步删除 `thread_messages`。
- 旧会话兼容：没有主库 transcript 时继续走 checkpoint 旧路径。

剩余注意点：

- 已经被旧逻辑搬到 `.bak.<timestamp>` 的历史不会自动导入 `thread_messages`。如果需要恢复特定已受损会话，应做一次性恢复/导入工具，避免自动扫描大备份文件带来误导入或性能风险。
- 主进程会按 stream chunk 幂等 upsert，sql.js 写入在内存中完成并由现有 debounced save 落盘；高频流式输出下仍需关注主库写入量，但目前测试和类型检查通过。

## 验证

已通过：

- `npm run typecheck`
- `npx tsx tests/thread-messages-db.spec.ts`
- `npx tsx tests/live-stream-messages.spec.ts`
- `npx tsx tests/stream-message-ids.spec.ts`
- `npx tsx tests/thread-fork-handler.spec.ts`
- `npx tsx tests/fork-interruption.spec.ts`
- `npx tsx tests/close-to-tray.spec.ts`
- `npx tsx tests/goal-transcript.spec.ts`
- `npx tsx tests/checkpoint-fork.spec.ts`
- `npx tsx tests/sqljs-saver-async-flush.spec.ts`
- `npx tsx tests/checkpointer-lru.spec.ts`
- `npx tsx tests/thread-checkpoint-cleanup.spec.ts`
- `npx tsx tests/sqlite-durable-delete.spec.ts`
- `npx tsx tests/sandbox-elevated.unit.spec.mjs`
- `npx tsx tests/coordinator-mode-plumbing.spec.ts`

环境型失败：

- `npm run test:workflow` 在当前 Windows 环境卡在 symlink `EPERM`。
- `tests/coordinator-worker-access.spec.ts` 同样卡在 symlink `EPERM`。
- `tests/local-sandbox-readonly-hook.spec.ts` 卡在 PowerShell `$USER` 展开差异。

这些失败点与本次会话历史持久化改动无直接关系。
