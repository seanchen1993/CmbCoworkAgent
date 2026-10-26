import type { PluginStartUseIssue } from "../../shared/plugin-start-use"
import type { FunctionUserConfigView } from "../../shared/mods/v2/user-config-view"
import type { ProjectFunctionDependencyReview } from "../../shared/project-runtime/function-source"

/** Opening the form is allowed; execution still requires consent in its actual project directory. */
export function pluginStartUseDependencyIssues(
  dependencies: readonly ProjectFunctionDependencyReview[],
  workspace?: { enabled: boolean; globallyEnabled: boolean }
): PluginStartUseIssue[] {
  const reasons = {
    missing: "尚未安装", disabled: "已停用", "source-changed": "源码与项目锁定版本不符",
    invalid: "无法核对源码", "needs-approval": "尚未获得当前目录的运行授权", ready: ""
  }
  const issues: PluginStartUseIssue[] = dependencies.flatMap(dependency => {
    const reason = reasons[dependency.state] ||
      (dependency.configurationReady === false ? "必填配置或知识目录尚未就绪" : "")
    return reason ? [{
      code: "dependency" as const,
      message: `项目依赖 ${dependency.name}：${reason}。请进入项目原生依赖卡核对；新项目目录需要重新确认。`,
      resolution: "project-form" as const
    }] : []
  })
  if (dependencies.length && workspace && (!workspace.enabled || !workspace.globallyEnabled))
    issues.unshift({
      code: "permission",
      message: workspace.globallyEnabled
        ? "当前目录尚未启用依赖运行，请在项目原生依赖卡中明确确认；打开表单不会自动授权。"
        : "插件运行总开关已关闭，请先在原生设置中启用后重新核对项目依赖。",
      resolution: workspace.globallyEnabled ? "project-form" : "chat-settings"
    })
  // The full native project review retains every dependency; StartUse has a bounded issue schema.
  if (issues.length > 48) return [...issues.slice(0, 48), {
    code: "dependency", message: "还有其他依赖待核对，请进入项目表单查看完整依赖列表。",
    resolution: "project-form"
  }]
  return issues
}

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
