import type { CreatorProjectTrialJourney } from "../../../shared/mods/creator-trial-journey"
import type {
  HostProjectOperation,
  HostProjectState
} from "../../../shared/project-runtime/host-types"
import { isSameWorkspacePath } from "../../../shared/workspace-path"

/** Durable observation binding only. Never use this reference to admit a project run. */
export interface CreatorTrialProjectReference {
  requestId: string
  draftId: string
  revision: number
  candidateDigest: string
  projectId: string
  installedPluginId: string
  pluginDigest: string
  workspace: string
}

export function projectCreatorTrialJourney(input: {
  reference: CreatorTrialProjectReference
  creatorThreadId: string
  candidateCurrent: boolean
  project?: HostProjectState
  operations: readonly HostProjectOperation[]
  operationLimit?: number
}): CreatorProjectTrialJourney {
  const { reference, project } = input
  const empty: CreatorProjectTrialJourney = {
    projectId: reference.projectId,
    creatorThreadId: input.creatorThreadId,
    candidateDigest: reference.candidateDigest,
    candidateCurrent: input.candidateCurrent,
    workspace: reference.workspace,
    phase: "unknown",
    canDeliver: false,
    operationsTruncated: input.operations.length >= (input.operationLimit ?? 100),
    diagnostics: [],
    stages: []
  }
  if (
    !project ||
    project.projectId !== reference.projectId ||
    project.installedPluginId !== reference.installedPluginId ||
    project.pluginDigest !== reference.pluginDigest ||
    !isSameWorkspacePath(project.workspace, reference.workspace) ||
    input.operations.some(
      (operation) =>
        operation.projectId !== reference.projectId ||
        operation.pluginDigest !== reference.pluginDigest
    )
  ) {
    empty.diagnostics.push("原试用项目或来源绑定不可核对；未借用其他项目的结果。")
    return empty
  }
  const stages = project.manifest.stages.map((stage, index) => {
    const operations = input.operations
      .filter((operation) => operation.stageId === stage.id)
      .sort(
        (left, right) =>
          right.createdAt - left.createdAt ||
          right.updatedAt - left.updatedAt ||
          right.operationId.localeCompare(left.operationId)
      )
    const operation = operations[0]
    const checks = stage.checkIds.map((id) => {
      const check = project.manifest.checks.find((value) => value.id === id)!
      const receipt = operation?.receipts.find(
        (value) =>
          value.checkId === id &&
          value.operationId === operation.operationId &&
          value.projectId === project.projectId &&
          value.stageId === stage.id &&
          value.pluginDigest === project.pluginDigest &&
          value.inputFingerprint === operation.inputFingerprint
      )
      return {
        id,
        artifactId: check.artifactId,
        result: receipt?.result ?? ("unknown" as const),
        ...(receipt
          ? { checkedAt: receipt.checkedAt, validatorVersion: receipt.validatorVersion }
          : {})
      }
    })
    const passed = checks.every((check) => check.result === "passed")
    const status: CreatorProjectTrialJourney["stages"][number]["status"] = !operation
      ? index < project.stageIndex || project.status === "completed"
        ? "unknown"
        : "pending"
      : operation.status === "transitioned" && passed
        ? "passed"
        : ["started", "cancel_requested"].includes(operation.status)
          ? "running"
          : operation.status === "prepared"
            ? stage.approval === "human" && operation.approval?.decision !== "approved"
              ? "needs-approval"
              : "ready"
            : operation.status === "succeeded" && passed
              ? stage.resultApproval === "human" && operation.resultApproval?.decision !== "approved"
                ? "needs-approval"
                : "checks-passed"
              : operation.status === "failed" ||
                  operation.status === "cancelled" ||
                  checks.some((check) => check.result === "failed" || check.result === "blocked")
                ? "failed"
                : "unknown"
    return {
      id: stage.id,
      title: stage.title,
      status,
      artifacts: stage.artifactIds.map((id) => {
        const artifact = project.manifest.artifacts.find((value) => value.id === id)!
        return { id, path: artifact.path, required: artifact.required }
      }),
      checks,
      sessions: operations.flatMap((value) =>
        value.execution
          ? [
              {
                threadId: value.execution.threadId,
                operationId: value.operationId,
                status: value.status,
                ...(value.execution.terminal
                  ? { terminalOutcome: value.execution.terminal.outcome }
                  : {})
              }
            ]
          : []
      )
    }
  })
  const unverified = stages.some(
    (stage) =>
      !stage.checks.length ||
      stage.artifacts.some(
        (artifact) =>
          artifact.required && !stage.checks.some((check) => check.artifactId === artifact.id)
      )
  )
  const allPassed = stages.length > 0 && stages.every((stage) => stage.status === "passed")
  const current = stages[project.stageIndex]
  const phase: CreatorProjectTrialJourney["phase"] =
    project.status === "completed"
      ? allPassed && !unverified && !empty.operationsTruncated
        ? "passed"
        : "unknown"
      : current?.status === "running"
        ? "running"
        : current?.status === "needs-approval"
          ? "needs-approval"
          : current?.status === "ready"
            ? "ready"
            : current?.status === "checks-passed"
              ? "needs-transition"
              : current?.status === "failed"
                ? "failed"
                : current?.status === "unknown"
                  ? "unknown"
                  : "not-started"
  return {
    ...empty,
    phase,
    stages,
    canDeliver: phase === "passed" && input.candidateCurrent,
    diagnostics: [
      "各阶段使用独立执行会话；本制作会话统一核对原项目、阶段、会话和原生检查回执。",
      "检查结果对应当时读取的产物；模型回复完成不代表验收通过，也不替代业务效果评审。",
      ...(!input.candidateCurrent ? ["草稿已修改；这些结果属于旧版本，当前版本须重新试用。"] : []),
      ...(empty.operationsTruncated
        ? ["原执行记录超过展示上限，证据不完整，不能认定整体验收通过。"]
        : []),
      ...(unverified ? ["部分阶段或必需产物没有声明检查；不能认定业务验收完整。"] : [])
    ]
  }
}
