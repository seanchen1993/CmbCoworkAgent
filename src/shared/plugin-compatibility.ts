export interface PluginCompatibilityReport {
  source: {
    pluginId: string
    name: string
    version: string
    enabled: boolean
    packageDigest: string | null
  }
  checkedAt: number
  status: "declared" | "undeclared" | "invalid"
  /** Static inspection never evaluates or issues execution permission. */
  authorization: "not-evaluated"
  chat: "check-in-chat"
  reasons: string[]
  entries: Array<{
    id: string
    title: string
    kind: "capability" | "flow"
    runtimeMode?: "host" | "legacy"
    available: boolean
    reasons: string[]
  }>
}

export function pluginCompatibilityReason(reason: string): string {
  if (reason.includes("EXTENSION_CONTRACT_PROTOCOL_UNSUPPORTED"))
    return "该插件要求当前客户端尚未支持的扩展协议，请升级客户端；不能回退到原项目入口执行。"
  if (reason.includes("EXTENSION_CONTRACT_PROVIDER_MISSING"))
    return "插件声明的上下文提供器文件缺失，请重新生成完整插件包。"
  if (reason.includes("PINNED_MODS_UNSUPPORTED"))
    return "此宿主完整流程暂不支持固定包含灵件模块的插件版本；可继续使用原插件入口。"
  if (reason.includes("PINNED_MCP_UNSUPPORTED"))
    return "此宿主完整流程暂不支持插件自带的外部工具连接（MCP）；可继续使用原插件入口。"
  if (reason.includes("PROJECT_MODS_"))
    return "插件的灵件模块声明无效或协议不受支持，请修正并重新检查完整插件包。"
  if (reason.includes("PROJECT_MCP_"))
    return "插件自带的外部工具连接（MCP）配置无效，请修正并重新检查完整插件包。"
  if (reason.includes("PROJECT_EXTENSION_RESOURCE_MISSING"))
    return "插件声明的资源缺失，请重新生成完整插件包。"
  if (/COMPOSITION_CATALOG_BUSY|CAPABILITY_PACKAGE_TIMEOUT/.test(reason))
    return "检查繁忙或超时，请稍后重新检查。"
  return reason
}
