import type { ClawProfile, ClawView } from "../../../shared/mods/claw"
import { resolveClawComponents } from "../../../shared/mods/claw-components"
import type { FunctionPluginStatus } from "../../../shared/mods/v2/commands"

export interface ChatClawEffectiveView {
  state: "selected" | "inherited" | "disabled" | "invalid" | "inapplicable"
  /** Saved session snapshot for diagnosis, including when it cannot take effect. */
  selected: ClawProfile | null
  /** Eligible session sources, not proof that a runtime has executed them. */
  plugins: FunctionPluginStatus[]
  issues: string[]
}

/** Presentation only. Never grants capabilities or changes the default inheritance policy. */
export function chatClawEffectiveView(view: ClawView): ChatClawEffectiveView {
  const selected = view.active
  const issues = [...view.issues]
  const plugins: FunctionPluginStatus[] = []
  const sources = selected
    ? selected.capabilities.flatMap((capability) => {
        const source = view.capabilities.find(
          (item) =>
            item.pluginId === capability.pluginId &&
            item.name === capability.name &&
            item.digest === capability.digest &&
            item.state === "ready"
        )
        if (!source) issues.push(`${capability.name} 已更改、禁用或未授权，请重新核对组合。`)
        return source ? [source] : []
      })
    : view.capabilities.filter((item) => item.state === "ready")
  for (const source of sources) {
    const selection =
      selected?.capabilities.find((item) => item.pluginId === source.pluginId)?.components ??
      (selected && source.components?.length
        ? { mode: "all" as const, ids: [], config: {} }
        : undefined)
    try {
      const components = resolveClawComponents(
        source.components ?? [],
        selection,
        view.usageContext ?? "chat"
      )
      if (source.components?.length && !components.length) continue
      plugins.push({ ...source, ...(source.components ? { components } : {}) })
    } catch {
      issues.push(`${source.name} 的组件选择或使用范围不适用于当前会话，请重新核对组合。`)
    }
  }
  const state = !view.applicable
    ? "inapplicable"
    : !view.enabled
      ? "disabled"
      : issues.length
        ? "invalid"
        : selected
          ? "selected"
          : "inherited"
  return {
    state,
    selected,
    plugins: state === "selected" || state === "inherited" ? plugins : [],
    issues: [...new Set(issues)]
  }
}
