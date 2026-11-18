import { MODS_COMPOSITION_REVIEW_REQUIRED } from "../../../shared/mods/v2/contracts"

const transientCodes = new Set([
  "MODS_DEVELOPMENT_APPLYING",
  "MODS_ENTRY_EXPIRED",
  "MODS_RUNTIME_INSTANCE_EXPIRED",
  "MODS_UI_DRAWING_STALE",
  "MODS_UI_SITE_CLOSED",
  "MODS_SESSION_CLOSED",
  "MODS_DISPLAY_ROW_CHANGED"
])

/** Electron invoke errors include an envelope; match whole codes, never message substrings. */
export function functionSiteErrorCode(cause: unknown): string | undefined {
  if (cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string")
    return cause.code
  return String(cause).match(/\bMODS_[A-Z0-9_]+\b/)?.[0]
}

export function isTransientFunctionSiteError(cause: unknown): boolean {
  return transientCodes.has(functionSiteErrorCode(cause) ?? "")
}

/** These host decisions pause display; they never authorize native fallback or a retry. */
export function functionSiteUnavailableMessage(code: string | undefined): string | undefined {
  if (code === MODS_COMPOSITION_REVIEW_REQUIRED)
    return "此会话引用的灵件已停用或发生变化，暂时无法显示相关内容。"
  if (code === "MODS_DISABLED") return "灵件当前未启用，相关内容暂时无法显示。"
  return undefined
}

/** External notifications may request reads, but cannot replenish autonomous retry credit. */
export class FunctionSiteRecovery {
  private retries = 0
  private failing = false
  private lastRead = -Infinity

  reset(): void {
    this.retries = 0
    this.failing = false
  }

  started(now: number): void {
    this.lastRead = now
  }

  notificationDelay(now: number): number {
    return this.failing ? Math.max(0, 400 - (now - this.lastRead)) : 0
  }

  failed(transient: boolean): number | undefined {
    this.failing = true
    if (!transient) return undefined
    return [150, 400, 1000, 2000][this.retries++]
  }
}
