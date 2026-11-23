import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import type { BotWorkItem } from "../../shared/bots/work"
import {
  setWorkConversationLookup,
  withBotThreadDeletionCheck
} from "../bots/conversation-link-authority"
import type { ThreadSummaryRow } from "../db"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { LocalBotHost } from "../bots/host"
import { BotStore } from "../bots/store"
import { renameBotWorkThread } from "../bots/work-management"
import { registerThreadHandlers } from "./threads"

const fixture = vi.hoisted(() => ({
  root: "",
  row: null as ThreadSummaryRow | null,
  capture: vi.fn(),
  remove: vi.fn(),
  getWorkForDeletion: vi.fn<() => BotWorkItem>(() => {
    throw new Error("missing whole Bot deletion fence")
  }),
  pendingResults: vi.fn<(workId: string) => boolean>(() => false),
  renameWork: vi.fn(),
  updateThread: vi.fn(),
  deleteThread: vi.fn(),
  beginTeardown: vi.fn(),
  bootstrapLegacy: vi.fn(),
  readMessagePage: vi.fn(),
  disableRemoteAccess: vi.fn(async () => {})
}))
vi.mock("../app-data-root", async () => {
  const { mkdtempSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  fixture.root = mkdtempSync(join(tmpdir(), "cmb-thread-deletion-ipc-"))
  return { getCmbCoworkAgentDataRoot: () => fixture.root }
})
vi.mock("electron", () => ({
  app: {
    getPath: () => fixture.root,
    getName: () => "CmbDevClaw",
    on: () => {},
    isPackaged: false
  },
  BrowserWindow: { fromWebContents: () => ({}), getAllWindows: () => [] }
}))
vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  getThreadCore: (id: string) => (fixture.row?.thread_id === id ? fixture.row : null),
  updateThread: fixture.updateThread,
  deleteThread: fixture.deleteThread
}))
vi.mock("../bots/local-service", () => ({
  getLocalBotHost: () => ({
    getWorkForDeletion: fixture.getWorkForDeletion,
    hasPendingWorkDeletionResults: fixture.pendingResults,
    renameWorkFromDesktop: fixture.renameWork
  })
}))
vi.mock("../bots/work-deletion", () => ({
  captureBotWorkDeletionTarget: fixture.capture,
  removeBotWork: fixture.remove
}))
vi.mock("./agent", () => ({
  hasActiveAgentRun: () => false,
  isActiveAgentRunAborting: () => false,
  waitForActiveAgentRunToSettle: async () => "settled",
  cancelAndWaitForAgentThreadRun: async () => "settled",
  disposeAgentThreadState: () => {}
}))
vi.mock("../agent/runtime", () => ({
  clearToolConcurrencyLocksForThread: () => {},
  hasPendingApprovalForRuntimeThread: () => false
}))
vi.mock("../hooks/session-lifecycle", () => ({ fireSessionEnd: async () => {} }))
vi.mock("../services/im/remote-access-service", () => ({
  imRemoteAccessService: { disableThread: fixture.disableRemoteAccess }
}))
vi.mock("../agent/workflow/run-manager", () => ({
  workflowRunManager: {
    isActive: () => false,
    activeWorkspaceForThread: () => undefined,
    cancelAndWait: async () => {},
    listFlushFailedRuns: () => []
  }
}))
vi.mock("../agent/workflow/run-store", () => ({
  isWorkflowThreadMarkedDisposed: () => false,
  markWorkflowThreadDisposed: fixture.beginTeardown,
  rollbackWorkflowThreadDisposal: () => {}
}))
vi.mock("../agent/coordinator-worker-manager", () => ({
  coordinatorWorkerManager: {
    hasRunningWorkersForThread: () => false,
    cancelWorkersForThread: () => [],
    waitForWorkerCleanup: async () => {}
  }
}))
vi.mock("../services/thread-external-run-busy", () => ({
  isExternallyManagedThreadRunBusy: () => false
}))
vi.mock("../legacy-subagent-migration/coordinator", () => ({
  cancelLegacySubagentTranscriptMigration: () => {}
}))
vi.mock("../subagent-transcript-startup/client", () => ({
  cancelSubagentTranscriptStartupRead: () => {}
}))
vi.mock("../checkpointer/runtime-projection-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../checkpointer/runtime-projection-client")>()),
  cancelLegacyCheckpointTranscriptBootstrap: () => {},
  bootstrapLegacyCheckpointTranscriptInWorker: fixture.bootstrapLegacy
}))
vi.mock("../thread-message-hydration/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../thread-message-hydration/client")>()),
  readThreadMessagesPageInWorker: fixture.readMessagePage
}))

function register(executionState: BotWorkItem["executionState"] = null) {
  const threadId = "original-thread"
  const incarnation = { token: "original", legacyCreatedAt: 12 }
  const work = {
    id: "original-work",
    botId: "local-bot",
    threadId,
    version: 2,
    executionState,
    backgroundBusy: false,
    pendingPeers: 0
  } as BotWorkItem
  fixture.row = {
    thread_id: threadId,
    created_at: incarnation.legacyCreatedAt,
    metadata: JSON.stringify({
      workspacePath: "/project",
      cmb_thread_incarnation: incarnation.token
    })
  } as ThreadSummaryRow
  setWorkConversationLookup((id) => (id === threadId ? work : null))
  const frame = {}
  const event = { senderFrame: frame, sender: { mainFrame: frame } } as IpcMainInvokeEvent
  const handles = new Map<string, (...args: unknown[]) => unknown>()
  const raw = registerThreadHandlers({
    handle: (name: string, handler: (...args: unknown[]) => unknown) => {
      handles.set(name, handler)
    }
  } as unknown as IpcMain)
  return { event, threadId, incarnation, work, raw, invoke: handles.get("threads:delete")!,
    bootstrap: handles.get("threads:bootstrap-legacy-checkpoint-transcript")!,
    update: handles.get("threads:update")! }
}

afterEach(() => {
  setWorkConversationLookup(undefined)
  fixture.row = null
  vi.clearAllMocks()
})
afterAll(() => {
  if (fixture.root) rmSync(fixture.root, { recursive: true, force: true })
})

describe("ordinary conversation history over IPC", () => {
  it.each([false, true])(
    "returns a serializable first page when restored history is present: %s", async restored => {
      const { bootstrap, event, threadId } = register()
      setWorkConversationLookup(undefined)
      const messages = restored ? [{ id: "old-message", role: "user", content: "Earlier request" }] : []
      const page = { messages, hasMore: false, hasVisibleMessages: restored }
      const checkpoint = restored ? { checkpoint: { id: "legacy" } } : null
      const migration = { importedMessages: messages.length }
      fixture.bootstrapLegacy.mockResolvedValueOnce({ runtimeTuple: checkpoint, stats: migration })
      fixture.readMessagePage.mockResolvedValueOnce(page)
      expect(structuredClone(await bootstrap(event, threadId))).toEqual({ checkpoint, migration, page })
    }
  )
})

describe("Bot work rename from the workbench", () => {
  const bind = (x: ReturnType<typeof register>) => {
    x.work.audienceKey = "desktop"
    x.work.conversation = { state: "bound", origin: "created",
      ref: { kind: "local_thread", threadId: x.threadId, incarnation: x.incarnation } }
  }

  it("passes the exact Host owner to the work-title service", async () => {
    const x = register()
    bind(x)
    fixture.renameWork.mockImplementationOnce(async () => {
      fixture.row = { ...fixture.row!, title: "新任务名称" }
    })
    const result = await x.update(x.event, { threadId: x.threadId, updates: { title: "新任务名称" } })
    expect(fixture.renameWork).toHaveBeenCalledWith(x.work, "新任务名称", {
      threadId: x.threadId, incarnation: x.incarnation
    })
    expect(fixture.updateThread).not.toHaveBeenCalled()
    expect(result).toMatchObject({ thread_id: x.threadId, title: "新任务名称" })
  })

  it("synchronizes the unexposed native row through the real Host without exposing it", async () => {
    const x = register()
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    const store = new BotStore(db)
    const bot = store.create({ name: "Desk", instructions: "", color: "#abcdef", modelRef: null })
    const host: LocalBotHost = new LocalBotHost(store, {
      renameWork: (work, commit, lease) => renameBotWorkThread(host, work, commit, lease),
      acquire: () => null, onAvailable: () => () => {}
    })
    try {
      const { work } = store.createWork({ botId: bot.id, operationId: "native", title: "原始任务", goal: "核对" })
      store.initializeWorkThread(bot.id, work.id)
      const metadata = { workspacePath: "/project", cmb_thread_incarnation: x.incarnation.token,
        botId: bot.id, botWorkId: work.id, botHostId: "local", botAudienceKey: "desktop", title: work.title }
      fixture.row = { ...fixture.row!, thread_id: work.threadId, title: work.title, metadata: JSON.stringify(metadata) }
      setWorkConversationLookup(id => host.conversationLinks.forThread(id))
      fixture.renameWork.mockImplementationOnce(host.renameWorkFromDesktop.bind(host))
      fixture.updateThread.mockImplementationOnce((threadId, updates) => {
        expect(threadId).toBe(work.threadId)
        return fixture.row = { ...fixture.row!, ...updates }
      })
      const renamed = await x.update(x.event, { threadId: work.threadId, updates: { title: "新的任务名称" } })
      expect(renamed).toMatchObject({ thread_id: work.threadId, title: "新的任务名称",
        metadata: { ...metadata, title: "新的任务名称" } })
      expect(host.getWork(bot.id, work.id)).toMatchObject({ title: "新的任务名称", version: work.version + 1 })
      expect(host.getWork(bot.id, work.id).conversation).toBeUndefined()
      expect(store.recentTasks()).toHaveLength(1)
    } finally {
      await host.stop()
      db.close()
    }
  })

  it("does not let a non-main-frame caller rename the Bot work", async () => {
    const x = register()
    bind(x)
    await expect(x.update({ ...x.event, senderFrame: {} }, {
      threadId: x.threadId, updates: { title: "不能改名" }
    })).rejects.toThrow("本机桌面窗口")
    expect(fixture.renameWork).not.toHaveBeenCalled()
    expect(fixture.updateThread).not.toHaveBeenCalled()
  })

  it.each(["ordinary", "detached", "preparing", "detaching", "external", "mixed"])("keeps a %s update on the original thread path", async (kind) => {
    const x = register()
    if (kind === "ordinary") setWorkConversationLookup(undefined)
    else {
      bind(x)
      if (kind === "detached" || kind === "preparing" || kind === "detaching") x.work.conversation!.state = kind
      if (kind === "external") {
        x.work.conversation = undefined
        x.work.audienceKey = "external-audience"
      }
    }
    const updates = kind === "mixed" ? { title: "会话标题", status: "idle" } : { title: "会话标题" }
    fixture.updateThread.mockReturnValueOnce({ ...fixture.row!, ...updates })
    await expect(x.update(x.event, { threadId: x.threadId, updates })).resolves.toMatchObject(updates)
    expect(fixture.updateThread).toHaveBeenCalledWith(x.threadId, updates)
    expect(fixture.renameWork).not.toHaveBeenCalled()
  })
})

describe("Bot work thread deletion IPC", () => {
  it("keeps ordinary conversation teardown available with a scoped target check and no Bot idle requirement", async () => {
    const x = register()
    setWorkConversationLookup(undefined)
    const check = vi.fn()
    fixture.beginTeardown.mockImplementationOnce(() => { throw new Error("ordinary teardown") })
    await expect(withBotThreadDeletionCheck(check, () => x.raw(x.event, x.threadId)))
      .rejects.toThrow("ordinary teardown")
    expect(check).toHaveBeenCalledWith(x.threadId, fixture.row, expect.objectContaining({ workspacePath: "/project" }))
    expect(fixture.capture).not.toHaveBeenCalled()
    expect(fixture.remove).not.toHaveBeenCalled()
  })
  it("routes a single unexposed work from the desktop handler to the original raw cleanup", async () => {
    const x = register("queued")
    const target = { threadId: x.threadId, incarnation: x.incarnation }
    fixture.capture.mockReturnValueOnce(target)
    fixture.remove.mockImplementationOnce(async (_host, target, deleteThread) => {
      await withBotThreadDeletionCheck(
        () => {},
        () => deleteThread(target.threadId)
      )
    })
    fixture.beginTeardown.mockImplementationOnce(() => {
      throw new Error("entered raw cleanup")
    })
    await expect(x.invoke(x.event, x.threadId)).rejects.toThrow("entered raw cleanup")
    expect(fixture.capture).toHaveBeenCalledWith(
      expect.any(Object),
      x.work.botId,
      x.work.id,
      x.work.version
    )
    expect(fixture.getWorkForDeletion).not.toHaveBeenCalled()
  })

  it.each(["deleted", "cleanup_pending"] as const)("returns the exact work only after %s settles", async (state) => {
    const x = register()
    fixture.capture.mockReturnValueOnce({ threadId: x.threadId, incarnation: x.incarnation })
    fixture.remove.mockResolvedValueOnce({
      state, botId: x.work.botId, workId: x.work.id, deletedThreadId: x.threadId,
      ...(state === "cleanup_pending" ? { error: "pending receipt" } : {})
    })
    const result = await x.invoke(x.event, x.threadId)
    expect(result).toEqual(state === "deleted"
      ? { deletedWork: { botId: x.work.botId, workId: x.work.id } }
      : undefined)
  })

  it("skips a queued unexposed work in bulk before capturing a destructive operation", async () => {
    const x = register("queued")
    await expect(
      x.invoke(x.event, x.threadId, {
        requireIdle: true,
        groupGuard: {
          selector: { type: "workspace", workspacePath: "/project" },
          incarnation: x.incarnation
        }
      })
    ).rejects.toThrow("已跳过该会话")
    expect(fixture.capture).not.toHaveBeenCalled()
    expect(fixture.remove).not.toHaveBeenCalled()
    expect(fixture.beginTeardown).not.toHaveBeenCalled()
  })

  it("skips a taken-over work in bulk while it holds an ordinary follow-up", async () => {
    const x = register()
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    const store = new BotStore(db)
    const host = new LocalBotHost(store, { acquire: () => null, onAvailable: () => () => {} })
    try {
      const bot = store.create({ name: "Desk", instructions: "", color: "#abcdef", modelRef: null })
      const { work, task } = store.createWork({
        botId: bot.id, operationId: "native", title: "报告", goal: "核对"
      })
      store.initializeWorkThread(bot.id, work.id)
      store.transition(task.id, "running")
      store.settle(task.id, "completed", null, "已核对")
      const request = host.send({ botId: bot.id, requestId: "follow-up", message: "继续核对附件" })
      store.transition(request.id, "running")
      store.recordPreparedInput(request.id, request.message)
      const followUp = store.sendWork({ taskId: request.id, callId: "send", key: "send" }, work.id, request.message)
      store.settle(request.id, "completed", null)
      const control = host.changeWorkControl({
        botId: bot.id, workId: work.id, expectedVersion: host.getWork(bot.id, work.id).version,
        operationId: "take", action: "take"
      })
      expect(control).toMatchObject({
        executionState: "completed", userControl: { settling: false, heldInputs: 1 }
      })

      setWorkConversationLookup(id => host.conversationLinks.forThread(id))
      fixture.row = { ...fixture.row!, thread_id: work.threadId, metadata: JSON.stringify({
        workspacePath: "/project", cmb_thread_incarnation: x.incarnation.token,
        botHostId: "local", botId: bot.id, botWorkId: work.id, botAudienceKey: "desktop"
      }) }
      const row = fixture.row
      const options = { requireIdle: true, groupGuard: {
        selector: { type: "workspace", workspacePath: "/project" }, incarnation: x.incarnation
      } }
      await expect(x.invoke(x.event, work.threadId, options)).rejects.toThrow("已跳过该会话")
      expect(fixture.capture).not.toHaveBeenCalled()
      expect(fixture.remove).not.toHaveBeenCalled()
      expect(fixture.beginTeardown).not.toHaveBeenCalled()
      expect(fixture.deleteThread).not.toHaveBeenCalled()
      expect(fixture.row).toBe(row)
      expect(store.getTask(followUp.id).state).toBe("queued")
      expect(host.workDeletionRecord(bot.id, work.id)).toBeUndefined()

      host.cancel(followUp.id)
      expect(host.getWork(bot.id, work.id).userControl?.heldInputs).toBe(0)
      const target = { threadId: work.threadId, incarnation: x.incarnation }
      fixture.capture.mockReturnValueOnce(target)
      fixture.remove.mockResolvedValueOnce({
        state: "deleted", botId: bot.id, workId: work.id, deletedThreadId: work.threadId
      })
      await expect(x.invoke(x.event, work.threadId, options)).resolves.toEqual({
        deletedWork: { botId: bot.id, workId: work.id }
      })
      expect(fixture.remove).toHaveBeenCalledWith(expect.any(Object), target, expect.any(Function))
    } finally {
      await host.stop()
      db.close()
    }
  })

  it("skips an idle-looking work with an in-flight result report before attempting deletion", async () => {
    const x = register()
    fixture.pendingResults.mockReturnValueOnce(true)
    await expect(x.invoke(x.event, x.threadId, { requireIdle: true })).rejects.toThrow(
      "已跳过该会话"
    )
    expect(fixture.pendingResults).toHaveBeenCalledWith(x.work.id)
    expect(fixture.remove).not.toHaveBeenCalled()
  })

  it("skips a work whose review yielded to a newer main conversation request", async () => {
    const x = register()
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    const store = new BotStore(db)
    const host = new LocalBotHost(store, { acquire: () => null, onAvailable: () => () => {} })
    const stopWork = vi.spyOn(host, "stopWork")
    try {
      const bot = store.create({ name: "Desk", instructions: "", color: "#abcdef", modelRef: null })
      const { work, task } = store.createWork({
        botId: bot.id, operationId: "native", title: "报告", goal: "核对"
      })
      store.initializeWorkThread(bot.id, work.id)
      store.transition(task.id, "running")
      store.recordPreparedInput(task.id, task.message)
      expect(store.armWorkResultReview(task.id, x.incarnation.token)).toBe(true)

      const request = host.send({ botId: bot.id, requestId: "newer-request", message: "另外查一下项目进度" })
      store.transition(request.id, "running")
      store.settle(task.id, "completed", null, "已有原任务成果")
      store.flushReplies()
      expect(host.getWork(bot.id, work.id)).toMatchObject({
        executionState: "completed", resultReviewState: "waiting", backgroundBusy: false, pendingPeers: 0
      })
      expect(host.hasPendingWorkDeletionResults(work.id)).toBe(false)

      setWorkConversationLookup(id => host.conversationLinks.forThread(id))
      fixture.pendingResults.mockImplementation(id => host.hasPendingWorkDeletionResults(id))
      fixture.row = { ...fixture.row!, thread_id: work.threadId, metadata: JSON.stringify({
        workspacePath: "/project", cmb_thread_incarnation: x.incarnation.token,
        botHostId: "local", botId: bot.id, botWorkId: work.id, botAudienceKey: "desktop"
      }) }
      const row = fixture.row
      const options = { requireIdle: true, groupGuard: {
        selector: { type: "workspace", workspacePath: "/project" }, incarnation: x.incarnation
      } }
      const target = { threadId: work.threadId, incarnation: x.incarnation }
      fixture.capture.mockReturnValue(target)
      fixture.remove.mockResolvedValue({ state: "deleted", botId: bot.id, workId: work.id, deletedThreadId: work.threadId })

      await expect(x.invoke(x.event, work.threadId, options)).rejects.toThrow("已跳过该会话")
      expect(fixture.capture).not.toHaveBeenCalled()
      expect(fixture.remove).not.toHaveBeenCalled()
      expect(stopWork).not.toHaveBeenCalled()
      expect(fixture.beginTeardown).not.toHaveBeenCalled()
      expect(fixture.deleteThread).not.toHaveBeenCalled()
      expect(fixture.row).toBe(row)
      expect(host.workDeletionRecord(bot.id, work.id)).toBeUndefined()
      expect(host.getWork(bot.id, work.id).dispatchStopped).toBeUndefined()
      expect(store.getTask(request.id).state).toBe("running")

      store.settle(request.id, "completed", null)
      store.flushReplies()
      const review = store.nextQueued([])!
      expect(review.origin).toMatchObject({ kind: "work_result", review: { phase: "review" } })
      store.transition(review.id, "running")
      expect(store.commitWorkResultReview(review.id, { kind: "ready", summary: "核查完成", evidenceIds: [] }).state)
        .toBe("publish")
      store.settle(review.id, "completed", null)
      store.flushReplies()
      const publication = store.nextQueued([])!
      expect(publication.origin).toMatchObject({ kind: "work_result", review: { phase: "publish" } })
      store.transition(publication.id, "running")
      expect(store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
      store.settle(publication.id, "completed", null)
      expect(host.getWork(bot.id, work.id)).toMatchObject({ resultConclusion: { kind: "ready" } })
      expect(host.hasPendingWorkDeletionResults(work.id)).toBe(false)

      await expect(x.invoke(x.event, work.threadId, options)).resolves.toEqual({
        deletedWork: { botId: bot.id, workId: work.id }
      })
      expect(fixture.remove).toHaveBeenCalledExactlyOnceWith(expect.any(Object), target, expect.any(Function))
    } finally {
      fixture.capture.mockReset()
      fixture.remove.mockReset()
      fixture.pendingResults.mockReset()
      stopWork.mockRestore()
      await host.stop()
      db.close()
    }
  })

  it.each(["executing", "checking"] as const)("checks the %s review state before bulk deletion", async phase => {
    const x = register("completed")
    x.work.resultReviewState = phase
    fixture.capture.mockReturnValue({ threadId: x.threadId, incarnation: x.incarnation })
    fixture.remove.mockResolvedValue({
      state: "deleted", botId: x.work.botId, workId: x.work.id, deletedThreadId: x.threadId
    })
    try {
      await expect(x.invoke(x.event, x.threadId, { requireIdle: true })).rejects.toThrow("已跳过该会话")
      expect(fixture.capture).not.toHaveBeenCalled()
      expect(fixture.remove).not.toHaveBeenCalled()
    } finally {
      fixture.capture.mockReset()
      fixture.remove.mockReset()
    }
  })

  it("refuses an unexposed work in raw cleanup without a main-process fence", async () => {
    const x = register()
    await expect(
      x.raw(x.event, x.threadId, { requireIdle: true, scoped: true } as never)
    ).rejects.toThrow("missing whole Bot deletion fence")
    expect(fixture.getWorkForDeletion).toHaveBeenCalledWith(x.work.botId, x.work.id)
    expect(fixture.beginTeardown).not.toHaveBeenCalled()
    expect(fixture.deleteThread).not.toHaveBeenCalled()
  })

  it("calls the scoped check on the actual row and rejects a stale grouped selection before work cleanup", async () => {
    const x = register()
    const check = vi.fn()
    await expect(
      withBotThreadDeletionCheck(check, () =>
        x.raw(x.event, x.threadId, {
          requireIdle: true,
          groupGuard: {
            selector: { type: "workspace", workspacePath: "/project" },
            incarnation: { ...x.incarnation, token: "replacement" }
          }
        })
      )
    ).rejects.toThrow("已移出分组")
    expect(check).toHaveBeenCalledWith(
      x.threadId,
      fixture.row,
      expect.objectContaining({
        cmb_thread_incarnation: "original"
      })
    )
    expect(fixture.getWorkForDeletion).not.toHaveBeenCalled()
    expect(fixture.beginTeardown).not.toHaveBeenCalled()
  })

  it("rejects a changed scoped authorization at the database commit boundary", async () => {
    const x = register()
    fixture.row = {
      ...fixture.row!,
      metadata: JSON.stringify({ cmb_thread_incarnation: x.incarnation.token })
    }
    let sourceActive = true
    fixture.disableRemoteAccess.mockImplementationOnce(async () => {
      sourceActive = false
    })
    const check = vi.fn(() => {
      if (!sourceActive) throw new Error("source cancelled during teardown")
    })
    await expect(
      withBotThreadDeletionCheck(check, () =>
        x.raw(x.event, x.threadId, {
          requireIdle: true
        })
      )
    ).rejects.toThrow("source cancelled during teardown")
    expect(check).toHaveBeenCalledTimes(2)
    expect(fixture.beginTeardown).toHaveBeenCalledTimes(1)
    expect(fixture.deleteThread).not.toHaveBeenCalled()
  })

  it("preserves the whole Bot fence and the ordinary and missing thread paths", async () => {
    const x = register()
    fixture.row = {
      ...fixture.row!,
      metadata: JSON.stringify({
        botId: x.work.botId,
        botHostId: "local",
        botWorkId: x.work.id,
        cmb_thread_incarnation: x.incarnation.token
      })
    }
    fixture.getWorkForDeletion.mockReturnValueOnce(x.work)
    fixture.beginTeardown.mockImplementationOnce(() => {
      throw new Error("entered raw cleanup")
    })
    await expect(x.raw(x.event, x.threadId, { requireIdle: true })).rejects.toThrow(
      "entered raw cleanup"
    )
    expect(fixture.getWorkForDeletion).toHaveBeenCalledWith(x.work.botId, x.work.id)

    setWorkConversationLookup(undefined)
    fixture.row = {
      ...fixture.row,
      metadata: JSON.stringify({ cmb_thread_incarnation: x.incarnation.token })
    }
    fixture.beginTeardown.mockImplementationOnce(() => {
      throw new Error("entered ordinary cleanup")
    })
    await expect(x.invoke(x.event, x.threadId)).rejects.toThrow("entered ordinary cleanup")
    await expect(x.invoke(x.event, "missing")).rejects.toThrow("Thread not found")
    expect(fixture.remove).not.toHaveBeenCalled()
  })
})
