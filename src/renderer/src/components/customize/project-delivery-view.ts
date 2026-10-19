/** Public recovery guidance only; native delivery remains the operation authority. */
export function projectDeliveryError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : ""
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
