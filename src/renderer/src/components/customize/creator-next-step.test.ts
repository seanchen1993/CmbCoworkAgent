import { describe, expect, it } from "vitest"
import type { DevelopmentStatus } from "../../../../shared/mods/development"
import { creatorNextStep } from "./creator-next-step"

const base = (): DevelopmentStatus => ({ threadId: "creator", workspace: "/author", enabled: true,
  mode: "creator", drafts: [], trials: [] })

describe("creator next action remains a factual projection", () => {
  it("does not invent a running creator from the existence of a draft", () => {
    const value = base()
    value.drafts = [{ id: "d", name: "report", revision: 2, digest: "new" }]
    expect(creatorNextStep(value).target).toBe("create")
    expect(creatorNextStep(value).title).not.toMatch(/正在|通过/)
  })
  it("does not inherit a passed receipt from another source or incomplete checks", () => {
    const value = base()
    value.projectTrial = { id: "trial", draftId: "d", name: "report", revision: 2,
      digest: "new", goal: "review", journey: {
        projectId: "run", creatorThreadId: "creator", workspace: "/trial", candidateDigest: "old",
        candidateCurrent: true, phase: "passed", canDeliver: true, operationsTruncated: false,
        diagnostics: [], stages: [{ id: "s", title: "review", status: "passed", artifacts: [], checks: [], sessions: [] }]
      } }
    expect(creatorNextStep(value).target).toBe("create")
    value.projectTrial.journey!.candidateDigest = "new"
    expect(creatorNextStep(value).target).toBe("delivery")
    value.projectTrial.journey!.operationsTruncated = true
    expect(creatorNextStep(value).target).toBe("trial")
  })
  it("treats retained installed and passed facts as history after the bound draft changes", () => {
    const value = base()
    value.projectTrial = { id: "retained", draftId: "draft", name: "report", revision: 1,
      digest: "old", goal: "review", journey: {
        projectId: "run", creatorThreadId: "creator", workspace: "/trial", candidateDigest: "old",
        candidateCurrent: false, phase: "passed", canDeliver: false, operationsTruncated: false,
        diagnostics: [], stages: [{ id: "s", title: "review", status: "passed", artifacts: [], checks: [], sessions: [] }]
      } }
    value.projectDelivery = { id: "saved", requestId: "retained", sourceDigest: "old", name: "saved-report",
      version: "1", digest: "package", phase: "installed", pluginId: "old-installed",
      canInstall: false, canExport: false }
    expect(creatorNextStep(value)).toMatchObject({ title: "历史版本已保存", target: "create" })
    expect(value.projectDelivery.pluginId).toBe("old-installed")
    value.projectTrial.journey!.candidateCurrent = true
    expect(creatorNextStep(value).title).toBe("当前版本已保存")
  })
  it("preserves a lost installation reply as reconciliation even with a previous plugin id", () => {
    const value = base()
    value.projectDelivery = { id: "save", requestId: "old", sourceDigest: "old", name: "report",
      version: "1", digest: "package", phase: "unknown", pluginId: "installed",
      canInstall: false, canExport: false }
    expect(creatorNextStep(value)).toMatchObject({ title: "保存结果待核对", target: "delivery" })
  })
  it("does not treat a prepared environment as a running or passed project", () => {
    const value = base()
    value.projectTrial = { id: "trial", draftId: "d", name: "report", revision: 1, digest: "new", goal: "review" }
    expect(creatorNextStep(value).title).toBe("项目候选已准备")
    expect(creatorNextStep(value).detail).toMatch(/填写下方的实际试用目标/)
  })
  it("keeps chat consent, actual trial and unknown effects distinct", () => {
    const value = base()
    value.trials = [{ componentId: "ui", draftId: "d", revision: 1, bundleDigest: "source",
      compiledDigest: "compiled", phase: "needs-approval", capabilities: ["ui.render"] }]
    expect(creatorNextStep(value).title).toBe("确认后即可在聊天试用")
    value.trials[0].phase = "active"
    expect(creatorNextStep(value).detail).toMatch(/不代表已通过/)
    value.trials[0].diagnostics = { unknownRequests: 1 }
    expect(creatorNextStep(value).title).toBe("试用结果待核对")
  })
  it("routes imported source dependencies and restored preparation to actual pending actions", () => {
    const value = base()
    value.sourceSet = { id: "source", title: "source", phase: "dependencies", dependencies: [
      { id: "dep", name: "dep", version: "1", digest: "source", phase: "prepared" }
    ] }
    expect(creatorNextStep(value)).toMatchObject({ title: "源码依赖待准备", target: "delivery" })
    value.sourceSet.phase = "needs-review"
    expect(creatorNextStep(value).title).toBe("源码准备需要重新核对")
    value.sourceSet.dependencies[0].phase = "unknown"
    expect(creatorNextStep(value)).toMatchObject({ title: "依赖安装结果待核对", target: "delivery" })
    value.sourceSet.phase = "cancelled"
    expect(creatorNextStep(value).target).toBe("create")
  })
  it("never promotes ready source records into trial success or current saved status", () => {
    const value = base()
    value.sourceSet = { id: "source", title: "source", phase: "ready", dependencies: [] }
    expect(creatorNextStep(value).target).toBe("create")
    value.projectTrial = { id: "trial", draftId: "draft", revision: 1, digest: "original", name: "test", goal: "test",
      journey: { projectId: "run", creatorThreadId: "creator", candidateDigest: "original", workspace: "/trial",
        candidateCurrent: false, phase: "passed", canDeliver: false, operationsTruncated: false, diagnostics: [], stages: [] } }
    expect(creatorNextStep(value)).toMatchObject({ title: "草稿已变化，需准备新候选", target: "create" })
  })
  it("prioritizes unknown outcomes over a new chat consent", () => {
    const value = base()
    value.trials = [{ componentId: "component", draftId: "draft", revision: 2, bundleDigest: "new",
      compiledDigest: "compiled", phase: "needs-approval", capabilities: [], diagnostics: { unknownRequests: 1 } }]
    expect(creatorNextStep(value).title).toBe("试用结果待核对")
  })
})
