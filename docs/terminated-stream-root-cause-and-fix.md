# `TypeError: terminated` 根因与 CmbCowork 修复方案

## 结论

`TypeError: terminated` 不是 `write_file` 本地写盘失败，也不是 HarnessBoard、CloudReporter、hook 或 trace 上传导致的错误。它的直接含义是：模型 API 的流式响应在读取 body/SSE 的过程中被中途终止。

在 CmbCowork 当前链路里，这个错误发生在 LangChain/OpenAI SDK 消费模型流时，被 LangChain 包成 `MiddlewareError` 后抛到 Agent 层。因为 CmbCowork 的 API 错误分类器没有把 `terminated` 识别为可重试网络错误，且 pinned 模式下通常没有剩余 failover candidate，最终直接中断本轮。

## 为什么大文件 `write_file` 几乎必现

大文件写入时，模型不是把文件“直接写到磁盘”。它必须先把完整文件内容作为 tool call 参数从模型响应流里吐出来，例如：

```json
{
  "file_path": "...",
  "content": "几百 KB 到几 MB 的完整文件内容"
}
```

所以大文件 `write_file` 会同时放大三类风险：

1. **单次 SSE 输出很长**：模型需要持续输出一个巨大的 JSON 参数，连接越长越容易被 provider、网关、代理或 Node/undici 中途切断。
2. **JSON 字符串更脆弱**：大段内容要经过转义、分片、合并、解析，任何半截字符串或半截括号都可能变成 malformed/truncated tool call。
3. **成功后的上下文污染**：如果完整 `write_file.args.content` 被保留在 assistant tool call 历史里，下一次请求又会把这段大内容带回模型 API，导致后续请求继续膨胀，更容易再次断流。

CmbCowork 已经有 malformed tool call 防护，见 [`src/main/agent/malformed-tool-call-recovery.ts`](../src/main/agent/malformed-tool-call-recovery.ts)，它能阻止部分“半截 tool args 被误当成正常 args 执行”的问题。但 `terminated` 本身仍然需要 stream-level 的错误分类和重试。

## CmbCowork 当前缺口

### 1. fetch retry 只覆盖到响应头之前

`createRetryingFetch` 的 per-attempt timeout 在拿到 response headers 后就清理掉，后续 stream body 由 SDK/LangChain 消费：

[`src/main/agent/runtime.ts`](../src/main/agent/runtime.ts)

```ts
const res = await fetch(input, { ...init, signal: attemptCtrl.signal })
cleanup()
return res
```

这意味着：如果连接已经建立、headers 已返回，但 SSE body 读到一半断了，`createRetryingFetch` 不会再接管重试。

### 2. `terminated` 没有被归类为网络错误

当前网络错误 token 包含：

[`src/main/agent/failover.ts`](../src/main/agent/failover.ts)

```ts
const NETWORK_MESSAGE_TOKENS = [
  "fetch failed",
  "socket hang up",
  "network error",
  "timeout"
]
```

`RETRYABLE_MESSAGE_PATTERNS` 也没有 `terminated` / `stream closed` / `disconnected`。所以：

```ts
new TypeError("terminated")
```

会被归类为 `unknown`，`isRetryableApiError()` 返回 `false`。

### 3. pinned 模式下中途断流没有同模型重试

CmbCowork 当前已经有 mid-stream failover 框架：

[`src/main/ipc/agent.ts`](../src/main/ipc/agent.ts)

```ts
try {
  await consumeStreamWithSideEffects(activeStream)
  break
} catch (midStreamErr) {
  if (!isRetryableApiError(midStreamErr) || remainingCandidates.length === 0) {
    throw midStreamErr
  }
  activeStream = await agent.stream(null, streamConfig)
}
```

问题在于：

- `terminated` 不是 retryable，所以第一关就失败。
- pinned 模式默认只使用用户选定模型，`buildOrderedChain(..., invokeRoutingResult?.layer !== "pinned")` 会关闭自动 fallback。
- 因此 pinned 模式下 `remainingCandidates.length` 往往为 0，即使把 `terminated` 标成 retryable，也仍然可能直接 throw。

## Claude Code 怎么处理

Claude Code 没有靠字符串匹配 `terminated`。它的策略是：

1. 流式请求中途失败时，捕获 streaming error。
2. 清理当前 assistant message、半截 tool use、半截 tool result 等部分状态。
3. 触发 streaming fallback，改走 non-streaming request。
4. non-streaming request 再进入统一 `withRetry` 框架。
5. 对 `APIConnectionError`、超时、`ECONNRESET`、`EPIPE`、5xx、429 等错误做重试。

这个方案的重点不是识别 `terminated` 这个字符串，而是把“stream body 读失败”视为一类可恢复错误，并在恢复前清掉半截状态，避免 tool call 不成对或污染历史。

优点：

- 对 provider/gateway 的中途断流比较稳。
- non-streaming fallback 能绕开部分 SSE 质量问题。
- 半截 assistant/tool 状态会被清理。

代价：

- 实现复杂度较高。
- 需要同时维护 streaming 与 non-streaming 两套路径。
- 对 CmbCowork 当前 LangGraph/deepagents 链路来说，直接照搬成本偏大。

## Codex 怎么处理

Codex 的处理更明确：它把“响应流中途断开”定义成协议级错误。

核心做法：

1. 区分建连失败和流中途断开：
   - `ResponseStreamConnectionFailed`
   - `ResponseStreamDisconnected`
   - `ResponseTooManyFailedAttempts`
2. 要求收到完整完成事件才算成功，例如 Responses API 的 `response.completed`。
3. 如果 stream 返回错误，或 stream 提前结束但没收到完成事件，就返回 `CodexErr::Stream`。
4. `CodexErr::Stream` 是 retryable。
5. 外层 turn loop 按 `stream_max_retries` 重试整个 sampling request，默认 5 次。
6. 半截 text/tool delta 可以展示到 UI，但只有完整 item done/completed 后才会进入会话历史。

这套方案非常适合 `terminated` 这类问题，因为它不关心底层错误叫 `terminated`、`ECONNRESET` 还是 early close。只要完成事件没到，就认为本次响应不完整，必须重试或报 `ResponseStreamDisconnected`。

优点：

- 语义最清楚。
- 对“流提前结束但没有抛明显异常”的情况也能兜住。
- 半截 tool call 不会进入模型历史。

代价：

- 需要协议层 completion marker。
- 需要把当前 streaming 消费与状态持久化拆得更细。
- 对 CmbCowork 当前 LangChain/deepagents 接入来说，完整照搬属于偏重改造。

## opencode 怎么处理

opencode 介于 Claude Code 和 Codex 之间。

它使用 Vercel AI SDK 的 `streamText`，并把 SDK 自己的 `maxRetries` 设为 0，然后在 SessionProcessor 外层包 `Effect.retry(SessionRetry.policy(...))`。

核心做法：

1. stream 抛错后进入 session 级 retry。
2. retry 是否发生取决于 `MessageV2.fromError()` 解析出的错误是否是 retryable。
3. 它显式把以下错误转成 retryable APIError：
   - `ECONNRESET`
   - 响应解压失败 `ZlibError`
   - provider SDK 标记为 retryable 的 `APICallError`
   - HTTP 5xx
   - rate limit / overloaded 等文本模式
4. 它有 `chunkTimeout`，可以配置 SSE chunk 间隔超时，避免流挂死。
5. 它忽略 `tool-input-delta`，只有最终完整 `tool-call` 才把 input 写进 part。

不足：

- 没看到它显式处理裸 `TypeError("terminated")`。
- 也没有像 Codex 那样定义“完成事件没到就是 stream disconnected”。
- `write` 工具依然是 `content + filePath` 巨型 JSON 参数；`apply_patch` 也是 `patchText` 字符串参数，不是 freeform。

所以 opencode 对一部分网络错误比 CmbCowork 更稳，但对 `terminated` 这个具体错误不是最彻底的答案。

## CmbCowork 推荐方案

目标：不过度设计，不引入完整 non-streaming fallback，不重写 deepagents，不做复杂 resumable SSE 协议，但要解决当前 `terminated` 和大文件写入高概率失败。

建议分两步做。

## 第一步：必须修，低成本兜住 `terminated`

### 1. 增加 stream disconnect 分类

在 [`src/main/agent/failover.ts`](../src/main/agent/failover.ts) 增加一个小函数：

```ts
function isStreamDisconnectLikeError(error: unknown): boolean {
  if (!error) return false
  const name = error instanceof Error ? error.name : ""
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  const code = typeof (error as { code?: unknown }).code === "string"
    ? String((error as { code?: unknown }).code)
    : ""

  if (name === "AbortError") return false
  if (message.includes("user abort") || message.includes("controller is already closed")) return false

  return (
    message === "terminated" ||
    /\bterminated\b/.test(message) ||
    /\bstream\b.*\b(closed|disconnected|terminated|reset)\b/.test(message) ||
    /\b(premature close|body stream|other side closed)\b/.test(message) ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_BODY_TIMEOUT"
  )
}
```

然后：

- `classifyApiError()` 命中时返回 `network_error`。
- `isRetryableApiError()` 命中时返回 `true`。
- 保持 `AbortError`、用户主动取消、`Controller is already closed` 仍然不可重试。

验收测试：

```ts
expect(classifyApiError(new TypeError("terminated"))).toBe("network_error")
expect(isRetryableApiError(new TypeError("terminated"))).toBe(true)
expect(isRetryableApiError(new DOMException("Aborted", "AbortError"))).toBe(false)
```

### 2. 增加 mid-stream 同模型重试

当前 mid-stream catch 只有在 `remainingCandidates.length > 0` 时才继续。建议增加一个独立的 stream retry budget，例如：

```ts
const STREAM_DISCONNECT_MAX_RETRIES = 2
let streamDisconnectRetries = 0
```

中途断流时处理顺序改成：

1. 用户取消：直接 throw。
2. 非 retryable：直接 throw。
3. retryable 且 `streamDisconnectRetries < STREAM_DISCONNECT_MAX_RETRIES`：
   - `streamDisconnectRetries += 1`
   - UI 发送“正在重连当前模型”的 retry 状态。
   - 等待指数退避，例如 500ms、1500ms。
   - 使用当前 agent 的 checkpoint resume：

```ts
activeStream = await agent.stream(null, streamConfig)
continue
```

4. 同模型 stream retry 耗尽后，如果还有 `remainingCandidates`，再走现有 failover。
5. 仍失败才 throw。

这样 pinned 模式也能恢复，因为它不依赖 `remainingCandidates`。

注意点：

- 不要重新发送原始 HumanMessage，避免重复用户输入。
- 使用现有 `agent.stream(null, streamConfig)` resume 语义，和当前 failover 代码保持一致。
- 每次 retry 前清掉 `latestSerializedValuesMessagesForGoalFlush` 这类只属于失败流的缓存。
- 给 trace/failover 记录增加 `kind: "stream-retry"`，方便排查。

### 3. 对大 `write_file` / `edit_file` 参数做请求侧脱敏

即使第一次写成功，后续请求如果继续携带几百 KB 的 `write_file.args.content`，还是会让上下文和请求体膨胀。

建议在“发给模型前”的消息 sanitize 层做 request-only 处理，不改磁盘历史：

- `write_file.args.content` 超过 32KB 或 64KB 时替换为占位文本。
- `edit_file.args.new_string` / `old_string` 超过阈值时替换为占位文本。
- 保留 tool name、tool_call_id、file_path、长度、sha256、前后少量预览。
- tool result 保持短文本即可。

示例占位：

```json
{
  "file_path": "/path/to/file.md",
  "content": "[large write_file content omitted after successful execution; length=812344; sha256=...]"
}
```

这样不会破坏 tool call/result 配对，也能显著降低下一轮请求再次 `terminated` 的概率。

这一步可以复用 [`malformed-tool-call-recovery.ts`](../src/main/agent/malformed-tool-call-recovery.ts) 里“只改 outgoing request，不重写历史”的设计原则。

## 第二步：建议做，用小工具解决大文件单次巨参

如果 CmbCowork 经常生成大型设计文档、代码文件、报告，单靠 stream retry 仍然可能治标不治本。因为 provider 如果对单次 SSE/tool args 有隐形上限，重试多次也可能在同一位置断。

建议增加一个非常小的 chunk 写入工具，不做复杂协议：

```ts
write_file_chunk({
  file_path: string,
  mode: "create" | "append",
  content: string,
  final?: boolean,
  expected_sha256?: string,
  expected_length?: number
})
```

规则：

- 单个 `content` 建议上限 64KB，硬上限 128KB。
- `mode: "create"` 创建新文件，文件已存在则失败，除非显式允许 overwrite。
- `mode: "append"` 只追加到已存在文件。
- `final: true` 时，如果提供 `expected_sha256` / `expected_length`，执行校验。
- tool result 必须短，只返回已写入长度、总长度、校验结果。
- 系统提示中要求：超过 64KB 或超过约 1000 行的新文件，必须使用 `write_file_chunk`，每次只写一个 chunk，等待 tool result 后继续。

这个方案的价值：

- 不需要 non-streaming fallback。
- 不需要改 provider。
- 不需要让模型一次吐出几 MB JSON。
- 单次 tool call 参数被限制在可控范围。
- 失败后可以从最后一个成功 chunk 继续，用户体验比整文件重试好。

这不是第一步的替代，而是解决“大文件几乎 100% 触发”的根治补丁。

## 不建议第一版做的事

以下方案有效，但第一版不建议做，成本和风险偏高：

1. 完整照搬 Claude Code 的 streaming -> non-streaming fallback。
2. 完整照搬 Codex 的 response completed 协议与 item-level persistence。
3. 重写 deepagents / LangGraph checkpoint。
4. 直接修改历史数据库里的旧 tool call 参数。
5. 对所有 `Error` 都盲目 retry。

## 推荐实施顺序

### PR 1：让 `terminated` 不再直接炸

范围：

- `failover.ts` 增加 stream disconnect 分类。
- `ipc/agent.ts` 增加 mid-stream 同模型 retry。
- 增加单元测试和一个模拟断流的集成测试。

验收：

- `TypeError("terminated")` 分类为 `network_error`。
- pinned 模式下，模拟 active stream 先抛 `terminated`，第二次 `agent.stream(null, streamConfig)` 成功，本轮不失败。
- 用户主动 Abort 不被 retry。

### PR 2：降低大文件写入后的二次爆炸

范围：

- outgoing request sanitize：大 `write_file.content` / `edit_file.old_string/new_string` 替换为占位。
- 保持 tool call/result 配对。
- trace 中记录原始长度和 sha256，不记录完整内容。

验收：

- 成功写入 500KB 文件后，下一次发给模型的请求不再包含 500KB `content`。
- 模型仍能看到文件路径、写入成功结果、长度和校验摘要。

### PR 3：如果大文件生成是高频场景，增加 `write_file_chunk`

范围：

- 增加 chunk 写入工具。
- 接入权限、trace、adoption、file mutation hook。
- 系统提示要求大文件使用 chunk 写入。

验收：

- 1MB 文档能通过多个 64KB chunk 写入。
- 任意单次 tool args 不超过上限。
- 中途断流后重试不会从头重发整文件。

## 最小代码改动摘要

最小可用版本只需要三处：

1. [`src/main/agent/failover.ts`](../src/main/agent/failover.ts)
   - 新增 `isStreamDisconnectLikeError()`。
   - `classifyApiError()` 返回 `network_error`。
   - `isRetryableApiError()` 返回 `true`。

2. [`src/main/ipc/agent.ts`](../src/main/ipc/agent.ts)
   - mid-stream catch 中加入同模型 `agent.stream(null, streamConfig)` retry。
   - retry 次数 2 次即可。
   - 同模型 retry 耗尽后再尝试现有 failover。

3. request sanitize middleware
   - 对已完成的大 `write_file` / `edit_file` tool args 做 request-only elision。
   - 不改历史文件，不破坏 tool pairing。

这三处做完，当前日志里的 `TypeError: terminated` 就不会再作为 unknown fatal error 直接打断；大文件写入后续请求也不会反复携带巨型 tool args。若还要从根上降低“大文件单次输出过长”的概率，再补 `write_file_chunk`。
