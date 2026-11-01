import type { ModObject } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

export interface DesktopNotificationHandle {
  once(event: "show" | "failed" | "close", callback: () => void): unknown
  removeAllListeners(): unknown
  show(): void
  close(): void
}
export interface DesktopNotificationAdapter {
  isSupported(): boolean
  create(title: string, text: string): DesktopNotificationHandle
}

/** Native receipt; never sends a decision, opens a URL or impersonates terminal channels. */
export class FunctionDesktopNotifications {
  private readonly active = new Map<DesktopNotificationHandle, () => void>()
  private readonly recent = new Map<string, number[]>()
  constructor(private readonly adapter: DesktopNotificationAdapter) {}

  async show(
    source: string,
    input: ModObject,
    context: {
      signal: AbortSignal
      lifetime: AbortSignal
      enabled(): boolean
      assertLive(): void
    }
  ): Promise<ModObject> {
    context.signal.throwIfAborted()
    context.lifetime.throwIfAborted()
    context.assertLive()
    if (!context.enabled()) return { isSent: false, reason: "disabled" }
    if (!this.adapter.isSupported()) return { isSent: false, reason: "no-channel" }
    const now = Date.now()
    for (const [owner, times] of this.recent) {
      const retained = times.filter((t) => now - t < 10000)
      if (retained.length) this.recent.set(owner, retained)
      else this.recent.delete(owner)
    }
    if (!this.recent.has(source) && this.recent.size >= 64)
      return { isSent: false, reason: "rate-limit" }
    const recent = (this.recent.get(source) ?? []).filter((t) => now - t < 10000)
    this.recent.set(source, recent)
    if (recent.length >= 3 || this.active.size >= 8) return { isSent: false, reason: "rate-limit" }
    recent.push(now)
    let handle: DesktopNotificationHandle
    try {
      handle = this.adapter.create(String(input.title ?? "插件通知"), String(input.text))
    } catch {
      return { isSent: false, reason: "failed" }
    }
    return new Promise<ModObject>((resolve, reject) => {
      let settled = false
      let cleaned = false
      let expiry: ReturnType<typeof setTimeout> | undefined
      const cleanup = (close = true) => {
        if (cleaned) return
        cleaned = true
        clearTimeout(timer)
        clearTimeout(expiry)
        context.signal.removeEventListener("abort", abort)
        context.lifetime.removeEventListener("abort", abort)
        this.active.delete(handle)
        handle.removeAllListeners()
        if (close) {
          try {
            handle.close()
          } catch {
            /* OS shutdown */
          }
        }
      }
      const finish = (result: ModObject) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          context.signal.throwIfAborted()
          context.lifetime.throwIfAborted()
          context.assertLive()
          if (!context.enabled()) {
            cleanup()
            resolve({ isSent: false, reason: "disabled" })
            return
          }
          resolve(result)
          if (!result.isSent) cleanup()
          else expiry = setTimeout(cleanup, 30000)
        } catch (error) {
          cleanup()
          reject(error)
        }
      }
      const abort = () => {
        cleanup()
        if (!settled) {
          settled = true
          reject(
            context.signal.reason ??
              context.lifetime.reason ??
              new ModFunctionError("MODS_CANCELLED")
          )
        }
      }
      this.active.set(handle, () => {
        finish({ isSent: false, reason: "disabled" })
        cleanup()
      })
      handle.once("show", () => finish({ isSent: true, channel: "desktop" }))
      handle.once("failed", () => finish({ isSent: false, reason: "failed" }))
      handle.once("close", () => {
        finish({ isSent: false, reason: "failed" })
        cleanup(false)
      })
      context.signal.addEventListener("abort", abort, { once: true })
      context.lifetime.addEventListener("abort", abort, { once: true })
      const timer = setTimeout(() => finish({ isSent: false, reason: "timeout" }), 3000)
      if (context.signal.aborted || context.lifetime.aborted) {
        abort()
        return
      }
      try {
        context.assertLive()
        handle.show()
      } catch {
        finish({ isSent: false, reason: "failed" })
      }
    })
  }

  close(): void {
    for (const close of this.active.values()) close()
    this.recent.clear()
  }
}
