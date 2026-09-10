import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import initSqlJs from "sql.js"
import type { ThreadRow } from "../src/main/db"
import type { UserInputRequest, UserInputResponse } from "../src/main/types"
import { ImCommandRouter, parseImCommand } from "../src/main/services/im/command-router"
import { ImConversationStateStore } from "../src/main/services/im/conversation-state"
import { ImEventStore } from "../src/main/services/im/event-store"
import type { ImPersistenceDependencies } from "../src/main/services/im/persistence"
import { ImRemoteGrantStore } from "../src/main/services/im/remote-grant-store"
import { ImRemoteUserInputService } from "../src/main/services/im/remote-user-input-service"
import { ensureImServiceSchema } from "../src/main/services/im/schema"

const ROUTE = {
  principalId: "principal-1",
  conversationKey: "conversation-1"
}

function userInputRequest(input: {
  requestId: string
  questions?: UserInputRequest["questions"]
}): UserInputRequest {
  return {
    requestId: input.requestId,
    threadId: "thread-1",
    createdAt: "2026-08-03T08:00:00.000Z",
    questions: input.questions ?? [
      {
        header: "格式",
        id: "export_format",
        question: "导出格式用哪种？",
        options: [
          { label: "CSV (Recommended)", description: "兼容性最好。" },
          { label: "Excel", description: "保留表格格式。" },
          { label: "JSON", description: "便于程序读取。" }
        ]
      }
    ]
  }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function createContext(options: { enabled?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "cmb-im-user-input-"))
  const SQL = await initSqlJs()
  const database = new SQL.Database()
  ensureImServiceSchema(database)
  const clock = { now: Date.parse("2026-08-03T08:00:00.000Z") }
  const persistence: ImPersistenceDependencies = {
    getDatabase: () => database,
    markDirty: () => undefined,
    flushStrict: async () => undefined,
    now: () => clock.now
  }
  const conversations = new ImConversationStateStore(persistence)
  const grants = new ImRemoteGrantStore(persistence, () => "grant-thread-1")
  const events = new ImEventStore(persistence)
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
  let pending: UserInputRequest | null = null
  let pendingListener: ((request: Readonly<UserInputRequest>) => void) | null = null
  let removedListener: ((requestId: string, threadId: string) => void) | null = null
  const responses: UserInputResponse[] = []
  const responseOptions: unknown[] = []
  const answerNotices: unknown[] = []
  const warnings: unknown[] = []
  let sendPendingCount = 0
  const generatedCodes = ["A1B2C3", "D4E5F6", "012ABC", "789DEF"]

  const service = new ImRemoteUserInputService({
    conversations,
    access: { getThreadGrant: (threadId) => grants.getThreadGrant(threadId) },
    grants,
    events,
    getThread: (threadId) => (threadId === thread.thread_id ? thread : null),
    getSettings: () => ({
      enabled: options.enabled !== false,
      gatewayUrl: null,
      remoteAccess: "inbox-only",
      remoteApprovalEnabled: false,
      waitingDesktopTtlMinutes: 10
    }),
    getPendingForThread: (threadId) => (pending?.threadId === threadId ? pending : null),
    submitResponse: (response, submitOptions) => {
      if (!pending || pending.requestId !== response.requestId) return false
      responses.push(response)
      responseOptions.push(submitOptions)
      const removed = pending
      pending = null
      removedListener?.(removed.requestId, removed.threadId)
      return true
    },
    subscribePending: (listener) => {
      pendingListener = listener
      return () => {
        pendingListener = null
      }
    },
    subscribeRemoved: (listener) => {
      removedListener = listener
      return () => {
        removedListener = null
      }
    },
    now: () => clock.now,
    createCode: () => generatedCodes.shift() ?? "ABC123",
    warn: (_message, error) => warnings.push(error)
  })
  service.registerReplyDrainer({
    sendPending: async () => {
      sendPendingCount += 1
      return { sent: 0, failed: 0, unknown: 0, deferred: 0 }
    }
  })
  service.subscribeAnswer((notice) => answerNotices.push(notice))

  function deliveryText(requestId: string): string {
    return events
      .listOutbox()
      .filter((record) => record.deliveryId === `user-input-request:${requestId}:0`)
      .map((record) => record.content)
      .join("\n")
  }

  function emit(request: UserInputRequest): void {
    pending = request
    pendingListener?.(request)
  }

  async function publish(request: UserInputRequest): Promise<void> {
    emit(request)
    await waitFor(() => deliveryText(request.requestId).length > 0, "user-input prompt")
  }

  return {
    root,
    database,
    clock,
    events,
    service,
    responses,
    responseOptions,
    answerNotices,
    warnings,
    deliveryText,
    emit,
    publish,
    sendPendingCount: () => sendPendingCount,
    removePending: () => {
      if (!pending) return
      const removed = pending
      pending = null
      removedListener?.(removed.requestId, removed.threadId)
    }
  }
}

async function testPromptAndSingleUseOptionAnswer(): Promise<void> {
  const context = await createContext()
  try {
    const request = userInputRequest({ requestId: "request-option" })
    await context.publish(request)
    const text = context.deliveryText(request.requestId)
    assert(text.includes("【会话：桌面会话】需要你确认"))
    assert(text.includes("导出格式用哪种？"))
    assert(text.includes("1. CSV (Recommended) — 兼容性最好。"))
    assert(text.includes("/回答 A1B2C3 <编号>"))
    assert.equal(context.sendPendingCount(), 1)

    assert.equal(
      await context.service.resolveAnswer({
        argument: "A1B2C3 1",
        principalId: "principal-other",
        conversationKey: ROUTE.conversationKey
      }),
      "该输入短码不属于当前招乎会话。"
    )
    assert.equal(context.responses.length, 0)
    assert.equal(
      await context.service.resolveAnswer({ argument: "A1B2C3 9", ...ROUTE }),
      "选项编号无效，请输入 1-3。"
    )

    assert.equal(
      await context.service.resolveAnswer({ argument: "A1B2C3 1", ...ROUTE }),
      "已从招乎提交回答，任务将继续执行。"
    )
    assert.deepEqual(context.responses, [
      {
        requestId: request.requestId,
        answers: {
          export_format: {
            type: "option",
            questionId: "export_format",
            optionIndex: 0,
            label: "CSV (Recommended)",
            description: "兼容性最好。"
          }
        },
        submittedAt: "2026-08-03T08:00:00.000Z"
      }
    ])
    assert.deepEqual(context.responseOptions, [
      { notifyRenderer: true, reason: "已从招乎完成补充输入。" }
    ])
    assert.deepEqual(context.answerNotices, [
      {
        requestId: request.requestId,
        threadId: request.threadId,
        message: "已从招乎回答 Agent 的补充问题。"
      }
    ])
    assert.equal(
      await context.service.resolveAnswer({ argument: "A1B2C3 1", ...ROUTE }),
      "输入短码不存在、已过期或已使用。"
    )
  } finally {
    context.service.dispose()
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

async function testMultipleQuestionsRotateCodeAndAcceptCustomText(): Promise<void> {
  const context = await createContext()
  try {
    const request = userInputRequest({
      requestId: "request-multiple",
      questions: [
        ...userInputRequest({ requestId: "template" }).questions,
        {
          header: "范围",
          id: "export_scope",
          question: "需要导出哪些数据？",
          options: [
            { label: "全部 (Recommended)", description: "导出全部可见数据。" },
            { label: "本月", description: "只导出本月数据。" }
          ]
        }
      ]
    })
    await context.publish(request)
    const next = await context.service.resolveAnswer({ argument: "A1B2C3 2", ...ROUTE })
    assert(next.includes("已记录第 1 题"))
    assert(next.includes("需要导出哪些数据？"))
    assert(next.includes("/回答 D4E5F6 <编号>"))
    assert.equal(
      await context.service.resolveAnswer({ argument: "A1B2C3 1", ...ROUTE }),
      "输入短码不存在、已过期或已使用。"
    )
    assert.equal(
      await context.service.resolveAnswer({
        argument: "D4E5F6 其他 仅导出已审核记录",
        ...ROUTE
      }),
      "已从招乎提交回答，任务将继续执行。"
    )
    assert.equal(context.responses.length, 1)
    assert.deepEqual(context.responses[0].answers.export_scope, {
      type: "other",
      questionId: "export_scope",
      text: "仅导出已审核记录"
    })
    assert.equal(context.responses[0].answers.export_format.type, "option")
  } finally {
    context.service.dispose()
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

async function testExpiryDesktopRaceAndExplicitCommand(): Promise<void> {
  const context = await createContext()
  try {
    const expired = userInputRequest({ requestId: "request-expired" })
    await context.publish(expired)
    context.clock.now += 10 * 60_000 + 1
    assert.equal(
      await context.service.resolveAnswer({ argument: "A1B2C3 1", ...ROUTE }),
      "输入短码不存在、已过期或已使用。"
    )
    assert.equal(context.responses.length, 0)

    context.removePending()
    const desktopRace = userInputRequest({ requestId: "request-desktop-race" })
    await context.publish(desktopRace)
    context.removePending()
    assert.equal(
      await context.service.resolveAnswer({ argument: "D4E5F6 1", ...ROUTE }),
      "输入短码不存在、已过期或已使用。"
    )

    assert.equal(parseImCommand("回答 012ABC 1"), null)
    assert.deepEqual(parseImCommand("/回答 012ABC 1"), {
      name: "answer",
      argument: "012ABC 1"
    })
    const routed: unknown[] = []
    const router = new ImCommandRouter({
      userInputs: {
        resolveAnswer: async (input) => {
          routed.push(input)
          return "resolved"
        }
      }
    })
    assert.equal(
      await router.handle({ command: parseImCommand("/回答 012ABC 1")!, ...ROUTE }),
      "resolved"
    )
    assert.deepEqual(routed, [{ argument: "012ABC 1", ...ROUTE }])
  } finally {
    context.service.dispose()
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

async function testDisabledRobotDoesNotPublish(): Promise<void> {
  const context = await createContext({ enabled: false })
  try {
    const request = userInputRequest({ requestId: "request-disabled" })
    context.emit(request)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(context.events.listOutbox().length, 0)
    assert.equal(
      await context.service.resolveAnswer({ argument: "A1B2C3 1", ...ROUTE }),
      "本设备的内置机器人已断开。"
    )
  } finally {
    context.service.dispose()
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  await testPromptAndSingleUseOptionAnswer()
  await testMultipleQuestionsRotateCodeAndAcceptCustomText()
  await testExpiryDesktopRaceAndExplicitCommand()
  await testDisabledRobotDoesNotPublish()
  console.log("IM remote user-input tests passed")
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
