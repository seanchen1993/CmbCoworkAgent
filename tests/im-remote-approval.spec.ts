import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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
  commandInArgs?: string
  allowed?: ApprovalRequest["allowed_approval_types"]
}): ApprovalRequest {
  return {
    id: input.id,
    tool_call: {
      id: `tool-${input.id}`,
      name: input.toolName ?? input.operation ?? "unknown",
      args: input.commandInArgs !== undefined ? { command: input.commandInArgs } : {},
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

async function createContext(
  options: {
    remoteApprovalEnabled?: boolean
    agentMode?: "normal" | "coordinator" | "workflow"
  } = {}
) {
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
    metadata: JSON.stringify({ workspacePath: root, agentMode: options.agentMode ?? "normal" })
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
      remoteApprovalEnabled: options.remoteApprovalEnabled !== false
    }),
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

function workflowRequest(input: {
  id: string
  cwd: string
  script?: string
  tokenBudget?: number
}): ApprovalRequest {
  return {
    id: input.id,
    tool_call: {
      id: `tool-${input.id}`,
      name: "workflow",
      args: {
        name: "workflow-smoke-test",
        description: "最小可用的 workflow 冒烟测试：3 个并行 agent + 汇总",
        phases: ["Fan-out", "Synthesize"],
        ...(input.script === undefined ? {} : { scriptPreview: input.script }),
        argsPreview: "(none)",
        ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget })
      },
      metadata: null,
      status: "pending",
      thread_values: null,
      title: null
    },
    allowed_decisions: ["approve", "reject"],
    safety_level: "needs_approval",
    cwd: input.cwd,
    // Mirrors the real request: the desktop offers a session-wide allow too.
    allowed_approval_types: ["approve", "approve_session", "reject"]
  } as ApprovalRequest
}

async function testAWorkflowLaunchIsApprovableWithItsWholeScript(): Promise<void> {
  const context = await createContext()
  try {
    const script = [
      "export const meta = {",
      "  name: 'workflow-smoke-test',",
      "  phases: [{ title: 'Fan-out' }, { title: 'Synthesize' }]",
      "}",
      "await Promise.all([agent('a'), agent('b'), agent('c')])"
    ].join("\n")
    const workflow = workflowRequest({ id: "request-workflow", cwd: context.root, script })
    const decisions = context.register(workflow)
    await waitFor(() => context.deliveryText(workflow.id).includes("A1B2C3"), "workflow approval")
    const text = context.deliveryText(workflow.id)

    assert(text.includes("运行工作流：workflow-smoke-test"))
    assert(text.includes("阶段（2）：Fan-out → Synthesize"))
    assert(text.includes("Token 预算上限：未设置（无上限）"))
    assert(text.includes("将在后台启动多个子代理"))
    // The WHOLE script, not a description of it. This is a security gate: a
    // hidden tail is where the dangerous part would live.
    assert(text.includes(script), `the full script must reach the approver:\n${text}`)
    assert(!text.includes(IM_REPLY_TRUNCATION_NOTICE))
    assert(text.includes("/批准 A1B2C3"))

    const result = await context.service.resolveCode({
      code: "A1B2C3",
      decision: "approve",
      ...ROUTE
    })
    assert(result.includes("一次性批准"))
    // approve, never approve_session — a remote yes covers this launch only,
    // even though the desktop card offers 本会话允许 for the same request.
    assert.deepEqual(decisions, [{ type: "approve", tool_call_id: workflow.tool_call.id }])
  } finally {
    context.service.dispose()
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

async function testAWorkflowNobodyCanReadStaysOnTheDesktop(): Promise<void> {
  const context = await createContext()
  try {
    // No script to audit: approving would be authorizing sub-agents to write
    // files and run commands sight unseen.
    const scriptless = workflowRequest({ id: "request-workflow-blind", cwd: context.root })
    context.register(scriptless)
    await waitFor(
      () => context.deliveryText(scriptless.id).length > 0,
      "scriptless workflow notice"
    )
    const blindText = context.deliveryText(scriptless.id)
    assert(blindText.includes("需要在桌面确认"))
    assert(!/[A-F0-9]{6}/u.test(blindText), "a workflow with no script must carry no code")

    // Too long to send: the reply would be truncated, so the fallback fires for
    // the same reason — a script that cannot be shown in full cannot be
    // audited in full. Real scripts run to 512 KiB, well past the 8 × 2800
    // character reply ceiling, so this is the common case, not a corner.
    const huge = workflowRequest({
      id: "request-workflow-huge",
      cwd: context.root,
      script: `// ${"x".repeat(30_000)}`
    })
    context.register(huge)
    await waitFor(() => context.deliveryText(huge.id).length > 0, "huge workflow notice")
    const hugeText = context.deliveryText(huge.id)
    assert(hugeText.includes("无法在招乎中完整、安全地展示"))
    assert(!/[A-F0-9]{6}/u.test(hugeText), "a truncated workflow must carry no code")
  } finally {
    context.service.dispose()
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

function testNoRemoteCodePromiseSurvivesAsCopyOnly(): void {
  // The bug this pins: the deadlines were removed from both services, the
  // wait notice and the user-input prompt were reworded, and the approval
  // prompt was not — so it kept telling people "短码 10 分钟内单次有效" about a
  // code that no longer expires. Behaviour and copy are changed by different
  // edits; only a check that reads both files at once catches the one you
  // forgot.
  const root = resolve(__dirname, "..")
  for (const file of [
    "src/main/services/im/remote-approval-service.ts",
    "src/main/services/im/remote-user-input-service.ts",
    "src/main/services/im/remote-runner.ts"
  ]) {
    const offending = readFileSync(join(root, file), "utf8")
      .split("\n")
      .filter((line) => /\d+\s*分钟/u.test(line) && !line.trimStart().startsWith("*"))
    assert.deepEqual(
      offending,
      [],
      `${file} still tells a remote user their code or turn expires:\n${offending.join("\n")}`
    )
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
    // The prompt is the only thing the person holding it can go on. It must not
    // promise a window nothing enforces — someone who reads "10 分钟" and gets
    // back an hour later will assume the code is dead and never try it.
    assert(!/\d+\s*分钟/u.test(text), `the approval prompt must not promise a deadline: ${text}`)
    assert(text.includes("短码单次有效"))
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
      "审批短码不存在、已使用，或该审批已不在等待中。"
    )
    assert.equal(decisions.length, 1)
  } finally {
    context.service.dispose()
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

async function testAllowedDecisionsFailClosedAndCodesOutliveTheClock(): Promise<void> {
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

    // A code carries no deadline. An approval is a safety gate the runtime
    // never times out, so the notification someone is holding must still be
    // answerable when they get back to it — otherwise the only way to answer a
    // Zhaohu approval is to stop being remote and walk to the desktop, which
    // is the whole thing remote approval exists to avoid.
    const lingering = approvalRequest({
      id: "request-lingering",
      operation: "write_file",
      cwd: context.root,
      filePath: join(context.root, "lingering.ts")
    })
    const lingeringDecisions = context.register(lingering)
    await waitFor(() => context.deliveryText(lingering.id).includes("D4E5F6"), "lingering approval")
    context.clock.now += 6 * 60 * 60_000
    assert(
      (
        await context.service.resolveCode({ code: "D4E5F6", decision: "approve", ...ROUTE })
      ).includes("一次性批准"),
      "hours later the code must still answer the request it was issued for"
    )
    assert.deepEqual(lingeringDecisions, [
      { type: "approve", tool_call_id: lingering.tool_call.id }
    ])

    // What still ends a code is its request no longer waiting — decided on the
    // desktop, or the run cancelled. Without that, codes would pile up for
    // gates nobody can answer any more.
    const decidedOnDesktop = approvalRequest({
      id: "request-decided-on-desktop",
      operation: "write_file",
      cwd: context.root,
      filePath: join(context.root, "desktop.ts")
    })
    context.register(decidedOnDesktop)
    await waitFor(
      () => context.deliveryText(decidedOnDesktop.id).includes("012ABC"),
      "desktop-decided approval"
    )
    context.broker.unregister(decidedOnDesktop.id)
    assert.equal(
      await context.service.resolveCode({ code: "012ABC", decision: "approve", ...ROUTE }),
      "审批短码不存在、已使用，或该审批已不在等待中。"
    )
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
    assert.deepEqual(executeDecisions, [{ type: "approve", tool_call_id: execute.tool_call.id }])
  } finally {
    context.service.dispose()
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

async function testCommandInsideToolArgsIsRecognized(): Promise<void> {
  const context = await createContext()
  try {
    const argsOnly = approvalRequest({
      id: "request-args-command",
      toolName: "execute",
      cwd: context.root,
      commandInArgs: "echo args-only-command"
    })
    const decisions = context.register(argsOnly)
    await waitFor(
      () => context.deliveryText(argsOnly.id).includes("A1B2C3"),
      "args-only command approval"
    )
    const text = context.deliveryText(argsOnly.id)
    assert(text.includes("args-only-command"))
    assert(!text.includes("unknown"))
    assert(!text.includes("需要在桌面确认"))
    const result = await context.service.resolveCode({
      code: "A1B2C3",
      decision: "approve",
      ...ROUTE
    })
    assert(result.includes("一次性批准"))
    assert.deepEqual(decisions, [{ type: "approve", tool_call_id: argsOnly.tool_call.id }])
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

async function testAdvancedModesCanPublishAndResolve(): Promise<void> {
  for (const agentMode of ["coordinator", "workflow"] as const) {
    const context = await createContext({ agentMode })
    try {
      const request = approvalRequest({
        id: `request-${agentMode}`,
        operation: "write_file",
        cwd: context.root,
        filePath: join(context.root, `${agentMode}.ts`)
      })
      const decisions = context.register(request)
      await waitFor(() => context.deliveryText(request.id).includes("A1B2C3"), agentMode)
      assert(
        (
          await context.service.resolveCode({
            code: "A1B2C3",
            decision: "approve",
            ...ROUTE
          })
        ).includes("一次性批准")
      )
      assert.deepEqual(decisions, [{ type: "approve", tool_call_id: request.tool_call.id }])
    } finally {
      context.service.dispose()
      context.database.close()
      await rm(context.root, { recursive: true, force: true })
    }
  }
}

async function main(): Promise<void> {
  await testDefaultOffDoesNotPublishOrResolve()
  testNoRemoteCodePromiseSurvivesAsCopyOnly()
  await testWorkspaceApprovalIsSingleUseAndAudited()
  await testAWorkflowLaunchIsApprovableWithItsWholeScript()
  await testAWorkflowNobodyCanReadStaysOnTheDesktop()
  await testAllowedDecisionsFailClosedAndCodesOutliveTheClock()
  await testAuditFlushFailureNeverResumesRuntime()
  await testDesktopDecisionWinsAuditFlushRace()
  await testCommandsAreInferredWhileUnsupportedOperationsStayDesktopOnly()
  await testCommandInsideToolArgsIsRecognized()
  await testConcurrentCodesPointToExactlyOneRequest()
  await testBrokerPreservesDesktopDecisionSurfaceAndCommandIsExplicit()
  await testAdvancedModesCanPublishAndResolve()
  console.log("IM remote approval tests passed")
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
