import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { DatabaseSync } from "node:sqlite"
import type { WebContents } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getBtwParentId } from "../../shared/btw-chat"
import { WORKFLOW_NOTIFICATION_MARKER_PREFIX } from "../../shared/transcript-visibility"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { publishThreadDirectoryIdentityChanged } from "../db/thread-directory-lifecycle"
import type { ThreadMessageHydrationPageOptions } from "../thread-message-hydration/protocol"
import type { Message, ThreadMessagesPage } from "../types"
import { beginSideThreadClose, bindSideWindow, btwRequest, canRunSideThread, captureSideContext, closeOwnedSideThread, createSideThread, getSideThreadContext, getSideThreadLifetimeSignal, hasRegisteredSideThread, sideThreadIds, unregisterSideThread } from "./btw-chat"
import { withThreadRunMutationLock } from "./thread-run-mutation-lock"

const { bootstrapLegacy, readLegacyStatus, readPage, readBoundary, readEndOrdinal, readParent, resolveModel, readLifetime, inspectFile, getDb } = vi.hoisted(() => ({
  bootstrapLegacy: vi.fn(), readLegacyStatus: vi.fn(),
  readPage: vi.fn(), readBoundary: vi.fn(), readEndOrdinal: vi.fn(), readParent: vi.fn(),
  resolveModel: vi.fn(), readLifetime: vi.fn(), inspectFile: vi.fn(), getDb: vi.fn<() => NativeSqliteAdapter>()
}))
vi.mock("../db", () => ({
  createThread: (id: string, metadata: object) => ({
    thread_id: id, title: "", status: "idle", created_at: 0, updated_at: 0, metadata: JSON.stringify(metadata)
  }),
  getDb,
  getLegacyCheckpointMigrationStatus: readLegacyStatus,
  threadExists: () => true,
  getThreadMessageOrdinalBoundary: readEndOrdinal,
  getThreadRowLifetime: readLifetime,
  getThreadTranscriptBoundaryOrdinal: readBoundary
}))
vi.mock("../checkpointer/runtime-projection-client", () => ({
  restoreSideConversationParentTranscript: bootstrapLegacy
}))
vi.mock("../storage", () => ({
  DEFAULT_MAX_TOKENS: 128_000,
  DEFAULT_MAX_OUTPUT_TOKENS: 8192,
  getDbPath: () => "/messages.sqlite",
  getThreadCheckpointPath: (threadId: string) => `/${threadId}.sqlite`
}))
vi.mock("../thread-message-hydration/client", () => ({
  readThreadMessagesPageInWorker: readPage,
  isThreadMessageHydrationWorkerUnavailable: () => false
}))
vi.mock("../thread-metadata-hydration/client", () => ({ readSideParentInWorker: readParent }))
vi.mock("../bots/conversation-link-authority", () => ({ findBotWorkThreadOwner: () => undefined }))
vi.mock("../models/registry", () => ({ getSelectableModelConfigOrDefault: resolveModel }))
vi.mock("../workspace-file-preview/client", () => ({ getWorkspaceFilePreviewClient: () => ({ inspect: inspectFile }) }))
const request = { modelId: "custom:test", parentId: randomUUID() }

const message = (id: string, ordinal: number, role: Message["role"], content = id): Message =>
  ({ id, ordinal, role, content, created_at: new Date(ordinal) })

const page = (messages: Message[], beforeOrdinal: number | null = null): ThreadMessagesPage => ({
  messages, beforeOrdinal, beforeMessageId: beforeOrdinal === null ? null : "cursor",
  hasMore: beforeOrdinal !== null, total: messages.length
})

describe("辅助对话创建", () => {
  beforeEach(() => {
    getDb.mockReset()
    bootstrapLegacy.mockReset()
    readLegacyStatus.mockReset().mockReturnValue("complete")
    readPage.mockReset()
    readBoundary.mockReset()
    readEndOrdinal.mockReset().mockReturnValue(10)
    readParent.mockReset().mockResolvedValue({ metadata: { workspacePath: "/workspace" } })
    resolveModel.mockReset().mockReturnValue(null)
    readLifetime.mockReset().mockReturnValue("lifetime")
    inspectFile.mockReset()
  })

  it("accepts a parent ID and model selection", () => {
    expect(btwRequest.safeParse(request).success).toBe(true)
  })

  it("rejects invalid parent IDs and renderer-supplied history", () => {
    for (const input of [
      { ...request, parentId: "../fake" },
      { ...request, context: [{ role: "user", content: "fake parent history" }] }
    ]) expect(btwRequest.safeParse(input).success).toBe(false)
  })

  it("finds only side threads whose persisted owner matches their generated ID prefix", () => {
    const database = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    getDb.mockReturnValue(database)
    try {
      database.run("CREATE TABLE threads (thread_id TEXT PRIMARY KEY, created_at INTEGER, metadata TEXT)")
      const { parentId } = request
      const childId = `btw-${parentId}-${randomUUID()}`
      const owned = JSON.stringify({ btwParentId: parentId })
      const rows = [
        [childId, owned],
        [`btw-${parentId}-${randomUUID()}`, '{"workspacePath":"/imported"}'],
        [`btw-${parentId}-${randomUUID()}`, '{"btwParentId":'],
        [`btw-${parentId}-${randomUUID()}`, JSON.stringify({ btwParentId: randomUUID() })],
        [`btw-${randomUUID()}-${randomUUID()}`, owned]
      ]
      for (const [id, metadata] of rows) database.run("INSERT INTO threads VALUES (?, 0, ?)", [id, metadata])
      expect(sideThreadIds(parentId)).toEqual([childId])
    } finally {
      database.close()
    }
  })

  it("does not create a tab or read parent context when an exact workspace file exists", async () => {
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents
    const owner = bindSideWindow(sender, vi.fn())
    const read = vi.fn()
    inspectFile.mockResolvedValue({ resolvedPath: "/workspace/notes.txt" })

    await expect(createSideThread({ ...request, fileCandidates: ["notes.txt"] }, sender, owner, () => read))
      .rejects.toThrow("当前草稿已保留")
    expect(inspectFile).toHaveBeenCalledExactlyOnceWith({
      threadId: request.parentId, filePath: "notes.txt", workspacePathKind: "relative"
    }, "/workspace", expect.any(String))
    expect(read).not.toHaveBeenCalled()
    expect(owner.ids.size).toBe(0)
  })

  it("accepts ordinary question tokens when they do not name regular workspace files", async () => {
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents
    const owner = bindSideWindow(sender, vi.fn())
    inspectFile.mockRejectedValueOnce(Object.assign(new Error("Missing file"), { code: "ENOENT" }))
      .mockRejectedValueOnce(new Error("Cannot preview a directory"))

    const { id } = await createSideThread({ ...request, fileCandidates: ["alice", "types/node"] },
      sender, owner, () => async () => [])
    expect(inspectFile.mock.calls.map(([source]) => source.filePath)).toEqual(["alice", "types/node"])
    expect(owner.ids.has(id)).toBe(true)
    unregisterSideThread(id)
  })

  it("keeps the active user boundary captured at creation", async () => {
    readPage.mockReturnValueOnce(page([
      message("prior question", 1, "user"), message("prior answer", 2, "assistant"), message("current question", 3, "user")
    ]))
    readEndOrdinal.mockReturnValue(2_052)
    readBoundary.mockReturnValue(3)

    const read = captureSideContext(request.parentId, true, "current question")
    readBoundary.mockReturnValue(8)
    expect(await read(512)).toEqual([
      { role: "user", content: "prior question" },
      { role: "assistant", content: "prior answer" },
      { role: "user", content: "current question" }
    ])
    expect(readPage).toHaveBeenCalledExactlyOnceWith(request.parentId, expect.objectContaining({
      beforeOrdinal: 4,
      sideContextTextByteBudget: 512 * 4
    }))
  })

  it("excludes later user prompts and tool output when the active user is known", async () => {
    readBoundary.mockReturnValue(3)
    const rows = [
      message("prior answer", 2, "assistant"), message("current question", 3, "user"),
      message("unfinished tool result", 4, "tool"), message("queued question", 5, "user"),
      message("unfinished answer", 6, "assistant")
    ]
    readPage.mockImplementation(async (_id: string, options: ThreadMessageHydrationPageOptions) =>
      page(rows.filter(row => row.ordinal! < options.beforeOrdinal!)))

    expect(await captureSideContext(request.parentId, true, "current question")(512)).toEqual([
      { role: "assistant", content: "prior answer" },
      { role: "user", content: "current question" }
    ])
    expect(readPage).toHaveBeenCalledExactlyOnceWith(request.parentId, expect.objectContaining({ beforeOrdinal: 4 }))
  })

  it("finds the last visible user behind hidden prompts when the active user is unknown", async () => {
    const rows = [
      message("prior question", 3, "user"), message("completed tool result", 4, "tool"),
      message("current question", 5, "user"),
      ...Array.from({ length: 17 }, (_, index) => index % 2 === 0
        ? message(`im-remote-approval:${index}`, index + 6, "user")
        : message(`internal-${index}`, index + 6, "user", WORKFLOW_NOTIFICATION_MARKER_PREFIX)),
      ...Array.from({ length: 300 }, (_, index) => message(`unfinished-${index}`, index + 23, "tool"))
    ]
    readEndOrdinal.mockReturnValue(323)
    readPage.mockImplementation(async (_id: string, options: ThreadMessageHydrationPageOptions) => {
      const candidates = rows.filter(row => row.ordinal! < options.beforeOrdinal! &&
        (options.userOrdinalFloor === undefined || (row.role === "user" && row.ordinal! > options.userOrdinalFloor)))
      const tail = candidates.slice(-options.limit!)
      return page(tail, tail.length < candidates.length ? tail[0].ordinal : null)
    })

    expect(await captureSideContext(request.parentId, true)(512)).toEqual([
      { role: "user", content: "prior question" },
      { role: "assistant", content: "工具 调用 的结果：\ncompleted tool result" },
      { role: "user", content: "current question" }
    ])
    expect(readPage.mock.calls.map(([, options]) => options)).toEqual([
      expect.objectContaining({ beforeOrdinal: 323, userOrdinalFloor: -1, limit: 16 }),
      expect.objectContaining({ beforeOrdinal: 7, userOrdinalFloor: -1, limit: 16 }),
      expect.objectContaining({ beforeOrdinal: 6, limit: 128 })
    ])
    expect(readPage.mock.lastCall?.[1]).not.toHaveProperty("userOrdinalFloor")
  })

  it("keeps completed output if a replacement run has not saved its user question yet", async () => {
    readPage.mockReturnValue(page([
      message("prior question", 1, "user"), message("prior answer", 2, "assistant"),
      message("arrived after snapshot", 10, "user")
    ]))
    expect(await captureSideContext(request.parentId, true, "unsaved")(512)).toEqual([
      { role: "user", content: "prior question" },
      { role: "assistant", content: "prior answer" }
    ])
  })

  it("keeps the completed exchange before a graph-only notification boundary", async () => {
    const rows = [
      message("prior question", 0, "user"), message("prior answer", 1, "assistant"),
      message("unfinished notice", 3, "assistant"), message("unfinished notification tool", 4, "tool"),
      message("later guide", 5, "user")
    ]
    readEndOrdinal.mockReturnValue(6)
    readBoundary.mockImplementation((_id, messageId) => messageId === "notification-graph" ? 2 : undefined)
    readPage.mockImplementation(async (_id: string, options: ThreadMessageHydrationPageOptions) =>
      page(rows.filter(row => row.ordinal! < options.beforeOrdinal!)))

    const snapshot = captureSideContext(request.parentId, true, "notification-graph")
    expect(await snapshot(512)).toEqual([
      { role: "user", content: "prior question" },
      { role: "assistant", content: "prior answer" }
    ])
    expect(readPage).toHaveBeenCalledExactlyOnceWith(request.parentId, expect.objectContaining({ beforeOrdinal: 3 }))
  })

  it("still finds the last visible user for a resumed run without an active user ID", async () => {
    readPage.mockResolvedValueOnce(page([message("current question", 3, "user")]))
      .mockResolvedValueOnce(page([message("current question", 3, "user")]))
    expect(await captureSideContext(request.parentId, true)(512))
      .toEqual([{ role: "user", content: "current question" }])
    expect(readPage).toHaveBeenNthCalledWith(1, request.parentId, expect.objectContaining({ beforeOrdinal: 10, userOrdinalFloor: -1 }))
    expect(readPage).toHaveBeenNthCalledWith(2, request.parentId, expect.objectContaining({ beforeOrdinal: 4 }))
  })

  it("inherits more than 64 rows when they fit in the model budget", async () => {
    const rows = Array.from({ length: 96 }, (_, index) =>
      message(`message ${index + 1}`, index + 1, index % 2 === 0 ? "user" : "assistant"))
    readEndOrdinal.mockReturnValue(97)
    readPage.mockReturnValueOnce(page(rows.slice(32), 33)).mockReturnValueOnce(page(rows.slice(0, 32)))

    const snapshot = await captureSideContext(request.parentId, false)(12800)
    expect(snapshot).toHaveLength(96)
    expect(snapshot[0]).toEqual({ role: "user", content: "message 1" })
    expect(snapshot.at(-1)).toEqual({ role: "assistant", content: "message 96" })
  })

  it("uses the available fallback model for both capture and the child", async () => {
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents
    const owner = bindSideWindow(sender, vi.fn().mockResolvedValue(undefined))
    const read = vi.fn().mockResolvedValue([])
    resolveModel.mockReturnValue({ id: "default-model", ref: "builtin:default-model", maxTokens: 32_000, maxOutputTokens: 8192 })

    const { id, thread } = await createSideThread(request, sender, owner, () => read)
    expect(resolveModel).toHaveBeenCalledExactlyOnceWith(request.modelId)
    expect(read).toHaveBeenCalledExactlyOnceWith(3_200, expect.any(Function))
    expect(thread.metadata.model).toBe("builtin:default-model")
    expect(bootstrapLegacy).not.toHaveBeenCalled()
    unregisterSideThread(id)
  })

  it("keeps the captured model and budget when the parent switches models during hydration", async () => {
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents
    const owner = bindSideWindow(sender, vi.fn())
    readParent.mockResolvedValue({ metadata: { workspacePath: "/workspace", model: "model-a" } })
    resolveModel.mockImplementation((id: string) => ({
      id, ref: `custom:${id}`, maxTokens: id === "model-a" ? 32_000 : 128_000, maxOutputTokens: 8192
    }))
    const read = vi.fn(async () => {
      await withThreadRunMutationLock(request.parentId, async () => {
        readParent.mockResolvedValue({ metadata: { workspacePath: "/workspace", model: "model-b" } })
        publishThreadDirectoryIdentityChanged(request.parentId)
      })
      return []
    })

    const { id, thread } = await createSideThread({ ...request, modelId: "" }, sender, owner, () => read)
    expect(readParent).toHaveBeenCalledTimes(2)
    expect(resolveModel).toHaveBeenCalledExactlyOnceWith("model-a")
    expect(read).toHaveBeenCalledExactlyOnceWith(3_200, expect.any(Function))
    expect(thread.metadata.model).toBe("custom:model-a")
    unregisterSideThread(id)
  })

  it.each([null, "migrating"])("restores the legacy parent history before capturing the side snapshot (%s)", async status => {
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents
    const owner = bindSideWindow(sender, vi.fn().mockResolvedValue(undefined))
    readLegacyStatus.mockReturnValue(status)
    readEndOrdinal.mockReturnValue(status === null ? 0 : 1)
    readPage.mockResolvedValue(page(status === null ? [] : [message("previous question", 0, "user")]))
    bootstrapLegacy.mockImplementationOnce(async () => {
      readLegacyStatus.mockReturnValue("complete")
      readEndOrdinal.mockReturnValue(2)
      readPage.mockResolvedValue(page([
        message("previous question", 0, "user"), message("previous answer", 1, "assistant")
      ]))
    })

    const { id } = await createSideThread(request, sender, owner, parentId => captureSideContext(parentId, false))
    expect(bootstrapLegacy).toHaveBeenCalledExactlyOnceWith(
      `/${request.parentId}.sqlite`, "/messages.sqlite", request.parentId, expect.any(AbortSignal)
    )
    expect(readPage).toHaveBeenCalledExactlyOnceWith(request.parentId, expect.objectContaining({ beforeOrdinal: 2 }))
    expect(getSideThreadContext(id)).toEqual([
      { role: "user", content: "previous question" }, { role: "assistant", content: "previous answer" }
    ])
    unregisterSideThread(id)
  })

  it("does not publish an incomplete inherited snapshot when legacy recovery remains pending", async () => {
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents
    const owner = bindSideWindow(sender, vi.fn().mockResolvedValue(undefined))
    readLegacyStatus.mockReturnValue("migrating")
    bootstrapLegacy.mockResolvedValue(undefined)

    await expect(createSideThread(request, sender, owner, parentId => captureSideContext(parentId, false)))
      .rejects.toThrow("原会话历史仍在恢复")
    expect(readEndOrdinal).not.toHaveBeenCalled()
    expect(owner.ids.size).toBe(0)
  })

  it("lets parent send or stop preempt legacy recovery and retries from the restored boundary", async () => {
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents
    const owner = bindSideWindow(sender, vi.fn())
    const workerStarted = Promise.withResolvers<AbortSignal | undefined>()
    const workerClosed = Promise.withResolvers<void>()
    readLegacyStatus.mockReturnValue("migrating")
    bootstrapLegacy.mockImplementationOnce(async (_checkpoint, _messages, _id, signal?: AbortSignal) => {
      workerStarted.resolve(signal)
      await workerClosed.promise
      signal?.throwIfAborted()
    })
    const open = () => createSideThread(request, sender, owner, parentId => captureSideContext(parentId, false))
    const first = open()
    const failed = expect(first).rejects.toThrow("原会话历史仍在恢复")
    const signal = await workerStarted.promise
    const mutateParent = vi.fn(async () => undefined)
    const parentMutation = withThreadRunMutationLock(request.parentId, mutateParent)
    try {
      expect(signal?.aborted).toBe(true)
      expect(mutateParent).not.toHaveBeenCalled()
    } finally {
      workerClosed.resolve()
      await Promise.all([parentMutation, failed])
    }
    expect(mutateParent).toHaveBeenCalledOnce()
    expect(owner.ids.size).toBe(0)
    expect(readEndOrdinal).not.toHaveBeenCalled()

    bootstrapLegacy.mockImplementationOnce(async () => {
      readLegacyStatus.mockReturnValue("complete")
      readEndOrdinal.mockReturnValue(2)
      readPage.mockResolvedValue(page([message("restored reply", 1, "assistant")]))
    })
    const { id } = await open()
    try {
      expect(readPage).toHaveBeenCalledExactlyOnceWith(request.parentId, expect.objectContaining({ beforeOrdinal: 2 }))
      expect(getSideThreadContext(id)).toEqual([{ role: "assistant", content: "restored reply" }])
    } finally {
      unregisterSideThread(id)
    }
  })

  it("keeps visible tab numbers distinct after closing a middle tab", async () => {
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents
    const owner = bindSideWindow(sender, vi.fn())
    const parentId = randomUUID()
    const make = () => createSideThread({ ...request, parentId }, sender, owner, () => async () => [])
    const first = await make()
    const middle = await make()
    const third = await make()
    unregisterSideThread(middle.id)
    const fourth = await make()
    expect([first.ordinal, third.ordinal, fourth.ordinal]).toEqual([1, 3, 4])
    for (const { id } of [first, third, fourth]) unregisterSideThread(id)
  })

  it("fences a closed tab and revokes its siblings only on document replacement", async () => {
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false })
    const sender = contents as unknown as WebContents
    const close = vi.fn().mockResolvedValue(undefined)
    const owner = bindSideWindow(sender, close)
    const makeSide = () => createSideThread(request, sender, owner, () => async () => [{ role: "user", content: "inherited" }])
    const first = await makeSide()
    const second = await makeSide()
    const firstLifetime = getSideThreadLifetimeSignal(first.id)
    const secondLifetime = getSideThreadLifetimeSignal(second.id)
    expect(getBtwParentId(first.id)).toBe(request.parentId)
    expect(JSON.stringify(first.thread)).not.toContain("inherited")
    expect(getSideThreadContext(first.id)).toEqual([{ role: "user", content: "inherited" }])
    expect(canRunSideThread(first.id)).toBe(true)
    expect(firstLifetime?.aborted).toBe(false)
    beginSideThreadClose(first.id)
    expect(canRunSideThread(first.id)).toBe(false)
    expect(getSideThreadContext(first.id)).toEqual([])
    expect(firstLifetime?.aborted).toBe(true)
    expect(canRunSideThread(second.id)).toBe(true)
    expect(secondLifetime?.aborted).toBe(false)

    contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true })
    expect(canRunSideThread(second.id)).toBe(true)
    contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
    expect(canRunSideThread(second.id)).toBe(false)
    expect(getSideThreadContext(second.id)).toBeUndefined()
    expect(secondLifetime?.aborted).toBe(true)
    expect(getSideThreadLifetimeSignal(second.id)?.aborted).toBe(true)
    expect(close).toHaveBeenCalledWith(second.id)
    expect(canRunSideThread(request.parentId)).toBe(true)
    expect(getSideThreadLifetimeSignal(request.parentId)).toBeUndefined()
  })

  it("does not publish a side conversation when its opener reloads during hydration", async () => {
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false })
    const sender = contents as unknown as WebContents
    const close = vi.fn().mockResolvedValue(undefined)
    const owner = bindSideWindow(sender, close)
    const opening = createSideThread(request, sender, owner, () => async () => {
      contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
      return []
    })

    await expect(opening).rejects.toThrow("创建辅助对话的页面已关闭")
    expect(owner.ids.size).toBe(0)
    expect(close).not.toHaveBeenCalled()
  })

  it.each([
    ["reload", false], ["reload", true], ["window destroyed", false], ["parent replaced", false], ["parent replaced", true]
  ] as const)("stops reading after %s during a paged read (running parent: %s)", async (interruption, running) => {
    const isDestroyed = vi.fn().mockReturnValue(false)
    const contents = Object.assign(new EventEmitter(), { isDestroyed })
    const sender = contents as unknown as WebContents
    const owner = bindSideWindow(sender, vi.fn())
    readPage.mockImplementationOnce(async () => {
      if (interruption === "reload") {
        contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
      } else if (interruption === "window destroyed") {
        isDestroyed.mockReturnValue(true)
        contents.emit("destroyed")
      } else {
        readLifetime.mockReturnValue("replacement")
        publishThreadDirectoryIdentityChanged(request.parentId)
      }
      return page([message("internal prompt", 6, "user", WORKFLOW_NOTIFICATION_MARKER_PREFIX)], 6)
    })

    await expect(createSideThread(request, sender, owner, parentId => captureSideContext(parentId, running)))
      .rejects.toThrow(interruption === "parent replaced" ? "原会话已关闭或变化" : "创建辅助对话的页面已关闭")
    expect(readPage).toHaveBeenCalledOnce()
    expect(owner.ids.size).toBe(0)
  })

  it("rechecks a changed parent lease without interrupting the same running parent or polling unchanged pages", async () => {
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents
    const owner = bindSideWindow(sender, vi.fn())
    readPage.mockImplementationOnce(async () => {
      publishThreadDirectoryIdentityChanged(request.parentId)
      return page([message("current question", 6, "user")])
    }).mockImplementationOnce(async () => {
      publishThreadDirectoryIdentityChanged(randomUUID())
      return page([message("current question", 6, "user")], 6)
    }).mockResolvedValueOnce(page([message("prior answer", 5, "assistant")]))

    const { id } = await createSideThread(request, sender, owner, parentId => captureSideContext(parentId, true))
    expect(readLifetime).toHaveBeenCalledTimes(4)
    expect(readParent).toHaveBeenCalledTimes(2)
    expect(readPage).toHaveBeenCalledTimes(3)
    expect(getSideThreadContext(id)).toEqual([
      { role: "assistant", content: "prior answer" }, { role: "user", content: "current question" }
    ])
    unregisterSideThread(id)
  })

  it("releases the parent mutation lock during hydration and revalidates the workspace before publishing", async () => {
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents
    const owner = bindSideWindow(sender, vi.fn().mockResolvedValue(undefined))
    const opening = createSideThread(request, sender, owner, () => async () => {
      await withThreadRunMutationLock(request.parentId, async () => {
        readParent.mockResolvedValue({ metadata: { workspacePath: "/changed" } })
        publishThreadDirectoryIdentityChanged(request.parentId)
      })
      return []
    })

    await expect(opening).rejects.toThrow("原会话工作区已变化")
    expect(owner.ids.size).toBe(0)
  })

  it("retries a stale metadata read without waiting on the parent lock", async () => {
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents
    const owner = bindSideWindow(sender, vi.fn())
    readParent.mockImplementationOnce(async () => {
      await withThreadRunMutationLock(request.parentId, async () => {
        publishThreadDirectoryIdentityChanged(request.parentId)
      })
      return { metadata: { workspacePath: "/stale" } }
    })

    const { id, thread } = await createSideThread(request, sender, owner, () => async () => [])
    expect(readParent).toHaveBeenCalledTimes(2)
    expect(thread.metadata.workspacePath).toBe("/workspace")
    unregisterSideThread(id)
  })

  it("keeps a failed close fenced and allows its owner to retry", async () => {
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents
    const stop = vi.fn().mockRejectedValueOnce(new Error("Still settling")).mockResolvedValueOnce(undefined)
    const owner = bindSideWindow(sender, stop)
    const { id } = await createSideThread(request, sender, owner, () => async () => [])

    await expect(closeOwnedSideThread(owner, id, stop)).rejects.toThrow("Still settling")
    expect(canRunSideThread(id)).toBe(false)
    expect(hasRegisteredSideThread(id)).toBe(true)
    expect(owner.ids.has(id)).toBe(true)

    await closeOwnedSideThread(owner, id, stop)
    expect(owner.ids.has(id)).toBe(false)
    expect(hasRegisteredSideThread(id)).toBe(false)
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it("unregisters a deleted side tab while its close is in flight", async () => {
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false })
    const sender = contents as unknown as WebContents
    const stopOnReload = vi.fn().mockResolvedValue(undefined)
    const owner = bindSideWindow(sender, stopOnReload)
    const { id } = await createSideThread(request, sender, owner, () => async () => [])
    let finishClose!: () => void
    const close = closeOwnedSideThread(owner, id, () => new Promise(resolve => { finishClose = resolve }))

    unregisterSideThread(id)
    expect(owner.ids.has(id)).toBe(false)
    expect(canRunSideThread(id)).toBe(false)
    contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
    contents.emit("destroyed")
    expect(stopOnReload).not.toHaveBeenCalled()
    finishClose()
    await close
  })
})
