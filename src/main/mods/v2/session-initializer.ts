import { ModFunctionError } from "../../../shared/mods/v2/contracts"

const localOrReadOnly = new Set([
  "command.register",
  "command.list",
  // The Session handles this as a candidate-local ui.render request, never a published redraw.
  "ui.invalidate",
  "agent.register",
  "tool.register",
  "store.get",
  "store.keys",
  "state.get",
  "fs.read",
  "fs.list",
  "fs.stat",
  "fs.ancestors",
  "fs.cwd",
  "env.get",
  "clock.time",
  "clock.now",
  "config.list",
  "fs.exists",
  "model.list",
  "agent.list",
  "tool.list",
  "session.context",
  "session.history",
  "session.messages",
  "session.usage",
  "session.version",
  "settings.read",
  "session.id",
  "session.cwd",
  "session.root",
  "session.surface",
  "session.surfaces",
  "session.repo",
  "session.model",
  "session.turns"
])

/** Current host phase is read on every call; AsyncResource cannot capture permanent privilege. */
export class FunctionSessionInitializer {
  private phase: "candidate" | "restart" | "active"
  private failure?: Error
  private readonly detach = new Set<() => void>()

  constructor(candidate: boolean | "restart") {
    this.phase = candidate === "restart" ? "restart" : candidate ? "candidate" : "active"
  }

  get strict(): boolean {
    return this.phase !== "active"
  }

  get allowsStartupEffects(): boolean {
    return this.phase !== "candidate"
  }

  record(error: unknown): void {
    if (this.strict)
      this.failure ??= error instanceof Error ? error : new Error("MODS_CONFIG_RELOAD_FAILED")
  }

  assertMethod(method: string): void {
    if (this.phase !== "candidate" || localOrReadOnly.has(method)) return
    const error = new ModFunctionError(
      "MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED",
      `插件启动时需要 ${method}；参数已保存，请在任务结束后重启插件以应用。`,
      true
    )
    this.record(error)
    throw error
  }

  /** A held initialization branch cannot gain active privileges after candidate activation. */
  captureAdmission(): {
    readonly candidate: boolean
    assertMethod(method: string): void
    record(error: unknown): void
  } {
    const readOnly = this.phase === "candidate"
    const strict = this.strict
    return Object.freeze({
      candidate: readOnly,
      assertMethod: (method: string): void => {
        if (!readOnly || localOrReadOnly.has(method)) return
        const error = new ModFunctionError(
          "MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED",
          `插件启动时需要 ${method}；参数已保存，请在任务结束后重启插件以应用。`,
          true
        )
        this.failure ??= error
        throw error
      },
      record: (error: unknown): void => {
        if (strict) this.failure ??= error instanceof Error
          ? error : new Error("MODS_CONFIG_RELOAD_FAILED")
      }
    })
  }

  assertReady(): void {
    if (this.failure) throw this.failure
  }

  bindCancellation(signal: AbortSignal, cancel: (reason: unknown) => void): () => void {
    if (!this.strict) return () => {}
    const abort = () => cancel(signal.reason)
    const detach = () => {
      signal.removeEventListener("abort", abort)
      this.detach.delete(detach)
    }
    this.detach.add(detach)
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
    return detach
  }

  activate(): void {
    this.assertReady()
    this.phase = "active"
    for (const detach of [...this.detach]) detach()
  }
}
