import type { BotStore } from "./store"
import type { BotMemorySynthesisSnapshot } from "./memory-store"
import { BotClockFence } from "./clock-fence"
import { randomUUID } from "node:crypto"
import { serializeBotFailure } from "./error-diagnostic"
import {
  reportBotBackgroundFailure,
  type BotBackgroundFailureReporter
} from "./background-error-reporter"
import { BotDomainError } from "../../shared/bot-types"
import { memoryContextLimitError } from "./memory-context"
import { MEMORY_RETENTION_POLICY } from "./memory-retention"
import {
  currentDate,
  normalizedChanges,
  parseJsonObject,
  parseMemorySynthesisChanges,
  synthesisSystemPrompt,
  verificationSystemPrompt,
  usesKnownEvidence,
  MEMORY_SYNTHESIS_DEADLINE_MS
} from "./upstream/grok-memory-synthesis"

export interface BotMemoryModelSession {
  complete(
    system: string,
    data: unknown,
    signal: AbortSignal,
    phase?: "synthesis" | "verification"
  ): Promise<string>
  assertCurrent(): Promise<void>
  fits?(system: string, data: unknown): boolean
}
export type BotMemoryModelFactory = (
  botId: string,
  signal: AbortSignal
) => Promise<BotMemoryModelSession>

/** One bounded background pass at a time. Durable evidence is acknowledged in the same
 * transaction as its verified changes, so a Host crash never commits half a proposal.
 */
export class BotMemorySynthesis {
  private timer?: ReturnType<typeof setInterval>
  private active?: Promise<void>
  private lifetime = new AbortController()
  private failureReporter?: BotBackgroundFailureReporter
  lastError: string | null = null
  constructor(
    private readonly store: BotStore,
    private readonly models: BotMemoryModelFactory,
    private readonly monotonicClock?: () => number
  ) {}
  bindFailureReporter(report: BotBackgroundFailureReporter): void {
    this.failureReporter = report
  }
  start() {
    if (this.timer || this.lifetime.signal.aborted) return
    this.store.memory.recover()
    this.timer = setInterval(() => {
      void this.runNow()
    }, 1000)
    this.timer.unref()
    void this.runNow()
  }
  runNow(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve()
    if (this.active) return this.active
    this.active = this.runPending()
      .catch(() => {
        // Keep model/provider error payloads out of diagnostics and renderer state.
        this.lastError = "记忆整理暂未完成，原有记忆已保留。"
      })
      .finally(() => {
        this.active = undefined
      })
    return this.active
  }
  private async runPending() {
    for (const botId of this.store.memory.targets().slice(0, 4)) {
      if (this.lifetime.signal.aborted) return
      const snapshot = this.store.memory.prepare(botId)
      if (!snapshot) continue
      await this.run(snapshot)
    }
  }
  private async run(snapshot: BotMemorySynthesisSnapshot) {
    const dataEpoch = this.store.dataEpoch()
    const episodeId = `memory:${randomUUID()}`
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    // Each pass uses one date and one supervised execution interval. A fresh
    // retry gets a new clock; a late response cannot revive this pass.
    const clock = new BotClockFence(() => this.store.now(), this.monotonicClock)
    const checkClock = () => {
      try {
        clock.assert()
      } catch (error) {
        controller.abort(error)
      }
      signal.throwIfAborted()
    }
    const deadline = setTimeout(
      () => controller.abort(new Error("记忆整理超时")),
      MEMORY_SYNTHESIS_DEADLINE_MS
    )
    // A deletion, correction, disable or Bot configuration edit revokes an in-flight pass.
    const fence = setInterval(() => {
      if (!clock.heartbeat()) controller.abort(new Error("系统时间变化或休眠中断了记忆整理"))
      if (!this.store.memory.isCurrent(snapshot)) controller.abort(new Error("记忆已变化"))
    }, 250)
    let begun = false
    try {
      const model = await this.models(snapshot.botId, signal)
      checkClock()
      const system =
        synthesisSystemPrompt() +
        "\n" +
        MEMORY_RETENTION_POLICY +
        "\nNever store passwords, API keys, access tokens or authentication codes. Assistant statements alone do not establish externally verified outcomes; retain uncertainty and require rechecking source systems for consequential decisions."
      const today = currentDate(this.store.now())
      // Remove whole newest evidence items from this pass only. Their durable queue
      // entries and attempt counts remain untouched, including across Host restart.
      // Existing memories are never silently dropped to make a proposal fit.
      if (model.fits) {
        const sources = snapshot.sources
        while (
          !model.fits(system, {
            today,
            currentMemories: snapshot.memories,
            newEvidence: snapshot.evidence
          })
        ) {
          if (snapshot.evidence.length <= 1) throw memoryContextLimitError()
          snapshot = { ...snapshot, evidence: snapshot.evidence.slice(0, -1) }
        }
        const ids = new Set(snapshot.evidence.map((item) => item.id))
        snapshot = {
          ...snapshot,
          sources: sources.filter((item) => ids.has(item.runId))
        }
      }
      if (!this.store.memory.begin(snapshot)) return
      begun = true
      const data = {
        today,
        currentMemories: snapshot.memories,
        newEvidence: snapshot.evidence
      }
      const raw = await model.complete(system, data, signal, "synthesis")
      checkClock()
      const parsed = parseMemorySynthesisChanges(parseJsonObject(raw))
      if (
        !parsed ||
        !usesKnownEvidence(new Set(snapshot.evidence.map((e) => e.id)), parsed, snapshot.temporal)
      ) {
        this.store.memory.failed(snapshot, "invalid-output")
        return
      }
      const changes = normalizedChanges(parsed)
      if (changes.some((c) => c.action !== "remove" && !c.content)) {
        this.store.memory.failed(snapshot, "invalid-output")
        return
      }
      // Independent request: no proposal conversation, tool access or hidden chain of thought.
      if (changes.length) {
        const verdict = parseJsonObject(
          await model.complete(
            verificationSystemPrompt() + "\n" + MEMORY_RETENTION_POLICY,
            {
              today: data.today,
              currentMemories: snapshot.memories,
              evidence: snapshot.evidence,
              proposedChanges: changes
            },
            signal,
            "verification"
          )
        )
        checkClock()
        if (verdict?.approved !== true) {
          this.store.memory.failed(snapshot, "rejected")
          return
        }
      }
      await model.assertCurrent()
      checkClock()
      const outcome = this.store.memory.commit(snapshot, changes)
      if (outcome === "stale") this.store.memory.stale(snapshot)
      if (outcome === "invalid-output") this.store.memory.failed(snapshot, outcome)
      this.lastError = null
    } catch (error) {
      if (!this.store.memory.isCurrent(snapshot)) {
        if (begun) this.store.memory.stale(snapshot)
      } else if (error instanceof BotDomainError && error.code === "model_usage_budget") {
        this.store.memory.deferForBudget(snapshot, begun)
      } else if (!this.lifetime.signal.aborted) {
        // Configuration/preflight failures are bounded too, but must not consume
        // attempts for evidence that was omitted from a successfully selected batch.
        if (!begun) this.store.memory.begin(snapshot)
        const failure = serializeBotFailure(error)
        const committed = this.store.memory.failed(
          snapshot,
          signal.aborted
            ? "interrupted"
            : error instanceof BotDomainError && error.code === "memory_context_limit"
              ? "context-limit"
              : "failed",
          failure.diagnostic
        )
        if (committed && !signal.aborted) {
          this.lastError = failure.message
          reportBotBackgroundFailure(
            this.failureReporter,
            {
              dataEpoch,
              episodeId,
              groupKey: "synthesis",
              source: "memory",
              title: "记忆整理未完成",
              botId: snapshot.botId
            },
            error
          )
        }
      }
    } finally {
      clearTimeout(deadline)
      clearInterval(fence)
    }
  }
  async close() {
    clearInterval(this.timer)
    this.timer = undefined
    this.lifetime.abort(new Error("Bot 后台正在停止"))
    await this.active
  }
}
