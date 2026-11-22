import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import type { ThreadTranscriptSourceScope } from "../../shared/thread-transcript-source-scope"

/** Execute the actual registered handler without starting Electron or importing its services. */
function bootstrapHandler(scope: object): (event: object, threadId: string) => Promise<unknown> {
  const source = ts.createSourceFile("threads.ts",
    readFileSync(resolve("src/main/ipc/threads.ts"), "utf8"), ts.ScriptTarget.Latest, true)
  const handlers: ts.Expression[] = []
  let desktopHistoryPage: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === "desktopHistoryPage") desktopHistoryPage = node.initializer
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === "ipcMain" &&
      node.expression.name.text === "handle" && ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "threads:bootstrap-legacy-checkpoint-transcript")
      handlers.push(node.arguments[1])
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(handlers).toHaveLength(1)
  if (!desktopHistoryPage) throw new Error("Missing desktop history decorator")
  const capture = (expression: ts.Expression) => ts.transpileModule(`(${expression.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return runInNewContext(capture(handlers[0]), {
    ...scope,
    desktopHistoryPage: runInNewContext(capture(desktopHistoryPage), scope)
  })
}

function fixture(sourceScope?: ThreadTranscriptSourceScope) {
  const cancelled = new Error("actual hydration read retired")
  const unavailable = new Error("worker unavailable")
  const read = { assertCurrent: vi.fn(), dispose: vi.fn(), signal: new AbortController().signal,
    row: { metadata: "{}" },
    incarnation: { token: "original-thread", legacyCreatedAt: 1 } }
  const runtimeTuple = { checkpoint: { id: "checkpoint", channel_values: { todos: [] } } }
  const stats = { checkpointId: "checkpoint", totalMessages: 1, migratedMessages: 0,
    batches: 0, payloadBytes: 0 }
  const canonical = vi.fn().mockResolvedValue({ runtimeTuple, stats })
  const stock = vi.fn()
  const finish = vi.fn()
  const legacy = vi.fn().mockResolvedValue({ runtimeTuple, stats })
  const runtimeHead = vi.fn()
  const page = { messages: [{ id: "durable-message" }], total: 1, hasMore: false }
  const pages = vi.fn().mockResolvedValue(page)
  const decorate = vi.fn(async (_id: string, captured: typeof page) => captured)
  const warn = vi.fn()
  const captureScope = vi.fn((_threadId: string, current: typeof read) => {
    current.assertCurrent()
    return sourceScope
  })
  const createWriter = vi.fn(() => { throw Error("Unexpected Main writer execution in IPC fixture") })
  const loadWriter = vi.fn((name: string) => {
    if (name !== "../checkpointer/legacy-transcript-main-writer")
      throw Error(`Unexpected IPC fixture import: ${name}`)
    return { createLegacyTranscriptWriter: createWriter }
  })
  let mutationLocked = false
  const handler = bootstrapHandler({
    require: loadWriter,
    BrowserWindow: { fromWebContents: () => ({}) },
    decorateBotHistoryPage: decorate,
    readForkReplyOrigins: vi.fn(),
    getThreadCore: () => read.row,
    captureThreadDisplayRead: () => read,
    captureThreadTranscriptSourceScope: captureScope,
    captureStockLegacyTranscriptSource: stock,
    canAuditStockLegacyTimes: () => false,
    isThreadPublicationPending: () => false,
    getThreadRowLifetime: () => 1,
    AbortSignal,
    beginCheckpointHydration: () => ({ controller: new AbortController(), workerKey: "test", finish }),
    withThreadRunMutationLock: async (_threadId: string, operation: () => Promise<unknown>) => {
      mutationLocked = true
      try { return await operation() } finally { mutationLocked = false }
    },
    verifyCanonicalThreadDisplayWitnesses: vi.fn(),
    assertValidCheckpointThreadId: (id: string) => id,
    nativeFunctionConversationWorkspace: () => "workspace",
    getModsManager: () => ({ workspaceKey: (workspace: string) => workspace }),
    readCanonicalCheckpointBootstrap: canonical,
    bootstrapLegacyCheckpointTranscriptInWorker: legacy,
    readLatestCheckpointRuntimeTupleInWorker: (...args: unknown[]) => {
      expect(mutationLocked).toBe(true)
      return runtimeHead(...args)
    },
    getThreadCheckpointPath: () => "checkpoint.sqlite",
    getDbPath: () => "messages.sqlite",
    readThreadMessagesPageInWorker: pages,
    isCheckpointRuntimeProjectionCancelled: (error: unknown) => error === cancelled,
    isThreadMessageHydrationWorkerUnavailable: (error: unknown) => error === unavailable,
    setImmediate,
    console: { warn }
  })
  const mainFrame = {}
  const event = { sender: { id: 7, mainFrame }, senderFrame: mainFrame }
  return { handler, event, read, canonical, legacy, pages, page, decorate, runtimeTuple, stats,
    cancelled, unavailable, warn, captureScope, createWriter, loadWriter, stock, finish, runtimeHead }
}

describe("checkpoint bootstrap IPC outcome classification", () => {
  it.each(["canonical", "legacy", "pages"] as const)(
    "propagates a real %s failure and retires the read without claiming cancellation", async stage => {
      const f = fixture(), failure = new Error("MODS_CONVERSATION_MIGRATION_REQUIRED")
      if (stage === "legacy") f.canonical.mockResolvedValue(null)
      f[stage].mockRejectedValue(failure)
      await expect(f.handler(f.event, "thread")).rejects.toBe(failure)
      expect(f.read.dispose).toHaveBeenCalledTimes(1)
      expect(f.warn).toHaveBeenCalledWith("Failed to bootstrap legacy checkpoint transcript:", failure)
      if (stage === "canonical") {
        expect(f.legacy).not.toHaveBeenCalled()
        expect(f.pages).not.toHaveBeenCalled()
      }
    })

  it.each(["canonical", "legacy", "pages"] as const)(
    "returns null only for a genuine cancelled %s read", async stage => {
      const f = fixture()
      if (stage === "legacy") f.canonical.mockResolvedValue(null)
      f[stage].mockRejectedValue(f.cancelled)
      await expect(f.handler(f.event, "thread")).resolves.toBeNull()
      expect(f.read.dispose).toHaveBeenCalledTimes(1)
      expect(f.warn).not.toHaveBeenCalled()
    })

  it("marks only the verified canonical path and preserves the original legacy path", async () => {
    const verified = fixture()
    await expect(verified.handler(verified.event, "thread")).resolves.toEqual({
      checkpoint: verified.runtimeTuple,
      page: { ...verified.page, canonicalCheckpointVerified: true }, migration: verified.stats
    })
    expect(verified.legacy).not.toHaveBeenCalled()
    const original = fixture()
    original.canonical.mockResolvedValue(null)
    await expect(original.handler(original.event, "thread")).resolves.toEqual({
      checkpoint: original.runtimeTuple, page: original.page, migration: original.stats
    })
    expect(original.legacy).toHaveBeenCalledTimes(1)
    expect(original.loadWriter).toHaveBeenCalledExactlyOnceWith(
      "../checkpointer/legacy-transcript-main-writer")
    expect(original.createWriter).not.toHaveBeenCalled()
    expect(verified.loadWriter).not.toHaveBeenCalled()
    expect(verified.read.dispose).toHaveBeenCalledTimes(1)
    expect(original.read.dispose).toHaveBeenCalledTimes(1)
  })

  it("forwards only the source header captured for this bootstrap read", async () => {
    const sourceScope: ThreadTranscriptSourceScope = {
      threadId: "thread", incarnation: { token: "original-thread", legacyCreatedAt: 1 },
      workspacePath: "/workspace"
    }
    const f = fixture(sourceScope)
    const result = await f.handler(f.event, "thread")
    expect(result).toEqual({ checkpoint: f.runtimeTuple,
      page: { ...f.page, sourceScope, canonicalCheckpointVerified: true }, migration: f.stats })
    expect(f.captureScope).toHaveBeenCalledExactlyOnceWith("thread", f.read)
    expect(f.createWriter).not.toHaveBeenCalled()
    expect(() => f.loadWriter("unrelated-service")).toThrow("Unexpected IPC fixture import")
    expect(f.read.dispose).toHaveBeenCalledTimes(1)
  })

  it("rechecks the ordinary source after paging and withholds retired history", async () => {
    const f = fixture()
    f.canonical.mockResolvedValue(null)
    const stockSource = { authority: {}, assertCurrent: vi.fn(() => { throw f.cancelled }) }
    f.stock.mockReturnValue(stockSource)
    await expect(f.handler(f.event, "thread")).resolves.toBeNull()
    expect(f.legacy.mock.calls[0][5]).toBeUndefined()
    expect(f.legacy.mock.calls[0][7]).toBe(stockSource)
    expect(f.pages).toHaveBeenCalledTimes(1)
    expect(stockSource.assertCurrent).toHaveBeenCalledExactlyOnceWith()
    expect(f.warn).not.toHaveBeenCalled()
    expect(f.finish).toHaveBeenCalledExactlyOnceWith()
  })

  it("publishes the current bounded runtime head after restoring an older project reservation", async () => {
    const f = fixture()
    const stockSource = { authority: { projectReservation: { checkpointId: "checkpoint" } },
      assertCurrent: vi.fn() }
    const runtimeTuple = { checkpoint: { id: "newer", channel_values: { todos: [{ id: "current" }] } } }
    f.canonical.mockResolvedValue(null)
    f.stock.mockReturnValue(stockSource)
    f.runtimeHead.mockResolvedValue(runtimeTuple)
    await expect(f.handler(f.event, "thread")).resolves.toEqual({
      checkpoint: runtimeTuple, page: f.page, migration: f.stats
    })
    expect(f.runtimeHead).toHaveBeenCalledExactlyOnceWith("checkpoint.sqlite", "thread", "", "test",
      expect.any(AbortSignal))
    expect(stockSource.assertCurrent).toHaveBeenCalledTimes(4)
    const guards = stockSource.assertCurrent.mock.invocationCallOrder
    const decoration = f.decorate.mock.invocationCallOrder[0]
    expect(guards[2]).toBeLessThan(decoration)
    expect(decoration).toBeLessThan(guards[3])
    expect(f.legacy.mock.invocationCallOrder[0]).toBeLessThan(f.runtimeHead.mock.invocationCallOrder[0])
  })

  it("rejects a real source failure discovered after desktop decoration", async () => {
    const f = fixture()
    const failure = new Error("MODS_CONVERSATION_THREAD_CHANGED")
    f.decorate.mockImplementation(async (_id, page) => {
      f.read.assertCurrent.mockImplementation(() => { throw failure })
      return page
    })

    await expect(f.handler(f.event, "thread")).rejects.toBe(failure)
    expect(f.decorate).toHaveBeenCalledOnce()
    expect(f.pages).toHaveBeenCalledOnce()
    expect(f.warn).toHaveBeenCalledExactlyOnceWith(
      "Failed to bootstrap legacy checkpoint transcript:", failure
    )
    expect(f.finish).toHaveBeenCalledExactlyOnceWith()
    expect(f.read.dispose).toHaveBeenCalledExactlyOnceWith()
  })

  it("propagates a second worker failure instead of retrying bootstrap again", async () => {
    const f = fixture()
    f.pages.mockRejectedValue(f.unavailable)
    await expect(f.handler(f.event, "thread")).rejects.toBe(f.unavailable)
    expect(f.canonical).toHaveBeenCalledOnce()
    expect(f.legacy).not.toHaveBeenCalled()
    expect(f.pages).toHaveBeenCalledTimes(2)
    expect(f.decorate).not.toHaveBeenCalled()
    expect(f.warn.mock.calls[1]).toEqual([
      "Failed to bootstrap legacy checkpoint transcript:", f.unavailable
    ])
    expect(f.read.dispose).toHaveBeenCalledExactlyOnceWith()
  })

  it("restarts an unavailable page reader once without replaying bootstrap", async () => {
    const f = fixture()
    f.pages.mockRejectedValueOnce(f.unavailable)
    await expect(f.handler(f.event, "thread")).resolves.toMatchObject({
      page: { canonicalCheckpointVerified: true }
    })
    expect(f.canonical).toHaveBeenCalledTimes(1)
    expect(f.legacy).not.toHaveBeenCalled()
    expect(f.pages).toHaveBeenCalledTimes(2)
    expect(f.pages.mock.calls[1]).toEqual(f.pages.mock.calls[0])
    expect(f.read.dispose).toHaveBeenCalledTimes(1)
  })
})
