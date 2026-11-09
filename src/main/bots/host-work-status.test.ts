import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost, type BotRunLease, type BotRunPort } from "./host"
import type { BotWorkRuntimeState } from "../../shared/bots/work-status"
import { createBotWorkTools } from "./work-tools"
import { claimLocalThreadRunLease, getLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock("../app-attention-events", () => ({ emitAppAttention: vi.fn() }))
import { requestUserInput, getPendingUserInputForThread, summarizePendingUserInputForRuntimeThread, submitUserInputResponse, cancelUserInputsForThread } from "../services/user-input"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
const quiet: BotWorkRuntimeState = {
  available: true, threadExists: true, runActive: false, userInput: { count: 0, questions: [] },
  approval: false, commands: false, workflow: false, workers: false, pendingResults: false
}
type Result = Awaited<ReturnType<BotRunLease["execute"]>>

async function fixture(history?: BotRunPort["workHistory"]) {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  let clock = 1000
  const store = new BotStore(db, () => ++clock)
  const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const controls = new Map<string, { resolve(result: Result): void; reject(error: Error): void; waiting(value: boolean): void }>()
  const runtimeStatus = vi.fn((work) => ({
    ...quiet, runActive: Boolean(getLocalThreadRunLease(work.threadId)),
    userInput: summarizePendingUserInputForRuntimeThread(work.threadId)
  }))
  const errors = vi.fn()
  const host = new LocalBotHost(store, {
    workHistory: history ?? { query: async w => ({ work: { id: w.id, title: w.title, goal: w.goal }, entries: [], nextCursor: null, scanned: 0, truncated: false, coverage: "exhausted" }), resolve: vi.fn() },
    workRuntimeStatus: runtimeStatus,
    onAvailable: () => () => {},
    acquire: (_bot, task) => {
      if (!claimLocalThreadRunLease({ threadId: task.threadId, owner: "bot", runId: task.id }).acquired) return null
      return {
        execute: (signal, waiting) => new Promise((resolve, reject) => {
          controls.set(task.id, { resolve, reject, waiting })
          signal.addEventListener("abort", () => {
            cancelUserInputsForThread(task.threadId, "stopped")
            resolve({ state: "completed" })
          }, { once: true })
        }),
        release: () => releaseLocalThreadRunLease(task.threadId, "bot", task.id)
      }
    }
  }, 2, errors)
  cleanups.push(async () => { await host.stop(); db.close() })
  const source = host.send({ botId: bot.id, requestId: "ask", message: "检查独立任务的实际进度" })
  await vi.waitFor(() => expect(controls.has(source.id)).toBe(true))
  const created = await host.createWork({ botId: bot.id, operationId: "work", title: "PRD", goal: "生成 PRD" })
  await vi.waitFor(() => expect(controls.has(created.task.id)).toBe(true))
  const read = () => host.workHistory(source.id, { workId: created.work.id })
  return { host, store, source, bot, created, controls, runtimeStatus, errors, read }
}

describe("Bot observes its task through real Host transitions and input registry", () => {
  it("sees request_user_input, resumes after answering, and does not mistake a finished reply for running", async () => {
    const f = await fixture()
    const control = f.controls.get(f.created.task.id)!
    expect((await f.read()).work.execution.phase).toBe("running")
    control.waiting(true)
    const result = requestUserInput({
      threadId: f.created.work.threadId, allowDeferredRenderer: true,
      questions: [{ id: "confirm", header: "PRD", question: "确认初稿内容？", options: [{ label: "确认", description: "继续" }] }]
    })
    const status = (await f.read()).work.execution
    expect(status).toMatchObject({ phase: "waiting_user_input", waitingFor: [{ kind: "user_input", count: 1, questions: ["确认初稿内容？"] }] })
    const context = f.host.workStatusContext(f.source.id)
    expect(context.items[0].execution).toMatchObject({ phase: "waiting_user_input" })
    const request = getPendingUserInputForThread(f.created.work.threadId)!
    expect(submitUserInputResponse({ requestId: request.requestId, answers: { confirm: { type: "option", questionId: "confirm", optionIndex: 0, label: "确认", description: "继续" } } })).toBe(true)
    await result
    control.waiting(false)
    expect((await f.read()).work.execution.phase).toBe("running")
    control.resolve({ state: "completed", result: "下半部分见下一条消息。" })
    await vi.waitFor(() => expect(f.store.getTask(f.created.task.id).state).toBe("completed"))
    expect((await f.read()).work.execution).toMatchObject({ phase: "idle", businessState: "active", runActive: false, waitingFor: [], lastExecution: { state: "completed" } })
    const tool = createBotWorkTools(f.source, () => f.host, new AbortController().signal).find(t => t.name === "bot_work_read")!
    const receipt = await tool.invoke({ type: "tool_call", id: "read", name: tool.name, args: { workId: f.created.work.id } })
    expect(JSON.stringify(receipt)).toContain('\\"phase\\":\\"idle\\"')
    expect(f.errors).not.toHaveBeenCalled()
  })

  it("refreshes after async history hydration, rather than returning its old running snapshot", async () => {
    let unblock!: () => void
    const barrier = new Promise<void>(resolve => { unblock = resolve })
    const query = vi.fn(async w => {
      await barrier
      return { work: { id: w.id, title: w.title, goal: w.goal }, entries: [], nextCursor: null, scanned: 0, truncated: false, coverage: "exhausted" as const }
    })
    const f = await fixture({ query, resolve: vi.fn() })
    const pending = f.read()
    expect(query).toHaveBeenCalledTimes(1)
    f.controls.get(f.created.task.id)!.resolve({ state: "failed", error: "模型连接断开" })
    await vi.waitFor(() => expect(f.store.getTask(f.created.task.id).state).toBe("failed"))
    unblock()
    expect((await pending).work.execution).toMatchObject({ phase: "failed", runActive: false, lastExecution: { error: "模型连接断开" } })
    await vi.waitFor(() => expect(f.store.recentTasks().some(t => t.origin.kind === "work_result" && t.origin.executionState === "failed")).toBe(true))
  })

  it("tracks and clears browser handoffs; an obsolete return cannot clear a newer request", async () => {
    const f = await fixture()
    f.controls.get(f.created.task.id)!.waiting(true)
    f.host.browserHelpNotice(f.created.task.id, { generation: 1, instruction: "登录文档" }, true)
    expect((await f.read()).work.execution.phase).toBe("waiting_browser")
    f.host.browserHelpNotice(f.created.task.id, { generation: 2, instruction: "手机确认" }, true)
    f.host.browserHelpNotice(f.created.task.id, { generation: 1, instruction: "登录文档" }, false)
    expect((await f.read()).work.execution.waitingFor).toEqual([{ kind: "browser", instruction: "手机确认" }])
    f.host.browserHelpNotice(f.created.task.id, { generation: 2, instruction: "手机确认" }, false)
    f.controls.get(f.created.task.id)!.waiting(false)
    expect((await f.read()).work.execution.phase).toBe("running")
    f.host.cancel(f.created.task.id)
    await vi.waitFor(() => expect(f.store.getTask(f.created.task.id).state).toBe("cancelled"))
    expect((await f.read()).work.execution).toMatchObject({ phase: "cancelled", waitingFor: [] })
  })

  it("keeps snapshots bounded and probes duplicate list/priority entries only once", async () => {
    const f = await fixture()
    for (let i = 0; i < 12; i++) f.store.createWork({ botId: f.bot.id, operationId: `extra-${i}`, title: `More ${i}`, goal: "Later" })
    f.runtimeStatus.mockClear()
    expect(f.host.workStatusContext(f.source.id)).toMatchObject({ hasMore: true })
    expect(f.runtimeStatus).toHaveBeenCalledTimes(8)
    f.runtimeStatus.mockClear()
    const page = f.host.workTargets(f.source.id)
    const ids = new Set([...page.items, ...page.priority].map(w => w.id))
    expect(f.runtimeStatus).toHaveBeenCalledTimes(ids.size)
    expect(page.items.every(w => w.execution.observedAt > 0)).toBe(true)
  })
})
