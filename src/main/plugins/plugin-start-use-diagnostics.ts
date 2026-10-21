import type { PluginStartUseIssue } from "../../shared/plugin-start-use"
import type { FunctionUserConfigView } from "../../shared/mods/v2/user-config-view"

/** Project only missing-field facts; credentials, directory values and labels stay native. */
export function pluginStartUseConfigurationIssues(
  view: FunctionUserConfigView
): PluginStartUseIssue[] {
  const missing = view.fields.filter(field => field.required && (
    !field.supported || (field.sensitive
      ? !["saved", "default"].includes(field.secretState ?? "unset")
      : field.value === undefined || field.value === "" ||
        (Array.isArray(field.value) && field.value.length === 0))
  ))
  const issues: PluginStartUseIssue[] = []
  if (missing.some(field => field.type === "directory")) issues.push({
    code: "knowledge",
    message: "必需的目录或知识绑定尚未配置，请在下方选择当前电脑上的有效目录后重新检查。",
    resolution: "plugin-settings"
  })
  if (missing.some(field => field.type !== "directory")) issues.push({
    code: "configuration",
    message: "仍有必填插件参数或凭据未就绪，请在下方原生配置区补齐后重新检查。",
    resolution: "plugin-settings"
  })
  if (view.migration) issues.push({
    code: "configuration",
    message: "当前插件配置版本需要迁移，请在原生配置区核对并确认迁移后重新检查。",
    resolution: "plugin-settings"
  })
  if (view.state === "failed" || view.state === "stopped") issues.push({
    code: "runtime",
    message: "原插件运行实例尚未就绪，请核对配置并从原生入口重新加载；进入创建表单不会恢复旧权限。",
    resolution: "chat-settings"
  })
  return issues
}
