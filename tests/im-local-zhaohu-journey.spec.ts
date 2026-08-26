import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import initSqlJs from "sql.js"
import { ApprovalDecisionBroker } from "../src/main/agent/approval-decision-broker"
import type { ThreadRow } from "../src/main/db"
import type {
  ApprovalDecision,
  ApprovalRequest,
  UserInputRequest,
  UserInputResponse
} from "../src/main/types"
import { ImRemoteCapabilityGuard } from "../src/main/services/im/capability-guard"
import { ImCommandRouter, parseImCommand } from "../src/main/services/im/command-router"
import { ImConversationStateStore } from "../src/main/services/im/conversation-state"
import { ImConversationTurnQueue } from "../src/main/services/im/conversation-turn-queue"
import { ImEventStore, type ImEventRecord } from "../src/main/services/im/event-store"
import { ImFeatureBindingService } from "../src/main/services/im/feature-binding-service"
import type {
  ImExecutionPermitResult,
  ImGatewayClientPort,
  ImReplySubmissionResult
} from "../src/main/services/im/gateway-client"
import { ImInboxService } from "../src/main/services/im/inbox-service"
import { ImIngressSequencer, type ImIngressResult } from "../src/main/services/im/ingress-sequencer"
import { MockImGateway } from "../src/main/services/im/mock-gateway"
import type { ImPersistenceDependencies } from "../src/main/services/im/persistence"
import { ImRemoteAccessService } from "../src/main/services/im/remote-access-service"
import { ImRemoteApprovalAuditStore } from "../src/main/services/im/remote-approval-audit-store"
import { ImRemoteApprovalService } from "../src/main/services/im/remote-approval-service"
import { ImRemoteGrantStore } from "../src/main/services/im/remote-grant-store"
import { ImRemoteRunner } from "../src/main/services/im/remote-runner"
import { ImRemoteUserInputService } from "../src/main/services/im/remote-user-input-service"
import { ImReplyClient } from "../src/main/services/im/reply-client"
import { ImSelectionContextStore } from "../src/main/services/im/selection-context"
import { ensureImServiceSchema } from "../src/main/services/im/schema"
import type {
  RemoteImAckV1,
  RemoteImEventV1,
  RemoteImReplyV1
} from "../src/shared/im-gateway-contract"

const PRINCIPAL_ID = "principal-local-journey"
const CONVERSATION_KEY = "zhaohu-local-single-chat"
const SESSION_ID = "desktop-local-session"

type PendingUserListener = (request: Readonly<UserInputRequest>) => void
type RemovedUserListener = (requestId: string, threadId: string) => void

class MockGatewayClient implements ImGatewayClientPort {
  readonly acknowledgements: RemoteImAckV1[] = []
  readonly replies: RemoteImReplyV1[] = []

  constructor(
    private readonly gateway: MockImGateway,
    private readonly sessionId: string
  ) {}

  isAuthenticated(): boolean {
    return true
  }

  async sendAcknowledgement(ack: RemoteImAckV1): Promise<void> {
    this.acknowledgements.push(structuredClone(ack))
    this.gateway.acknowledge(this.sessionId, ack)
  }

  async acquireExecutionPermit(event: ImEventRecord): Promise<ImExecutionPermitResult> {
    const result = this.gateway.acquirePermit({
      eventId: event.eventId,
      sessionId: this.sessionId,
      leaseId: event.leaseId
    })
    return {
      status: result.status,
      ...(result.leaseId ? { leaseId: result.leaseId } : {}),
      ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
      ...(result.reasonCode ? { reasonCode: result.reasonCode } : {})
    }
  }

  async renewExecutionPermit(event: ImEventRecord): Promise<ImExecutionPermitResult> {
    const result = this.gateway.renewPermit({
      eventId: event.eventId,
      sessionId: this.sessionId,
      leaseId: event.leaseId
    })
    return {
      status: result.status,
      ...(result.leaseId ? { leaseId: result.leaseId } : {}),
      ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
      ...(result.reasonCode ? { reasonCode: result.reasonCode } : {})
    }
  }

  async submitReply(reply: RemoteImReplyV1): Promise<ImReplySubmissionResult> {
    this.replies.push(structuredClone(reply))
    const result = this.gateway.submitReply(this.sessionId, reply)
    return {
      state: result.state,
      ...(result.platformReplyId ? { platformReplyId: result.platformReplyId } : {})
    }
  }
}

function selectionIndexContaining(list: string, marker: string): number {
  const line = list.split("\n").find((candidate) => candidate.includes(marker))
  const match = line?.match(/^(\d+)\./u)
  if (!match) throw new Error(`selection containing ${marker} not found`)
  return Number(match[1])
}

async function waitFor<T>(read: () => T | null | undefined | false, label: string): Promise<T> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const value = read()
    if (value !== null && value !== undefined && value !== false) return value
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function createJourney() {
  const root = await mkdtemp(join(tmpdir(), "cmb-im-local-journey-"))
  const SQL = await initSqlJs()
  const database = new SQL.Database()
  ensureImServiceSchema(database)
  const clock = { now: Date.parse("2026-08-19T08:00:00.000Z") }
  const persistence: ImPersistenceDependencies = {
    getDatabase: () => database,
    markDirty: () => undefined,
    flushStrict: async () => undefined,
    now: () => clock.now
  }
  const conversations = new ImConversationStateStore(persistence)
  const events = new ImEventStore(persistence)
  let idSequence = 0
  const createId = (prefix: string): string => `${prefix}-${++idSequence}`
  const threads = new Map<string, ThreadRow>()
  const makeThread = (threadId: string, metadata: Record<string, unknown> = {}): ThreadRow => {
    const row: ThreadRow = {
      thread_id: threadId,
      created_at: clock.now,
      updated_at: clock.now,
      title: typeof metadata.title === "string" ? metadata.title : null,
      status: "idle",
      thread_values: null,
      metadata: JSON.stringify(metadata)
    }
    threads.set(threadId, row)
    return row
  }
  const updateLocalThread = (
    threadId: string,
    patch: Partial<Omit<ThreadRow, "thread_id" | "created_at">>
  ): ThreadRow | null => {
    const existing = threads.get(threadId)
    if (!existing) return null
    const updated = { ...existing, ...patch, updated_at: clock.now }
    threads.set(threadId, updated)
    return updated
  }

  const featureService = new ImFeatureBindingService({
    conversationState: conversations,
    getSettings: () => ({ enabled: true, remoteAccess: "inbox-and-features" }) as never,
    projectModeEnabled: async () => true,
    listProjects: () =>
      [
        {
          projectId: "project-pay",
          name: "支付平台",
          lifecycle: { status: "active", createAt: "2026-08-19T00:00:00.000Z" },
          boardCompatibility: { compatible: true }
        }
      ] as never,
    getProjectDetail: () =>
      ({
        project: {
          projectId: "project-pay",
          name: "支付平台",
          projectRootPath: root,
          sessionWorkspacePath: root
        },
        projectState: { label: "active", uiKind: "active" },
        runs: [
          {
            slug: "feature-quick-pay",
            title: "快捷支付",
            location: "active",
            featureStatus: "in_progress",
            overallStatus: { label: "进行中", uiKind: "active" }
          }
        ],
        error: null
      }) as never,
    getRunDetail: () => ({ sessions: [] }) as never,
    buildFeatureContext: () => ({ featureId: "feature-quick-pay" }) as never,
    getThread: (threadId) => threads.get(threadId) ?? null,
    createThread: makeThread as never,
    createId: () => createId("feature-thread")
  })
  const inbox = new ImInboxService({
    conversationState: conversations,
    openworkDirectory: () => root,
    createThread: makeThread,
    getThread: (threadId) => threads.get(threadId) ?? null,
    createId: () => createId("inbox"),
    ensureDirectory: async () => undefined
  })
  const grants = new ImRemoteGrantStore(persistence, () => createId("grant"))
  const selections = new ImSelectionContextStore(
    persistence,
    () => createId("selection"),
    5 * 60_000
  )
  const broker = new ApprovalDecisionBroker()
  let pendingUserInput: UserInputRequest | null = null
  let resolvePendingUserInput: ((response: UserInputResponse) => void) | null = null
  const pendingUserListeners = new Set<PendingUserListener>()
  const removedUserListeners = new Set<RemovedUserListener>()
  const userInputResponses: UserInputResponse[] = []

  const access = new ImRemoteAccessService({
    conversations,
    grants,
    features: featureService,
    getThread: (threadId) => threads.get(threadId) ?? null,
    deleteThread: ((threadId: string) => threads.delete(threadId)) as never,
    createId: () => createId("target"),
    getGoal: () => null,
    coordinator: {
      hasRunningWorkersForThread: () => false,
      hasNotifications: () => false,
      hasTerminalWorkerAwaitingNotificationForThread: () => false
    },
    workflow: { isBusyForThread: () => false },
    hasPendingApproval: (threadId) => broker.list(threadId).length > 0,
    hasPendingUserInput: (threadId) => pendingUserInput?.threadId === threadId
  })

  const mockGateway = new MockImGateway({ now: () => clock.now })
  mockGateway.connectSession({ principalId: PRINCIPAL_ID, sessionId: SESSION_ID })
  const gateway = new MockGatewayClient(mockGateway, SESSION_ID)
  const replyClient = new ImReplyClient(gateway, events, () => clock.now)
  const audits = new ImRemoteApprovalAuditStore(persistence, () => createId("audit"))
  const approvalService = new ImRemoteApprovalService({
    broker,
    conversations,
    access: { getThreadGrant: (threadId) => grants.getThreadGrant(threadId) },
    grants,
    events,
    audits,
    getThread: (threadId) => threads.get(threadId) ?? null,
    getSettings: () =>
      ({
        enabled: true,
        gatewayUrl: null,
        remoteAccess: "inbox-and-features",
        remoteApprovalEnabled: true,
        waitingDesktopTtlMinutes: 10
      }) as never,
    now: () => clock.now,
    createCode: () => "A1B2C3",
    warn: (message, error) => {
      throw new Error(`${message}: ${String(error ?? "")}`)
    }
  })
  const userInputService = new ImRemoteUserInputService({
    conversations,
    access: { getThreadGrant: (threadId) => grants.getThreadGrant(threadId) },
    grants,
    events,
    getThread: (threadId) => threads.get(threadId) ?? null,
    getSettings: () =>
      ({
        enabled: true,
        gatewayUrl: null,
        remoteAccess: "inbox-and-features",
        remoteApprovalEnabled: true,
        waitingDesktopTtlMinutes: 10
      }) as never,
    getPendingForThread: ((threadId: string) =>
      pendingUserInput?.threadId === threadId ? pendingUserInput : null) as never,
    submitResponse: ((response: UserInputResponse) => {
      if (!pendingUserInput || response.requestId !== pendingUserInput.requestId) return false
      const removed = pendingUserInput
      pendingUserInput = null
      userInputResponses.push(response)
      for (const listener of removedUserListeners) listener(removed.requestId, removed.threadId)
      const resolve = resolvePendingUserInput
      resolvePendingUserInput = null
      resolve?.(response)
      return true
    }) as never,
    subscribePending: ((listener: PendingUserListener) => {
      pendingUserListeners.add(listener)
      return () => pendingUserListeners.delete(listener)
    }) as never,
    subscribeRemoved: ((listener: RemovedUserListener) => {
      removedUserListeners.add(listener)
      return () => removedUserListeners.delete(listener)
    }) as never,
    now: () => clock.now,
    createCode: () => "D4E5F6",
    warn: (message, error) => {
      throw new Error(`${message}: ${String(error ?? "")}`)
    }
  })
  approvalService.registerReplyDrainer(replyClient)
  userInputService.registerReplyDrainer(replyClient)

  const guard = new ImRemoteCapabilityGuard({
    conversationState: conversations,
    getThread: (threadId) => threads.get(threadId) ?? null,
    updateThread: updateLocalThread,
    getGoal: () => null,
    coordinator: {
      hasRunningWorkersForThread: () => false,
      hasNotifications: () => false,
      hasTerminalWorkerAwaitingNotificationForThread: () => false
    },
    workflow: { isBusyForThread: () => false },
    hasPendingApproval: (threadId) => broker.list(threadId).length > 0,
    hasPendingUserInput: (threadId) => pendingUserInput?.threadId === threadId,
    validateExistingFeatureThread: (metadata, workspacePath) =>
      featureService.validateExistingFeatureThread(metadata, workspacePath),
    grants
  })

  let releaseLongTask: (() => void) | null = null
  const executedMessages: string[] = []
  const requestUserInput = (threadId: string, signal: AbortSignal): Promise<UserInputResponse> => {
    const request: UserInputRequest = {
      requestId: createId("input-request"),
      threadId,
      createdAt: new Date(clock.now).toISOString(),
      questions: [
        {
          id: "deployment_scope",
          header: "范围",
          question: "本次发布到哪个环境？",
          options: [
            { label: "UAT (Recommended)", description: "先在验收环境验证。" },
            { label: "生产", description: "直接发布到生产环境。" }
          ]
        }
      ]
    }
    pendingUserInput = request
    for (const listener of pendingUserListeners) listener(request)
    return new Promise<UserInputResponse>((resolve, reject) => {
      resolvePendingUserInput = resolve
      const onAbort = (): void => {
        if (pendingUserInput?.requestId === request.requestId) {
          pendingUserInput = null
          for (const listener of removedUserListeners) listener(request.requestId, threadId)
        }
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
      }
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }
  const runner = new ImRemoteRunner({
    gateway,
    eventStore: events,
    conversationState: conversations,
    capabilityGuard: guard,
    replyClient,
    getThread: (threadId) => threads.get(threadId) ?? null,
    getThreadMessages: () => [],
    updateThread: updateLocalThread,
    notifyThreadChanged: () => undefined,
    createRunId: () => createId("run"),
    permitRenewIntervalMs: 60_000,
    waitingDesktopTtlMs: 5_000,
    setThreadLifecycle: async () => undefined,
    executeTurn: async ({ event, signal, interactionWaitHooks }) => {
      executedMessages.push(event.messageText)
      if (event.messageText === "运行一个长任务") {
        await new Promise<void>((resolve, reject) => {
          releaseLongTask = resolve
          signal.addEventListener(
            "abort",
            () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true }
          )
        })
        return "Feature 长任务完成"
      }
      if (event.messageText === "执行需要审批的命令") {
        assert(interactionWaitHooks)
        const request: ApprovalRequest = {
          id: "approval-request-journey",
          tool_call: {
            id: "tool-call-journey",
            name: "execute",
            args: {},
            metadata: null,
            status: "pending",
            thread_values: null,
            title: null
          },
          allowed_decisions: ["approve", "reject"],
          safety_level: "needs_approval",
          operation: "execute",
          command: "npm test",
          cwd: root,
          allowed_approval_types: ["approve", "reject"]
        }
        await interactionWaitHooks.onWaitStart({
          id: request.id,
          kind: "approval",
          threadId: event.targetSnapshot!.threadId
        })
        const decision = await new Promise<ApprovalDecision>((resolve, reject) => {
          const onAbort = (): void =>
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
          signal.addEventListener("abort", onAbort, { once: true })
          broker.register({
            request,
            threadId: event.targetSnapshot!.threadId,
            runtimeThreadId: event.targetSnapshot!.threadId,
            resolve: (value) => {
              signal.removeEventListener("abort", onAbort)
              resolve(value)
            }
          })
        })
        await interactionWaitHooks.onWaitEnd({
          id: request.id,
          kind: "approval",
          threadId: event.targetSnapshot!.threadId
        })
        return decision.type === "approve" ? "审批通过后任务完成" : "审批拒绝后任务结束"
      }
      if (event.messageText === "询问发布范围") {
        assert(interactionWaitHooks)
        const waitId = "user-input-wait-journey"
        await interactionWaitHooks.onWaitStart({
          id: waitId,
          kind: "user_input",
          threadId: event.targetSnapshot!.threadId
        })
        const response = await requestUserInput(event.targetSnapshot!.threadId, signal)
        await interactionWaitHooks.onWaitEnd({
          id: waitId,
          kind: "user_input",
          threadId: event.targetSnapshot!.threadId
        })
        const answer = response.answers.deployment_scope
        return `已选择：${answer.type === "option" ? answer.label : answer.text}`
      }
      if (event.messageText === "启动可停止任务") {
        return new Promise<string>((_resolve, reject) => {
          const rejectAborted = (): void =>
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
          if (signal.aborted) rejectAborted()
          else signal.addEventListener("abort", rejectAborted, { once: true })
        })
      }
      return `模拟回答：${event.messageText}`
    }
  })
  const queueErrors: unknown[] = []
  const queue = new ImConversationTurnQueue(async (event, signal) => {
    await runner.invoke(event, signal)
  }, events)
  const router = new ImCommandRouter({
    conversations,
    events,
    inbox,
    access,
    approvals: approvalService,
    userInputs: userInputService,
    selections,
    abortCurrent: (conversationKey) => queue.abortCurrentImEvent(conversationKey),
    getCurrentEventId: (conversationKey) => queue.getCurrentEventId(conversationKey)
  })
  const ingress = new ImIngressSequencer({
    conversationState: conversations,
    eventStore: events,
    inboxService: inbox,
    replyClient,
    emitAcknowledgement: (ack) => gateway.sendAcknowledgement(ack)
  })

  const deliver = async (event: RemoteImEventV1): Promise<ImIngressResult> => {
    const command = parseImCommand(event.message.text)
    if (command) {
      return ingress.receiveControlEvent(event, () =>
        router.handle({
          command,
          conversationKey: event.conversationKey,
          principalId: event.principalId
        })
      )
    }
    const result = await ingress.receiveOrdinaryEvent(event)
    void queue.notify(event.conversationKey).catch((error) => queueErrors.push(error))
    return result
  }
  let platformSequence = 0
  const send = async (
    text: string,
    platformMessageId = `zhaohu-message-${++platformSequence}`
  ): Promise<{ event: ImEventRecord; platformMessageId: string }> => {
    const ingested = mockGateway.ingestText({
      platformMessageId,
      principalId: PRINCIPAL_ID,
      conversationKey: CONVERSATION_KEY,
      text,
      occurredAt: new Date(clock.now + platformSequence * 1_000).toISOString()
    })
    assert.equal(ingested.status, "deliverable")
    const deliveries = mockGateway.takeDeliveries(SESSION_ID)
    assert.equal(deliveries.length, 1, `expected one delivery for ${text}`)
    const result = await deliver(deliveries[0])
    return { event: result.event, platformMessageId }
  }
  const eventReplyText = (eventId: string): string =>
    gateway.replies
      .filter((reply) => reply.eventId === eventId)
      .sort((left, right) => left.segment.index - right.segment.index)
      .map((reply) => reply.message.content)
      .join("")
  const deliveryText = (deliveryId: string): string =>
    gateway.replies
      .filter((reply) => reply.deliveryId === deliveryId)
      .sort((left, right) => left.segment.index - right.segment.index)
      .map((reply) => reply.message.content)
      .join("")
  const waitForEventState = (eventId: string, state: ImEventRecord["state"]) =>
    waitFor(
      () => (events.getEvent(eventId)?.state === state ? events.getEvent(eventId) : null),
      `${eventId} to become ${state}`
    )

  return {
    root,
    database,
    clock,
    threads,
    conversations,
    events,
    grants,
    access,
    audits,
    mockGateway,
    gateway,
    approvalService,
    userInputService,
    queue,
    queueErrors,
    executedMessages,
    userInputResponses,
    send,
    deliver,
    eventReplyText,
    deliveryText,
    waitForEventState,
    releaseLongTask: () => releaseLongTask?.(),
    makeThread,
    cleanup: async () => {
      await queue.stop()
      approvalService.dispose()
      userInputService.dispose()
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  }
}

async function testSimulatedZhaohuUserJourney(): Promise<void> {
  const journey = await createJourney()
  try {
    const first = await journey.send("你好，介绍一下你自己")
    await journey.waitForEventState(first.event.eventId, "completed")
    const inbox = journey.conversations.getActiveTarget(CONVERSATION_KEY)
    assert.equal(inbox?.kind, "inbox")
    assert.equal(journey.threads.get(inbox!.threadId)?.title, "远程收件箱")
    assert(journey.eventReplyText(first.event.eventId).includes("模拟回答：你好，介绍一下你自己"))

    const help = await journey.send("/帮助", "zhaohu-help-stable-id")
    assert.equal(help.event.state, "completed")
    const helpText = journey.eventReplyText(help.event.eventId)
    assert(helpText.includes("/会话"))
    assert(helpText.includes("/批准"))
    assert.equal(helpText.match(/^\/收件箱 —/gmu)?.length, 1)

    const current = await journey.send("/当前")
    assert(journey.eventReplyText(current.event.eventId).includes("当前目标：【收件箱】"))

    journey.makeThread("desktop-debug-thread", {
      title: "桌面排障会话",
      workspacePath: journey.root,
      agentMode: "normal"
    })
    await journey.access.enableThread({
      route: { principalId: PRINCIPAL_ID, conversationKey: CONVERSATION_KEY },
      threadId: "desktop-debug-thread"
    })
    await journey.access.enableFeature({
      principalId: PRINCIPAL_ID,
      projectId: "project-pay",
      featureSlug: "feature-quick-pay"
    })

    const initialSessions = await journey.send("/会话")
    const initialSessionsText = journey.eventReplyText(initialSessions.event.eventId)
    assert(initialSessionsText.includes("桌面排障会话（普通会话）"))
    assert(initialSessionsText.includes("支付平台 / 快捷支付（特性，可创建新会话）"))
    const featureIndex = selectionIndexContaining(initialSessionsText, "（特性，可创建新会话）")
    const featureBind = await journey.send(`/绑定 ${featureIndex}`)
    assert(journey.eventReplyText(featureBind.event.eventId).includes("新建会话并切换"))
    const featureTarget = journey.conversations.getActiveTarget(CONVERSATION_KEY)
    assert.equal(featureTarget?.kind, "thread")
    if (featureTarget?.kind !== "thread") throw new Error("Feature Thread target expected")
    assert(featureTarget.title.startsWith("Thread "))
    const featureMetadata = JSON.parse(
      journey.threads.get(featureTarget.threadId)!.metadata!
    ) as Record<string, unknown>
    assert.equal(featureMetadata.targetKind, "feature")
    assert.equal(featureMetadata.remoteThread, true)
    assert.deepEqual(featureMetadata.harnessFeature, {
      projectId: "project-pay",
      slug: "feature-quick-pay",
      source: "autobizdevops"
    })
    assert.equal(journey.grants.getThreadGrant(featureTarget.threadId)?.state, "active")

    const legacyThread = journey.threads.get(featureTarget.threadId)
    if (!legacyThread) throw new Error("remote Feature Thread expected")
    legacyThread.title = "支付平台 / 快捷支付 · 远程会话 1"
    await journey.conversations.refreshGrantTarget({
      targetId: featureTarget.targetId,
      grantId: featureTarget.grantId,
      grantVersion: featureTarget.grantVersion,
      workspacePath: featureTarget.workspacePath,
      title: legacyThread.title
    })

    const featureMessage = await journey.send("检查 Feature 当前状态")
    await journey.waitForEventState(featureMessage.event.eventId, "completed")
    assert(
      journey
        .eventReplyText(featureMessage.event.eventId)
        .startsWith("【会话：检查 Feature 当前状态】")
    )

    const longTask = await journey.send("运行一个长任务")
    await journey.waitForEventState(longTask.event.eventId, "executing")
    const switchInbox = await journey.send("/收件箱")
    assert(journey.eventReplyText(switchInbox.event.eventId).includes("上一会话任务仍在执行"))
    assert.equal(journey.conversations.getActiveTarget(CONVERSATION_KEY)?.kind, "inbox")
    const queuedInbox = await journey.send("切换后进入收件箱的消息")
    assert.equal(journey.events.getEvent(queuedInbox.event.eventId)?.state, "queued")
    assert.equal(journey.events.getEvent(queuedInbox.event.eventId)?.targetSnapshot?.kind, "inbox")
    journey.releaseLongTask()
    await journey.waitForEventState(longTask.event.eventId, "completed")
    await journey.waitForEventState(queuedInbox.event.eventId, "completed")
    const longReply = journey.eventReplyText(longTask.event.eventId)
    assert(longReply.includes("【会话：检查 Feature 当前状态】"))
    assert(longReply.includes("切换前任务"))
    assert(!journey.eventReplyText(queuedInbox.event.eventId).includes("切换前任务"))

    const sessions = await journey.send("/会话")
    const sessionsText = journey.eventReplyText(sessions.event.eventId)
    assert(sessionsText.includes("检查 Feature 当前状态（项目会话）"))
    const ordinaryIndex = selectionIndexContaining(sessionsText, "桌面排障会话（普通会话）")
    const ordinaryBind = await journey.send(`/绑定 ${ordinaryIndex}`)
    assert(journey.eventReplyText(ordinaryBind.event.eventId).includes("桌面排障会话"))
    const ordinaryTarget = journey.conversations.getActiveTarget(CONVERSATION_KEY)
    assert.equal(ordinaryTarget?.threadId, "desktop-debug-thread")

    const approvalTask = await journey.send("执行需要审批的命令")
    await journey.waitForEventState(approvalTask.event.eventId, "waiting_desktop")
    await waitFor(
      () =>
        journey.deliveryText("approval-request:approval-request-journey").includes("A1B2C3")
          ? true
          : false,
      "remote approval prompt"
    )
    const approve = await journey.send("/批准 A1B2C3")
    assert(journey.eventReplyText(approve.event.eventId).includes("一次性批准"))
    await journey.waitForEventState(approvalTask.event.eventId, "completed")
    assert(journey.eventReplyText(approvalTask.event.eventId).includes("审批通过后任务完成"))
    assert.equal(journey.audits.getByRequestId("approval-request-journey")?.decision, "approve")
    const reusedApproval = await journey.send("/批准 A1B2C3")
    assert(journey.eventReplyText(reusedApproval.event.eventId).includes("已过期或已使用"))

    const userInputTask = await journey.send("询问发布范围")
    await journey.waitForEventState(userInputTask.event.eventId, "waiting_desktop")
    const inputRequest = await waitFor(
      () => journey.gateway.replies.find((reply) => reply.message.content.includes("D4E5F6")),
      "remote user-input prompt"
    )
    assert(inputRequest.message.content.includes("本次发布到哪个环境？"))
    const answer = await journey.send("/回答 D4E5F6 1")
    assert(journey.eventReplyText(answer.event.eventId).includes("任务将继续执行"))
    await journey.waitForEventState(userInputTask.event.eventId, "completed")
    assert(
      journey.eventReplyText(userInputTask.event.eventId).includes("已选择：UAT (Recommended)")
    )
    assert.equal(journey.userInputResponses.length, 1)

    const stoppable = await journey.send("启动可停止任务")
    await journey.waitForEventState(stoppable.event.eventId, "executing")
    const stop = await journey.send("/停止")
    assert(journey.eventReplyText(stop.event.eventId).includes("已请求停止"))
    await journey.waitForEventState(stoppable.event.eventId, "cancelled")
    assert(journey.eventReplyText(stoppable.event.eventId).includes("已停止当前远程任务"))

    const helpReplyCount = journey.gateway.replies.filter(
      (reply) => reply.eventId === help.event.eventId
    ).length
    journey.mockGateway.redeliver(help.event.eventId)
    const [redeliveredHelp] = journey.mockGateway.takeDeliveries(SESSION_ID)
    assert(redeliveredHelp.redelivered)
    const duplicate = await journey.deliver(redeliveredHelp)
    assert.equal(duplicate.duplicate, true)
    assert.equal(
      journey.gateway.replies.filter((reply) => reply.eventId === help.event.eventId).length,
      helpReplyCount,
      "a redelivered command must not send a second reply"
    )

    journey.mockGateway.disconnectSession(SESSION_ID)
    const offline = journey.mockGateway.ingestText({
      platformMessageId: "zhaohu-offline-message",
      principalId: PRINCIPAL_ID,
      conversationKey: CONVERSATION_KEY,
      text: "重连后继续处理",
      occurredAt: new Date(journey.clock.now + 60_000).toISOString()
    })
    assert.equal(offline.status, "waiting_session")
    journey.mockGateway.connectSession({ principalId: PRINCIPAL_ID, sessionId: SESSION_ID })
    const reconnectDeliveries = journey.mockGateway.takeDeliveries(SESSION_ID)
    const reconnectEvent = reconnectDeliveries.find(
      (candidate) => candidate.platformMessageId === "zhaohu-offline-message"
    )
    assert(reconnectEvent)
    const reconnected = await journey.deliver(reconnectEvent)
    await journey.waitForEventState(reconnected.event.eventId, "completed")
    assert(journey.eventReplyText(reconnected.event.eventId).includes("模拟回答：重连后继续处理"))

    assert.equal(journey.queueErrors.length, 0)
    assert.equal(
      journey.events.listOutbox().filter((record) => record.state === "pending").length,
      0
    )
    assert(journey.executedMessages.includes("检查 Feature 当前状态"))
    assert(journey.executedMessages.includes("执行需要审批的命令"))
    assert(journey.executedMessages.includes("询问发布范围"))
  } finally {
    await journey.cleanup()
  }
}

void testSimulatedZhaohuUserJourney()
  .then(() => console.log("IM local simulated Zhaohu journey tests passed"))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
