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

export function modErrorCode(error: unknown): string {
  return error instanceof ModError || error instanceof ModFunctionError
    ? error.code
    : "MODS_EXECUTION_FAILED"
}
