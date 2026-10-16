import { ModFunctionError } from "../../shared/mods/v2/contracts"

export class ModError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = "ModError"
    this.code = code
  }
}

/** The reason has already crossed the host's output policy; generic exception text is not public. */
export class ModPermissionError extends ModError {
  constructor(reason?: string) {
    super("MODS_TOOL_PERMISSION_DENIED")
    if (reason) this.message += `: ${reason}`
  }
}

/** Source retirement is a tool-level failure, not replacement of the native chat owner. */
export class ModPluginChangedError extends ModError {
  constructor() {
    super("MODS_PLUGIN_CHANGED")
    this.message += ": 插件已停用或更新，本次插件调用已停止。制作草稿已保留，可以继续当前聊天；不会自动重试原操作。"
  }
}

export function modErrorCode(error: unknown): string {
  return error instanceof ModError || error instanceof ModFunctionError
    ? error.code
    : "MODS_EXECUTION_FAILED"
}
