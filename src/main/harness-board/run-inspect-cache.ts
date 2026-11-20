interface Inspection {
  featureKey: string
  task: Promise<Buffer>
  controller: AbortController
  readers: number
  settled: boolean
  value?: Buffer
  expiresAt?: number
  expiry?: ReturnType<typeof setTimeout>
}

/** Share readonly run inspections between the page and stage attribution.
 * A short, byte-bounded handoff window bridges their different notification
 * debounce times. State/artifact notifications remove old entries immediately.
 */
export class HarnessRunInspectCache {
  private readonly entries = new Map<string, Inspection>()
  private retainedBytes = 0
  private retainedEntries = 0

  constructor(
    private readonly reuseMs = 1_000,
    private readonly maxBytes = 8 * 1024 * 1024,
    private readonly maxEntries = 64
  ) {}

  run(
    projectId: string,
    featureSlug: string,
    invocationKey: string,
    execute: (signal: AbortSignal) => Promise<Buffer>,
    signal?: AbortSignal
  ): Promise<Buffer> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    const featureKey = JSON.stringify([projectId.trim(), featureSlug.trim()])
    const key = JSON.stringify([featureKey, invocationKey])
    let entry = this.entries.get(key)
    if (entry?.value && Date.now() >= (entry.expiresAt ?? 0)) {
      this.remove(key, entry)
      entry = undefined
    }
    if (entry?.value) return Promise.resolve(entry.value)
    if (!entry) {
      const controller = new AbortController()
      entry = { featureKey, controller, readers: 0, settled: false, task: undefined! }
      const current = entry
      this.entries.set(key, current)
      current.task = Promise.resolve()
        .then(() => execute(controller.signal))
        .then(
          (value) => {
            current.settled = true
            if (
              this.entries.get(key) === current &&
              !controller.signal.aborted &&
              this.maxEntries > 0 &&
              value.byteLength <= this.maxBytes
            ) {
              for (const [otherKey, other] of this.entries) {
                if (
                  this.retainedEntries < this.maxEntries &&
                  this.retainedBytes + value.byteLength <= this.maxBytes
                )
                  break
                // Pending tasks stay discoverable until they settle, so capacity
                // pressure cannot start duplicate processes for the same query.
                if (other.value) this.remove(otherKey, other)
              }
              current.value = value
              this.retainedBytes += value.byteLength
              this.retainedEntries++
              current.expiresAt = Date.now() + this.reuseMs
              current.expiry = setTimeout(() => this.remove(key, current), this.reuseMs)
              current.expiry.unref()
            } else this.remove(key, current)
            return value
          },
          (error) => {
            current.settled = true
            this.remove(key, current)
            throw error
          }
        )
    }
    const current = entry
    current.readers++
    return new Promise<Buffer>((resolve, reject) => {
      let finished = false
      const finish = (callback: () => void) => {
        if (finished) return
        finished = true
        signal?.removeEventListener("abort", abort)
        current.readers--
        if (!current.settled && current.readers === 0) {
          this.remove(key, current)
          current.controller.abort()
        }
        callback()
      }
      const abort = () => finish(() => reject(signal?.reason))
      signal?.addEventListener("abort", abort, { once: true })
      current.task.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error))
      )
      if (signal?.aborted) abort()
    })
  }

  invalidate(projectId: string, featureSlug: string): void {
    const featureKey = JSON.stringify([projectId.trim(), featureSlug.trim()])
    for (const [key, entry] of this.entries) {
      if (entry.featureKey === featureKey) this.remove(key, entry)
    }
  }

  private remove(key: string, entry: Inspection): void {
    if (this.entries.get(key) !== entry) return
    this.entries.delete(key)
    if (entry.expiry) clearTimeout(entry.expiry)
    if (entry.value) {
      this.retainedBytes -= entry.value.byteLength
      this.retainedEntries--
    }
  }
}

export const harnessRunInspections = new HarnessRunInspectCache()
export function invalidateHarnessRunInspection(projectId: string, featureSlug: string): void {
  harnessRunInspections.invalidate(projectId, featureSlug)
}
