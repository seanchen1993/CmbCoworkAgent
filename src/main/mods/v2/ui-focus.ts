import { randomUUID } from "node:crypto"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type {
  FunctionFocusAddress,
  FunctionFocusRequest,
  FunctionFocusAck,
  FunctionFocusOutcome
} from "../../../shared/mods/v2/ui-focus"

function withAbort<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener("abort", aborted, { once: true })
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return run()
      })
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", aborted)
      })
  })
}

interface Pending {
  target: FunctionFocusAddress
  controller: AbortController
  request?: FunctionFocusRequest
  accept?: (allowed: boolean) => void
}

/** Renderer acknowledgements bypass the callback queue which may be awaiting this request. */
export class FunctionFocusRequests {
  private readonly pending = new Map<string, Pending>()
  private closed = false
  constructor(
    private readonly host: {
      assertLive(target: FunctionFocusAddress): void
      changed(): void
    }
  ) {}

  current(pane: string): FunctionFocusRequest | undefined {
    const request = this.pending.get(pane)?.request
    return request ? { ...request } : undefined
  }

  ack(input: FunctionFocusAck): void {
    const entry = input && this.pending.get(input.pane)
    const request = entry?.request
    if (
      !entry ||
      !request ||
      !entry.accept ||
      typeof input.allowed !== "boolean" ||
      Object.keys(input).some(
        (key) =>
          ![
            "pane",
            "generation",
            "plugin",
            "element",
            "client",
            "clientHandle",
            "id",
            "phase",
            "allowed"
          ].includes(key)
      ) ||
      (
        [
          "pane",
          "generation",
          "plugin",
          "element",
          "client",
          "clientHandle",
          "id",
          "phase"
        ] as const
      ).some((key) => input[key] !== request[key])
    )
      throw new ModFunctionError("MODS_UI_FOCUS_STALE")
    this.host.assertLive(entry.target)
    this.host.assertLive(request)
    const accept = entry.accept
    entry.accept = undefined
    accept(input.allowed)
  }

  async run(
    target: FunctionFocusAddress,
    signal: AbortSignal,
    operation: (
      apply: (target: FunctionFocusAddress) => Promise<FunctionFocusOutcome>,
      signal: AbortSignal
    ) => Promise<FunctionFocusOutcome>
  ): Promise<FunctionFocusOutcome> {
    signal.throwIfAborted()
    this.host.assertLive(target)
    if (this.closed) throw new ModFunctionError("MODS_UI_FOCUS_STALE")
    if (this.pending.has(target.pane)) return { deny: "A focus request is already pending" }
    if (this.pending.size >= 8) throw new ModFunctionError("MODS_UI_FOCUS_LIMIT")
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    const entry: Pending = { target: { ...target }, controller }
    this.pending.set(target.pane, entry)
    const id = randomUUID()
    const timer = setTimeout(
      () => controller.abort(new ModFunctionError("MODS_UI_FOCUS_TIMEOUT")),
      5000
    )
    timer.unref()
    const wait = (
      phase: FunctionFocusRequest["phase"],
      address: FunctionFocusAddress
    ): Promise<boolean> => {
      combined.throwIfAborted()
      this.host.assertLive(address)
      return new Promise<boolean>((resolve, reject) => {
        const aborted = () => {
          cleanup()
          reject(combined.reason)
        }
        const cleanup = () => {
          combined.removeEventListener("abort", aborted)
          entry.accept = undefined
          if (combined.aborted) entry.request = undefined
        }
        entry.request = { ...address, id, phase }
        entry.accept = (allowed) => {
          cleanup()
          resolve(allowed)
        }
        combined.addEventListener("abort", aborted, { once: true })
        this.host.changed()
      })
    }
    try {
      if (!(await wait("probe", target)))
        return { deny: "The site does not hold this plugin's keyboard focus" }
      combined.throwIfAborted()
      let selected: FunctionFocusAddress | undefined
      const outcome = await withAbort(combined, () =>
        operation((candidate) => {
          if (selected) throw new ModFunctionError("MODS_UI_FOCUS_REPLAY")
          combined.throwIfAborted()
          if (
            candidate.pane !== target.pane ||
            candidate.generation !== target.generation ||
            candidate.plugin !== target.plugin
          )
            throw new ModFunctionError("MODS_UI_FOCUS_STALE")
          this.host.assertLive(candidate)
          selected = { ...candidate }
          // next() prepares a target. Only the complete chain may authorize a physical move.
          return Promise.resolve({})
        }, combined)
      )
      combined.throwIfAborted()
      this.host.assertLive(target)
      if (typeof outcome.deny === "string") return outcome
      if (!selected) return { deny: "The focus chain did not apply the request" }
      if (!(await wait("apply", selected))) return { deny: "The focus owner or drawing changed" }
      combined.throwIfAborted()
      this.host.assertLive(selected)
      return {}
    } finally {
      clearTimeout(timer)
      controller.abort(new ModFunctionError("MODS_UI_FOCUS_STALE"))
      if (this.pending.get(target.pane) === entry) this.pending.delete(target.pane)
      this.host.changed()
    }
  }

  cancel(pane: string): void {
    this.pending.get(pane)?.controller.abort(new ModFunctionError("MODS_UI_FOCUS_STALE"))
  }

  close(): void {
    this.closed = true
    for (const entry of this.pending.values())
      entry.controller.abort(new ModFunctionError("MODS_UI_FOCUS_STALE"))
  }
}
