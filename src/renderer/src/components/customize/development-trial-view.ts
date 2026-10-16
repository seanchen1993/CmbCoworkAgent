import type { DevelopmentTrialStatus } from "../../../../shared/mods/development"

/** Human-readable scope summaries never replace the actual approval capability set. */
export function developmentCapabilitySummary(capabilities: readonly string[]): string[] {
  const groups: Array<[string, readonly string[]]> = [
    [
      "在聊天中显示面板和提示",
      [
        "ui.open",
        "ui.close",
        "ui.panes",
        "ui.resolve",
        "ui.invalidate",
        "ui.log",
        "ui.status",
        "ui.toast",
        "event:ui.render"
      ]
    ],
    ["读取或保存此灵件的本地设置", ["store.get", "store.set", "store.keys", "store.delete"]],
    ["提供聊天快捷指令", ["command.register", "command.list", "event:command.run"]],
    ["查看和调整工具调用", ["event:tool.call"]],
    ["随聊天开始、每轮结束更新", ["event:session.start", "event:turn.complete"]],
    ["读取聊天用量和版本", ["session.usage", "session.version"]],
    ["读取当前时间", ["clock.time", "clock.now"]],
    ["读取当前目标的文件", ["fs.read", "fs.list", "fs.stat", "fs.exists", "fs.ancestors"]],
    ["修改当前目标的文件（仍需原有文件权限）", ["fs.write"]],
    ["访问网络服务（实际请求沿用原有权限）", ["http.fetch", "mcp.call"]],
    ["调用模型，可能产生费用", ["model.complete", "model.classify", "model.fork"]],
    ["运行本地进程或工具", ["process.run", "process.spawn", "tool.call", "command.run"]],
    ["创建运行期间的定时任务", ["clock.after", "clock.every", "clock.sleep"]],
    ["读取、订阅或操作已获准的业务能力", ["platform.list", "platform.read",
      "platform.subscribe", "platform.poll", "platform.unsubscribe", "platform.publish",
      "platform.act", "platform.cancel", "platform.status"]]
  ]
  const summary = groups
    .filter(([, members]) => capabilities.some((value) => members.includes(value)))
    .map(([label]) => label)
  if (
    capabilities.some((capability) => !groups.some(([, members]) => members.includes(capability)))
  )
    summary.push("其他权限（见完整列表）")
  return summary
}

export function developmentNextStep(row: DevelopmentTrialStatus): string {
  if (row.phase === "needs-approval") return "核对用途、当前目标和新增权限，再确认试用。"
  if (row.phase === "queued") return row.waitingReason === "turn-interrupted"
    ? "回到聊天继续完成制作；不会重放中断的操作。" : "等待当前任务安全结束，再刷新试用状态。"
  if (["preflight", "retiring"].includes(row.phase)) return "等待检查和旧版资源清理，不要重复启动。"
  if (row.phase === "unknown") return "刷新并核对实际结果；未知操作不会自动重试，当前不会启动新版。"
  if (row.phase === "failed") return row.activeRevision !== undefined
    ? `旧版 v${row.activeRevision} 仍可用。点击修复，助手会检查并重新制作。`
    : "点击修复，助手会读取具体原因并重新检查，无需复制错误信息。"
  if (row.phase === "stopped") return "试用已停止。继续修改时重新申请；重启应用不会自动恢复试用任务。"
  if ((row.diagnostics?.unknownRequests ?? 0) > 0)
    return "存在结果未知的真实调用，请先用状态读取核对；不要再次执行相同动作。"
  return row.validation === "authorized-real"
    ? "版本已生效。执行目标动作后读取实际状态核对效果；批准和安装本身不表示验证完成。"
    : "在当前聊天核对显示和操作效果，再保存使用。"
}

export function developmentFailureMessage(code?: string): string {
  if (code?.includes("MODS_RETURN_UNDEFINED"))
    return "启动代码缺少必要的返回结果，导致灵件未能启动。助手可以修正这段代码。"
  if (code?.includes("MODS_COMMAND_CONFLICT"))
    return "快捷指令与已启用的灵件重名。请让助手更换指令名称后再试。"
  if (code?.includes("MODS_DEVELOPMENT_CAPABILITY_DENIED"))
    return "启动时使用了本次未批准的权限。请让助手修正权限申请后再试。"
  if (code?.includes("MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED"))
    return "启动时执行了不支持的操作。请让助手调整启动代码后再试。"
  if (code?.includes("MODS_RUNTIME_LOST"))
    return "试用运行已断开。请让助手检查当前状态，再重新申请试用。"
  if (code?.includes("MODS_DEVELOPMENT_SOURCE_CHANGED"))
    return "草稿在启动前发生了变化。请让助手检查最新版本，再重新申请试用。"
  return "这个版本未能启动。请让助手检查原因、修改后再试用。"
}

export function developmentRepairPrompt(name: string, row: DevelopmentTrialStatus): string {
  const reason = developmentFailureMessage(row.error)
  const hint = row.error?.includes("MODS_RETURN_UNDEFINED")
    ? "重点检查 session.start 等中间件是否遗漏 return next(event)，不要只修改快捷指令名称。"
    : row.error?.includes("MODS_COMMAND_CONFLICT")
      ? "核对实际命令目录，仅修正已证实的重名命令。" : "按实际诊断定位原因，不要猜测指令重名或反复提交相同源码。"
  return `请修复这段聊天保存的灵件“${name}”第 ${row.revision} 版，保留原有功能和用户需求。当前结果：${reason}请先读取当前试用状态和最新草稿，获取准确诊断。${hint}修复后重新申请试用，最多尝试两次源码修复；仍失败请说明具体原因与可行调整。新增权限由我确认，结果未知的外部操作不要重放。不要把检查通过或排队称为已经生效。`
}
