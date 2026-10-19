import type { ClawProfile } from "./claw"
import type { ClawActionDescriptor } from "./claw-actions"
import type { FunctionPluginStatus } from "./v2/commands"
import type { ModObject } from "./types"
import { resolveClawComponents } from "./claw-components"
import type { FlowDefinition } from "./flows/types"

/** Produces an editable proposal. Existing approval and save endpoints remain authoritative. */
export function planClawUpgrade(
  original: ClawProfile,
  available: FunctionPluginStatus[],
  actions: ClawActionDescriptor[],
  validate: (value: ModObject, schema?: ModObject, providedFields?: string[]) => string | undefined,
  pendingDefinition?: FlowDefinition | null
): { profile: ClawProfile; flow?: FlowDefinition; issues: string[]; changes: string[] } {
  const profile = structuredClone(original)
  const issues: string[] = []
  const changes: string[] = []
  for (const item of profile.capabilities) {
    const current = available.find(
      (source) => source.pluginId === item.pluginId && source.name === item.name
    )
    if (!current || current.state !== "ready" || !current.digest) {
      issues.push(`${item.name}：请先安装并授权当前版本`)
      continue
    }
    if (item.digest !== current.digest) {
      changes.push(`${item.name}：采用已授权的新版本，保留组件和参数`)
      item.digest = current.digest
      for (const rule of profile.completionRules ?? [])
        if (rule.pluginId === item.pluginId) rule.digest = current.digest
    }
    try {
      for (const component of resolveClawComponents(current.components ?? [], item.components)) {
        const error = validate(item.components?.config[component.id] ?? {}, component.configSchema)
        if (error) issues.push(`${item.name}/${component.name}：${error}`)
      }
    } catch (error) {
      issues.push(`${item.name}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  let flow: FlowDefinition | undefined
  const definition = pendingDefinition === undefined ? original.flow?.definition : pendingDefinition
  if (definition) {
    const candidate = structuredClone(definition)
    for (const step of candidate.steps) {
      if (step.kind !== "plugin-action") continue
      const capability = profile.capabilities.find(
        (item) => item.pluginId === step.pluginId && item.name === step.plugin
      )
      const action = actions.find(
        (item) =>
          item.pluginId === step.pluginId &&
          item.plugin === step.plugin &&
          item.actionId === step.actionId &&
          item.digest === capability?.digest
      )
      if (!action) {
        if (step.enabled)
          issues.push(`${step.name}：动作已移除或当前来源未授权，请在流程中重新选择`)
        continue
      }
      const source = available.find((item) => item.pluginId === step.pluginId)
      try {
        if (
          source?.components?.length &&
          !resolveClawComponents(source.components, capability?.components).some((item) =>
            item.actionIds.includes(step.actionId)
          )
        )
          issues.push(`${step.name}：动作所属组件未加入组合`)
      } catch {
        /* The capability issue already explains invalid selection. */
      }
      const error =
        (!step.inputFrom &&
          validate(
            step.input,
            action.inputSchema,
            step.evidenceInput ? [step.evidenceInput.field] : undefined
          )) ||
        validate(step.config ?? {}, action.configSchema)
      if (step.enabled && error) issues.push(`${step.name}：${error}`)
      if (step.digest !== action.digest) {
        step.digest = action.digest
        flow = candidate
        changes.push(`${step.name}：需要保存新的流程副本`)
      }
    }
  }
  return { profile, flow, issues, changes }
}
