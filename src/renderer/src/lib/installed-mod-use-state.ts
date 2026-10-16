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
  if (plugin.state === "needs-approval") return "已添加，待确认权限"
  if (plugin.state === "disabled") return "已添加，尚未启用"
  if (plugin.state === "invalid") return "已添加，需要修复"
  if (!enabled) return "已授权，当前未启用"
  if (readFailed || !view || view.workspace !== workspace) return "已授权，使用状态待核对"
  if (!view.enabled || !view.applicable) return "已授权，当前场景未使用"
  if (!view.active) return "按默认设置使用"
  const selected = view.active.capabilities.find((item) => item.pluginId === plugin.pluginId)
  if (!selected || (selected.components?.mode === "selected" && !selected.components.ids.length))
    return "已授权，未用于此聊天"
  if (selected.digest !== plugin.digest || view.issues.length) return "已选入常用搭配，配置需核对"
  return `已用于此聊天 · ${view.active.name}`
}
