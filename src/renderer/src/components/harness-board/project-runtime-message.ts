/** Shared recovery wording for both project entry points; technical details remain expandable. */
export function projectRuntimeRecoveryMessage(error: string): string | undefined {
  if (error.includes("PROJECT_LEGACY_RUNTIME_UNAVAILABLE"))
    return "项目运行记录暂时无法读取，不能核实先前的执行状态，项目执行已暂停。普通聊天仍可使用。请重启应用后更新记录；如仍失败，请将问题详情交给维护者修复。"
  if (error.includes("PROJECT_WORKSPACE_MODE_CONFLICT"))
    return "此工作目录已用于另一种项目运行方式。请继续使用已绑定的项目，或为新项目选择另一个目录；系统不会合并或迁移现有成果。"
  return undefined
}
