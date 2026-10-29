import type { ClawView } from "../../../shared/mods/claw"
import type { FunctionPluginStatus } from "../../../shared/mods/v2/commands"

/** Installation, grants, target binding and execution are separate facts. */
export function installedModUseState(
  plugin: FunctionPluginStatus,
  workspace: string,
  enabled: boolean,
  view: ClawView | null,
  readFailed = false
): string {
  if (plugin.state === "needs-approval") return "首次使用需确认权限"
  if (plugin.state === "disabled") return "已停用"
  if (plugin.state === "invalid") return "需要修复"
  if (!enabled) return "灵件开关已关闭"
  if (readFailed || !view || view.workspace !== workspace) return "使用状态待核对"
  if (!view.enabled || !view.applicable) return "当前场景未使用"
  if (!view.active) return "按默认设置使用"
  const selected = view.active.capabilities.find((item) => item.pluginId === plugin.pluginId)
  if (!selected || (selected.components?.mode === "selected" && !selected.components.ids.length))
    return "未用于此聊天"
  if (selected.digest !== plugin.digest || view.issues.length) return "使用配置需核对"
  return `已用于此聊天 · ${view.active.name}`
}

/** The next step describes an action; it never stands in for runtime admission checks. */
export function installedModNextAction(
  enabled: boolean,
  plugin?: FunctionPluginStatus,
  modsEnabled = true
): "修复" | "启用" | "去使用" {
  if (plugin?.state === "invalid") return "修复"
  if (!enabled || plugin?.state === "disabled" || plugin?.state === "needs-approval") return "启用"
  if (plugin && !modsEnabled) return "启用"
  return "去使用"
}
