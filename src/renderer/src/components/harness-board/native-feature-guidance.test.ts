import { describe, expect, it } from "vitest"
import type { HarnessRunDetailViewModel } from "../../../../shared/harness-board-types"
import type {
  HostOperationStatus,
  HostProjectOperation
} from "../../../../shared/project-runtime/host-types"
import {
  nativeFeatureChatGuide,
  nativeFeatureGuidance,
  nativeFeatureSessionLabel
} from "./native-feature-guidance"

function detail(status?: HostOperationStatus): HarnessRunDetailViewModel {
  return {
    project: { lifecycle: { status: "active" } },
    nativeBinding: { hostRunId: "generic-run" },
    workflow: { nodes: [{ id: "collect", label: "整理资料" }] },
    run: { currentNodeId: "collect" },
    ...(status
      ? {
          nativeProject: {
            project: {
              version: 2,
              stageIndex: 0,
              status: "active",
              manifest: { stages: [{ id: "collect", title: "整理资料", resultApproval: "human" }] }
            },
            operations: [{ stageId: "collect", expectedVersion: 2, status }]
          }
        }
      : {})
  } as HarnessRunDetailViewModel
}

describe("native feature guidance", () => {
  it("uses the final route, authored stage guide and generic fallback without changing the draft", () => {
    const value = detail()
    value.workflow.nodes[0].userGuide = "请准备客户资料。\n完成后查看报告。"
    expect(nativeFeatureChatGuide(value)).toMatchObject({
      userGuide: value.workflow.nodes[0].userGuide,
      route: "整理资料"
    })
    delete value.workflow.nodes[0].userGuide
    expect(nativeFeatureChatGuide(value)?.userGuide).toContain("验收要求")
  })
  it("reads the frozen version after stage transition, never the newer installed guide", () => {
    const value = detail("started")
    const project = value.nativeProject!.project
    value.workflow.nodes[0].userGuide = "新版说明，不应使用"
    project.manifest.stages[0].userGuide = "本次运行绑定的旧版说明"
    expect(nativeFeatureChatGuide(value)?.userGuide).toBe("本次运行绑定的旧版说明")
    project.manifest.stages.push({
      ...project.manifest.stages[0],
      id: "review",
      title: "审核",
      userGuide: "查看复核结论"
    })
    project.stageIndex = 1
    expect(nativeFeatureChatGuide(value)).toMatchObject({
      stage: "审核",
      userGuide: "查看复核结论",
      route: "整理资料 → 审核"
    })
    project.status = "completed"
    expect(nativeFeatureChatGuide(value)?.userGuide).toBeNull()
    delete value.nativeBinding
    expect(nativeFeatureChatGuide(value)).toBeNull()
  })
  it("identifies execution from the host ledger, not the current stage or installed plugin", () => {
    const value = detail("started")
    value.nativeProject!.operations[0].execution = { threadId: "host-thread", terminal: null }
    expect(nativeFeatureSessionLabel(value, "host-thread")).toBe("插件阶段执行会话 · 整理资料")
    expect(nativeFeatureSessionLabel(value, "manual-thread")).toContain("普通讨论会话")
    expect(nativeFeatureSessionLabel(detail(), "host-thread")).toContain("普通讨论会话")
  })
  it("guides any plugin to the existing start controls without inventing a slash skill", () => {
    expect(nativeFeatureGuidance(detail())).toMatchObject({ stage: "整理资料", action: "start" })
    const legacy = detail()
    delete legacy.nativeBinding
    expect(nativeFeatureGuidance(legacy)).toBeNull()
    expect(nativeFeatureGuidance(null)).toBeNull()
  })

  it.each([
    ["prepared", "执行确认"],
    ["started", "正在执行"],
    ["succeeded", "确认成果"],
    ["unknown", "待核对"],
    ["cancel_requested", "正在停止"],
    ["failed", "重新执行"],
    ["cancelled", "重新执行"]
  ] as const)("routes %s to existing review, never duplicate execution", (status, text) => {
    expect(nativeFeatureGuidance(detail(status))).toMatchObject({
      action: "review",
      message: expect.stringContaining(text)
    })
  })

  it("ignores old stages and versions, uses the latest attempt", () => {
    const value = detail("failed")
    const view = value.nativeProject!
    const operation = view.operations[0]
    view.operations.push(
      { ...operation, status: "started", stageId: "past" },
      { ...operation, status: "started", expectedVersion: 1 }
    )
    expect(nativeFeatureGuidance(value)?.message).toContain("重新执行")
    view.operations.unshift({ ...operation, status: "started" })
    expect(nativeFeatureGuidance(value)?.message).toContain("正在执行")
    view.operations = view.operations.filter((item) => item.expectedVersion === 1)
    expect(nativeFeatureGuidance(value)?.action).toBe("start")
  })

  it("routes input requests to the right session, answered requests to resume controls", () => {
    const value = detail("started")
    value.nativeProject!.inputWait = {
      operationId: "operation",
      requestId: "question",
      threadId: "answer-thread",
      status: "waiting",
      resumable: false
    }
    expect(nativeFeatureGuidance(value)).toMatchObject({
      action: "input",
      threadId: "answer-thread"
    })
    value.nativeProject!.inputWait.resumable = true
    expect(nativeFeatureGuidance(value)?.action).toBe("review")
  })

  it("does not present a rejected result as awaiting acceptance", () => {
    const value = detail("succeeded")
    value.nativeProject!.operations[0].resultApproval = {
      decision: "rejected"
    } as NonNullable<HostProjectOperation["resultApproval"]>
    expect(nativeFeatureGuidance(value)?.message).toContain("需要修改")
  })

  it("does not start completed, archived, or unresolved stages", () => {
    const value = detail("succeeded")
    value.nativeProject!.project.status = "completed"
    expect(nativeFeatureGuidance(value)?.message).toContain("所有阶段已完成")
    value.nativeProject!.project.status = "active"
    value.nativeProject!.project.stageIndex = 10
    expect(nativeFeatureGuidance(value)?.action).toBe("review")
    value.project.lifecycle!.status = "archived"
    expect(nativeFeatureGuidance(value)).toBeNull()
  })
})
