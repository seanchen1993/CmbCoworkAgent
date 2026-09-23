import { randomUUID } from "node:crypto"
import type { BaseCheckpointSaver, Checkpoint } from "@langchain/langgraph-checkpoint"

export interface CmbCompactionHooks {
  /** Dynamic host configuration: disabled Mods with no legacy hooks installs no gate. */
  isEnabled?: () => boolean
  before(
    event: { trigger: "manual" | "auto"; customInstructions: string | null },
    signal?: AbortSignal
  ): Promise<void>
  after(event: { trigger: "manual" | "auto"; summary: string }, signal?: AbortSignal): Promise<void>
}

type Pending = { summary: string; signal?: AbortSignal; release: () => void }

function compactionEvidence(values: Record<string, unknown>): string {
  const event = values._summarizationEvent as Record<string, unknown> | undefined
  const message = event?.summaryMessage as { content?: unknown } | undefined
  return JSON.stringify([
    values._summarizationSessionId,
    values._cmbSummarizationOwner,
    event?.compactionId,
    event?.cutoffIndex,
    event?.usageStartIndex,
    event?.filePath,
    message?.content
  ])
}

export function hasSameCompactionEvidence(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown>
): boolean {
  return !!actual && compactionEvidence(actual) === compactionEvidence(expected)
}

/** Host-only receipt: a model result or Command is not a durable compaction. */
export class CompactionCommitObserver {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly hooks?: CmbCompactionHooks) {}

  private enabled(): boolean {
    return !!this.hooks && (this.hooks.isEnabled?.() ?? true)
  }

  async before(
    trigger: "manual" | "auto",
    instructions: string | undefined,
    signal?: AbortSignal
  ): Promise<boolean> {
    signal?.throwIfAborted()
    if (!this.enabled()) return false
    await this.hooks?.before({ trigger, customInstructions: instructions || null }, signal)
    signal?.throwIfAborted()
    return true
  }

  register(summary: string, signal?: AbortSignal): string | undefined {
    if (!this.enabled()) return undefined
    signal?.throwIfAborted()
    // A graph normally has one pending summary. Keep aborted/failed runs bounded
    // even when an embedding host does not supply a usable checkpointer.
    while (this.pending.size >= 16) this.discard(this.pending.keys().next().value!)
    const id = randomUUID()
    const abort = () => this.discard(id)
    this.pending.set(id, {
      summary,
      signal,
      release: () => signal?.removeEventListener("abort", abort)
    })
    signal?.addEventListener("abort", abort, { once: true })
    return id
  }

  private discard(id: string): Pending | undefined {
    const pending = this.pending.get(id)
    this.pending.delete(id)
    pending?.release()
    return pending
  }

  onceAfterManual(summary: string): ((signal: AbortSignal) => Promise<void>) | undefined {
    if (!this.enabled()) return undefined
    let reported = false
    return async (signal) => {
      if (reported || signal.aborted) return
      reported = true
      await this.report("manual", summary, signal)
    }
  }

  private async report(
    trigger: "manual" | "auto",
    summary: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted || !this.enabled()) return
    try {
      await this.hooks?.after({ trigger, summary }, signal)
    } catch (error) {
      // Post observes a successful commit. Its policy result/error cannot undo it
      // or cause the host to retry an already committed mutation.
      if (!signal?.aborted) console.warn("[Compaction] PostCompact observation failed:", error)
    }
  }

  wrapCheckpointer<T>(saver: T): T {
    if (!this.hooks || !saver || typeof saver !== "object") return saver
    const target = saver as T &
      Pick<BaseCheckpointSaver, "put" | "getTuple"> & { flushStrict?: () => Promise<void> }
    if (typeof target.put !== "function" || typeof target.getTuple !== "function") return saver
    return new Proxy(target, {
      get: (object, property) => {
        if (property === "put")
          return async (...args: Parameters<BaseCheckpointSaver["put"]>) => {
            const checkpoint: Checkpoint = args[1]
            const event = checkpoint.channel_values._summarizationEvent as
              | { compactionId?: unknown }
              | undefined
            const id = typeof event?.compactionId === "string" ? event.compactionId : undefined
            const pending = id ? this.discard(id) : undefined
            const expectedEvidence = pending
              ? compactionEvidence(checkpoint.channel_values)
              : undefined
            // Reserve the receipt before awaiting writes, so duplicate checkpoint
            // saves cannot publish the same observation concurrently.
            const config = await object.put(...args)
            if (pending && !pending.signal?.aborted && this.enabled()) {
              await object.flushStrict?.()
              const latestConfig = { ...config, configurable: { ...config.configurable } }
              delete latestConfig.configurable.checkpoint_id
              try {
                const latest = await object.getTuple(latestConfig)
                if (
                  latest?.checkpoint.id === checkpoint.id &&
                  compactionEvidence(latest.checkpoint.channel_values) === expectedEvidence &&
                  !pending.signal?.aborted
                )
                  await this.report("auto", pending.summary, pending.signal)
              } catch (error) {
                // The write and required flush already succeeded. A failed
                // observation read suppresses Post without retrying that mutation.
                console.warn("[Compaction] Cannot verify committed summary:", error)
              }
            }
            return config
          }
        const value = Reflect.get(object, property, object)
        return typeof value === "function" ? value.bind(object) : value
      }
    })
  }
}
