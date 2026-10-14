import type {
  HostProjectOperation,
  HostProjectState
} from "../../shared/project-runtime/host-types"
import type { ProjectActionLock } from "../../shared/project-runtime/action-bindings"
import type { ProjectActionResults } from "../../shared/project-runtime/action-results"
import type { ClawActionDescriptor } from "../../shared/mods/claw-actions"
import type { FlowRun } from "../../shared/mods/flows/types"
import { assertProjectActionProviders } from "./project-runtime/action-input"
import { runtimeDigest } from "./project-runtime/safe-files"
import { isSameWorkspacePath } from "../../shared/workspace-path"

/** Bounded projection of the existing Flow ledger. No execution, recovery, files or grants. */
export function projectActionResults(input: {
  project: HostProjectState
  operation: HostProjectOperation
  binding: unknown
  threadId: string
  lock: ProjectActionLock
  runs: readonly FlowRun[]
  catalog: readonly ClawActionDescriptor[]
}): ProjectActionResults {
  const { project, operation, threadId, lock } = input
  const binding = input.binding as Record<string, unknown> | null
  if (
    !binding ||
    binding.projectId !== project.projectId ||
    binding.operationId !== operation.operationId ||
    binding.stageId !== operation.stageId ||
    binding.pluginDigest !== project.pluginDigest ||
    operation.projectId !== project.projectId ||
    operation.pluginDigest !== project.pluginDigest ||
    operation.execution?.threadId !== threadId
  )
    throw Error("PROJECT_ACTION_RESULT_SCOPE_CHANGED")
  const stage = project.manifest.stages.find((item) => item.id === operation.stageId)
  if (!stage) throw Error("PROJECT_ACTION_RESULT_SCOPE_CHANGED")
  const flowId = `project-actions-${runtimeDigest(operation.operationId).slice(0, 24)}`
  const runs = input.runs.filter(
    (run) =>
      run.threadId === threadId &&
      isSameWorkspacePath(run.workspace, project.workspace) &&
      run.flow.definition.id === flowId
  )
  if (runs.length > 1) throw Error("PROJECT_ACTION_RESULT_AMBIGUOUS")
  const run = runs[0]
  let budget = 64 * 1024
  const actions = lock.bindings
    .filter((item) => stage.actionIds.includes(item.id))
    .map((item) => {
      const step = run?.flow.definition.steps.find((value) => value.id === item.id)
      if (
        run &&
        (!step ||
          step.kind !== "plugin-action" ||
          step.pluginId !== item.ref.pluginId ||
          step.plugin !== item.ref.plugin ||
          step.digest !== item.ref.digest ||
          step.actionId !== item.ref.actionId)
      )
        throw Error("PROJECT_ACTION_RESULT_PROVIDER_CHANGED")
      let authorizedNow = true
      try {
        assertProjectActionProviders({ ...lock, bindings: [item] }, input.catalog)
      } catch {
        authorizedNow = false
      }
      const attempt = run?.attempts.filter((value) => value.stepId === item.id).at(-1)
      const result = attempt?.result
      if (result?.provider && JSON.stringify(result.provider) !== JSON.stringify(item.ref)) {
        const actual = result.provider
        if (
          actual.pluginId !== item.ref.pluginId ||
          actual.plugin !== item.ref.plugin ||
          actual.digest !== item.ref.digest ||
          actual.actionId !== item.ref.actionId
        )
          throw Error("PROJECT_ACTION_RESULT_PROVIDER_CHANGED")
      }
      let truncated = false
      const text = (value: unknown, limit: number) => {
        const full = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2)
        const count = Math.min(limit, budget)
        const shown = full.slice(0, count)
        budget -= shown.length
        if (shown.length !== full.length) truncated = true
        return shown
      }
      return {
        id: item.id,
        plugin: item.ref.plugin,
        actionId: item.ref.actionId,
        providerDigest: item.ref.digest,
        authorizedNow,
        status: attempt?.status ?? "not-recorded",
        summary: authorizedNow && result ? text(result.summary, 2000) : null,
        output: authorizedNow && result?.output !== undefined ? text(result.output, 8192) : null,
        inputSchema: text(item.inputSchema, 4096),
        outputSchema: text(item.outputSchema, 4096),
        truncated
      }
    })
  return {
    projectId: project.projectId,
    operationId: operation.operationId,
    packageVersion: project.packageVersion,
    pluginDigest: project.pluginDigest,
    observedAt: Date.now(),
    flowStatus: run?.status ?? null,
    actions,
    message:
      "这是已保存的公开动作结果，不证明文件现在仍有效，也不授权再次执行。当前提供者未获准或版本不符时隐藏输出；请在目标工作目录确认原授权。"
  }
}
