import { SingleFlightBatchCoalescer } from "../agent/run-settlement-fence"

export interface BotMemoryBatch {
  botId: string
  /** Prevent a delayed summary from crossing a Bot settings change. */
  botVersion?: number
  threadId: string
  modelRef: string | null
  editVersion: number
  conversation: string
  /** Host-owned user text, kept separate from assistant context for evidence checks. */
  userText: string
}

const MAX_CONVERSATION = 12_000
const compact = (text: string): string =>
  text.length <= MAX_CONVERSATION ? text : `${text.slice(0, 4000)}\n[…]\n${text.slice(-7900)}`

/** One model request globally, one bounded pending batch per Bot. No polling or retained turn history. */
export class BotMemoryMaintainer {
  private readonly abort = new AbortController()
  private running: Promise<void> = Promise.resolve()
  private readonly batches: SingleFlightBatchCoalescer<string, Map<string, BotMemoryBatch>>

  constructor(
    private readonly summarize: (batch: BotMemoryBatch, signal: AbortSignal) => Promise<void>,
    private readonly onError: (error: unknown) => void = console.error
  ) {
    this.batches = new SingleFlightBatchCoalescer({
      schedule: (run) => {
        this.running = Promise.resolve().then(run)
      },
      onError
    })
  }

  enqueue(batch: BotMemoryBatch): void {
    if (this.abort.signal.aborted || !batch.conversation.trim()) return
    this.batches.enqueue(
      "memory",
      new Map([
        [
          batch.botId,
          { ...batch, conversation: compact(batch.conversation), userText: compact(batch.userText) }
        ]
      ]),
      (pending, incoming) => {
        for (const [id, next] of incoming) {
          const prior = pending.get(id)
          if (!prior && pending.size >= 200) continue
          pending.set(
            id,
            prior?.editVersion === next.editVersion && prior.botVersion === next.botVersion
              ? {
                  ...next,
                  conversation: compact(`${prior.conversation}\n\n${next.conversation}`),
                  userText: compact(`${prior.userText}\n\n${next.userText}`)
                }
              : next
          )
        }
        return pending
      },
      async (pending) => {
        for (const batch of pending.values()) {
          if (this.abort.signal.aborted) break
          // Each adapter must honor this signal; close waits until its request releases resources.
          const controller = new AbortController()
          const stop = () => controller.abort(this.abort.signal.reason)
          this.abort.signal.addEventListener("abort", stop, { once: true })
          const timer = setTimeout(() => controller.abort(new Error("记忆总结超时")), 30_000)
          timer.unref?.()
          try {
            await this.summarize(batch, controller.signal)
          } catch (error) {
            if (!controller.signal.aborted) this.onError(error)
          } finally {
            clearTimeout(timer)
            this.abort.signal.removeEventListener("abort", stop)
          }
        }
      }
    )
  }

  async close(): Promise<void> {
    this.abort.abort(new Error("Bot 记忆总结正在退出"))
    await this.running
  }
}
