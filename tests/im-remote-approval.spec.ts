import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import initSqlJs from "sql.js"
import { ApprovalDecisionBroker } from "../src/main/agent/approval-decision-broker"
import type { ThreadRow } from "../src/main/db"
import type { ApprovalDecision, ApprovalRequest } from "../src/main/types"
import { ImCommandRouter, parseImCommand } from "../src/main/services/im/command-router"
import { ImConversationStateStore } from "../src/main/services/im/conversation-state"
import { ImEventStore } from "../src/main/services/im/event-store"
import type { ImPersistenceDependencies } from "../src/main/services/im/persistence"
import { ImRemoteApprovalAuditStore } from "../src/main/services/im/remote-approval-audit-store"
import { ImRemoteApprovalService } from "../src/main/services/im/remote-approval-service"
import { ImRemoteGrantStore } from "../src/main/services/im/remote-grant-store"
import { IM_REPLY_TRUNCATION_NOTICE } from "../src/main/services/im/reply-segmentation"
import { ensureImServiceSchema } from "../src/main/services/im/schema"

const ROUTE = {
  principalId: "principal-1",
  conversationKey: "conversation-1"
}

function approvalRequest(input: {
  id: string
  operation?: ApprovalRequest["operation"]
  toolName?: string
  cwd: string
  filePath?: string
  command?: string
  allowed?: ApprovalRequest["allowed_approval_types"]
}): ApprovalRequest {
  return {
    id: input.id,
    tool_call: {
      id: `tool-${input.id}`,
      name: input.toolName ?? input.operation ?? "unknown",
      args: {},
      metadata: null,
      status: "pending",
      thread_values: null,
      title: null
    },
    allowed_decisions: ["approve", "reject"],
    safety_level: "needs_approval",
    operation: input.operation,
    cwd: input.cwd,
    filePath: input.filePath,
    command: input.command,
    allowed_approval_types: input.allowed ?? ["approve", "reject"]
  }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function createContext(options: { remoteApprovalEnabled?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "cmb-im-approval-"))
  const SQL = await initSqlJs()
  const database = new SQL.Database()
  ensureImServiceSchema(database)
  const clock = { now: Date.parse("2026-07-29T08:00:00.000Z") }
  const flushControl: { fail: boolean; onFlush: (() => void) | null } = {
    fail: false,
    onFlush: null
  }
  const persistence: ImPersistenceDependencies = {
    getDatabase: () => database,
    markDirty: () => undefined,
    flushStrict: async () => {
      const onFlush = flushControl.onFlush
      flushControl.onFlush = null
      onFlush?.()
      if (flushControl.fail) throw new Error("simulated durable audit failure")
    },
    now: () => clock.now
  }
  const conversations = new ImConversationStateStore(persistence)
  const grants = new ImRemoteGrantStore(persistence, () => "grant-thread-1")
  const events = new ImEventStore(persistence)
  let auditSequence = 0
  const audits = new ImRemoteApprovalAuditStore(persistence, () => `audit-${++auditSequence}`)
  await conversations.ensureConversation(ROUTE)
  await grants.enableThreadGrant({ route: ROUTE, threadId: "thread-1", title: "桌面会话" })

  const thread: ThreadRow = {
    thread_id: "thread-1",
    created_at: clock.now,
    updated_at: clock.now,
    title: "桌面会话",
    status: "idle",
    thread_values: null,
    metadata: JSON.stringify({ workspacePath: root, agentMode: "normal" })
  }
  const broker = new ApprovalDecisionBroker()
  const generatedCodes = ["A1B2C3", "D4E5F6", "012ABC", "789DEF", "AAA111"]
  const desktopAuditNotices: string[] = []
  const warnings: unknown[] = []
  let sendPendingCount = 0
  const service = new ImRemoteApprovalService({
    broker,
    conversations,
    access: { getThreadGrant: (threadId) => grants.getThreadGrant(threadId) },
    grants,
    events,
    audits,
    getThread: (threadId) => (threadId === thread.thread_id ? thread : null),
    getSettings: () => ({
      enabled: true,
      gatewayUrl: null,
      remoteAccess: "inbox-only",
      remoteApprovalEnabled: options.remoteApprovalEnabled !== false,
      waitingDesktopTtlMinutes: 10
    }),
    now: () => clock.now,
    createCode: () => generatedCodes.shift() ?? "ABC123",
    warn: (_message, error) => warnings.push(error)
  })
  service.subscribeAudit((record) => {
    desktopAuditNotices.push(`${record.decision}:${record.summary}`)
  })
  service.registerReplyDrainer({
    sendPending: async () => {
      sendPendingCount += 1
      return { sent: 0, failed: 0, unknown: 0, deferred: 0 }
    }
  })

  function register(request: ApprovalRequest): ApprovalDecision[] {
    const decisions: ApprovalDecision[] = []
    broker.register({
      request,
      threadId: thread.thread_id,
      runtimeThreadId: thread.thread_id,
      resolve: (decision) => {
        decisions.push(decision)
        broker.unregister(request.id)
      }
    })
    return decisions
  }

  function deliveryText(requestId: string): string {
    return events
      .listOutbox()
      .filter((record) => record.deliveryId === `approval-request:${requestId}`)
      .map((record) => record.content)
      .join("\n")
  }

  return {
    root,
    database,
    clock,
    flushControl,
    broker,
    events,
    audits,
    service,
    register,
    deliveryText,
    desktopAuditNotices,
    warnings,
    sendPendingCount: () => sendPendingCount
  }
}

async function testDefaultOffDoesNotPublishOrResolve(): Promise<void> {
  const context = await createContext({ remoteApprovalEnabled: false })
  try {
    const request = approvalRequest({
      id: "request-disabled",
      operation: "write_file",
      cwd: context.root,
      filePath: join(context.root, "disabled.ts")
    })
    const decisions = context.register(request)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(context.events.listOutbox().length, 0)
    assert.equal(decisions.length, 0)
    assert.equal(
      await context.service.resolveCode({ code: "A1B2C3", decision: "approve", ...ROUTE }),
      "招乎远程审批未开启，请回到桌面确认。"
    )
  } finally {
    context.service.dispose()
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

async function testWorkspaceApprovalIsSingleUseAndAudited(): Promise<void> {
  const context = await createContext()
  try {
    const request = approvalRequest({
      id: "request-write-opaque-id",
      operation: "write_file",
      cwd: context.root,
      filePath: join(context.root, "src", "billing.ts")
    })
    const decisions = context.register(request)
    await waitFor(
      () => context.deliveryText(request.id).includes("A1B2C3") && context.sendPendingCount() === 1,
      "approval outbox drain"
    )
    const text = context.deliveryText(request.id)
    assert(text.includes("写入文件：src/billing.ts"))
    assert(text.includes("/批准 A1B2C3"))
    assert(text.includes("/拒绝 A1B2C3"))
    assert(!text.includes(context.root), "approval text must not leak the absolute workspace path")
    assert.equal(context.sendPendingCount(), 1)

    assert.equal(
      await context.service.resolveCode({
        code: "A1B2C3",
        decision: "approve",
        principalId: "principal-other",
        conversationKey: ROUTE.conversationKey
      }),
      "该审批短码不属于当前招乎会话。"
    )
    assert.equal(decisions.length, 0)

    const result = await context.service.resolveCode({
      code: "A1B2C3",
      decision: "approve",
      ...ROUTE
    })
    assert(result.includes("一次性批准"))
    assert.deepEqual(decisions, [{ type: "approve", tool_call_id: request.tool_call.id }])
    assert.equal(context.audits.getByRequestId(request.id)?.decision, "approve")
    assert.deepEqual(context.desktopAuditNotices, ["approve:写入文件 src/billing.ts"])
    assert.equal(
      await context.service.resolveCode({ code: "A1B2C3", decision: "approve", ...ROUTE }),
      "审批短码不存在、已过期或已使用。"
    )
    assert.equal(decisions.length, 1)
  } finally {
    context.service.dispose()
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

async function testAllowedDecisionAndExpiryRemainFailClosed(): Promise<void> {
  const context = await createContext()
  try {
    const rejectOnly = approvalRequest({
      id: "request-reject-only",
      operation: "edit_file",
      cwd: context.root,
      filePath: join(context.root, "only-reject.ts"),
      allowed: ["reject"]
    })
    const decisions = context.register(rejectOnly)
    await waitFor(
      () => context.deliveryText(rejectOnly.id).includes("A1B2C3"),
      "reject-only approval"
    )
    const text = context.deliveryText(rejectOnly.id)
    assert(!text.includes("/批准 A1B2C3"))
    assert(text.includes("/拒绝 A1B2C3"))
    assert(
      (
        await context.service.resolveCode({ code: "A1B2C3", decision: "approve", ...ROUTE })
      ).includes("不接受这个审批决定")
    )
    assert.equal(decisions.length, 0)
    assert(
      (
        await context.service.resolveCode({ code: "A1B2C3", decision: "reject", ...ROUTE })
      ).includes("已从招乎拒绝")
    )
    assert.deepEqual(decisions, [{ type: "reject", tool_call_id: rejectOnly.tool_call.id }])

    const expiring = approvalRequest({
      id: "request-expiring",
      operation: "write_file",
      cwd: context.root,
      filePath: join(context.root, "expires.ts")
    })
    const expiringDecisions = context.register(expiring)
    await waitFor(() => context.deliveryText(expiring.id).includes("D4E5F6"), "expiring approval")
    context.clock.now += 10 * 60_000 + 1
    assert.equal(
      await context.service.resolveCode({ code: "D4E5F6", decision: "approve", ...ROUTE }),
      "审批短码不存在、已过期或已使用。"
    )
    assert.equal(expiringDecisions.length, 0)
  } finally {
    context.service.dispose()
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

async function testAuditFlushFailureNeverResumesRuntime(): Promise<void> {
  const context = await createContext()
  try {
    const request = approvalRequest({
      id: "request-audit-failure",
      operation: "write_file",
      cwd: context.root,
      filePath: join(context.root, "audit.ts")
    })
    const decisions = context.register(request)
    await waitFor(() => context.deliveryText(request.id).includes("A1B2C3"), "audit failure code")
    context.flushControl.fail = true
    const failed = await context.service.resolveCode({
      code: "A1B2C3",
      decision: "approve",
      ...ROUTE
    })
    assert(failed.includes("本次决定未执行"))
    assert.equal(decisions.length, 0)
    assert.equal(context.desktopAuditNotices.length, 0)

    context.flushControl.fail = false
    const retried = await context.service.resolveCode({
      code: "A1B2C3",
      decision: "approve",
      ...ROUTE
    })
    assert(retried.includes("一次性批准"))
    assert.deepEqual(decisions, [{ type: "approve", tool_call_id: request.tool_call.id }])
  } finally {
    context.service.dispose()
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

async function testDesktopDecisionWinsAuditFlushRace(): Promise<void> {
  const context = await createContext()
  try {
    const request = approvalRequest({
      id: "request-desktop-race",
      operation: "write_file",
      cwd: context.root,
      filePath: join(context.root, "race.ts")
    })
    const decisions = context.register(request)
    await waitFor(() => context.deliveryText(request.id).includes("A1B2C3"), "race code")
    context.flushControl.onFlush = () => {
      const result = context.broker.decide({
        source: { kind: "desktop", webContentsId: 9 },
        requestId: request.id,
        decision: { type: "reject", tool_call_id: request.tool_call.id }
      })
      assert.equal(result.accepted, true)
    }
    const result = await context.service.resolveCode({
      code: "A1B2C3",
      decision: "approve",
      ...ROUTE
    })
    assert(result.includes("已失效或发生变化"))
    assert.deepEqual(decisions, [{ type: "reject", tool_call_id: request.tool_call.id }])
    assert.equal(context.audits.getByRequestId(request.id), null)
    assert.equal(context.desktopAuditNotices.length, 0)
  } finally {
    context.service.dispose()
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

async function testCommandsAreInferredWhileUnsupportedOperationsStayDesktopOnly(): Promise<void> {
  const context = await createContext()
  try {
    const git = approvalRequest({
      id: "request-git",
      operation: "git_commit",
      cwd: context.root
    })
    context.register(git)
    await waitFor(() => context.deliveryText(git.id).length > 0, "desktop-only git notice")
    const gitText = context.deliveryText(git.id)
    assert(gitText.includes("需要在桌面确认"))
    assert(!/[A-F0-9]{6}/u.test(gitText))

    const outsidePath = join(tmpdir(), "must-not-leak", "outside.ts")
    const outside = approvalRequest({
      id: "request-outside",
      operation: "write_file",
      cwd: context.root,
      filePath: outsidePath
    })
    context.register(outside)
    await waitFor(() => context.deliveryText(outside.id).length > 0, "outside path notice")
    const outsideText = context.deliveryText(outside.id)
    // Out-of-workspace writes are IM-approvable: the message shows the resolved
    // absolute path with an explicit marker and a single-use short code.
    assert(outsideText.includes("A1B2C3"))
    assert(outsideText.includes("工作区外"))
    assert(outsideText.includes(outsidePath))

    const command = `printf 'BEGIN-REMOTE-EXECUTE-${"x".repeat(6_000)}-END-REMOTE-EXECUTE'`
    const execute = approvalRequest({
      id: "request-execute",
      toolName: "execute",
      cwd: context.root,
      command
    })
    const executeDecisions = context.register(execute)
    await waitFor(() => context.deliveryText(execute.id).includes("D4E5F6"), "execute approval")
    const executeText = context.deliveryText(execute.id)
    assert(executeText.includes("BEGIN-REMOTE-EXECUTE"))
    assert(executeText.includes("END-REMOTE-EXECUTE"))
    assert(!executeText.includes(IM_REPLY_TRUNCATION_NOTICE))
    const approvalResult = await context.service.resolveCode({
      code: "D4E5F6",
      decision: "approve",
      ...ROUTE
    })
    assert(approvalResult.includes("一次性批准"))
    assert.deepEqual(executeDecisions, [
      { type: "approve", tool_call_id: execute.tool_call.id }
    ])
  } finally {
    context.service.dispose()
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

async function testConcurrentCodesPointToExactlyOneRequest(): Promise<void> {
  const context = await createContext()
  try {
    const first = approvalRequest({
      id: "request-first",
      operation: "write_file",
      cwd: context.root,
      filePath: join(context.root, "first.ts")
    })
    const second = approvalRequest({
      id: "request-second",
      operation: "edit_file",
      cwd: context.root,
      filePath: join(context.root, "second.ts")
    })
    const firstDecisions = context.register(first)
    const secondDecisions = context.register(second)
    await waitFor(
      () =>
        context.deliveryText(first.id).includes("A1B2C3") &&
        context.deliveryText(second.id).includes("D4E5F6"),
      "concurrent approvals"
    )
    await context.service.resolveCode({ code: "D4E5F6", decision: "reject", ...ROUTE })
    assert.equal(firstDecisions.length, 0)
    assert.deepEqual(secondDecisions, [{ type: "reject", tool_call_id: second.tool_call.id }])
    await context.service.resolveCode({ code: "A1B2C3", decision: "approve", ...ROUTE })
    assert.deepEqual(firstDecisions, [{ type: "approve", tool_call_id: first.tool_call.id }])
  } finally {
    context.service.dispose()
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

async function testBrokerPreservesDesktopDecisionSurfaceAndCommandIsExplicit(): Promise<void> {
  const broker = new ApprovalDecisionBroker()
  const request = approvalRequest({
    id: "request-desktop",
    operation: "execute",
    cwd: "/workspace",
    command: "npm test",
    allowed: ["approve"]
  })
  const decisions: ApprovalDecision[] = []
  broker.register({
    request,
    threadId: "thread-1",
    runtimeThreadId: "thread-1",
    resolve: (decision) => decisions.push(decision)
  })
  assert.deepEqual(
    broker.decide({
      source: { kind: "desktop", webContentsId: 7 },
      requestId: request.id,
      decision: { type: "approve_permanent", tool_call_id: "wrong-tool" }
    }),
    { accepted: false, reasonCode: "APPROVAL_TOOL_CALL_MISMATCH" }
  )
  assert.equal(
    broker.decide({
      source: { kind: "desktop", webContentsId: 7 },
      requestId: request.id,
      decision: { type: "approve_permanent", tool_call_id: request.tool_call.id }
    }).accepted,
    true
  )
  assert.deepEqual(decisions, [{ type: "approve_permanent", tool_call_id: request.tool_call.id }])
  assert.deepEqual(
    broker.decide({
      source: { kind: "desktop", webContentsId: 7 },
      requestId: request.id,
      decision: { type: "approve", tool_call_id: request.tool_call.id }
    }),
    { accepted: false, reasonCode: "APPROVAL_NOT_FOUND" }
  )

  assert.equal(parseImCommand("批准 A1B2C3"), null, "natural language must remain ordinary text")
  assert.equal(parseImCommand("同意"), null)
  assert.deepEqual(parseImCommand("/批准 A1B2C3"), {
    name: "approve",
    argument: "A1B2C3"
  })
  const calls: unknown[] = []
  const router = new ImCommandRouter({
    approvals: {
      resolveCode: async (input) => {
        calls.push(input)
        return "resolved"
      }
    }
  })
  assert.equal(
    await router.handle({
      command: parseImCommand("/拒绝 D4E5F6")!,
      ...ROUTE
    }),
    "resolved"
  )
  assert.deepEqual(calls, [{ code: "D4E5F6", decision: "reject", ...ROUTE }])
}

async function main(): Promise<void> {
  await testDefaultOffDoesNotPublishOrResolve()
  await testWorkspaceApprovalIsSingleUseAndAudited()
  await testAllowedDecisionAndExpiryRemainFailClosed()
  await testAuditFlushFailureNeverResumesRuntime()
  await testDesktopDecisionWinsAuditFlushRace()
  await testCommandsAreInferredWhileUnsupportedOperationsStayDesktopOnly()
  await testConcurrentCodesPointToExactlyOneRequest()
  await testBrokerPreservesDesktopDecisionSurfaceAndCommandIsExplicit()
  console.log("IM remote approval tests passed")
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
