/** Only the native pre-admission busy code proves this user intent has not started. */
export function sourceSetFailureCode(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : ""
  if (/^[A-Z][A-Z0-9_]+$/.test(message)) return message
  const wrapped =
    /^Error invoking remote method 'mods:development:(?:import-source-set|advance-source-set|cancel-source-set|install-source-set-dependency|reconcile-source-set-dependency)': Error: ([A-Z][A-Z0-9_]+)$/.exec(
      message
    )
  return wrapped?.[1] ?? "SOURCE_SET_PREPARATION_FAILED"
}

export async function runSourceSetWhenIdle<T>(
  work: () => Promise<T>,
  assertCurrent: () => void,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<T> {
  const delays = [75, 125, 200, 300, 400]
  for (let attempt = 0; ; attempt++) {
    assertCurrent()
    try {
      const result = await work()
      assertCurrent()
      return result
    } catch (error) {
      const delay = delays[attempt]
      if (sourceSetFailureCode(error) !== "SOURCE_SET_BUSY" || delay === undefined) throw error
      await wait(delay)
      assertCurrent()
    }
  }
}

export function sourceSetError(code: string): string {
  if (code === "SOURCE_SET_BUSY")
    return "本次操作尚未开始，原操作仍在结束处理中。请稍后再试；依赖尚未重新安装。"
  if (/DESCRIPTOR_REQUIRED|NATIVE_SOURCE_REQUIRED/.test(code))
    return "所选目录缺少作者源码集合声明或项目组合源。请选择包含 devclaw.source-set.json 的完整交付目录。"
  if (
    /PATH_|ROOT_UNSAFE|LOCAL_CONFIGURATION|PURE_SOURCE|FUNCTION_DEPENDENCY|TOTAL_LIMIT/.test(code)
  )
    return "此源码集合包含不支持的路径、连接配置或超限内容。请作者提供普通目录内的完整项目和独立能力源码，移除本机配置。"
  if (/INSTALLED_CONFLICT|DEPENDENCY_AMBIGUOUS/.test(code))
    return "已安装同名能力与此来源不同，或来源不唯一。请在插件管理中核对版本，或请作者使用独立名称；系统不会覆盖现有插件。"
  if (/AUTHORIZATION|PROVIDER_UNRESOLVED/.test(code))
    return "依赖尚未启用、授权或无法唯一匹配。请打开对应依赖的使用条件，完成原生权限确认及必要配置，再点击核对权限。"
  if (/UNKNOWN|UNCONFIRMED|NOT_UNKNOWN/.test(code))
    return "上次操作的实际结果尚未确认。请使用对应依赖的“核对实际安装结果”；确认前不会重复安装。"
  if (/CHANGED|CANCELLED|REVISION/.test(code))
    return "来源、权限或当前聊天已变化。请回到原聊天核对；如需换用新源码，可结束本次准备后重新选择。已安装依赖会保留。"
  if (/LIMIT/.test(code))
    return "本次源码或草稿版本已达限额。请保留现有源码与记录，结束本次准备后选择新的作者源码；系统不会删除历史。"
  if (/DEPENDENCIES_PENDING|INSTALL_REVIEW_REQUIRED/.test(code))
    return "请先逐项确认依赖安装。已经安装的依赖仍需在其原生使用条件中检查权限。"
  if (/BUSY|PENDING/.test(code))
    return "当前准备或运行尚未结束。请等待原操作完成；如不再使用此来源，可先结束准备，未知安装必须先核对。"
  return "源码准备未完成。请核对完整目录、项目声明与作者提供的依赖；原安装和授权事实均已保留。"
}
