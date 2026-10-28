import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ThreadRow } from "../db"
import type { AgentRunDelivery, AgentRunExecutionContext } from "../agent/agent-run-service"
import type {
  ManagedFeatureStatusSnapshot,
  ManagedRunSummary
} from "../../shared/harness-board-types"
import type { ManagedRunStore } from "./managed-run-store"

const dependencies = vi.hoisted(() => ({
  store: undefined as ManagedRunStore | undefined,
  threads: new Map<string, ThreadRow>(),
  messages: new Map<string, Array<{ content: string }>>(),
  active: vi.fn(),
  workflowBusy: vi.fn(),
  workers: vi.fn(),
  finalizing: vi.fn(),
  notifications: vi.fn(),
  inspect: vi.fn(),
  startAgent: vi.fn(),
  createThread: vi.fn(),
  generateTitle: vi.fn(async () => "新任务"),
  requestDecision: vi.fn(),
  deliveryAvailable: vi.fn(),
  grant: vi.fn(),
  send: vi.fn(),
  getThread: vi.fn(),
  getThreadCore: vi.fn()
}))
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock("../db", () => ({
  getThread: dependencies.getThread,
  getThreadCore: dependencies.getThreadCore,
  getAllThreadSummaries: () => [...dependencies.threads.values()],
  updateThread: (id: string, updates: Partial<ThreadRow>) => {
    const thread = dependencies.threads.get(id)
    if (!thread) return null
    const updated = { ...thread, ...updates }
    dependencies.threads.set(id, updated)
    return updated
  },
  upsertThreadMessages: (id: string, messages: Array<{ content: string }>) => {
    dependencies.messages.set(id, [...(dependencies.messages.get(id) ?? []), ...messages])
    return messages.length
  }
}))
vi.mock("../agent/agent-run-service", () => ({
  hasActiveTopLevelAgentRun: dependencies.active,
  startAgentRun: dependencies.startAgent
}))
vi.mock("../agent/coordinator-worker-manager", () => ({
  coordinatorWorkerManager: {
    hasRunningWorkersForThread: dependencies.workers,
    hasTerminalWorkerAwaitingNotificationForThread: dependencies.finalizing,
    hasAutoRunnableNotifications: dependencies.notifications
  }
}))
vi.mock("../agent/workflow/run-manager", () => ({
  workflowRunManager: {
    isBusyForThreadAsync: dependencies.workflowBusy
  }
}))
vi.mock("./service", () => ({
  requireHarnessFeatureWorkspace: async () => "/configured/workspace",
  markHarnessProjectManagedRunStarted: async () => undefined,
  getHarnessProjectAdapterSnapshot: async () => null,
  readHarnessFeatureMetadata: (metadata: { harnessFeature?: Record<string, string> }) => {
    const feature = metadata?.harnessFeature
    return feature?.projectId && feature.slug ? feature : null
  }
}))
vi.mock("./managed-feature-status", () => ({
  inspectHarnessManagedFeatureStatus: dependencies.inspect
}))
vi.mock("./biz-retry-service", () => ({
  managedBizRetryService: {
    request: dependencies.requestDecision,
    removeRunNotifications: vi.fn()
  }
}))
vi.mock("./human-gate-service", () => ({
  hasPendingHumanGateForThread: () => false,
  interruptHumanGatesForRun: vi.fn()
}))
vi.mock("./notifications", () => ({ harnessNotifications: { invalidateRun: vi.fn() } }))
vi.mock("./managed-run-telemetry", () => ({
  reportManagedRunStarted: vi.fn(),
  reportManagedRunEnded: vi.fn()
}))
vi.mock("../app-attention-events", () => ({ emitAppAttention: vi.fn() }))
vi.mock("../ipc/skills", () => ({
  listAllSkills: async () => [
    { id: "dev-code", name: "dev-code", path: "/skills/dev-code", description: "实现代码" }
  ],
  listPluginSkills: async () => []
}))
vi.mock("../storage", () => ({ getDisabledSkills: () => [] }))
vi.mock("../services/thread-service", () => ({ createThreadService: dependencies.createThread }))
vi.mock("../services/project-thread-title", () => ({
  generateProjectThreadTitle: dependencies.generateTitle
}))
vi.mock("../services/im/feature-thread-grant", () => ({
  materializeHarnessFeatureThreadGrant: dependencies.grant
}))
vi.mock("./managed-run-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./managed-run-store")>()
  return {
    ...actual,
    managedRunStore: new Proxy(
      {},
      {
        get(_target, key) {
          const store = dependencies.store!
          const method = store[key as keyof ManagedRunStore]
          return typeof method === "function" ? method.bind(store) : method
        }
      }
    )
  }
})

import { ManagedRunStore as RunStore } from "./managed-run-store"
import {
  handleAutoModeAgentCancelled,
  handleAutoModeAgentTurnEnd,
  startManagedRun,
  stopManagedRun,
  validateManagedRunStart
} from "./auto-mode-controller"

let root: string
let oldRun: ManagedRunSummary
let feature: ManagedFeatureStatusSnapshot
const delivery = {
  send: dependencies.send,
  isAvailable: dependencies.deliveryAvailable,
  window: {}
} as unknown as AgentRunDelivery

function metadata() {
  return JSON.parse(dependencies.threads.get("origin")!.metadata!)
}
function start(overrides = {}) {
  return startManagedRun({
    projectId: "project",
    featureId: "feature",
    existingThreadId: "origin",
    workspacePath: "/ignored/path",
    delivery,
    ...overrides
  })
}
function updateOrigin(updates: Partial<ThreadRow>) {
  dependencies.threads.set("origin", { ...dependencies.threads.get("origin")!, ...updates })
}

beforeEach(() => {
  vi.resetAllMocks()
  dependencies.threads.clear()
  dependencies.messages.clear()
  dependencies.getThread.mockImplementation((id: string) => dependencies.threads.get(id))
  dependencies.getThreadCore.mockImplementation((id: string) => {
    const thread = dependencies.threads.get(id)
    if (!thread) return undefined
    return {
      thread_id: thread.thread_id,
      created_at: thread.created_at,
      updated_at: thread.updated_at,
      status: thread.status,
      title: thread.title,
      metadata: thread.metadata
    }
  })
  root = mkdtempSync(join(tmpdir(), "managed-run-start-"))
  dependencies.store = new RunStore({ rootDir: root })
  const old = dependencies.store.createRun("project", "feature", root)
  dependencies.store.updateSnapshot({
    ...old,
    status: "cancelled",
    currentSession: { threadId: "origin" },
    decisionBaseline: {
      nodeId: "dev.old",
      featureStateHash: `v1:sha256:${"c".repeat(64)}`,
      featureStatus: "in_progress",
      nodeStatus: "in_progress",
      nextActionHash: `v1:sha256:${"d".repeat(64)}`
    },
    providerRetryCount: 2,
    cancellationReason: "用户终止"
  })
  oldRun = dependencies.store.getLatestRun("project", "feature")!
  dependencies.threads.set("origin", {
    thread_id: "origin",
    created_at: 1,
    updated_at: 2,
    status: "idle",
    title: "已有会话",
    thread_values: '{"messages":["previous context"]}',
    metadata: JSON.stringify({
      workspacePath: root,
      model: "original-model",
      agentMode: "coordinator",
      keep: "unchanged",
      harnessFeature: {
        projectId: "project",
        slug: "feature",
        runId: old.runId,
        nodeId: "dev.old",
        launchStageName: "原始阶段"
      }
    })
  })
  dependencies.messages.set("origin", [{ content: "之前的上下文" }])
  feature = {
    currentNodeId: "dev.code",
    featureStatus: "in_progress",
    currentNodeStatus: "in_progress",
    isFinalNode: false,
    nextAction: { slashSkill: "dev-code", userMessage: "请继续实现" },
    featureStateHash: `v1:sha256:${"a".repeat(64)}`,
    nextActionHash: `v1:sha256:${"b".repeat(64)}`
  }
  dependencies.active.mockReturnValue(false)
  dependencies.workers.mockReturnValue(false)
  dependencies.finalizing.mockReturnValue(false)
  dependencies.notifications.mockReturnValue(false)
  dependencies.workflowBusy.mockResolvedValue(false)
  dependencies.inspect.mockImplementation(async () => feature)
  dependencies.requestDecision.mockResolvedValue(true)
  dependencies.deliveryAvailable.mockReturnValue(true)
  dependencies.grant.mockResolvedValue({ required: false, granted: false })
  dependencies.startAgent.mockImplementation(async (request) => ({
    threadId: request.threadId,
    completion: Promise.resolve()
  }))
  dependencies.createThread.mockImplementation(async (meta) => {
    dependencies.threads.set("created", {
      thread_id: "created",
      created_at: 3,
      updated_at: 3,
      status: "idle",
      title: "新任务",
      thread_values: null,
      metadata: JSON.stringify(meta)
    })
    return {
      thread_id: "created",
      metadata: meta,
      status: "idle",
      created_at: new Date(3),
      updated_at: new Date(3)
    }
  })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("start managed mode with an existing session", () => {
  it("creates a new run, preserves history and configuration, and binds ownership before starting", async () => {
    const oldRecord = JSON.stringify(dependencies.store!.getRun(oldRun))
    dependencies.startAgent.mockImplementationOnce(async (request) => {
      const latest = dependencies.store!.getLatestRun("project", "feature")!
      expect(latest.runId).not.toBe(oldRun.runId)
      expect(latest.currentSession?.threadId).toBe("origin")
      expect(latest.decisionBaseline?.nodeId).toBe("dev.code")
      expect(metadata().harnessFeature.runId).toBe(latest.runId)
      return { threadId: request.threadId, completion: Promise.resolve() }
    })
    const run = await start({ initialUserMessage: "先检查已经完成的修改，再继续" })
    expect(run.status).toBe("running")
    expect(run.workspacePath).toBe(root)
    expect(run.providerRetryCount).toBe(0)
    expect(dependencies.createThread).not.toHaveBeenCalled()
    expect(dependencies.startAgent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        threadId: "origin",
        modelId: "original-model",
        agentMode: "coordinator",
        managedExecution: true,
        message: expect.stringContaining("先检查已经完成的修改，再继续")
      }),
      delivery,
      expect.objectContaining({ source: "desktop", verifyResolvedThread: expect.any(Function) })
    )
    expect(dependencies.messages.get("origin")?.[0].content).toBe("之前的上下文")
    expect(dependencies.messages.get("origin")).toHaveLength(2)
    expect(dependencies.threads.get("origin")?.thread_values).toBe(
      '{"messages":["previous context"]}'
    )
    expect(metadata()).toMatchObject({
      keep: "unchanged",
      model: "original-model",
      workspacePath: root,
      harnessFeature: { runId: run.runId, nodeId: "dev.code", launchStageName: "原始阶段" }
    })
    expect(JSON.stringify(dependencies.store!.getRun(oldRun))).toBe(oldRecord)
    const events = dependencies.store!.listEvents(run, undefined, 100).events
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "managed_run_decision",
      "session_continued"
    ])
    expect(events[1].decisionAction).toBe("continue_current_thread")
  })

  it("uses the current step's default message and skill when no custom message is provided", async () => {
    await start()
    const message = dependencies.startAgent.mock.calls[0][0].message
    expect(message).toContain("请继续实现")
    expect(message).toContain("/skills/dev-code")
    expect(dependencies.grant).toHaveBeenCalledWith(expect.objectContaining({ threadId: "origin" }))
  })

  it("validates and prepares the session using core reads without loading thread values", async () => {
    await start()
    expect(dependencies.getThreadCore).toHaveBeenCalledWith("origin")
    expect(dependencies.getThread).not.toHaveBeenCalled()
  })

  it.each(["active", "worker", "workflow", "deleted", "workspace", "binding"])(
    "rejects session changes during grant preparation before binding or submission: %s",
    async (reason) => {
      dependencies.grant.mockImplementationOnce(async () => {
        if (reason === "active") dependencies.active.mockReturnValue(true)
        if (reason === "worker") dependencies.workers.mockReturnValue(true)
        if (reason === "workflow") dependencies.workflowBusy.mockResolvedValue(true)
        if (reason === "deleted") dependencies.threads.delete("origin")
        if (reason === "workspace")
          updateOrigin({ metadata: JSON.stringify({ ...metadata(), workspacePath: tmpdir() }) })
        if (reason === "binding")
          updateOrigin({
            metadata: JSON.stringify({
              ...metadata(),
              harnessFeature: { ...metadata().harnessFeature, slug: "other" }
            })
          })
        return { required: false, granted: false }
      })
      const run = await start()
      expect(run.status).toBe("failed")
      expect(dependencies.startAgent).not.toHaveBeenCalled()
      expect(dependencies.messages.get("origin")).toHaveLength(1)
      if (reason !== "deleted") expect(metadata().harnessFeature.runId).toBe(oldRun.runId)
    }
  )

  it("does not take ownership when grant preparation fails", async () => {
    dependencies.grant.mockResolvedValueOnce({
      required: true,
      granted: false,
      error: "授权失败"
    })
    const run = await start()
    expect(run.status).toBe("failed")
    expect(run.failureReason).toBe("授权失败")
    expect(metadata().harnessFeature.runId).toBe(oldRun.runId)
    expect(dependencies.startAgent).not.toHaveBeenCalled()
  })

  it("honors a stop requested during grant preparation", async () => {
    let stop: Promise<boolean> | undefined
    dependencies.grant.mockImplementationOnce(async () => {
      stop = stopManagedRun(dependencies.store!.getLatestRun("project", "feature")!)
      return { required: false, granted: false }
    })
    const run = await start()
    expect(await stop).toBe(true)
    expect(dependencies.store!.getRun(run).snapshot?.status).toBe("cancelled")
    expect(metadata().harnessFeature.runId).toBe(oldRun.runId)
    expect(dependencies.startAgent).not.toHaveBeenCalled()
  })

  it.each(["workspace", "project", "feature", "run", "node"])(
    "refuses a changed execution target at the actual runtime check: %s",
    async (reason) => {
      let executionStarted = false
      dependencies.startAgent.mockImplementationOnce(
        async (request, _delivery, context: AgentRunExecutionContext) => {
          const current = metadata()
          expect(
            context.verifyResolvedThread?.({ workspacePath: root, metadata: current })
          ).toBeNull()
          if (reason === "workspace") current.workspacePath = tmpdir()
          if (reason === "project") current.harnessFeature.projectId = "other"
          if (reason === "feature") current.harnessFeature.slug = "other"
          if (reason === "run") current.harnessFeature.runId = oldRun.runId
          if (reason === "node") current.harnessFeature.nodeId = "dev.old"
          const refusal = context.verifyResolvedThread?.({
            workspacePath: current.workspacePath,
            metadata: current
          })
          if (refusal) throw new Error(refusal)
          executionStarted = true
          return { threadId: request.threadId, completion: Promise.resolve() }
        }
      )
      const run = await start()
      expect(run.status).toBe("failed")
      expect(run.failureReason).toContain("已变化")
      expect(executionStarted).toBe(false)
    }
  )

  it("keeps the existing new-session path when no existing session is selected", async () => {
    const run = await start({ existingThreadId: undefined, workspacePath: root })
    expect(run.status).toBe("running")
    expect(run.currentSession?.threadId).toBe("created")
    expect(dependencies.generateTitle).toHaveBeenCalledWith(
      expect.any(String),
      "dev-code",
      { projectId: "project", slug: "feature" },
      "实现代码"
    )
    expect(dependencies.createThread).toHaveBeenCalledOnce()
    expect(metadata().harnessFeature.runId).toBe(oldRun.runId)
  })

  it.each([
    "deleted",
    "other-feature",
    "other-project",
    "missing-workspace",
    "missing-directory",
    "busy",
    "active",
    "workers",
    "finalizing",
    "notifications",
    "workflow"
  ])("rejects an unavailable session before creating a run: %s", async (reason) => {
    if (reason === "deleted") dependencies.threads.delete("origin")
    if (reason === "other-feature")
      updateOrigin({
        metadata: JSON.stringify({
          ...metadata(),
          harnessFeature: { projectId: "project", slug: "other" }
        })
      })
    if (reason === "other-project")
      updateOrigin({
        metadata: JSON.stringify({
          ...metadata(),
          harnessFeature: { projectId: "other", slug: "feature" }
        })
      })
    if (reason === "missing-workspace")
      updateOrigin({ metadata: JSON.stringify({ ...metadata(), workspacePath: "" }) })
    if (reason === "missing-directory")
      updateOrigin({
        metadata: JSON.stringify({ ...metadata(), workspacePath: join(root, "missing") })
      })
    if (reason === "busy") updateOrigin({ status: "busy" })
    if (reason === "active") dependencies.active.mockReturnValue(true)
    if (reason === "workers") dependencies.workers.mockReturnValue(true)
    if (reason === "finalizing") dependencies.finalizing.mockReturnValue(true)
    if (reason === "notifications") dependencies.notifications.mockReturnValue(true)
    if (reason === "workflow") dependencies.workflowBusy.mockResolvedValue(true)
    await expect(start()).rejects.toThrow()
    expect(dependencies.store!.listFeatureRunSummaries("project", "feature")).toHaveLength(1)
    expect(dependencies.startAgent).not.toHaveBeenCalled()
  })

  it("rechecks activity after inspecting the feature and does not take over a newly running session", async () => {
    dependencies.inspect.mockImplementationOnce(async () => {
      dependencies.workers.mockReturnValue(true)
      return feature
    })
    const run = await start()
    expect(run.status).toBe("failed")
    expect(run.failureReason).toContain("仍在运行")
    expect(metadata().harnessFeature.runId).toBe(oldRun.runId)
    expect(dependencies.startAgent).not.toHaveBeenCalled()
  })

  it("rechecks deletion after inspecting the feature", async () => {
    dependencies.inspect.mockImplementationOnce(async () => {
      dependencies.threads.delete("origin")
      return feature
    })
    const run = await start()
    expect(run.status).toBe("failed")
    expect(run.failureReason).toContain("已删除")
    expect(dependencies.startAgent).not.toHaveBeenCalled()
  })

  it("rejects background work that starts during the asynchronous workflow check", async () => {
    dependencies.workflowBusy.mockImplementationOnce(async () => {
      dependencies.workers.mockReturnValue(true)
      return false
    })
    await expect(start()).rejects.toThrow("仍在运行")
    expect(dependencies.store!.listFeatureRunSummaries("project", "feature")).toHaveLength(1)
  })

  it("does not silently switch workspaces if the selected session changes during startup", async () => {
    dependencies.inspect.mockImplementationOnce(async () => {
      updateOrigin({ metadata: JSON.stringify({ ...metadata(), workspacePath: tmpdir() }) })
      return feature
    })
    const run = await start()
    expect(run.status).toBe("failed")
    expect(run.failureReason).toContain("工作区已变化")
    expect(metadata().harnessFeature.runId).toBe(oldRun.runId)
    expect(dependencies.startAgent).not.toHaveBeenCalled()
  })

  it("rejects an empty selection instead of falling back to creating a session", async () => {
    await expect(start({ existingThreadId: " " })).rejects.toThrow("请选择")
    expect(dependencies.createThread).not.toHaveBeenCalled()
    expect(dependencies.store!.listFeatureRunSummaries("project", "feature")).toHaveLength(1)
  })

  it("preserves the new run's session reference if submission fails", async () => {
    dependencies.startAgent.mockRejectedValueOnce(new Error("submission failed"))
    const run = await start()
    expect(run.status).toBe("failed")
    expect(run.currentSession?.threadId).toBe("origin")
    expect(metadata().harnessFeature.runId).toBe(run.runId)
    expect(dependencies.store!.getRun(oldRun).snapshot?.status).toBe("cancelled")
  })

  it("does not bind or submit a session when the feature is already complete", async () => {
    feature = { ...feature, isFinalNode: true, featureStatus: "done", currentNodeStatus: "done" }
    const run = await start()
    expect(run.status).toBe("completed")
    expect(metadata().harnessFeature.runId).toBe(oldRun.runId)
    expect(dependencies.startAgent).not.toHaveBeenCalled()
  })

  it("routes subsequent turn completion to the new run", async () => {
    const run = await start()
    await handleAutoModeAgentTurnEnd({
      threadId: "origin",
      outcome: "success",
      endReason: { code: "normal" },
      delivery
    })
    expect(dependencies.requestDecision).toHaveBeenCalledWith(
      expect.objectContaining({ run: expect.objectContaining({ runId: run.runId }) })
    )
    expect(dependencies.store!.getRun(oldRun).snapshot?.status).toBe("cancelled")
  })

  it("supports stopping and starting again with the same session", async () => {
    const first = await start()
    expect(await stopManagedRun(first)).toBe(true)
    const second = await start()
    expect(second.runId).not.toBe(first.runId)
    expect(second.currentSession?.threadId).toBe("origin")
    expect(dependencies.store!.getRun(first).snapshot?.status).toBe("cancelled")
  })

  it("routes manual cancellation to the new run without changing the old one", async () => {
    const run = await start()
    handleAutoModeAgentCancelled("origin")
    await vi.waitFor(() =>
      expect(dependencies.store!.getRun(run).snapshot?.status).toBe("cancelled")
    )
    expect(dependencies.store!.getRun(oldRun).snapshot?.cancellationReason).toBe("用户终止")
  })

  it("opens the picker when sessions are active but retains the submission gate", async () => {
    dependencies.active.mockReturnValue(true)
    expect(() =>
      validateManagedRunStart({ projectId: "project", featureId: "feature" })
    ).not.toThrow()
    await expect(start({ existingThreadId: undefined, workspacePath: root })).rejects.toThrow(
      "已有运行中的会话"
    )
  })
})
