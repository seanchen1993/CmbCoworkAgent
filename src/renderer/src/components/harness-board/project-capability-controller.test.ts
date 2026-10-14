import { describe, expect, it, vi } from "vitest"
import type { AppNotification } from "../../../../shared/app-notifications"
import type {
  HarnessRunDetailViewModel,
  HarnessRunNode
} from "../../../../shared/harness-board-types"
import {
  createProjectCapabilityController,
  projectCapabilityState,
  projectCapabilityUnavailable,
  type ProjectCapabilityActivity
} from "./project-capability-controller"

function node(id: string): HarnessRunNode {
  return {
    id,
    label: id,
    nodeStatus: "in_progress",
    status: { label: "进行中", uiKind: "active" },
    artifacts: [],
    hooks: []
  }
}

function detail(): HarnessRunDetailViewModel {
  return {
    project: { projectId: "project" },
    projectCapability: {
      status: "ready",
      manifest: {
        apiVersion: "devclaw.project/v1",
        name: "能力包",
        description: "中文说明",
        help: [],
        stages: [{ nodeId: "plan", guidance: "计划指导", before: ["需求"], after: ["评审"] }]
      }
    },
    workflow: {
      display: { mode: "ordered_nodes" },
      nodes: [
        {
          id: "plan",
          label: "plan",
          states: [
            {
              nodeStatus: "in_progress",
              nextAction: { slashSkill: "plan", userMessage: "继续计划" }
            }
          ]
        },
        {
          id: "code",
          label: "code",
          states: [
            {
              nodeStatus: "in_progress",
              nextAction: { slashSkill: "code", userMessage: "继续开发" }
            }
          ]
        }
      ]
    },
    run: {
      slug: "feature",
      currentNodeId: "plan",
      resolvedSessionWorkspacePath: "C:/project",
      nodes: [node("plan"), node("code")]
    },
    sessions: []
  } as unknown as HarnessRunDetailViewModel
}

function gate(featureId = "feature"): AppNotification {
  return {
    notificationId: "gate",
    type: "human_gate",
    kind: "decision",
    status: "pending",
    title: "确认",
    message: "确认",
    targets: ["app_view"],
    createdAt: "",
    updatedAt: "",
    payload: {
      projectId: "project",
      featureId,
      sourceThreadId: "approval-thread",
      humanGate: { hookId: "hook" }
    }
  }
}

function harness() {
  const scope = Symbol("feature")
  let currentScope = scope
  let canAct = true
  let activity: ProjectCapabilityActivity = { known: true }
  let latest = detail()
  let notifications: AppNotification[] = []
  const create = vi.fn<(detail: HarnessRunDetailViewModel) => Promise<string>>(
    async () => "created-thread"
  )
  const open = vi.fn()
  const showApproval = vi.fn()
  const message = vi.fn()
  const busy = vi.fn()
  const load = vi.fn(async () => ({ detail: latest, notifications }))
  const run = createProjectCapabilityController({
    isCurrent: (value) => currentScope === value,
    canAct: () => canAct,
    activity: () => activity,
    load,
    create,
    open,
    showApproval,
    message,
    busy
  })
  return {
    scope,
    run,
    create,
    open,
    showApproval,
    message,
    busy,
    load,
    setActivity: (value: ProjectCapabilityActivity) => {
      activity = value
    },
    setCanAct: (value: boolean) => {
      canAct = value
    },
    setLatest: (value: HarnessRunDetailViewModel) => {
      latest = value
    },
    setNotifications: (value: AppNotification[]) => {
      notifications = value
    },
    switchScope: () => {
      currentScope = Symbol("another feature")
    }
  }
}

describe("project capability projection", () => {
  it("keeps current actions independent from the inspected node and handles dynamic nodes", () => {
    const value = detail()
    value.run.nodes.push(node("dynamic-review"))
    const state = projectCapabilityState(value, "dynamic-review")
    expect(state.current?.id).toBe("plan")
    expect(state.selected?.id).toBe("dynamic-review")
    expect(state.nextAction?.slashSkill).toBe("plan")
    expect(state.guidance).toBeUndefined()
  })

  it("does not treat generated invalid files or historical success as current acceptance", () => {
    const value = detail()
    value.run.nodes[0].artifacts = [
      {
        id: "file",
        artifactLabel: "计划",
        artifactType: "file",
        path: "plan.md",
        required: true,
        artifactStatus: "generated",
        status: { label: "已生成", uiKind: "ok" },
        validation: { status: "invalid", message: "验收已过期" }
      }
    ]
    value.run.nodes[0].hooks = [
      {
        ts: "2026-10-09",
        source: "plugin",
        sessionId: "old",
        pluginId: "plugin",
        featureId: "feature",
        eventId: "check",
        eventStatus: "success",
        message: "历史成功",
        nodeId: "plan"
      }
    ]
    const state = projectCapabilityState(value)
    expect(state.issues[0].validation?.message).toBe("验收已过期")
    expect(state.hooks[0].eventStatus).toBe("success")
    expect(state.current?.nodeStatus).toBe("in_progress")
  })

  it("blocks legacy/missing/unknown/completed and instructionless snapshots", () => {
    const legacy = detail()
    delete legacy.projectCapability
    expect(projectCapabilityUnavailable(legacy)).toBeTruthy()
    const unknown = detail()
    unknown.run.currentNodeId = "absent"
    expect(projectCapabilityUnavailable(unknown)).toMatch(/无法确认/)
    const completed = detail()
    completed.run.featureStatus = "done"
    expect(projectCapabilityUnavailable(completed)).toMatch(/已完成/)
    const empty = detail()
    empty.workflow.nodes[0].states![0].nextAction = { dialogTips: "仅说明" }
    expect(projectCapabilityUnavailable(empty)).toMatch(/没有可准备/)
  })
})

describe("project capability actual action callbacks", () => {
  it("creates using refreshed current-stage action, not the stale view", async () => {
    const h = harness()
    const latest = detail()
    latest.run.currentNodeId = "code"
    latest.run.resolvedSessionWorkspacePath = "C:/fresh-workspace"
    h.setLatest(latest)
    await h.run(detail(), h.scope)
    expect(h.create).toHaveBeenCalledExactlyOnceWith(latest)
    expect(projectCapabilityState(h.create.mock.calls[0][0]).nextAction?.slashSkill).toBe("code")
    expect(h.open).toHaveBeenCalledExactlyOnceWith("created-thread")
  })

  it("allows completed stages with a configured transition instruction", async () => {
    const h = harness()
    const latest = detail()
    latest.run.nodes[0].nodeStatus = "done"
    latest.workflow.nodes[0].states = [
      {
        nodeStatus: "done",
        nextAction: { slashSkill: "autodev-specs", userMessage: "开始规格阶段" }
      }
    ]
    h.setLatest(latest)
    await h.run(detail(), h.scope)
    expect(h.create).toHaveBeenCalledExactlyOnceWith(latest)
    expect(projectCapabilityState(latest).nextAction?.slashSkill).toBe("autodev-specs")
  })

  it("clears busy when temporarily disabled during refresh and permits re-enabling", async () => {
    const h = harness()
    let release!: () => void
    h.load.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { detail: detail(), notifications: [] }
    })
    const pending = h.run(detail(), h.scope)
    h.setCanAct(false)
    release()
    await pending
    expect(h.create).not.toHaveBeenCalled()
    expect(h.busy).toHaveBeenLastCalledWith(false)
    h.setCanAct(true)
    await h.run(detail(), h.scope)
    expect(h.create).toHaveBeenCalledTimes(1)
  })

  it.each([
    { known: true, runningThreadId: "ordinary-thread" },
    { known: true, managedRunning: true, runningThreadId: "managed-thread" }
  ])("opens existing running conversation without creating a rival: %j", async (activity) => {
    const h = harness()
    h.setActivity(activity)
    await h.run(detail(), h.scope)
    expect(h.create).not.toHaveBeenCalled()
    expect(h.open).toHaveBeenCalledExactlyOnceWith(activity.runningThreadId)
  })

  it("uses fresh independent human-gate notifications and ignores other Features", async () => {
    const h = harness()
    h.setNotifications([gate("other-feature"), gate()])
    await h.run(detail(), h.scope)
    expect(h.create).not.toHaveBeenCalled()
    expect(h.showApproval).toHaveBeenCalledExactlyOnceWith("approval-thread")
    expect(h.open).not.toHaveBeenCalled()
  })

  it.each([
    { known: true, runningThreadId: "new-stream" },
    { known: true, gatePending: true, gateThreadId: "new-gate" }
  ])("rechecks activity that appears during refresh: %j", async (activity) => {
    const h = harness()
    let release!: () => void
    h.load.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { detail: detail(), notifications: [] }
    })
    const pending = h.run(detail(), h.scope)
    h.setActivity(activity)
    release()
    await pending
    expect(h.create).not.toHaveBeenCalled()
    expect(h.open.mock.calls.length + h.showApproval.mock.calls.length).toBe(1)
  })

  it("takes a synchronous lock against repeat clicks", async () => {
    const h = harness()
    let release!: () => void
    h.load.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { detail: detail(), notifications: [] }
    })
    const first = h.run(detail(), h.scope)
    await h.run(detail(), h.scope)
    expect(h.load).toHaveBeenCalledTimes(1)
    release()
    await first
    expect(h.create).toHaveBeenCalledTimes(1)
  })

  it("drops a refresh receipt after switching Feature", async () => {
    const h = harness()
    let release!: () => void
    h.load.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { detail: detail(), notifications: [] }
    })
    const pending = h.run(detail(), h.scope)
    h.switchScope()
    release()
    await pending
    expect(h.create).not.toHaveBeenCalled()
    expect(h.open).not.toHaveBeenCalled()
  })

  it("does not navigate a new Feature when old creation completes", async () => {
    const h = harness()
    h.create.mockImplementationOnce(async () => {
      h.switchScope()
      return "old-created-thread"
    })
    await h.run(detail(), h.scope)
    expect(h.open).not.toHaveBeenCalled()
  })

  it("fails closed when notifications/detail read fails, then permits a retry", async () => {
    const h = harness()
    h.load.mockRejectedValueOnce(new Error("通知读取失败"))
    await h.run(detail(), h.scope)
    expect(h.create).not.toHaveBeenCalled()
    expect(h.message).toHaveBeenCalledWith("通知读取失败")
    await h.run(detail(), h.scope)
    expect(h.create).toHaveBeenCalledTimes(1)
  })

  it("fails closed for unknown activity and mismatched snapshots", async () => {
    const h = harness()
    h.setActivity({ known: false })
    await h.run(detail(), h.scope)
    expect(h.create).not.toHaveBeenCalled()
    h.setActivity({ known: true })
    const wrong = detail()
    wrong.run.slug = "other"
    h.setLatest(wrong)
    await h.run(detail(), h.scope)
    expect(h.create).not.toHaveBeenCalled()
    expect(h.message).toHaveBeenLastCalledWith("详情已切换，请重新打开当前特性。")
  })
})
