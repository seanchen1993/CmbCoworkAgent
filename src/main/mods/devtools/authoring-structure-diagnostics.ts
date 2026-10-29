/** Fixed public authoring errors only. Never forward arbitrary loader/worker exception text. */
const structureDiagnostics = {
  CLAW_COMPONENT_ENTRY_CONFLICT: {
    path: "/entry",
    message:
      "mods/manifest.json 声明 claw.components 时，不得同时声明顶层 entry。保留组件及其 entry，删除顶层 entry。"
  },
  CLAW_COMPONENTS_NATIVE_ONLY: {
    path: "/claw",
    message:
      "claw.components 只能声明在 apiVersion 为 cmb.mods/v2 的 mods 清单中，不能声明在 plugin.json 中。"
  },
  CLAW_COMPONENT_ENTRY_DUPLICATE: {
    path: "/claw/components",
    message: "不同组件必须使用不同的入口文件；核对组件 entry，避免重复登记同一入口。"
  },
  CLAW_COMPONENT_ACTION_OWNERSHIP: {
    path: "/claw",
    message: "公开动作必须由实际存在的组件独占声明；核对 components 的 actionIds 与 actions。"
  },
  CLAW_ACTION_DECLARATION_CONFLICT: {
    path: "/claw",
    message: "公开动作声明存在冲突；核对 plugin.json 与 mods 清单中的动作来源，保留单一声明来源。"
  },
  MODS_USER_CONFIG_DECLARATION_CONFLICT: {
    path: "/userConfig",
    message: "插件配置同时在不同清单声明；保留配置内容并统一到单一声明来源。"
  },
  MODS_MODULES_INVALID: {
    path: "/modules",
    message: "modules 声明无效；使用当前 catalog 的清单结构，核对各模块入口。"
  },
  MODS_MODEL_PROTOCOL_CONFLICT: {
    path: "/modelProtocol",
    message: "模型协议声明存在冲突；核对各清单声明并保留当前构建支持的同一协议。"
  }
} as const

export type AuthoringStructureCode = keyof typeof structureDiagnostics
export function authoringStructureCode(value: unknown): AuthoringStructureCode | undefined {
  return typeof value === "string" && Object.hasOwn(structureDiagnostics, value)
    ? (value as AuthoringStructureCode)
    : undefined
}
export class AuthoringStructureError extends Error {
  readonly diagnostic: { scope: "manifest"; path: string; message: string }
  constructor(code: AuthoringStructureCode) {
    super(code)
    this.diagnostic = { scope: "manifest", ...structureDiagnostics[code] }
  }
}
