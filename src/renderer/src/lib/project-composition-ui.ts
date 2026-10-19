import {
  parseProjectComposition,
  type ProjectCompositionDefinition,
  type ProjectCompositionSource,
  type ProjectCompositionUnit
} from "../../../shared/project-runtime/composition"
import { isSameWorkspacePath } from "../../../shared/workspace-path"
import type {
  CompositionRun,
  ProjectCompositionApproval,
  ProjectCompositionApprovalInput,
  ProjectCompositionCatalogEntry,
  ProjectCompositionScope
} from "../../../shared/project-runtime/composition-api"

export function compositionErrorText(value: unknown): string {
  return value instanceof Error
    ? value.message
    : typeof value === "string"
      ? value
      : "操作未完成，请先核对当前状态。"
}

/** Explain next steps without turning an uncertain execution into permission to replay it. */
export function compositionProblem(
  value: unknown,
  status?: string
): {
  message: string
  nextStep?: string
  detail?: string
} {
  const raw = compositionErrorText(value)
  const codes = raw.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)?.join(" ") ?? ""
  const result = (message: string, nextStep: string) => ({ message, nextStep, detail: raw })
  if (
    status !== "unknown" &&
    /\bCOMPOSITION_(?:UNIT_UNKNOWN|EXECUTION_WORKSPACE_MISSING|WORKSPACE_OPEN_FAILED|WORKSPACE_OWNER_CHANGED)\b/.test(codes)
  )
    return result(
      "暂时无法打开本步骤的运行文件夹。",
      "先刷新运行状态；尚未开始的步骤可能还没有文件夹。已有文件夹无法打开时，请核对目录是否仍在原位置，不要重新启动任务。"
    )
  if (status === "unknown" || /UNKNOWN|UNCERTAIN|UNCOMMITTED/.test(codes))
    return result(
      "运行结果尚未确认。",
      "先查看原任务状态和已产生的结果，再核对恢复；不要直接重新启动可能已执行的操作。"
    )
  if (/\b(?:CAPABILITY_PACKAGE_TIMEOUT|COMPOSITION_CATALOG_BUSY)\b/.test(codes))
    return result(
      "能力目录核对暂时超时，最新状态尚未确认。",
      "原运行不会因这次核对超时而停止，已有记录已保留。请稍后刷新目录或核对运行状态，不要重新启动任务。"
    )
  if (!codes && /[\u3400-\u9fff]/.test(raw)) return { message: raw }
  if (/REJECT|DENIED|DENY/.test(codes))
    return result(
      "本次操作未获批准，流程没有继续。",
      "查看原审批记录；如需继续，请重新核对待执行内容并按原流程确认。"
    )
  if (/APPROVAL|AUTHORIZATION/.test(codes))
    return result(
      "当前审批或授权尚未确认有效。",
      "查看当前待确认事项，核对后重新作出决定；旧确认不能沿用。"
    )
  if (/ARTIFACT|OUTPUT|HANDOFF|INPUTS_CHANGED/.test(codes))
    return result(
      "结果文件或交接资料未通过核对。",
      "查看前序流程的检查记录和实际文件，修复缺失或变化的资料后再验证；后续流程暂不能使用这些结果。"
    )
  if (
    /CHECK|HOOK|NOT_COMPLETED|INCOMPLETE|COMPLETE_(?:UNVERIFIED|PROOF_REQUIRED)/.test(codes) &&
    !/ADAPTER/.test(codes)
  )
    return result(
      "原流程还有未完成或未核实的检查。",
      "查看原流程的阶段和检查记录，完成所需验证后再核对运行结果；助手回复完成不能代替检查。"
    )
  if (/SCOPE|CONTEXT|PROJECT_REQUIRED|THREAD_CHANGED|OWNED_WORKSPACE/.test(codes))
    return result(
      "当前项目或会话与这次配置不一致。",
      "回到目标项目重新打开“项目能力”，核对当前选择和已有运行。"
    )
  if (
    /SOURCE|CATALOG|PREVIEW|STALE|REVISION|VERSION_CONFLICT|CONTRACT_CHANGED|ENGINE_ID_CHANGED/.test(
      codes
    )
  )
    return result(
      "插件来源、配置或运行状态已变化。",
      "刷新目录并重新预览选择；已有运行请先核对状态，不要直接再次启动。"
    )
  if (/BUSY|LEASE|LOCKED/.test(codes))
    return result(
      "项目已有任务占用，暂时不能开始这次操作。",
      "先查看当前运行，等待它结束；需要停止时请使用原取消入口。"
    )
  if (/UNSUPPORTED|ADAPTER|DECLARATION_REQUIRED|ENTRY_MISSING/.test(codes))
    return result(
      "这个插件暂不满足完整流程组合的要求。",
      "查看插件的兼容说明；未支持的旧版本继续从原项目入口使用。"
    )
  return result("这次操作未能完成。", "先核对项目、原流程记录和已有结果；需要排查时展开技术详情。")
}

export function compositionApprovalInput(
  scope: ProjectCompositionScope,
  run: Pick<CompositionRun, "id" | "version">,
  approval: ProjectCompositionApproval,
  decision: "approved" | "rejected"
): ProjectCompositionApprovalInput {
  const common = { scope, runId: run.id, unitId: approval.unitId, decision }
  return approval.kind === "legacy-human-gate"
    ? { ...common, kind: approval.kind, gateId: approval.gateId, expectedVersion: run.version }
    : {
        ...common,
        operationId: approval.operationId,
        expectedVersion: approval.operationVersion,
        inputFingerprint: approval.inputFingerprint
      }
}

export interface ProjectCompositionDraft {
  definition: ProjectCompositionDefinition
  labels: Record<string, string>
}
export const compositionSourceKey = (source: ProjectCompositionSource) =>
  JSON.stringify([source.pluginId, source.capabilityId, source.packageDigest])
export const compositionScopeKey = (scope: ProjectCompositionScope) =>
  JSON.stringify([scope.projectId, scope.threadId, scope.expectedWorkspace])
export const compositionDraftKey = (scope: ProjectCompositionScope) =>
  `project-composition-draft-v1:${compositionScopeKey(scope)}`

export function emptyCompositionDraft(scope: ProjectCompositionScope): ProjectCompositionDraft {
  return {
    definition: {
      apiVersion: "devclaw.project-composition/v1",
      parentProjectId: scope.projectId,
      workspace: scope.expectedWorkspace,
      units: []
    },
    labels: {}
  }
}

export function readCompositionDraft(
  scope: ProjectCompositionScope,
  text: string | null
): ProjectCompositionDraft {
  if (!text) return emptyCompositionDraft(scope)
  if (text.length > 128 * 1024) throw Error("草稿超出大小限制，请保留后重新配置。")
  const value = JSON.parse(text) as ProjectCompositionDraft
  if (
    !value?.definition ||
    value.definition.parentProjectId !== scope.projectId ||
    value.definition.workspace !== scope.expectedWorkspace ||
    !Array.isArray(value.definition.units) ||
    value.definition.apiVersion !== "devclaw.project-composition/v1" ||
    !value.labels ||
    typeof value.labels !== "object" ||
    Array.isArray(value.labels)
  )
    throw Error("草稿不属于当前项目，未加载该配置。")
  const definition = value.definition.units.length
    ? parseProjectComposition(value.definition)
    : {
        ...emptyCompositionDraft(scope).definition,
        ...(typeof value.definition.goal === "string" &&
        value.definition.goal.trim() &&
        value.definition.goal.length <= 16000
          ? { goal: value.definition.goal }
          : {})
      }
  const labels: Record<string, string> = {}
  for (const unit of definition.units) {
    const label = value.labels[unit.id]
    if (typeof label === "string" && label.length <= 512) labels[unit.id] = label
  }
  return { definition, labels }
}

export function addCompositionEntry(
  draft: ProjectCompositionDraft,
  entry: ProjectCompositionCatalogEntry,
  unitId: string
): ProjectCompositionDraft {
  if (!entry.available) throw Error("此能力尚未通过宿主验证，请查看不可用原因。")
  if (draft.definition.units.length >= 16) throw Error("一个组合最多包含 16 个执行单元。")
  const unit: ProjectCompositionUnit = {
    id: unitId,
    kind: entry.kind,
    source: { ...entry.source },
    inputs: [],
    outputs: entry.outputs.map(({ id, path }) => ({ id, path }))
  }
  const definition = parseProjectComposition({
    ...draft.definition,
    units: [...draft.definition.units, unit]
  })
  return {
    definition,
    labels: { ...draft.labels, [unitId]: `${entry.title} · ${entry.sourceName}` }
  }
}

/** Reordering/removing a producer never silently drops a user's handoff. */
export function changeCompositionOrder(
  draft: ProjectCompositionDraft,
  units: ProjectCompositionUnit[]
): ProjectCompositionDraft {
  try {
    if (units.length) parseProjectComposition({ ...draft.definition, units })
  } catch {
    throw Error("该步骤已被后续步骤用于资料交接。请先调整交接，再移除或改变顺序。")
  }
  return { ...draft, definition: { ...draft.definition, units } }
}

export function compositionDraftIssues(
  draft: ProjectCompositionDraft,
  entries: ProjectCompositionCatalogEntry[]
): string[] {
  if (!draft.definition.units.length) return ["请添加至少一项能力或完整流程。"]
  const issues: string[] = draft.definition.goal?.trim() ? [] : ["请填写这次要完成的任务。"]
  for (const unit of draft.definition.units) {
    const entry = entries.find(
      (item) => compositionSourceKey(item.source) === compositionSourceKey(unit.source)
    )
    const label = draft.labels[unit.id] ?? "已选能力"
    if (unit.kind !== "flow") {
      issues.push(`${label}：独立能力请在“对话中使用”区域配置，原草稿已保留。`)
      continue
    }
    if (!entry?.available) {
      issues.push(`${label}：来源已变化或暂不可用，请重新核对；原选择已保留。`)
      continue
    }
    for (const input of entry.inputs)
      if (input.required && !unit.inputs.some((item) => item.inputId === input.id))
        issues.push(`${label}：请指定“${input.title}”从哪个前序步骤取得。`)
  }
  return issues
}

export function compositionRunLabel(run: CompositionRun): string {
  if (run.configurationPending) return "等待配置参数与授权"
  if (
    run.status === "succeeded" &&
    (run.units.length !== run.definition.units.length ||
      !run.units.length ||
      run.units.some((unit) => unit.status !== "succeeded" || !unit.proof))
  )
    return "完成结果待核对"
  return {
    running: "执行中",
    "waiting-approval": "等待原流程确认",
    succeeded: "已完成",
    failed: "执行失败",
    "cancel-requested": "正在取消",
    cancelled: "已取消",
    unknown: "恢复待确认"
  }[run.status]
}

export function compositionRunBelongsTo(
  run: CompositionRun,
  scope: ProjectCompositionScope
): boolean {
  return (
    run.definition.parentProjectId === scope.projectId &&
    isSameWorkspacePath(run.definition.workspace, scope.expectedWorkspace)
  )
}
