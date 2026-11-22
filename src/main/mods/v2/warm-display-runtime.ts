import { FunctionDispatchDeadline } from "./dispatch-deadline"

interface WarmDisplaySlot<Client> {
  workspace: string
  epoch: string
  client: Client
  stop: () => Promise<void>
  timer: ReturnType<typeof setTimeout>
  current?: () => boolean
  retired: boolean
  draining?: Promise<void>
}

/** Owns one empty physical host until it is claimed or its exit is confirmed. */
export class WarmDisplayRuntime<Client> {
  private slot?: WarmDisplaySlot<Client>

  constructor(private readonly ttlMs = 15_000) {}

  get occupied(): boolean {
    return this.slot !== undefined
  }

  start(
    workspace: string,
    epoch: string,
    client: Client,
    prepare: () => Promise<() => boolean>,
    stop: () => Promise<void>
  ): void {
    if (this.slot) return
    const slot: WarmDisplaySlot<Client> = {
      workspace, epoch, client, stop, retired: false,
      timer: setTimeout(() => this.retireSilently(slot), this.ttlMs)
    }
    this.slot = slot
    slot.timer.unref()

    // Preparation starts a single native attempt synchronously within prepare().
    // Its promise waits for that attempt and never starts another physical host.
    void Promise.resolve().then(() => slot.retired ? undefined : prepare()).then((current) => {
      if (!slot.retired) slot.current = current
    }, () => this.retireSilently(slot))
  }

  take(workspace: string, epoch: string): Client | undefined {
    const slot = this.slot
    if (!slot || slot.retired || slot.workspace !== workspace || slot.epoch !== epoch || !slot.current)
      return undefined

    let current = false
    try { current = slot.current() } catch { /* A failed proof cannot return a host. */ }
    if (!current) {
      this.retireSilently(slot)
      return undefined
    }
    if (slot.retired || this.slot !== slot) return undefined

    clearTimeout(slot.timer)
    this.slot = undefined
    return slot.client
  }

  retire(workspace?: string): Promise<void> {
    const slot = this.slot
    if (slot && (workspace === undefined || slot.workspace === workspace)) return this.drain(slot)
    return Promise.resolve()
  }

  async retireForAdmission(): Promise<void> {
    const deadline = new FunctionDispatchDeadline(250)
    try { await deadline.wait(this.retire()) }
    catch { /* An unconfirmed exit still owns its slot. */ }
    finally { deadline.close() }
  }

  private retireSilently(slot: WarmDisplaySlot<Client>): void {
    // An explicit retirement already owns cleanup, including any failed drain.
    if (!slot.retired && this.slot === slot) void this.drain(slot).catch(() => {})
  }

  private drain(slot: WarmDisplaySlot<Client>): Promise<void> {
    if (slot.draining) return slot.draining
    slot.retired = true
    clearTimeout(slot.timer)
    const draining = Promise.resolve().then(slot.stop).then(() => {
      if (this.slot === slot) this.slot = undefined
    }).finally(() => {
      slot.draining = undefined
    })
    slot.draining = draining
    return draining
  }
}
