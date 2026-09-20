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
import {
  setThreadYoloOverride,
  getThreadYoloOverride,
  setThreadSandboxDisabled,
  isThreadSandboxDisabled
} from "../src/main/agent/api-run-flags"
import { createOpenAiStreamEncoder } from "../src/main/api/openai-stream"
import { ApprovalDecisionBroker } from "../src/main/agent/approval-decision-broker"
import {
  buildApiThreadRuntime,
  remoteAllowedApprovalActions,
  serializePendingApproval
} from "../src/main/api/thread-runtime"
import type { ApprovalDecision, ApprovalRequest } from "../src/main/types"

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

// ── api-run-flags: per-thread yolo override + sandbox disable ───────────────
{
  const t = "thread-yolo"
  assert(getThreadYoloOverride(t) === undefined, "no yolo override by default (use global)")
  setThreadYoloOverride(t, false)
  assert(getThreadYoloOverride(t) === false, "override forces yolo off")
  setThreadYoloOverride(t, true)
  assert(getThreadYoloOverride(t) === true, "override forces yolo on")
  assert(getThreadYoloOverride("other") === undefined, "override is per-thread")
  setThreadYoloOverride(t, undefined)
  assert(getThreadYoloOverride(t) === undefined, "undefined clears the override")

  const s = "thread-sandbox"
  assert(isThreadSandboxDisabled(s) === false, "sandbox enabled by default")
  setThreadSandboxDisabled(s, true)
  assert(isThreadSandboxDisabled(s) === true, "sandbox disabled after set")
  assert(isThreadSandboxDisabled("other") === false, "sandbox flag is per-thread")
  setThreadSandboxDisabled(s, false)
  assert(isThreadSandboxDisabled(s) === false, "sandbox re-enabled after clear")
}
console.log("PASS yolo override + sandbox flags")

// ── OpenAI-compatible stream encoder ────────────────────────────────────────
{
  const enc = createOpenAiStreamEncoder("54d3-28cb", 1700000000)
  const msg = (
    id: string,
    kwargs: Record<string, unknown>,
    meta: Record<string, unknown> = {}
  ) => ({
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

function approvalRequest(input: {
  id: string
  operation?: ApprovalRequest["operation"]
  toolName?: string
  allowed?: ApprovalRequest["allowed_approval_types"]
  args?: Record<string, unknown>
}): ApprovalRequest {
  return {
    id: input.id,
    tool_call: {
      id: `tool-${input.id}`,
      name: input.toolName ?? input.operation ?? "unknown",
      args: input.args ?? {}
    },
    allowed_decisions: ["approve", "reject"],
    safety_level: "needs_approval",
    operation: input.operation,
    cwd: "/workspace",
    allowed_approval_types: input.allowed ?? ["approve", "reject"]
  }
}

// ── live thread state and remote approval policy ────────────────────────────
{
  const inactive = {
    foreground: false,
    workflow: false,
    coordinator: false,
    background_shell: false,
    active: false
  }
  const active = {
    foreground: true,
    workflow: false,
    coordinator: false,
    background_shell: false,
    active: true
  }
  const writeRequest = approvalRequest({ id: "write", operation: "write_file" })
  const gitRequest = approvalRequest({ id: "git", operation: "git_commit" })
  const workflowScript = "export default async function ({ agent }) {\n  await agent('review')\n}\n"
  const workflowRequest = approvalRequest({
    id: "workflow",
    toolName: "workflow",
    args: {
      name: "remote review",
      description: "review the workspace",
      phases: ["inspect", "report"],
      argsPreview: '{"target":"src"}',
      argsReview: '{"target":"src"}',
      tokenBudget: 12000,
      scriptPreview: workflowScript
    }
  })
  const incompleteWorkflowRequest = approvalRequest({
    id: "workflow-incomplete",
    toolName: "workflow",
    args: { name: "hidden script" }
  })
  const truncatedWorkflowRequest = approvalRequest({
    id: "workflow-truncated-args",
    toolName: "workflow",
    args: {
      name: "hidden args tail",
      description: "review the workspace",
      phases: ["inspect"],
      argsPreview: `${"x".repeat(800)}\n…`,
      tokenBudget: 12000,
      scriptPreview: workflowScript
    }
  })
  const longArgs = JSON.stringify({ target: "src", policy: "x".repeat(1200) })
  const longArgsWorkflowRequest = approvalRequest({
    id: "workflow-long-args",
    toolName: "workflow",
    args: {
      name: "full long args",
      description: "review all workflow arguments",
      phases: ["inspect"],
      argsPreview: `${longArgs.slice(0, 800)}\n…`,
      argsReview: longArgs,
      tokenBudget: 12000,
      scriptPreview: workflowScript
    }
  })
  const nestedCommandRequest = approvalRequest({ id: "execute", toolName: "shell" })
  nestedCommandRequest.tool_call.args = { command: "npm test" }

  assert(
    remoteAllowedApprovalActions(writeRequest).join(",") === "approve,reject",
    "ordinary file approval supports remote approve/reject"
  )
  assert(
    remoteAllowedApprovalActions(workflowRequest).join(",") === "approve,reject",
    "fully reviewable workflow supports remote approve/reject"
  )
  assert(
    remoteAllowedApprovalActions(incompleteWorkflowRequest).join(",") === "reject",
    "workflow without complete review material fails closed for remote approve"
  )
  assert(
    remoteAllowedApprovalActions(truncatedWorkflowRequest).join(",") === "reject",
    "workflow with only a truncated args preview fails closed for remote approve"
  )
  assert(
    remoteAllowedApprovalActions(longArgsWorkflowRequest).join(",") === "approve,reject",
    "workflow with complete long args remains remotely approvable"
  )
  assert(
    remoteAllowedApprovalActions(nestedCommandRequest).join(",") === "approve,reject",
    "nested command identifies an execute approval"
  )
  assert(
    remoteAllowedApprovalActions(gitRequest).join(",") === "reject",
    "git approval requires desktop while remote rejection stays available"
  )

  const serializedWorkflow = serializePendingApproval({
    request: workflowRequest,
    runtimeThreadId: "thread-1"
  })
  assert(
    serializedWorkflow.workflow_review?.script === workflowScript,
    "full workflow script returned"
  )
  assert(
    serializedWorkflow.workflow_review?.name === "remote review" &&
      serializedWorkflow.workflow_review?.phases.join(",") === "inspect,report",
    "workflow identity and phases returned"
  )
  assert(
    serializedWorkflow.workflow_review?.args === '{"target":"src"}' &&
      serializedWorkflow.workflow_review.args_bytes === Buffer.byteLength('{"target":"src"}') &&
      serializedWorkflow.workflow_review.args_sha256.length === 64 &&
      serializedWorkflow.workflow_review?.token_budget === 12000,
    "full workflow args, integrity metadata, and token budget returned"
  )
  assert(
    serializedWorkflow.workflow_review?.script_bytes === Buffer.byteLength(workflowScript) &&
      serializedWorkflow.workflow_review.script_sha256.length === 64,
    "workflow script integrity metadata returned"
  )
  const serializedLongArgsWorkflow = serializePendingApproval({
    request: longArgsWorkflowRequest,
    runtimeThreadId: "thread-1"
  })
  assert(
    serializedLongArgsWorkflow.workflow_review?.args === longArgs &&
      serializedLongArgsWorkflow.workflow_review.args_bytes === Buffer.byteLength(longArgs) &&
      serializedLongArgsWorkflow.workflow_review.args_sha256.length === 64,
    "long workflow args are returned in full with integrity metadata"
  )
  const serializedIncompleteWorkflow = serializePendingApproval({
    request: incompleteWorkflowRequest,
    runtimeThreadId: "thread-1"
  })
  assert(
    serializedIncompleteWorkflow.workflow_review === undefined &&
      serializedIncompleteWorkflow.remote_allowed_actions.join(",") === "reject",
    "incomplete workflow response cannot be remotely approved"
  )

  const pending = serializePendingApproval({ request: writeRequest, runtimeThreadId: "thread-1" })
  const waiting = buildApiThreadRuntime({
    activity: active,
    messageCount: 1,
    pendingApprovals: [pending]
  })
  assert(waiting.state === "awaiting_approval", "approval state has priority over active run")
  assert(waiting.is_waiting_approval && !waiting.is_generating, "waiting flags are unambiguous")

  const generating = buildApiThreadRuntime({
    activity: active,
    messageCount: 1,
    pendingApprovals: []
  })
  assert(generating.state === "generating" && generating.is_generating, "active run is generating")

  const backgroundGenerating = buildApiThreadRuntime({
    activity: { ...inactive, background_shell: true, active: true },
    messageCount: 1,
    pendingApprovals: []
  })
  assert(
    backgroundGenerating.state === "generating" &&
      backgroundGenerating.activity.background_shell,
    "thread-owned background shell task remains generating after foreground completion"
  )

  const notStarted = buildApiThreadRuntime({
    activity: inactive,
    messageCount: 0,
    pendingApprovals: []
  })
  assert(notStarted.state === "not_started", "empty inactive thread has not started")

  const finished = buildApiThreadRuntime({
    activity: inactive,
    messageCount: 2,
    pendingApprovals: []
  })
  assert(finished.state === "finished" && finished.is_finished, "settled thread is finished")
  assert(
    Object.keys(finished.state_definitions).length === 4,
    "response carries definitions for every runtime state"
  )
}
console.log("PASS thread runtime state + approval policy")

// ── HTTP decisions retain the broker's one-shot remote restrictions ─────────
{
  const broker = new ApprovalDecisionBroker()
  const request = approvalRequest({
    id: "approval-http",
    operation: "execute",
    allowed: ["approve", "approve_session", "reject"]
  })
  const resolved: ApprovalDecision[] = []
  broker.register({
    request,
    threadId: "thread-1",
    runtimeThreadId: "thread-1",
    resolve: (decision) => resolved.push(decision)
  })
  const unsupported = broker.decide({
    source: { kind: "http" },
    requestId: request.id,
    decision: { type: "approve_session", tool_call_id: request.tool_call.id }
  })
  assert(
    !unsupported.accepted && unsupported.reasonCode === "REMOTE_APPROVAL_DECISION_UNSUPPORTED",
    "HTTP cannot grant session-wide approval"
  )
  assert(broker.get(request.id) !== null, "rejected decision does not consume approval")

  const accepted = broker.decide({
    source: { kind: "http" },
    requestId: request.id,
    decision: { type: "approve", tool_call_id: request.tool_call.id }
  })
  assert(accepted.accepted, "HTTP one-shot approval is accepted")
  assert(resolved.length === 1 && resolved[0].type === "approve", "resolver receives HTTP decision")
  assert(broker.get(request.id) === null, "accepted HTTP decision consumes approval once")
}
console.log("PASS HTTP approval broker restrictions")

console.log(`\nAll api-gateway unit checks passed (${passed} assertions).`)
