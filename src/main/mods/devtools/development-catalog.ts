import {
  FUNCTION_COMPATIBILITY_EVENT_NAMES,
  getFunctionEventSupport
} from "../../../shared/mods/v2/compatibility-catalog"
import { FUNCTION_SDK_METHODS } from "../v2/sdk-capabilities"
import { DEVELOPMENT_CAPABILITIES, DEVELOPMENT_EVENT_CAPABILITIES } from "../v2/development-session"
import { functionAuthoringDeclarations } from "./authoring-declarations"

export const DEVELOPMENT_COUNTER_EXAMPLE = `import type { Register } from "claude-code"
export const register: Register = (on) => {
  let calls = 0
  on("tool.call", async ($, event, next) => {
    calls += 1
    $.ui.invalidate("ui.render")
    return next(event)
  })
  on("ui.render", { component: "AbovePrompt" }, ($, event) => {
    const { Text } = $.ui.resolve(event)
    return Text({ children: "工具调用：" + calls })
  })
}
`

/** The same declarations go to the model and the actual isolated type checker. */
export function developmentCatalog() {
  return {
    contract: "cmb-desktop-authoring-v2",
    types: functionAuthoringDeclarations("result-v1"),
    events: FUNCTION_COMPATIBILITY_EVENT_NAMES.map((name) => ({
      name,
      ...getFunctionEventSupport(name)
    })),
    sdkMethods: [...FUNCTION_SDK_METHODS],
    trialCapabilities: [...DEVELOPMENT_CAPABILITIES],
    trialEventEnvelope: [...DEVELOPMENT_EVENT_CAPABILITIES],
    trialEventConsent:
      "这组固定事件范围随 SDK 一起由用户确认；加载后逐项校验实际注册，拒绝通配符和范围外事件。",
    examples: { toolCounter: DEVELOPMENT_COUNTER_EXAMPLE },
    package: {
      "plugin.json": {
        name: "my-component",
        version: "0.1.0",
        description: "组件说明",
        mods: "mods/manifest.json"
      },
      "mods/manifest.json": {
        apiVersion: "cmb.mods/v2",
        id: "my-component",
        entry: "main.ts",
        modelProtocol: "result-v1"
      },
      "mods/main.ts": DEVELOPMENT_COUNTER_EXAMPLE
    },
    limitations: [
      "当前构建的桌面子集；事件支持不代表全部作者重载都已声明。",
      "试用只接受 trialCapabilities 中的 SDK 方法和事件；其他能力需正式安装与授权。",
      "试用不可调用模型、进程、网络、文件、跨插件 state 或注册自定义工具；隔离状态使用 store。",
      "轮次结束并且真实任务结算后才应用；request_trial 返回排队状态，不是生效证明。",
      "模块局部变量在重新加载后重置；状态需显式使用宿主接口。",
      "不得从其他会话或全局插件目录直接覆盖源码。"
    ]
  }
}

/** Targeted discovery stays within the normal tool-result budget instead of dumping the SDK. */
export function developmentCatalogPage(
  section: "overview" | "types" | "events" | "sdk" = "overview",
  cursor = 0
) {
  const catalog = developmentCatalog()
  if (section === "overview")
    return {
      contract: catalog.contract,
      trialCapabilities: catalog.trialCapabilities,
      trialEventEnvelope: catalog.trialEventEnvelope,
      trialEventConsent: catalog.trialEventConsent,
      package: catalog.package,
      limitations: catalog.limitations,
      discovery:
        "用 catalogSection=types/events/sdk 分页读取精确声明；nextCursor 存在时继续，缺省返回入门范围。"
    }
  const value =
    section === "types" ? catalog.types : section === "events" ? catalog.events : catalog.sdkMethods
  const size = section === "types" ? 6000 : section === "events" ? 12 : 60
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > value.length)
    throw Error("DEVELOPMENT_CATALOG_CURSOR")
  return {
    contract: catalog.contract,
    section,
    cursor,
    content: value.slice(cursor, cursor + size),
    ...(cursor + size < value.length ? { nextCursor: cursor + size } : {})
  }
}
