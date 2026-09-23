import { randomUUID } from "node:crypto"
import type { ModObject } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import {
  functionScrollGeometry,
  functionScrollPosition,
  type FunctionScrollAck,
  type FunctionScrollAddress,
  type FunctionScrollArgs,
  type FunctionScrollGeometry,
  type FunctionScrollOutcome,
  type FunctionScrollRequest
} from "../../../shared/mods/v2/ui-scroll"

interface Pending {
  address: FunctionScrollAddress
  controller: AbortController
  request?: FunctionScrollRequest
  accept?: (ack: FunctionScrollAck) => void
}

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
      .finally(() => signal.removeEventListener("abort", aborted))
  })
}

/** A measured proposal and a final renderer acknowledgement bracket the original Hook chain. */
export class FunctionScrollRequests {
  private readonly pending = new Map<string, Pending>()
  private closed = false
  constructor(
    private readonly host: {
      assertLive(address: FunctionScrollAddress): void
      changed(): void
      applied?(address: FunctionScrollAddress, id: string, followEnd: boolean): void
    }
  ) {}

  current(pane: string): FunctionScrollRequest | undefined {
    const request = this.pending.get(pane)?.request
    return request ? structuredClone(request) : undefined
  }

  ack(input: FunctionScrollAck): void {
    const entry = input && this.pending.get(input.pane)
    const request = entry?.request
    if (
      !entry ||
      !request ||
      !entry.accept ||
      typeof input.allowed !== "boolean" ||
      Object.keys(input).some(
        (key) => !["pane", "generation", "id", "phase", "allowed", "geometry"].includes(key)
      ) ||
      (["pane", "generation", "id", "phase"] as const).some((key) => input[key] !== request[key])
    )
      throw new ModFunctionError("MODS_UI_SCROLL_STALE")
    this.host.assertLive(entry.address)
    let geometry: FunctionScrollGeometry | undefined
    if (input.phase === "probe" && input.allowed) geometry = functionScrollGeometry(input.geometry)
    else if (input.geometry !== undefined) throw new ModFunctionError("MODS_UI_SCROLL_GEOMETRY")
    const accept = entry.accept
    entry.accept = undefined
    accept({ ...input, ...(geometry ? { geometry: structuredClone(geometry) } : {}) })
  }

  async run(
    address: FunctionScrollAddress,
    args: FunctionScrollArgs,
    signal: AbortSignal,
    operation: (
      input: ModObject,
      select: (offset: number) => Promise<FunctionScrollOutcome>,
      signal: AbortSignal
    ) => Promise<FunctionScrollOutcome>
  ): Promise<FunctionScrollOutcome> {
    signal.throwIfAborted()
    this.host.assertLive(address)
    if (this.closed) throw new ModFunctionError("MODS_UI_SCROLL_STALE")
    if (this.pending.has(address.pane)) return { deny: "A scroll request is already pending" }
    if (this.pending.size >= 8) throw new ModFunctionError("MODS_UI_SCROLL_LIMIT")
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    const entry: Pending = { address: { ...address }, controller }
    this.pending.set(address.pane, entry)
    const id = randomUUID()
    const timer = setTimeout(
      () => controller.abort(new ModFunctionError("MODS_UI_SCROLL_TIMEOUT")),
      5000
    )
    timer.unref()
    const wait = (phase: "probe" | "apply", geometry?: FunctionScrollGeometry, offset?: number) => {
      combined.throwIfAborted()
      this.host.assertLive(address)
      return new Promise<FunctionScrollAck>((resolve, reject) => {
        const cleanup = () => {
          combined.removeEventListener("abort", aborted)
          entry.accept = undefined
          if (combined.aborted) entry.request = undefined
        }
        const aborted = () => {
          cleanup()
          reject(combined.reason)
        }
        entry.request = {
          ...address,
          id,
          phase,
          args: structuredClone(args),
          ...(geometry ? { geometry } : {}),
          ...(offset !== undefined ? { offset } : {})
        }
        entry.accept = (ack) => {
          cleanup()
          resolve(ack)
        }
        combined.addEventListener("abort", aborted, { once: true })
        this.host.changed()
      })
    }
    try {
      const probe = await wait("probe")
      if (!probe.allowed || !probe.geometry)
        return { deny: "The owned site or target cannot be measured" }
      const geometry = probe.geometry
      const position = functionScrollPosition(args, geometry)
      let selected: number | undefined
      const outcome = await withAbort(combined, () =>
        operation(
          {
            component: "Pane",
            requestId: address.requestId,
            ...position,
            origin: { kind: "plugin", name: address.plugin }
          },
          (offset) => {
            combined.throwIfAborted()
            this.host.assertLive(address)
            if (selected !== undefined) throw new ModFunctionError("MODS_UI_SCROLL_REPLAY")
            if (typeof offset !== "number" || !Number.isFinite(offset))
              throw new ModFunctionError("MODS_UI_SCROLL_OFFSET")
            selected = Math.max(
              0,
              Math.min(Math.max(0, position.contentRows - position.bodyRows), offset)
            )
            return Promise.resolve({})
          },
          combined
        )
      )
      combined.throwIfAborted()
      this.host.assertLive(address)
      if (typeof outcome.deny === "string") return outcome
      if (selected === undefined) return { deny: "The scroll chain did not apply the request" }
      const applied = await wait("apply", geometry, selected)
      combined.throwIfAborted()
      this.host.assertLive(address)
      if (!applied.allowed) return { deny: "The window or drawing moved meanwhile" }
      this.host.applied?.(
        address,
        id,
        args.to === "end" &&
          Math.abs(selected - Math.max(0, position.contentRows - position.bodyRows)) < 1e-9
      )
      return {}
    } finally {
      clearTimeout(timer)
      controller.abort(new ModFunctionError("MODS_UI_SCROLL_STALE"))
      if (this.pending.get(address.pane) === entry) this.pending.delete(address.pane)
      this.host.changed()
    }
  }

  cancel(pane: string): void {
    this.pending.get(pane)?.controller.abort(new ModFunctionError("MODS_UI_SCROLL_STALE"))
  }
  close(): void {
    this.closed = true
    for (const entry of this.pending.values())
      entry.controller.abort(new ModFunctionError("MODS_UI_SCROLL_STALE"))
  }
}
