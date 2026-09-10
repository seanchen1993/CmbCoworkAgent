/**
 * Zhaohu interaction cards.
 *
 * The invariant these tests exist to hold is that a card is an affordance, not
 * an authority: it must reach the runtime through exactly the short code a
 * typed command would consume, it must never answer for a principal it was not
 * published to, and it must never be the reason a gate becomes unanswerable.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import initSqlJs from "sql.js"
import { ApprovalDecisionBroker } from "../src/main/agent/approval-decision-broker"
import type { ThreadRow } from "../src/main/db"
import type { ApprovalDecision, ApprovalRequest } from "../src/main/types"
import {
  assertRemoteImCardReceiptV1,
  assertRemoteImCardSendV1,
  assertRemoteImCardUpdateV1,
  type RemoteImCardReceiptV1,
  type RemoteImCardSendV1,
  type RemoteImCardUpdateV1
} from "../src/shared/im-gateway-contract"
import {
  buildApprovalCard,
  buildQuestionCard,
  QUESTION_OTHER_SUFFIX
} from "../src/main/services/im/card-builder"
import { ImCardInteractionStore } from "../src/main/services/im/card-interaction-store"
import { ImCardPublisher } from "../src/main/services/im/card-publisher"
import { ImCardReceiptRouter } from "../src/main/services/im/card-receipt-router"
import { ImConversationStateStore } from "../src/main/services/im/conversation-state"
import { ImEventStore } from "../src/main/services/im/event-store"
import type { ImGatewayClientPort } from "../src/main/services/im/gateway-client"
import type { ImPersistenceDependencies } from "../src/main/services/im/persistence"
import { ImRemoteApprovalAuditStore } from "../src/main/services/im/remote-approval-audit-store"
import { ImRemoteApprovalService } from "../src/main/services/im/remote-approval-service"
import { ImRemoteGrantStore } from "../src/main/services/im/remote-grant-store"
import { ensureImServiceSchema } from "../src/main/services/im/schema"

const ROUTE = { principalId: "principal-1", conversationKey: "conversation-1" }

class RecordingGateway implements Partial<ImGatewayClientPort> {
  readonly sent: RemoteImCardSendV1[] = []
  readonly updated: RemoteImCardUpdateV1[] = []
  readonly acknowledged: string[] = []
  authenticated = true
  accept = true

  isAuthenticated(): boolean {
    return this.authenticated
  }
  async sendCard(card: RemoteImCardSendV1) {
    assertRemoteImCardSendV1(card)
    this.sent.push(card)
    return this.accept
      ? ({ state: "accepted" } as const)
      : ({ state: "rejected", reasonCode: "CARD_REJECTED" } as const)
  }
  async updateCard(update: RemoteImCardUpdateV1) {
    assertRemoteImCardUpdateV1(update)
    this.updated.push(update)
    return { state: "accepted" } as const
  }
  async acknowledgeCardReceipt(receiptId: string): Promise<void> {
    this.acknowledged.push(receiptId)
  }
}

function approvalRequest(cwd: string, id = "req-1"): ApprovalRequest {
  return {
    id,
    tool_call: {
      id: `tool-${id}`,
      name: "edit_file",
      args: {},
      metadata: null,
      status: "pending",
      thread_values: null,
      title: null
    },
    allowed_decisions: ["approve", "reject"],
    safety_level: "needs_approval",
    operation: "edit_file",
    cwd,
    filePath: join(cwd, "config.ts"),
    allowed_approval_types: ["approve", "reject"]
  }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return
    await new Promise<void>((done) => setTimeout(done, 0))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function createContext() {
  const root = await mkdtemp(join(tmpdir(), "cmb-im-card-"))
  const SQL = await initSqlJs()
  const database = new SQL.Database()
  ensureImServiceSchema(database)
  const clock = { now: Date.parse("2026-09-09T08:00:00.000Z") }
  const persistence: ImPersistenceDependencies = {
    getDatabase: () => database,
    markDirty: () => undefined,
    flushStrict: async () => undefined,
    now: () => clock.now
  }
  const conversations = new ImConversationStateStore(persistence)
  const grants = new ImRemoteGrantStore(persistence, () => "grant-thread-1")
  const events = new ImEventStore(persistence)
  let auditSequence = 0
  const audits = new ImRemoteApprovalAuditStore(persistence, () => `audit-${++auditSequence}`)
  await conversations.ensureConversation(ROUTE)
  await grants.enableThreadGrant({ route: ROUTE, threadId: "thread-1", title: "快捷支付" })

  const thread: ThreadRow = {
    thread_id: "thread-1",
    created_at: clock.now,
    updated_at: clock.now,
    title: "快捷支付",
    status: "idle",
    thread_values: null,
    metadata: JSON.stringify({ workspacePath: root, agentMode: "normal" })
  }
  const gateway = new RecordingGateway()
  let interactionSequence = 0
  const interactions = new ImCardInteractionStore(
    () => `interaction-${++interactionSequence}`,
    () => clock.now
  )
  const warnings: string[] = []
  const cards = new ImCardPublisher({
    gateway: gateway as unknown as ImGatewayClientPort,
    interactions,
    createIdempotencyKey: () => `idem-${interactionSequence}`,
    warn: (message) => warnings.push(message)
  })
  const broker = new ApprovalDecisionBroker()
  const codes = ["A1B2C3", "D4E5F6", "AAA111"]
  const approvals = new ImRemoteApprovalService({
    broker,
    conversations,
    access: { getThreadGrant: (threadId) => grants.getThreadGrant(threadId) },
    grants,
    events,
    audits,
    cards,
    getThread: (threadId) => (threadId === thread.thread_id ? thread : null),
    getSettings: () => ({
      enabled: true,
      gatewayUrl: null,
      remoteAccess: "inbox-only",
      remoteApprovalEnabled: true
    }),
    createCode: () => codes.shift() ?? "ZZZ999",
    warn: () => undefined
  })
  approvals.registerReplyDrainer({
    sendPending: async () => ({ sent: 0, failed: 0, unknown: 0, deferred: 0 })
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

  return {
    root,
    gateway,
    cards,
    interactions,
    approvals,
    events,
    broker,
    register,
    warnings,
    async dispose() {
      approvals.dispose()
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  }
}

async function testTheCardCarriesTheSameGateAsTheShortCode(): Promise<void> {
  const context = await createContext()
  try {
    const decisions = context.register(approvalRequest(context.root))
    await waitFor(() => context.gateway.sent.length === 1, "the approval card")

    const card = context.gateway.sent[0]
    assert.equal(card.kind, "approval")
    const rendered = JSON.stringify(card.content)
    // Which session is asking must survive into the card. A scheduler reminder
    // can reach someone bound elsewhere, and approving a write without knowing
    // whose task asked is exactly what the text prefix prevents.
    assert.ok(rendered.includes("快捷支付"), "the card names its thread")
    assert.ok(rendered.includes("config.ts"), "the card names the file")
    // The short code stays on the card: the buttons can fail, the code cannot.
    assert.ok(rendered.includes("/批准 A1B2C3"), "the card keeps the short code")

    const receipt: RemoteImCardReceiptV1 = {
      schemaVersion: 1,
      receiptId: "receipt-1",
      interactionId: card.interactionId,
      tag: `${card.tag}:approve`,
      principalId: ROUTE.principalId,
      conversationKey: ROUTE.conversationKey,
      feedback: [],
      occurredAt: new Date().toISOString()
    }
    const router = new ImCardReceiptRouter({
      cards: context.cards,
      approvals: context.approvals,
      userInput: { resolveCardAnswers: async () => "unused" },
      events: context.events,
      warn: () => undefined
    })
    await router.handle(receipt)

    assert.equal(decisions.length, 1, "the click decided the request")
    assert.equal(decisions[0].type, "approve")
    assert.deepEqual(context.gateway.acknowledged, ["receipt-1"])
    await waitFor(() => context.gateway.updated.length >= 1, "the terminal card")
    assert.ok(
      JSON.stringify(context.gateway.updated[0].content).includes("已批准"),
      "the card shows the outcome"
    )
    console.log("PASS testTheCardCarriesTheSameGateAsTheShortCode")
  } finally {
    await context.dispose()
  }
}

async function testASecondClickFindsTheCodeAlreadySpent(): Promise<void> {
  const context = await createContext()
  try {
    context.register(approvalRequest(context.root))
    await waitFor(() => context.gateway.sent.length === 1, "the approval card")
    const card = context.gateway.sent[0]
    const router = new ImCardReceiptRouter({
      cards: context.cards,
      approvals: context.approvals,
      userInput: { resolveCardAnswers: async () => "unused" },
      events: context.events,
      warn: () => undefined
    })
    const receipt = (receiptId: string): RemoteImCardReceiptV1 => ({
      schemaVersion: 1,
      receiptId,
      interactionId: card.interactionId,
      tag: `${card.tag}:approve`,
      principalId: ROUTE.principalId,
      conversationKey: ROUTE.conversationKey,
      feedback: [],
      occurredAt: new Date().toISOString()
    })
    await router.handle(receipt("receipt-1"))
    // A distinct receipt id is a genuine second click, not a platform retry:
    // it must be refused by the spent short code rather than deduplicated.
    await router.handle(receipt("receipt-2"))

    const replies = context.events
      .listOutbox()
      .filter((row) => row.deliveryId === "card-receipt:receipt-2")
      .map((row) => row.content)
      .join("\n")
    assert.ok(replies.length > 0, "the second click still gets an answer")
    // Either refusal is correct: the short code is spent, or the interaction was
    // released with it. What must never appear is a second applied decision.
    assert.ok(
      replies.includes("已使用") || replies.includes("失效"),
      `the second click is refused, got: ${replies}`
    )
    assert.ok(
      !replies.includes("已从招乎"),
      `the second click must not decide again, got: ${replies}`
    )
    console.log("PASS testASecondClickFindsTheCodeAlreadySpent")
  } finally {
    await context.dispose()
  }
}

async function testAClickFromAnotherPrincipalIsRefused(): Promise<void> {
  const context = await createContext()
  try {
    const decisions = context.register(approvalRequest(context.root))
    await waitFor(() => context.gateway.sent.length === 1, "the approval card")
    const card = context.gateway.sent[0]
    const router = new ImCardReceiptRouter({
      cards: context.cards,
      approvals: context.approvals,
      userInput: { resolveCardAnswers: async () => "unused" },
      events: context.events,
      warn: () => undefined
    })
    // The webhook behind this receipt is authenticated by source IP alone, so
    // the tag is a bearer capability and this ownership check is the only
    // thing standing between a real user and someone else's approval.
    await router.handle({
      schemaVersion: 1,
      receiptId: "receipt-x",
      interactionId: card.interactionId,
      tag: `${card.tag}:approve`,
      principalId: "principal-2",
      conversationKey: ROUTE.conversationKey,
      feedback: [],
      occurredAt: new Date().toISOString()
    })
    assert.equal(decisions.length, 0, "a foreign principal decided nothing")
    // The approval service checks ownership too, so assert on the router's own
    // wording: otherwise this passes even with the router's check deleted and
    // stops guarding the user-input path, which has no second line of defence.
    const replies = context.events
      .listOutbox()
      .filter((row) => row.deliveryId === "card-receipt:receipt-x")
      .map((row) => row.content)
      .join("\n")
    assert.ok(
      replies.includes("这张卡片不属于当前招乎会话"),
      `the router refused it before reaching a service, got: ${replies}`
    )
    console.log("PASS testAClickFromAnotherPrincipalIsRefused")
  } finally {
    await context.dispose()
  }
}

async function testAClickOnAForgottenCardIsExplainedNotSwallowed(): Promise<void> {
  const context = await createContext()
  try {
    const router = new ImCardReceiptRouter({
      cards: context.cards,
      approvals: context.approvals,
      userInput: { resolveCardAnswers: async () => "unused" },
      events: context.events,
      warn: () => undefined
    })
    // Cards live in the chat history forever; the runs they gate do not.
    await router.handle({
      schemaVersion: 1,
      receiptId: "receipt-old",
      interactionId: "interaction-gone",
      tag: "a".repeat(32),
      principalId: ROUTE.principalId,
      conversationKey: ROUTE.conversationKey,
      feedback: [],
      occurredAt: new Date().toISOString()
    })
    const replies = context.events
      .listOutbox()
      .filter((row) => row.deliveryId === "card-receipt:receipt-old")
      .map((row) => row.content)
      .join("\n")
    // The desktop cannot see whether the request is still waiting — only that it
    // no longer tracks this card — so the answer must not claim the gate ended,
    // and must point at the short code that can still answer it.
    assert.ok(replies.includes("失效"), `the stale click is explained, got: ${replies}`)
    assert.ok(replies.includes("短码"), `the stale click keeps a way out, got: ${replies}`)
    assert.ok(
      !replies.includes("已经结束"),
      `an approval never times out; the desktop must not declare it over, got: ${replies}`
    )
    assert.deepEqual(context.gateway.acknowledged, ["receipt-old"])
    console.log("PASS testAClickOnAForgottenCardIsExplainedNotSwallowed")
  } finally {
    await context.dispose()
  }
}

async function testAnUnsendableCardLeavesTheShortCodeWorking(): Promise<void> {
  const context = await createContext()
  try {
    context.gateway.accept = false
    const decisions = context.register(approvalRequest(context.root))
    await waitFor(() => context.gateway.sent.length === 1, "the attempted card")
    // The gate is still answerable: no interaction is retained, the text notice
    // with its short code was queued before the card was ever attempted.
    assert.equal(context.interactions.list().length, 0, "a refused card is not retained")
    assert.equal(decisions.length, 0, "nothing was decided by the failure")
    const text = context.events
      .listOutbox()
      .filter((row) => row.deliveryId === "approval-request:req-1")
      .map((row) => row.content)
      .join("\n")
    assert.ok(text.includes("/批准 A1B2C3"), "the short code still reached the reader")
    console.log("PASS testAnUnsendableCardLeavesTheShortCodeWorking")
  } finally {
    await context.dispose()
  }
}

function testTheQuestionFormMirrorsTheTextEscapeHatch(): void {
  const content = buildQuestionCard({
    targetLabel: "快捷支付",
    questions: [
      {
        key: "q0",
        header: "分支",
        question: "合到哪个分支？",
        options: [{ label: "main" }, { label: "release" }]
      },
      {
        key: "q1",
        header: "范围",
        question: "只改前端吗？",
        options: [{ label: "是" }, { label: "否" }],
        answered: true,
        answeredLabel: "是"
      }
    ],
    tag: "b".repeat(32),
    fallbackCommand: "/回答 A1B2C3 <编号>"
  })
  const interactive = content.find((component) => component.type === "interactive")
  assert.ok(interactive, "the form renders an interactive component")
  const controls = interactive.inputControlArray as Array<Record<string, unknown>>
  const keys = controls.map((control) => control.feedbackKey)
  // Every text question accepts `其他 <回答>`, so a form without a free-text
  // control would be strictly weaker than the short code it replaces.
  assert.deepEqual(keys, ["q0", `q0${QUESTION_OTHER_SUFFIX}`])
  assert.ok(!keys.includes("q1"), "a question already answered by short code is not offered again")
  console.log("PASS testTheQuestionFormMirrorsTheTextEscapeHatch")
}

function testEveryBuiltCardSatisfiesTheContract(): void {
  const approval = buildApprovalCard({
    targetLabel: "快捷支付",
    operation: "edit_file",
    detail: "写入 src/config.ts",
    tag: "c".repeat(32),
    allowedDecisions: ["approve", "reject"],
    fallbackCommands: "/批准 A1B2C3   或   /拒绝 A1B2C3"
  })
  assertRemoteImCardSendV1({
    schemaVersion: 1,
    interactionId: "interaction-1",
    conversationKey: ROUTE.conversationKey,
    idempotencyKey: "idem-1",
    tag: "c".repeat(32),
    kind: "approval",
    content: approval
  })
  console.log("PASS testEveryBuiltCardSatisfiesTheContract")
}

/**
 * The gateway sends what an unresolved click actually looks like: no
 * interaction, no route. Rejecting that shape closed the socket, and because an
 * unacknowledged receipt is redelivered, the connection cycled for as long as
 * the receipt existed — taking every approval, reply and permit with it.
 */
function testAnUnresolvedReceiptIsAValidPayload(): void {
  assertRemoteImCardReceiptV1({
    schemaVersion: 1,
    receiptId: "receipt-unresolved",
    interactionId: null,
    conversationKey: null,
    kind: null,
    tag: "u".repeat(32),
    principalId: ROUTE.principalId,
    feedback: [],
    occurredAt: new Date().toISOString()
  })
  assertRemoteImCardReceiptV1({
    schemaVersion: 1,
    receiptId: "receipt-omitted",
    tag: "v".repeat(32),
    principalId: ROUTE.principalId,
    feedback: [],
    occurredAt: new Date().toISOString()
  })
  console.log("PASS testAnUnresolvedReceiptIsAValidPayload")
}

/**
 * A click on a card the desktop has forgotten must actually close it. The close
 * used to run through `resolve`, which starts by claiming a version from the
 * in-memory store — and the only way to reach this path is for the interaction
 * to be absent from that store, so it returned before reaching the gateway.
 */
async function testAForgottenCardIsActuallyClosed(): Promise<void> {
  const gateway = new RecordingGateway()
  const publisher = new ImCardPublisher({
    gateway: gateway as never,
    interactions: new ImCardInteractionStore(),
    isThreadLive: () => true,
    warn: () => undefined
  })
  const router = new ImCardReceiptRouter({
    cards: publisher,
    approvals: { resolveCardClick: async () => "unused" },
    userInput: { resolveCardAnswers: async () => "unused" },
    events: { enqueueProactiveReplies: async () => [] },
    warn: () => undefined
  })

  await router.handle({
    schemaVersion: 1,
    receiptId: "receipt-stale",
    interactionId: "interaction-long-gone",
    kind: "user_input",
    tag: "w".repeat(32),
    principalId: ROUTE.principalId,
    conversationKey: ROUTE.conversationKey,
    feedback: [],
    occurredAt: new Date().toISOString()
  })
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(gateway.updated.length, 1, "the stale card must be closed")
  assert.equal(gateway.updated[0]!.interactionId, "interaction-long-gone")
  assert.equal(
    gateway.updated[0]!.cardVersion,
    undefined,
    "a forgotten card cannot claim a version; the gateway assigns it"
  )
  const rendered = JSON.stringify(gateway.updated[0]!.content)
  assert(rendered.includes("已失效"), rendered)
  assert(
    rendered.includes("需要你的选择"),
    "a stale question card must not be closed with the approval title"
  )
  console.log("PASS testAForgottenCardIsActuallyClosed")
}

/**
 * The interaction is addressable from the moment it is registered, so a gate
 * resolved while its card is still being sent can still claim a version and
 * issue its terminal update.
 *
 * The transport half of this — that the client no longer refuses an overlapping
 * command — lives in im-gateway-ws-client.spec.ts, because the guard being
 * tested is in the real client and a stub gateway cannot show it.
 */
async function testAnUpdateDuringTheSendStillLands(): Promise<void> {
  const gateway = new RecordingGateway()
  let releaseSend: (() => void) | null = null
  const slowSend = new Promise<void>((resolve) => {
    releaseSend = resolve
  })
  const originalSend = gateway.sendCard.bind(gateway)
  gateway.sendCard = async (card) => {
    await slowSend
    return originalSend(card)
  }

  const interactions = new ImCardInteractionStore()
  const publisher = new ImCardPublisher({
    gateway: gateway as never,
    interactions,
    isThreadLive: () => true,
    warn: () => undefined
  })

  const publishing = publisher.publish({
    kind: "approval",
    threadId: "thread-1",
    principalId: ROUTE.principalId,
    conversationKey: ROUTE.conversationKey,
    requestRef: "CODE01",
    targetLabel: "会话：桌面会话",
    build: (tag) =>
      buildApprovalCard({
        targetLabel: "会话：桌面会话",
        operation: "写入文件",
        detail: "src/a.ts",
        tag,
        allowedDecisions: ["approve", "reject"],
        fallbackCommands: "/批准 CODE01"
      })
  })

  // The desktop decides while the send is still in flight.
  const interaction = interactions.findByRequestRef("CODE01")
  assert(interaction, "the interaction must be addressable during the send")
  const resolving = publisher.resolve(interaction.interactionId, [
    { type: "title", content: "需要批准" },
    { type: "status", content: "已在桌面处理", style: 5 }
  ])

  releaseSend!()
  await publishing
  const updated = await resolving

  assert.equal(updated, true, "the terminal update must not be dropped as in-flight")
  assert.equal(gateway.sent.length, 1)
  assert.equal(gateway.updated.length, 1, "the card must end on the decision that resolved it")
  console.log("PASS testAnUpdateDuringTheSendStillLands")
}

/**
 * `kind` only chooses the wording on a closing card, but a receipt that fails
 * validation is dropped without being acknowledged — so it is redelivered
 * forever while its gate stays open. That is what made a casing mismatch on a
 * rendering hint fatal to every legitimate click.
 *
 * So the rule under test is that no value of `kind` can cost the click: the two
 * wire spellings are honoured, anything else is ignored. This cannot detect the
 * gateway drifting to another casing — that is a cross-repository fact and lives
 * in the gateway's own tools/check_card_kind_casing.py — it only guarantees the
 * drift stays survivable.
 */
function testAnUnknownKindNeverCostsTheClick(): void {
  const base = {
    schemaVersion: 1 as const,
    receiptId: "receipt-kind",
    interactionId: "interaction-1",
    tag: "k".repeat(32),
    principalId: ROUTE.principalId,
    conversationKey: ROUTE.conversationKey,
    feedback: [],
    occurredAt: new Date().toISOString()
  }
  for (const unknown of ["APPROVAL", "USER_INPUT", "something-new", ""]) {
    const receipt = { ...base, kind: unknown }
    assertRemoteImCardReceiptV1(receipt)
    assert.equal(
      (receipt as { kind?: string }).kind,
      undefined,
      "an unrecognised kind must be dropped, never allowed to reject the click"
    )
  }
  for (const wire of ["approval", "user_input"]) {
    const receipt = { ...base, kind: wire }
    assertRemoteImCardReceiptV1(receipt)
    assert.equal((receipt as { kind?: string }).kind, wire)
  }
  console.log("PASS testAnUnknownKindNeverCostsTheClick")
}

/**
 * A stale close must not paint over the card that recorded the decision. The
 * desktop releases an interaction as it writes that terminal card, so a click
 * arriving right afterwards resolves to nothing and asks the gateway to close a
 * card that was closed a moment ago.
 */
async function testAStaleCloseCannotOverwriteADecision(): Promise<void> {
  const gateway = new RecordingGateway()
  const interactions = new ImCardInteractionStore()
  const publisher = new ImCardPublisher({
    gateway: gateway as never,
    interactions,
    isThreadLive: () => true,
    warn: () => undefined
  })
  const router = new ImCardReceiptRouter({
    cards: publisher,
    approvals: { resolveCardClick: async () => "unused" },
    userInput: { resolveCardAnswers: async () => "unused" },
    events: { enqueueProactiveReplies: async () => [] },
    warn: () => undefined
  })

  const interaction = await publisher.publish({
    kind: "approval",
    threadId: "thread-1",
    principalId: ROUTE.principalId,
    conversationKey: ROUTE.conversationKey,
    requestRef: "CODE02",
    targetLabel: "会话：桌面会话",
    build: (tag) =>
      buildApprovalCard({
        targetLabel: "会话：桌面会话",
        operation: "写入文件",
        detail: "src/a.ts",
        tag,
        allowedDecisions: ["approve", "reject"],
        fallbackCommands: "/批准 CODE02"
      })
  })
  assert(interaction)

  // The decision lands and releases the interaction.
  await publisher.resolve(interaction.interactionId, [
    { type: "title", content: "需要批准" },
    { type: "status", content: "已批准", style: 3 }
  ])
  // A click for the now-forgotten card arrives immediately afterwards.
  await router.handle({
    schemaVersion: 1,
    receiptId: "receipt-late",
    interactionId: interaction.interactionId,
    kind: "approval",
    tag: interaction.tag,
    principalId: ROUTE.principalId,
    conversationKey: ROUTE.conversationKey,
    feedback: [],
    occurredAt: new Date().toISOString()
  })
  await new Promise((resolve) => setTimeout(resolve, 10))

  const versionless = gateway.updated.filter((update) => update.cardVersion === undefined)
  assert.equal(versionless.length, 1, "the stale close is still attempted")
  assert.equal(
    versionless[0]!.cardVersion,
    undefined,
    "it cannot claim a version, so the gateway must be the one to refuse it"
  )
  // The gateway is the authority here: it drops a version-less update once the
  // card has been updated. Assert the desktop hands it what it needs to decide.
  const decision = gateway.updated.find((update) => update.cardVersion !== undefined)
  assert(decision, "the decision must have claimed a version")
  assert(JSON.stringify(decision.content).includes("已批准"))
  console.log("PASS testAStaleCloseCannotOverwriteADecision")
}

async function main(): Promise<void> {
  testEveryBuiltCardSatisfiesTheContract()
  testTheQuestionFormMirrorsTheTextEscapeHatch()
  await testTheCardCarriesTheSameGateAsTheShortCode()
  await testASecondClickFindsTheCodeAlreadySpent()
  await testAClickFromAnotherPrincipalIsRefused()
  await testAClickOnAForgottenCardIsExplainedNotSwallowed()
  await testAnUnsendableCardLeavesTheShortCodeWorking()
  testAnUnresolvedReceiptIsAValidPayload()
  await testAForgottenCardIsActuallyClosed()
  await testAnUpdateDuringTheSendStillLands()
  testAnUnknownKindNeverCostsTheClick()
  await testAStaleCloseCannotOverwriteADecision()
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
