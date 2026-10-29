import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { IpcMain } from "electron"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppNotification } from "../../shared/app-notifications"
import type { ManagedRunSnapshot } from "../../shared/harness-board-types"
import type { AgentRunDelivery } from "../agent/agent-run-service"
import { ensureAppNotificationsSchema } from "../db/app-notifications-schema"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"

const dependencies = vi.hoisted(() => ({
  database: undefined as NativeSqliteAdapter | undefined,
  rootDir: "",
  send: vi.fn(),
  createSession: vi.fn(),
  startSession: vi.fn(),
  startPrepared: vi.fn()
}))
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: dependencies.send }
      }
    ]
  }
}))
vi.mock("../db", () => ({
  getDb: () => dependencies.database,
  getThread: () => ({ thread_id: "origin" }),
  getAllThreadSummaries: () => []
}))
vi.mock("../agent/agent-run-service", () => ({ hasActiveTopLevelAgentRun: () => false }))
vi.mock("./service", () => ({ readHarnessFeatureMetadata: () => null }))
vi.mock("./human-gate-service", () => ({
  hasPendingHumanGateForThread: () => false,
  interruptHumanGatesForRun: () => undefined
}))
vi.mock("./managed-feature-status", () => ({
  inspectHarnessManagedFeatureStatus: async () => ({
    currentNodeId: "dev.plan",
    featureStateHash: `v1:sha256:${"a".repeat(64)}`,
    featureStatus: "in_progress",
    currentNodeStatus: "in_progress",
    nextActionHash: `v1:sha256:${"b".repeat(64)}`,
    nextAction: { slashSkill: "dev-plan", userMessage: "继续规划" }
  })
}))
vi.mock("./auto-mode-action-executor", () => ({
  ManagedActionValidationError: class extends Error {},
  prepareManagedHarnessSession: async () => ({}),
  createManagedHarnessSession: dependencies.createSession,
  startManagedHarnessSession: dependencies.startSession,
  prepareManagedBizRetryRun: () => ({}),
  startPreparedManagedAgentRun: dependencies.startPrepared
}))

let sqlite: DatabaseSync
let run: ManagedRunSnapshot
let notificationId: string
let service: (typeof import("./biz-retry-service"))["managedBizRetryService"]
let notifications: (typeof import("../services/notification-service"))["notificationService"]
let runStore: (typeof import("./managed-run-store"))["managedRunStore"]
let decide: (typeof import("../services/notification-actions"))["decideNotification"]
let listAppNotifications: () => AppNotification[]

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  dependencies.rootDir = mkdtempSync(join(tmpdir(), "biz-retry-decision-"))
  vi.doMock("./managed-run-store", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./managed-run-store")>()
    return {
      ...actual,
      managedRunStore: new actual.ManagedRunStore({ rootDir: dependencies.rootDir })
    }
  })
  sqlite = new DatabaseSync(":memory:")
  dependencies.database = new NativeSqliteAdapter(sqlite)
  ensureAppNotificationsSchema(dependencies.database)
  dependencies.createSession.mockResolvedValue({
    threadId: "created",
    thread: { thread_id: "created" }
  })
  dependencies.startSession.mockResolvedValue(undefined)
  dependencies.startPrepared.mockResolvedValue(undefined)
  notifications = (await import("../services/notification-service")).notificationService
  runStore = (await import("./managed-run-store")).managedRunStore
  const source = await import("./biz-retry-service")
  service = source.managedBizRetryService
  const { resolveManagedBizRetryDecision } = await import("./auto-mode-controller")
  source.initializeBizRetrySource(resolveManagedBizRetryDecision)
  decide = (await import("../services/notification-actions")).decideNotification
  const handlers = new Map<string, () => AppNotification[]>()
  const { registerNotificationHandlers } = await import("../ipc/notifications")
  registerNotificationHandlers({
    handle: (channel: string, handler: () => AppNotification[]) => handlers.set(channel, handler)
  } as unknown as IpcMain)
  listAppNotifications = handlers.get("appNotifications:list")!
  run = runStore.updateSnapshot({
    ...runStore.createRun("project", "feature", dependencies.rootDir),
    currentSession: { threadId: "origin" },
    decisionBaseline: {
      nodeId: "dev.plan",
      featureStateHash: `v1:sha256:${"c".repeat(64)}`,
      featureStatus: "in_progress",
      nodeStatus: "in_progress",
      nextActionHash: `v1:sha256:${"d".repeat(64)}`
    }
  })
  const sourceEvent = runStore.appendEvent(run, { type: "run_started", summary: "启动" })
  service.request({
    run,
    sourceEvent,
    policyResult: {
      type: "biz_retry",
      proposedAction: "start_new_thread",
      reasonCode: "no_progress"
    },
    summary: "需要人工决策",
    stageName: "dev.plan",
    delivery: { send: vi.fn(), isAvailable: () => true } as unknown as AgentRunDelivery
  })
  notificationId = notifications.pending()[0].notificationId
  dependencies.send.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  sqlite.close()
  rmSync(dependencies.rootDir, { recursive: true, force: true })
})

function choose(action = "new_thread") {
  return decide({ notificationId, action }, { channel: "desktop" })
}

describe("Biz Retry decision failures and input liveness", () => {
  it("refreshes APP once for persisted completion and still removes execution resources", async () => {
    notifications.finish(notificationId, {
      status: "resolved",
      channel: "desktop",
      action: "continue",
      reasonCode: "user_decision",
      result: "done"
    })
    expect(
      dependencies.send.mock.calls.filter(([channel]) => channel === "appNotifications:changed")
    ).toHaveLength(1)
    // A stale caller cannot revive execution even if it retained an earlier pending snapshot.
    expect((await choose()).applied).toBe(false)
    expect(dependencies.createSession).not.toHaveBeenCalled()
    expect(listAppNotifications()).toEqual([])
    service.removeNotification(notificationId)
    expect(
      dependencies.send.mock.calls.filter(([channel]) => channel === "appNotifications:changed")
    ).toHaveLength(1)
  })

  it("refreshes APP when disabling IM even though the APP target remains enabled", () => {
    notifications.disableChannel(notificationId, "im")
    expect(
      dependencies.send.mock.calls.filter(([channel]) => channel === "appNotifications:changed")
    ).toHaveLength(1)
    expect(listAppNotifications()[0].disabledTargets?.im).toBe(true)
    expect(service.blocksThread("origin")).toBe(true)
  })

  it("applies a separately registered source visibility rule through the same generic APP entry", async () => {
    const { registerNotificationVisibility } = await import("../services/notification-read-model")
    notifications.create({
      notificationId: "external",
      kind: "decision",
      type: "external",
      title: "External",
      message: "Message",
      targets: ["app_view"],
      payload: {}
    })
    registerNotificationVisibility("external", () => false)
    expect(listAppNotifications().map((item) => item.notificationId)).toEqual([notificationId])
    registerNotificationVisibility("external", () => true)
    expect(listAppNotifications()).toHaveLength(2)
    expect(notifications.get("external")?.status).toBe("pending")
  })

  it("invalidates the decision and saves a failed run when startup throws after creation", async () => {
    dependencies.startSession.mockRejectedValue(new Error("startup failed"))
    expect((await choose()).applied).toBe(false)
    const saved = runStore.getRun(run).snapshot
    expect(saved).toMatchObject({
      status: "failed",
      currentSession: { threadId: "created" },
      lastDecision: { policyResult: { reasonCode: "biz_retry_action_failed" } }
    })
    expect(notifications.get(notificationId)).toMatchObject({
      status: "invalidated",
      reasonCode: "biz_retry_action_failed"
    })
    expect(service.blocksThread("origin")).toBe(false)
    expect(listAppNotifications()).toEqual([])
    expect((await choose()).applied).toBe(false)
    expect(dependencies.createSession).toHaveBeenCalledTimes(1)
  })

  it("reports success without repeating creation when another path already finished the notification", async () => {
    dependencies.startSession.mockImplementation(async () => {
      notifications.finish(notificationId, {
        status: "invalidated",
        channel: "system",
        reasonCode: "ended_elsewhere",
        result: "已结束"
      })
    })
    const finish = vi.spyOn(notifications, "finish")
    const result = await choose()
    expect(result.applied).toBe(true)
    expect(result.message).toContain("本次操作已执行，但决策通知已由其他路径结束")
    expect(finish.mock.results.some((result) => result.value === false)).toBe(true)
    expect(runStore.getRun(run).snapshot?.status).toBe("running")
    expect(service.blocksThread("origin")).toBe(false)
    expect((await choose()).applied).toBe(false)
    expect(dependencies.createSession).toHaveBeenCalledTimes(1)
  })

  it("executes a normally completed notification only once through the registered decision entry", async () => {
    expect((await choose()).applied).toBe(true)
    expect((await choose()).applied).toBe(false)
    expect(dependencies.createSession).toHaveBeenCalledTimes(1)
    expect(dependencies.startSession).toHaveBeenCalledTimes(1)
  })

  it("releases input and refreshes APP even when successful-action notification writes keep failing", async () => {
    expect(service.blocksThread("origin")).toBe(true)
    expect(listAppNotifications()).toHaveLength(1)
    vi.spyOn(notifications, "finish").mockImplementation(() => {
      throw new Error("write failed")
    })
    const result = await choose()
    expect(result.applied).toBe(true)
    expect(result.message).toContain("不要重复执行")
    expect(runStore.getRun(run).snapshot?.status).toBe("running")
    expect(notifications.get(notificationId)?.status).toBe("pending")
    expect(dependencies.send).toHaveBeenCalledWith("appNotifications:changed")
    expect(service.blocksThread("origin")).toBe(false)
    expect(listAppNotifications()).toEqual([])
    // The persistent notification is still pending: rejection must come from runtime invalidation.
    expect((await choose()).applied).toBe(false)
    expect(dependencies.createSession).toHaveBeenCalledTimes(1)
  })

  it("keeps terminal-run reads side-effect free and cleans up at an explicit decision boundary", () => {
    runStore.updateSnapshot({ ...run, status: "failed", failureReason: "ended elsewhere" })
    expect(listAppNotifications()).toEqual([])
    expect(service.blocksThread("origin")).toBe(false)
    expect(notifications.get(notificationId)?.status).toBe("pending")
    expect(dependencies.send).not.toHaveBeenCalled()
    service.reconcileDecision(notificationId)
    expect(notifications.get(notificationId)?.status).toBe("invalidated")
  })

  it("releases both projections for a terminal run even if cleanup cannot be saved", () => {
    runStore.updateSnapshot({ ...run, status: "failed", failureReason: "ended elsewhere" })
    vi.spyOn(notifications, "finish").mockImplementation(() => {
      throw new Error("write failed")
    })
    expect(service.blocksThread("origin")).toBe(false)
    expect(listAppNotifications()).toEqual([])
    expect(notifications.get(notificationId)?.status).toBe("pending")
  })

  it("refreshes an already open APP when stopping a run cannot persist notification cleanup", async () => {
    expect(listAppNotifications()).toHaveLength(1)
    vi.spyOn(notifications, "finish").mockImplementation(() => {
      throw new Error("write failed")
    })
    const { stopManagedRun } = await import("./auto-mode-controller")
    expect(runStore.findRunningRun(run.projectId, run.featureId)?.snapshot).toMatchObject({
      status: "running"
    })
    await expect(stopManagedRun(run)).rejects.toThrow("write failed")
    expect(runStore.getRun(run).snapshot?.status).toBe("cancelled")
    expect(dependencies.send).toHaveBeenCalledWith("appNotifications:changed")
    expect(listAppNotifications()).toEqual([])
    expect(service.blocksThread("origin")).toBe(false)
    expect((await choose()).applied).toBe(false)
    expect(dependencies.createSession).not.toHaveBeenCalled()
  })

  it("keeps a decision blocked while its action is in flight, including an intermediate terminal snapshot", async () => {
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    dependencies.startSession.mockImplementation(async () => {
      runStore.updateSnapshot({ ...run, status: "failed", failureReason: "intermediate" })
      entered()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    const decision = choose()
    await started
    try {
      expect(service.blocksThread("origin")).toBe(true)
      expect(listAppNotifications()).toHaveLength(1)
      expect(notifications.get(notificationId)?.status).toBe("pending")
      expect((await choose()).applied).toBe(false)
      const otherChannel = await decide({ notificationId, action: "stop" }, { channel: "im" })
      expect(otherChannel).toEqual({ applied: false, message: "该决策正在处理，请稍后。" })
    } finally {
      release()
      await decision
    }
    expect(dependencies.createSession).toHaveBeenCalledTimes(1)
  })

  it("keeps APP decision input blocked when only IM is disabled", () => {
    notifications.disableChannel(notificationId, "im")
    expect(service.blocksThread("origin")).toBe(true)
    expect(listAppNotifications()).toHaveLength(1)
    expect(notifications.get(notificationId)?.status).toBe("pending")
  })

  it("does not invalidate a live decision when its run cannot be read", () => {
    vi.spyOn(runStore, "getRun").mockImplementation(() => {
      throw new Error("read failed")
    })
    expect(service.blocksThread("origin")).toBe(true)
    expect(listAppNotifications()).toHaveLength(1)
    expect(notifications.get(notificationId)?.status).toBe("pending")
  })

  it("fails the run instead of reporting success when continuing the existing thread throws", async () => {
    dependencies.startPrepared.mockRejectedValue(new Error("submit failed"))
    expect((await choose("continue")).applied).toBe(false)
    expect(runStore.getRun(run).snapshot?.status).toBe("failed")
    expect(notifications.get(notificationId)).toMatchObject({
      status: "invalidated",
      reasonCode: "biz_retry_action_failed"
    })
    expect(dependencies.createSession).not.toHaveBeenCalled()
  })
})
