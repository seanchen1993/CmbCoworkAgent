export class ModError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = "ModError"
    this.code = code
  }
}

export function modErrorCode(error: unknown): string {
  return error instanceof ModError ? error.code : "MODS_EXECUTION_FAILED"
}
