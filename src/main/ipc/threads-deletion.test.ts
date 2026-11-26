import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BotWorkItem } from "../../shared/bots/work"
import { CoordinatorWorkerManager, coordinatorWorkerManager } from "../agent/coordinator-worker-manager"
import { pendingNotificationScheduler } from "../agent/pending-notification-scheduler"
import {
  setWorkConversationLookup,
  withBotThreadDeletionCheck
} from "../bots/conversation-link-authority"
import type { ThreadSummaryRow } from "../db"
import * as db from "../db"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { LocalBotHost } from "../bots/host"
import { BotStore } from "../bots/store"
import { renameBotWorkThread } from "../bots/work-management"
import { getDbPath, getThreadCheckpointPath } from "../storage"
import { readThreadHydrationProjection } from "../thread-metadata-hydration/reader"
import { canRunSideThread, getSideThreadTeardown, getSideThreadTeardownAttempt, hasRegisteredSideThread, sideThreadIds } from "./btw-chat"
import { forkThread, registerThreadHandlers, resolveForkCheckpointForMessage } from "./threads"

const fixture = vi.hoisted(() => ({
  root: "",
  row: null as ThreadSummaryRow | null,
  useRealDb: false,
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
  closeCheckpointer: vi.fn(async () => {}),
  fireSessionEnd: vi.fn(async () => {}),
  getActiveAgentRunSettlement: vi.fn<(threadId: string) => Promise<void> | undefined>(),
  cancelAndWaitForAgentThreadRun: vi.fn<(threadId: string) => Promise<"settled" | "timed_out" | "shell_timed_out">>(
    async () => "settled"
  ),
  activeWorkflowRunId: vi.fn<() => string | undefined>(),
  waitForWorkflowRunLifecycle: vi.fn<() => Promise<void>>(async () => {}),
  waitForWorkerCleanup: vi.fn<(threadId: string) => Promise<void>>(async () => {}),
  waitForWorkerSettlement: vi.fn<() => Promise<void>>(async () => {}),
  countUnresolvedWorktrees: vi.fn<(workspace: string, threadId: string) => Promise<number>>(async () => 0),
  stopWatching: vi.fn(),
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
vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>()
  return {
    ...actual,
    getThreadCore: (id: string) => fixture.useRealDb ? actual.getThreadCore(id)
      : fixture.row?.thread_id === id ? fixture.row : null,
    getThreadRowLifetime: (id: string) => fixture.useRealDb ? actual.getThreadRowLifetime(id)
      : fixture.row?.thread_id === id ? String(fixture.row.created_at) : null,
    updateThread: fixture.updateThread,
    deleteThread: (id: string) => {
      fixture.deleteThread(id)
      if (fixture.useRealDb) actual.deleteThread(id)
    }
  }
})
vi.mock("../bots/local-service", () => ({
  removeLocalBotMessageReactionsForThreads: () => {},
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
  getActiveAgentRunSettlement: fixture.getActiveAgentRunSettlement,
  getActiveAgentUserMessageId: () => undefined,
  isActiveAgentRunAborting: () => false,
  waitForActiveAgentRunToSettle: async () => "settled",
  cancelAndWaitForAgentThreadRun: fixture.cancelAndWaitForAgentThreadRun,
  disposeAgentThreadState: () => {},
  disposeDeletedAgentThreadRuntime: () => {},
  forgetCoordinatorThreadState: () => {}
}))
vi.mock("../agent/runtime", () => ({
  closeCheckpointer: fixture.closeCheckpointer,
  retireThreadCheckpointers: async () => {},
  pendingApprovals: new Map(),
  clearToolConcurrencyLocksForThread: () => {},
  hasPendingApprovalForRuntimeThread: () => false
}))
vi.mock("../hooks/session-lifecycle", () => ({ fireSessionEnd: fixture.fireSessionEnd }))
vi.mock("../services/im/remote-access-service", () => ({
  imRemoteAccessService: { disableThread: fixture.disableRemoteAccess }
}))
vi.mock("../agent/workflow/run-manager", () => ({
  workflowRunManager: {
    isActive: () => false,
    activeRunId: fixture.activeWorkflowRunId,
    waitForRunLifecycle: fixture.waitForWorkflowRunLifecycle,
    activeWorkspaceForThread: () => undefined,
    cancelAndWait: async () => {},
    listFlushFailedRuns: () => [],
    forgetThread: () => {}
  }
}))
vi.mock("../agent/workflow/run-store", () => ({
  isWorkflowThreadMarkedDisposed: () => false,
  markWorkflowThreadDisposed: fixture.beginTeardown,
  rollbackWorkflowThreadDisposal: () => {},
  commitWorkflowThreadDisposal: () => {},
  countUnresolvedWorkflowWorktreesAsync: fixture.countUnresolvedWorktrees,
  deleteWorkflowRunsForThread: async () => {}
}))
vi.mock("../agent/coordinator-worker-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/coordinator-worker-manager")>()
  vi.spyOn(actual.coordinatorWorkerManager, "waitForWorkerCleanup").mockImplementation(fixture.waitForWorkerCleanup)
  vi.spyOn(actual.coordinatorWorkerManager, "waitForWorkerSettlement").mockImplementation(fixture.waitForWorkerSettlement)
  return { ...actual, deleteCoordinatorWorkerArtifacts: async () => {} }
})
vi.mock("../services/thread-external-run-busy", () => ({
  hasExternalThreadRunOwner: () => false,
  isExternallyManagedThreadRunBusy: () => false
}))
vi.mock("../legacy-subagent-migration/coordinator", () => ({
  cancelLegacySubagentTranscriptMigration: () => {},
  forgetLegacySubagentTranscriptMigration: () => {}
}))
vi.mock("../subagent-transcript-startup/client", () => ({
  cancelSubagentTranscriptStartupRead: () => {}
}))
vi.mock("../thread-metadata-hydration/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../thread-metadata-hydration/client")>()),
  readSideParentInWorker: async (threadId: string) => {
    const database = new DatabaseSync(getDbPath(), { readOnly: true })
    try {
      return readThreadHydrationProjection(database, {
        type: "read-thread", threadId, sideParent: true, requestId: 1,
        databasePath: getDbPath(), cancellationBuffer: new SharedArrayBuffer(4)
      }).thread
    } finally {
      database.close()
    }
  }
}))
vi.mock("../services/workspace-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/workspace-watcher")>()),
  stopWatching: fixture.stopWatching
}))
vi.mock("./thread-transcript-gc-scan", () => ({
  collectReferencedTranscriptHashesFromPages: async () => new Set<string>()
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

function registerHandlers() {
  const frame = {}
  const sender = Object.assign(new EventEmitter(), {
    id: 1, mainFrame: frame, isDestroyed: () => false
  })
  const event = { senderFrame: frame, sender } as unknown as IpcMainInvokeEvent
  const handles = new Map<string, (...args: unknown[]) => unknown>()
  const raw = registerThreadHandlers({
    handle: (name: string, handler: (...args: unknown[]) => unknown) => {
      handles.set(name, handler)
    }
  } as unknown as IpcMain)
  return {
    event, raw, invoke: handles.get("threads:delete")!,
    createBtw: handles.get("btw:create")!, closeBtw: handles.get("btw:close")!,
    bootstrap: handles.get("threads:bootstrap-legacy-checkpoint-transcript")!,
    update: handles.get("threads:update")!
  }
}

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
  return { threadId, incarnation, work, ...registerHandlers() }
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

  it("rejects side conversation forks before loading any checkpoint", async () => {
    const threadId = `btw-${randomUUID()}-${randomUUID()}`
    await expect(forkThread({ sourceThreadId: threadId })).rejects.toThrow("辅助对话暂不支持 fork。")
    await expect(resolveForkCheckpointForMessage({ threadId, messageId: "message" })).resolves.toBeNull()
  })
})

describe("closing auxiliary conversations", () => {
  beforeEach(async () => {
    await db.initializeDatabase()
    fixture.useRealDb = true
  })

  afterEach(async () => {
    fixture.useRealDb = false
    await db.closeDatabase()
  })

  async function openEmptySide() {
    const parentId = randomUUID()
    db.createThread(parentId, { workspacePath: fixture.root }, { newDurableTranscript: true })
    const handlers = registerHandlers()
    const { id } = await handlers.createBtw(handlers.event, { parentId, modelId: "" }) as { id: string }
    return { ...handlers, id, parentId }
  }

  it("reclaims an unused tab's thread and transcript marker", async () => {
    const { id, parentId, event, closeBtw } = await openEmptySide()
    expect(db.getLegacyCheckpointMigrationStatus(id)).toBe("complete")
    await closeBtw(event, id)
    expect(db.threadExists(id)).toBe(false)
    expect(db.getLegacyCheckpointMigrationStatus(id)).toBeNull()
    expect(coordinatorWorkerManager["restoreGenerationByParent"].has(id)).toBe(false)
    expect(db.threadExists(parentId)).toBe(true)
  })

  it.each(["tab", "parent"])("clears a stopped side tab's notification hold when closing through the %s", async route => {
    const { id, parentId, event, closeBtw, invoke } = await openEmptySide()
    const heldThreads = pendingNotificationScheduler["suppressedThreads"]
    pendingNotificationScheduler.suppressAfterStop(id)
    expect(heldThreads.has(id)).toBe(true)

    if (route === "tab") await closeBtw(event, id)
    else await invoke(event, parentId)

    expect(heldThreads.has(id)).toBe(false)
  })

  it("reclaims a completed side worker's queued notification while preserving its result and the parent worker", async () => {
    const { id, parentId, event, closeBtw } = await openEmptySide()
    db.upsertThreadMessages(id, [{ id: "question", role: "user", content: "Check result", created_at: new Date() }])
    pendingNotificationScheduler.suppressAfterStop(id)
    try {
      const [sideWorker, parentWorker] = [id, parentId].map(threadId => coordinatorWorkerManager.startWorker({
        parentThreadId: threadId,
        workspacePath: fixture.root,
        role: "verifier",
        description: "Check result",
        prompt: "Check result",
        runner: async () => ({ summary: `Completed ${threadId}` })
      }))
      await Promise.all([id, parentId].map(threadId =>
        CoordinatorWorkerManager.prototype.waitForWorkerCleanup.call(coordinatorWorkerManager, threadId)))
      expect(coordinatorWorkerManager.peekNotifications(id)).toHaveLength(1)
      expect(coordinatorWorkerManager.peekNotifications(parentId)).toHaveLength(1)

      await closeBtw(event, id)

      expect(coordinatorWorkerManager.peekNotifications(id)).toEqual([])
      expect(coordinatorWorkerManager.readWorkers(id)).toEqual([])
      expect(coordinatorWorkerManager.peekNotifications(parentId)).toHaveLength(1)
      expect(coordinatorWorkerManager.readWorkers(parentId)).toEqual([
        expect.objectContaining({ worker_id: parentWorker.worker_id, status: "completed" })
      ])
      const savedWorker = join(fixture.root, ".cmbdevclaw", "coordinator", id, "workers", `${sideWorker.worker_id}.json`)
      expect(JSON.parse(readFileSync(savedWorker, "utf8"))).toMatchObject({
        status: "completed", summary: `Completed ${id}`, notification_acknowledged: false
      })
    } finally {
      coordinatorWorkerManager.forgetThread(id)
      coordinatorWorkerManager.forgetThread(parentId)
    }
  })

  it("keeps a user request when stopped before the first model reply", async () => {
    const { id, event, closeBtw } = await openEmptySide()
    db.upsertThreadMessages(id, [
      { id: "question", role: "user", content: "Already submitted", created_at: new Date() }
    ])
    await closeBtw(event, id)
    expect(db.threadExists(id)).toBe(true)
    expect(db.getThreadMessages(id)).toEqual([
      expect.objectContaining({ id: "question", content: "Already submitted" })
    ])
  })

  it("keeps an empty transcript with a checkpoint recovery sidecar", async () => {
    const { id, event, closeBtw } = await openEmptySide()
    const recoveryFile = getThreadCheckpointPath(id) + ".bak"
    writeFileSync(recoveryFile, "checkpoint to recover")
    await closeBtw(event, id)
    expect(db.threadExists(id)).toBe(true)
  })

  it("tracks window teardown through the SessionEnd hooks after releasing the side tab", async () => {
    const { id, event } = await openEmptySide()
    const hookStarted = Promise.withResolvers<void>()
    const hookFinished = Promise.withResolvers<void>()
    fixture.fireSessionEnd.mockImplementationOnce(() => {
      hookStarted.resolve()
      return hookFinished.promise
    })

    event.sender.emit("destroyed")
    await hookStarted.promise
    const teardown = getSideThreadTeardown(id)
    try {
      expect(hasRegisteredSideThread(id)).toBe(false)
      expect(teardown).toBeDefined()
    } finally {
      hookFinished.resolve()
      await teardown
    }
    expect(getSideThreadTeardown(id)).toBeUndefined()
  })

  it("detaches a destroyed window's watcher immediately and finishes after late run settlement", async () => {
    const { id, event } = await openEmptySide()
    let settleRun!: () => void
    let reportTimeout!: (status: "timed_out") => void
    fixture.getActiveAgentRunSettlement.mockReturnValueOnce(new Promise<void>(resolve => {
      settleRun = resolve
    }))
    fixture.cancelAndWaitForAgentThreadRun.mockImplementationOnce(() => new Promise(resolve => {
      reportTimeout = resolve
    }))
    event.sender.emit("destroyed")
    await vi.waitFor(() => {
      expect(fixture.stopWatching).toHaveBeenCalledWith(id)
      expect(fixture.cancelAndWaitForAgentThreadRun).toHaveBeenCalledOnce()
    })
    expect(fixture.closeCheckpointer).not.toHaveBeenCalled()
    const teardown = getSideThreadTeardown(id)
    const attempt = getSideThreadTeardownAttempt(id)
    reportTimeout("timed_out")
    await expect(attempt).rejects.toThrow("辅助对话正在退出")
    expect(teardown).toBeDefined()
    expect(getSideThreadTeardown(id)).toBe(teardown)
    settleRun()
    await teardown
    expect(db.threadExists(id)).toBe(false)
    expect(getSideThreadTeardown(id)).toBeUndefined()
    expect(fixture.cancelAndWaitForAgentThreadRun).toHaveBeenCalledTimes(2)
    expect(fixture.closeCheckpointer).toHaveBeenCalledExactlyOnceWith(id)
  })

  it.each(["workflow", "worker"])("finishes window teardown after late %s settlement", async runtime => {
    const { id, event } = await openEmptySide()
    db.upsertThreadMessages(id, [{ id: "question", role: "user", content: "Saved", created_at: new Date() }])
    const settlement = Promise.withResolvers<void>()
    const waitForSettlement = runtime === "workflow" ? fixture.waitForWorkflowRunLifecycle : fixture.waitForWorkerSettlement
    waitForSettlement.mockReturnValueOnce(settlement.promise)
    if (runtime === "workflow") fixture.activeWorkflowRunId.mockReturnValueOnce("slow-workflow")
    else fixture.waitForWorkerCleanup.mockRejectedValueOnce(new Error("Slow worker cleanup"))

    event.sender.emit("destroyed")
    await vi.waitFor(() => expect(waitForSettlement).toHaveBeenCalledOnce())
    expect(fixture.closeCheckpointer).not.toHaveBeenCalled()
    expect(fixture.cancelAndWaitForAgentThreadRun).toHaveBeenCalledOnce()

    settlement.resolve()
    await vi.waitFor(() => expect(fixture.closeCheckpointer).toHaveBeenCalledExactlyOnceWith(id))
    expect(fixture.cancelAndWaitForAgentThreadRun).toHaveBeenCalledTimes(2)
    expect(db.getThreadMessages(id).map(message => message.content)).toEqual(["Saved"])
  })

  it("leaves a timed-out explicit close retryable in its window", async () => {
    const { id, event, closeBtw } = await openEmptySide()
    fixture.waitForWorkerCleanup.mockRejectedValueOnce(new Error("Slow worker cleanup"))

    await expect(closeBtw(event, id)).rejects.toThrow("Slow worker cleanup")
    expect(fixture.waitForWorkerSettlement).not.toHaveBeenCalled()
    expect(db.threadExists(id)).toBe(true)
    expect(canRunSideThread(id)).toBe(false)

    await closeBtw(event, id)
    expect(db.threadExists(id)).toBe(false)
    expect(fixture.closeCheckpointer).toHaveBeenCalledExactlyOnceWith(id)
  })

  it("keeps the parent and child available when its child's shell cannot stop", async () => {
    const { id, parentId, event, invoke } = await openEmptySide()
    fixture.cancelAndWaitForAgentThreadRun.mockImplementation(async threadId =>
      threadId === id ? "shell_timed_out" : "settled")

    await expect(invoke(event, parentId)).rejects.toThrow("Shell 任务仍在退出")
    expect(db.threadExists(parentId)).toBe(true)
    expect(db.threadExists(id)).toBe(true)
    expect(canRunSideThread(id)).toBe(true)

    fixture.cancelAndWaitForAgentThreadRun.mockImplementation(async () => "settled")
    await expect(invoke(event, parentId)).resolves.toEqual({ deletedSideThreadIds: [id] })
    expect(db.threadExists(parentId)).toBe(false)
    expect(db.threadExists(id)).toBe(false)
  })

  it.each(["foreground", "worker"])("keeps both workspace bindings when a side %s run is still settling", async runtime => {
    const { id, parentId, event, invoke } = await openEmptySide()
    const settlement = Promise.withResolvers<void>()
    if (runtime === "foreground") {
      fixture.getActiveAgentRunSettlement.mockImplementationOnce(() => settlement.promise)
      fixture.cancelAndWaitForAgentThreadRun.mockImplementation(async threadId =>
        threadId === id ? "timed_out" : "settled")
    } else {
      fixture.waitForWorkerCleanup.mockImplementation(async threadId => {
        if (threadId === id) throw new Error("Slow worker cleanup")
      })
    }

    try {
      await expect(invoke(event, parentId)).rejects.toThrow("辅助对话仍在退出")
      expect(fixture.deleteThread).not.toHaveBeenCalled()
      expect(db.threadExists(parentId)).toBe(true)
      expect(db.threadExists(id)).toBe(true)
      expect(canRunSideThread(id)).toBe(true)
      if (runtime === "foreground") {
        expect(fixture.cancelAndWaitForAgentThreadRun).toHaveBeenCalledWith(id, {}, settlement.promise)
      }
    } finally {
      settlement.resolve()
      fixture.cancelAndWaitForAgentThreadRun.mockImplementation(async () => "settled")
      fixture.waitForWorkerCleanup.mockImplementation(async () => {})
    }

    await expect(invoke(event, parentId)).resolves.toEqual({ deletedSideThreadIds: [id] })
    expect(db.threadExists(parentId)).toBe(false)
    expect(db.threadExists(id)).toBe(false)
  })

  it("reports which side tabs were deleted before finding a protected child worktree", async () => {
    const { parentId, event, createBtw, invoke } = await openEmptySide()
    await createBtw(event, { parentId, modelId: "" })
    const [deletable, protectedChild] = sideThreadIds(parentId)
    fixture.countUnresolvedWorktrees.mockImplementation(async (_workspace, threadId) =>
      threadId === protectedChild ? 1 : 0)

    await expect(invoke(event, parentId)).resolves.toEqual({
      deletedSideThreadIds: [deletable],
      deletionError: expect.stringContaining("待清理的 workflow worktree")
    })
    expect(db.threadExists(parentId)).toBe(true)
    expect(db.threadExists(deletable)).toBe(false)
    expect(db.threadExists(protectedChild)).toBe(true)
    expect(canRunSideThread(deletable)).toBe(false)
    expect(canRunSideThread(protectedChild)).toBe(true)

    fixture.countUnresolvedWorktrees.mockImplementation(async () => 0)
    await expect(invoke(event, parentId)).resolves.toEqual({ deletedSideThreadIds: [protectedChild] })
    expect(db.threadExists(parentId)).toBe(false)
    expect(db.threadExists(protectedChild)).toBe(false)
  })

  it("allows parent deletion to settle while the empty tab is closing", async () => {
    const { id, parentId, event, closeBtw, invoke } = await openEmptySide()
    let finishClose!: () => void
    let announceClose!: () => void
    const closingCheckpoint = new Promise<void>(resolve => { announceClose = resolve })
    fixture.closeCheckpointer.mockImplementationOnce(() => {
      announceClose()
      return new Promise<void>(resolve => { finishClose = resolve })
    })
    const close = closeBtw(event, id)
    await Promise.race([closingCheckpoint, close])

    const deletion = invoke(event, parentId)
    await vi.waitFor(() => expect(fixture.cancelAndWaitForAgentThreadRun).toHaveBeenCalledWith(parentId, {}))
    expect(fixture.deleteThread).not.toHaveBeenCalled()
    finishClose()
    await expect(close).resolves.toBeUndefined()
    // The close can remove the empty row before the parent enumerates its children.
    expect([undefined, { deletedSideThreadIds: [id] }]).toContainEqual(await deletion)
    expect(db.threadExists(parentId)).toBe(false)
    expect(db.threadExists(id)).toBe(false)
    expect(fixture.deleteThread.mock.calls.map(([threadId]) => threadId)).toEqual([id, parentId])
  })
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
