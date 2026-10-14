import { createHash } from "node:crypto"
import { isAbsolute, resolve } from "node:path"
import type { HarnessRunDetailViewModel } from "../../../shared/harness-board-types"
import { resolveHarnessNextAction } from "../../../shared/harness-run-next-action"
import {
  PROJECT_RUNTIME_API_VERSION,
  type ProjectRuntimeBinding,
  type ProjectRuntimeSnapshot,
  type ProjectRuntimePreparedAction
} from "../../../shared/project-runtime"

function assertBinding(detail: HarnessRunDetailViewModel, binding: ProjectRuntimeBinding): void {
  const workspace = detail.run.resolvedSessionWorkspacePath || detail.project.workspacePath
  if (
    !binding.projectId ||
    !binding.featureId ||
    !binding.pluginId ||
    binding.projectId !== detail.project.projectId ||
    binding.featureId !== detail.run.slug ||
    !isAbsolute(binding.workspace) ||
    !isAbsolute(workspace) ||
    resolve(binding.workspace) !== resolve(workspace) ||
    detail.adapterSnapshot.mock ||
    (binding.pluginDigest !== null && !/^[a-f0-9]{64}$/.test(binding.pluginDigest))
  ) {
    throw new Error("PROJECT_RUNTIME_BINDING_MISMATCH")
  }
}

/** No I/O. The caller supplies detail and plugin identity resolved by the existing host. */
export function projectLegacyRuntimeSnapshot(
  detail: HarnessRunDetailViewModel,
  binding: ProjectRuntimeBinding
): ProjectRuntimeSnapshot {
  assertBinding(detail, binding)
  const stages: ProjectRuntimeSnapshot["stages"] = detail.run.nodes.map((node) => ({
    id: node.id,
    title: node.label,
    status: node.nodeStatus,
    artifacts: node.artifacts.map((artifact) => ({
      id: artifact.id,
      paths: [...new Set([...(artifact.path ? [artifact.path] : []), ...(artifact.paths ?? [])])],
      required: artifact.required,
      presence:
        artifact.exists === true ? "present" : artifact.exists === false ? "missing" : "unknown",
      validation: artifact.validation?.status ?? "unknown"
    }))
  }))
  const evidence: ProjectRuntimeSnapshot["evidence"] = detail.run.nodes.flatMap((node) =>
    node.hooks
      .filter(
        (hook) =>
          hook.featureId === binding.featureId &&
          hook.pluginId === binding.pluginId &&
          hook.nodeId === node.id
      )
      .map((hook) => ({
        id: createHash("sha256")
          .update(JSON.stringify([binding, node.id, hook]))
          .digest("hex"),
        stageId: node.id,
        source: "legacy-hook" as const,
        validity: "unknown" as const,
        historicalStatus: hook.eventStatus,
        timestamp: hook.ts
      }))
  )
  const observationFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        binding,
        currentStageId: detail.run.currentNodeId,
        stages,
        evidence,
        featureStatus: detail.run.featureStatus,
        workflow: detail.workflow,
        managedRun: detail.run.managedRun
      })
    )
    .digest("hex")
  return {
    apiVersion: PROJECT_RUNTIME_API_VERSION,
    binding: { ...binding },
    stateOwner: "plugin",
    currentStageId: detail.run.currentNodeId,
    observationFingerprint,
    stages,
    evidence,
    support: {
      snapshot: true,
      prepareAction: true,
      startAction: false,
      requestTransition: false,
      cancel: false,
      reconcile: false
    }
  }
}

/** Advisory plan only: activity and approval must be rechecked by the original session entry. */
export function prepareLegacyRuntimeAction(
  detail: HarnessRunDetailViewModel,
  binding: ProjectRuntimeBinding,
  expectedObservationFingerprint?: string
): ProjectRuntimePreparedAction {
  const snapshot = projectLegacyRuntimeSnapshot(detail, binding)
  if (
    expectedObservationFingerprint !== undefined &&
    snapshot.observationFingerprint !== expectedObservationFingerprint
  )
    return { status: "blocked", reason: "项目状态已变化，请刷新后重新准备。" }
  if (["done", "skipped", "archived"].includes(detail.run.featureStatus ?? ""))
    return { status: "blocked", reason: "此特性已完成或归档。" }
  if (
    detail.run.managedRun?.status === "running" ||
    detail.run.managedRun?.corrupt ||
    detail.run.managedRun?.status === "corrupt"
  )
    return { status: "blocked", reason: "请先查看已有托管运行。" }
  if (!detail.run.resolvedSessionWorkspacePath)
    return { status: "blocked", reason: "当前特性尚无可用会话工作目录。" }
  const current = detail.run.nodes.find((node) => node.id === detail.run.currentNodeId)
  if (!current || current.nodeStatus === "unknown")
    return { status: "blocked", reason: "无法确认当前阶段。" }
  const action = resolveHarnessNextAction(detail.workflow, current.id, current.nodeStatus)
  if (!action?.slashSkill && !action?.userMessage)
    return { status: "blocked", reason: "当前阶段没有可准备的原会话指令。" }
  return {
    status: "prepared",
    kind: "legacy-session",
    binding: snapshot.binding,
    stageId: current.id,
    observationFingerprint: snapshot.observationFingerprint,
    ...(action.slashSkill ? { slashSkill: action.slashSkill } : {}),
    ...(action.userMessage ? { userMessage: action.userMessage } : {}),
    ...(action.dialogTips ? { dialogTips: action.dialogTips } : {}),
    ...(action.preferredPlugin ? { preferredPlugin: { ...action.preferredPlugin } } : {}),
    execution: "existing-session-entry"
  }
}
