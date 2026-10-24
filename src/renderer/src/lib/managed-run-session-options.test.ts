import { describe, expect, it, vi } from "vitest"
import {
  buildManagedRunSessionOptions,
  getManagedRunInitialSession
} from "./managed-run-session-options"
import type { HarnessSessionBinding } from "../../../shared/harness-board-types"
import type { Thread } from "../types"
import { useAppStore } from "./store"

const session = (
  threadId: string,
  lastActiveAt = "2026-10-24T06:30:00.000Z"
): HarnessSessionBinding => ({
  threadId,
  projectId: "project",
  slug: "feature",
  source: "cmbdevclaw",
  createdAt: lastActiveAt,
  lastActiveAt
})
const thread = (threadId: string, overrides: Partial<Thread> = {}): Thread => ({
  thread_id: threadId,
  title: "已有会话",
  created_at: new Date(0),
  updated_at: new Date(0),
  status: "idle",
  metadata: { workspacePath: "/original/workspace" },
  ...overrides
})

describe("managed run session options", () => {
  it("sorts by activity and displays GMT+8 timestamps and the original workspace", () => {
    const options = buildManagedRunSessionOptions(
      [session("old", "2026-10-23T06:30:00.000Z"), session("new")],
      new Map([
        ["old", thread("old")],
        ["new", thread("new")]
      ]),
      {},
      {}
    )
    expect(options.map((option) => option.threadId)).toEqual(["new", "old"])
    expect(options[0]).toMatchObject({
      workspacePath: "/original/workspace",
      lastActiveAt: "2026-10-24 14:30:00"
    })
  })
  it.each(["stream", "status", "workflow", "worker", "scheduled"])(
    "disables running sessions: %s",
    (reason) => {
      const options = buildManagedRunSessionOptions(
        [session("busy"), session("idle")],
        new Map([
          ["busy", thread("busy", { status: reason === "status" ? "busy" : "idle" })],
          ["idle", thread("idle")]
        ]),
        {
          busy: {
            workflowRunning: reason === "workflow",
            hasRunningCoordinatorWorker: reason === "worker",
            scheduledTaskLoading: reason === "scheduled"
          }
        },
        { busy: reason === "stream" }
      )
      expect(options.find((option) => option.threadId === "busy")?.disabledReason).toBe("运行中")
      expect(options.find((option) => option.threadId === "idle")?.disabledReason).toBeUndefined()
    }
  )
  it("disables deleted sessions and sessions without a workspace", () => {
    const options = buildManagedRunSessionOptions(
      [session("deleted"), session("missing")],
      new Map([["missing", thread("missing", { metadata: {} })]]),
      {},
      {}
    )
    expect(options.map((option) => option.disabledReason)).toEqual(["会话不可用", "缺少工作区"])
  })
  it("defaults to the last managed session only if it is still available", () => {
    const options = buildManagedRunSessionOptions(
      [session("previous"), session("other")],
      new Map([
        ["previous", thread("previous")],
        ["other", thread("other")]
      ]),
      {},
      {}
    )
    expect(getManagedRunInitialSession(options, "previous")?.threadId).toBe("previous")
    expect(getManagedRunInitialSession(options, "deleted")).toBeUndefined()
    expect(
      getManagedRunInitialSession(
        options.map((option) => ({ ...option, disabledReason: "运行中" })),
        "previous"
      )
    ).toBeUndefined()
  })

  it("makes an older session selectable after loading beyond the initial directory page", async () => {
    const previousState = useAppStore.getState()
    const recent = Array.from({ length: 128 }, (_, index) =>
      thread(`recent-${index}`, { updated_at: new Date(2000 - index) })
    )
    const older = thread("older", { updated_at: new Date(1000) })
    const listPage = vi
      .fn()
      .mockResolvedValueOnce({
        threads: recent,
        hasMore: true,
        beforeUpdatedAt: recent[127].updated_at.getTime(),
        beforeThreadId: recent[127].thread_id
      })
      .mockResolvedValueOnce({
        threads: [older],
        hasMore: false,
        beforeUpdatedAt: null,
        beforeThreadId: null
      })
    vi.stubGlobal("window", { api: { threads: { listPage } } })
    useAppStore.setState({ threads: [], mainView: "harness", currentThreadId: null })
    try {
      await useAppStore.getState().loadThreads()
      expect(useAppStore.getState().threadDirectoryHasMore).toBe(true)
      expect(useAppStore.getState().threads).not.toContainEqual(older)

      await useAppStore.getState().loadMoreThreads()

      const state = useAppStore.getState()
      const options = buildManagedRunSessionOptions(
        [session("older")],
        new Map(state.threads.map((item) => [item.thread_id, item])),
        {},
        {}
      )
      expect(options[0]).toMatchObject({ threadId: "older", disabledReason: undefined })
      expect(state.threadDirectoryHasMore).toBe(false)
      expect(state.mainView).toBe("harness")
      expect(state.currentThreadId).toBeNull()
      expect(listPage.mock.calls[1][0]).toMatchObject({
        beforeUpdatedAt: recent[127].updated_at.getTime(),
        beforeThreadId: recent[127].thread_id
      })
    } finally {
      useAppStore.setState(previousState)
      vi.unstubAllGlobals()
    }
  })
})
