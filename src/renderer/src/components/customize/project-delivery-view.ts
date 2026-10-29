import type { DevelopmentProjectTrialRequest } from "../../../../shared/mods/development"

/** Initialization only. A native saved name or an already edited input is never re-derived. */
export function projectDeliveryInitialName(
  request?: Pick<DevelopmentProjectTrialRequest, "id" | "name" | "draftId">,
  retainedName?: string
): string {
  if (retainedName !== undefined) return retainedName
  const base = [request?.name, request?.draftId].find(value =>
    typeof value === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(value))
  if (base) return `${base.slice(0, 41).replace(/-+$/, "")}-custom`
  const suffix = request?.id.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-8) || "custom"
  return `my-plugin-${suffix}`
}

/** Public recovery guidance only; native delivery remains the operation authority. */
export function projectDeliveryError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : ""
  if (/PROJECT_DELIVERY_(OUTCOME_UNCONFIRMED|INSTALL_UNCONFIRMED|EXPORT_UNCONFIRMED)/.test(message))
    return "上一次交付结果尚未确认。请点击“核对实际交付结果”；系统只核实已有结果，不会自动重试安装或导出。不要重复提交未知操作。"
  if (message.includes("PROJECT_DELIVERY_EXPORT_TARGET_EXISTS"))
    return "所选位置已有 ZIP 文件，原文件未覆盖。请重新导出并选择新的文件名。"
  if (message.includes("PROJECT_DELIVERY_NAME_ALREADY_INSTALLED"))
    return "此名称已被已安装插件使用。请填写新的独立插件标识，再准备保存；原插件保留。"
  if (message.includes("PROJECT_DELIVERY_IDENTITY_INVALID"))
    return "新插件标识或版本格式不符合要求。请使用英文字母、数字和短横线填写标识，并填写有效版本后重新准备。"
  if (/PROJECT_DELIVERY_(CANDIDATE_CHANGED|SOURCE_CHANGED|PACKAGE_CHANGED)/.test(message))
    return "候选源码或保存内容已变化。请刷新工作区，核对当前版本并重新准备保存；原操作结果仍需按实际记录核对。"
  if (message.includes("PROJECT_DELIVERY_REVIEW_REQUIRED"))
    return "此保存方案需要重新核对。请刷新工作区，重新准备当前候选，再明确选择安装或导出。"
  if (/PROJECT_DELIVERY_BUSY|DEVELOPMENT_SCOPE_CHANGED/.test(message))
    return "当前操作仍在处理，或原聊天、项目归属已变化。请等待后刷新原工作区核对，不要重复提交。"
  if (/PROJECT_DELIVERY_EXPORT_TARGET_(UNSAFE|INVALID)/.test(message))
    return "此导出位置不可用。请选择新的普通本地 ZIP 文件路径，再重新导出。"
  return "保存结果尚未确认。请刷新工作区，核对候选版本、插件名称及实际安装或导出结果；不要重复提交未知操作。"
}

export function projectDeliveryReconciliationText(
  outcome: "installed" | "exported" | "not-executed" | "conflict" | "unknown"
): string {
  switch (outcome) {
    case "installed":
      return "已核实：本次插件已完整安装。核对不会恢复旧批准；可检查使用条件，或重新准备后确认导出。"
    case "exported":
      return "已核实：本次 ZIP 已完整导出，文件内容与冻结交付一致。核对不会再次写入文件或恢复旧批准。"
    case "not-executed":
      return "已核实：未发现本次交付的执行结果。请核对名称与版本后重新准备，并再次明确确认；已安装事实会保留。"
    case "conflict":
      return "发现安装或导出内容冲突，无法认定为本次交付。原文件及插件保留，请检查实际版本或导出位置；不会自动覆盖或重试。"
    case "unknown":
      return "目前仍不能确认实际结果。请排查安装目录或导出位置是否可读取，再次核对；不能直接重试未知操作。"
  }
}
