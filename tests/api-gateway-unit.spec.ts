/**
 * Unit tests for the remote HTTP API gateway's dependency-free pieces:
 *  - security gating in config.ts (opt-in + token-required floor);
 *  - the per-thread stream-sink registry (the SSE tap plumbing);
 *  - the forced-yolo run-flag registry.
 *
 * The full HTTP → SSE → agent path needs the Electron runtime and a real model,
 * so it is exercised in-app; here we lock down the parts that must be correct
 * regardless of the runtime.
 */

import { readApiGatewayConfig, apiGatewayStartBlockReason } from "../src/main/api/config"
import {
  registerAgentStreamSink,
  hasAgentStreamSink,
  forwardAgentStreamToSinks
} from "../src/main/agent/agent-stream-sinks"
import { setForcedYoloThread, isForcedYoloThread } from "../src/main/agent/api-run-flags"
import { createOpenAiStreamEncoder } from "../src/main/api/openai-stream"

let passed = 0
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
  passed++
}

// ── config.ts: on-by-default gating, optional token ─────────────────────────
{
  const dflt = readApiGatewayConfig({})
  assert(dflt.enabled === true, "ON by default when CMB_API_ENABLED unset")
  assert(dflt.host === "0.0.0.0", "default host is network-reachable (machine IP)")
  assert(dflt.port === 8765, "default port 8765")
  assert(dflt.token === "", "no token by default (open access)")
  assert(apiGatewayStartBlockReason(dflt) === null, "default config is cleared to start")

  const off = readApiGatewayConfig({ CMB_API_ENABLED: "0" })
  assert(off.enabled === false, "'0' disables")
  assert(
    apiGatewayStartBlockReason(off) === "disabled via CMB_API_ENABLED",
    "explicitly disabled gateway is blocked"
  )
  assert(readApiGatewayConfig({ CMB_API_ENABLED: "false" }).enabled === false, "'false' disables")
  assert(readApiGatewayConfig({ CMB_API_ENABLED: "" }).enabled === true, "empty string stays ON")

  const withToken = readApiGatewayConfig({ CMB_API_TOKEN: "s3cr3t" })
  assert(withToken.token === "s3cr3t", "token read from env")
  assert(apiGatewayStartBlockReason(withToken) === null, "token does not change start gating")

  const custom = readApiGatewayConfig({
    CMB_API_HOST: "127.0.0.1",
    CMB_API_PORT: "9000",
    CMB_API_TOKEN: "  padded  "
  })
  assert(custom.host === "127.0.0.1" && custom.port === 9000, "host/port overrides honored")
  assert(custom.token === "padded", "token is trimmed")

  const badPort = readApiGatewayConfig({ CMB_API_PORT: "not-a-port" })
  assert(badPort.port === 8765, "invalid port falls back to default")
}
console.log("PASS config gating")

// ── agent-stream-sinks: the SSE tap plumbing ────────────────────────────────
{
  const threadId = "thread-A"
  assert(hasAgentStreamSink(threadId) === false, "no sink before registration")
  forwardAgentStreamToSinks(threadId, "agent:stream:thread-A", { type: "x" }) // must not throw

  const received: unknown[] = []
  const unsubscribe = registerAgentStreamSink(threadId, (_ch, payload) => received.push(payload))
  assert(hasAgentStreamSink(threadId) === true, "sink present after registration")

  forwardAgentStreamToSinks(threadId, "agent:stream:thread-A", { type: "chunk", i: 1 })
  forwardAgentStreamToSinks(threadId, "agent:stream:thread-A", { type: "done" })
  assert(received.length === 2, "sink received both payloads")
  assert((received[1] as { type: string }).type === "done", "terminal payload delivered")

  // Isolation: a second thread's forward must not reach thread-A's sink.
  forwardAgentStreamToSinks("thread-B", "agent:stream:thread-B", { type: "chunk" })
  assert(received.length === 2, "cross-thread forward does not leak")

  unsubscribe()
  assert(hasAgentStreamSink(threadId) === false, "sink gone after unsubscribe")
  forwardAgentStreamToSinks(threadId, "agent:stream:thread-A", { type: "late" })
  assert(received.length === 2, "no delivery after unsubscribe")

  // Idempotent unsubscribe.
  unsubscribe()
  assert(hasAgentStreamSink(threadId) === false, "double unsubscribe is safe")
}
console.log("PASS stream sink registry")

// ── multi-sink + throwing-sink isolation ────────────────────────────────────
{
  const threadId = "thread-multi"
  const a: unknown[] = []
  const b: unknown[] = []
  const offThrow = registerAgentStreamSink(threadId, () => {
    throw new Error("boom")
  })
  const offA = registerAgentStreamSink(threadId, (_ch, p) => a.push(p))
  const offB = registerAgentStreamSink(threadId, (_ch, p) => b.push(p))

  forwardAgentStreamToSinks(threadId, "agent:stream:thread-multi", { type: "chunk" })
  assert(a.length === 1 && b.length === 1, "a throwing sink does not block the others")

  offThrow()
  offA()
  offB()
  assert(hasAgentStreamSink(threadId) === false, "all sinks cleared")
}
console.log("PASS multi-sink isolation")

// ── api-run-flags: forced yolo per thread ───────────────────────────────────
{
  const t = "thread-yolo"
  assert(isForcedYoloThread(t) === false, "not forced by default")
  setForcedYoloThread(t, true)
  assert(isForcedYoloThread(t) === true, "forced after set true")
  assert(isForcedYoloThread("other") === false, "flag is per-thread")
  setForcedYoloThread(t, false)
  assert(isForcedYoloThread(t) === false, "cleared after set false")
}
console.log("PASS forced-yolo flags")

// ── OpenAI-compatible stream encoder ────────────────────────────────────────
{
  const enc = createOpenAiStreamEncoder("54d3-28cb", 1700000000)
  const msg = (id: string, kwargs: Record<string, unknown>, meta: Record<string, unknown> = {}) => ({
    type: "stream",
    mode: "messages",
    data: [{ lc: 1, type: "constructor", id: ["langchain_core", "messages", id], kwargs }, meta]
  })

  // Noise is dropped: full-state snapshots and custom events encode to "".
  assert(enc.encode({ type: "stream", mode: "values", data: {} }) === "", "values snapshot dropped")
  assert(
    enc.encode({ type: "custom", data: { type: "routing_result" } }) === "",
    "custom event dropped"
  )

  // First text delta carries role:"assistant" + content, and the model name.
  const first = enc.encode(msg("AIMessageChunk", { content: "你好" }, { ls_model_name: "glm-4.7" }))
  assert(first.startsWith("data: "), "frame is an SSE data line")
  const firstObj = JSON.parse(first.slice(6))
  assert(firstObj.object === "chat.completion.chunk", "openai chunk object")
  assert(firstObj.model === "glm-4.7", "model name picked from metadata")
  assert(firstObj.choices[0].delta.role === "assistant", "first delta sets role")
  assert(firstObj.choices[0].delta.content === "你好", "first delta carries content")

  // Subsequent text delta omits role.
  const second = JSON.parse(enc.encode(msg("AIMessageChunk", { content: "世界" })).slice(6))
  assert(second.choices[0].delta.role === undefined, "later delta has no role")
  assert(second.choices[0].delta.content === "世界", "later delta content")

  // Empty content (thinking tokens) encodes to nothing.
  assert(enc.encode(msg("AIMessageChunk", { content: "" })) === "", "empty content dropped")

  // Tool call delta → openai tool_calls shape.
  const tc = JSON.parse(
    enc
      .encode(
        msg("AIMessageChunk", {
          content: "",
          tool_call_chunks: [{ index: 0, id: "call_1", name: "code_exec", args: '{"code"' }]
        })
      )
      .slice(6)
  )
  assert(tc.choices[0].delta.tool_calls[0].function.name === "code_exec", "tool call name")
  assert(tc.choices[0].delta.tool_calls[0].function.arguments === '{"code"', "tool call args delta")
  assert(tc.choices[0].delta.tool_calls[0].type === "function", "tool call type")

  // Tool result (ToolMessage) → role:"tool" chunk.
  const tr = JSON.parse(
    enc
      .encode(msg("ToolMessage", { tool_call_id: "call_1", name: "code_exec", content: "42" }))
      .slice(6)
  )
  assert(tr.choices[0].delta.role === "tool", "tool result role")
  assert(tr.choices[0].delta.content === "42", "tool result content")
  assert(tr.choices[0].delta.tool_call_id === "call_1", "tool result id")

  // Finish emits a stop chunk then [DONE].
  const fin = enc.finish()
  assert(fin.includes('"finish_reason":"stop"'), "finish has stop reason")
  assert(fin.trimEnd().endsWith("data: [DONE]"), "stream ends with [DONE]")

  // content as an array of text blocks is flattened.
  const enc2 = createOpenAiStreamEncoder("t", 1700000000)
  const blocks = JSON.parse(
    enc2.encode(msg("AIMessageChunk", { content: [{ type: "text", text: "块" }] })).slice(6)
  )
  assert(blocks.choices[0].delta.content === "块", "array content flattened to text")
}
console.log("PASS openai stream encoder")

console.log(`\nAll api-gateway unit checks passed (${passed} assertions).`)
