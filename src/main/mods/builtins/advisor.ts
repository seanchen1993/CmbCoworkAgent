import { createHash } from "node:crypto"
import type { BuiltinAdvisorView } from "../../../shared/mods/builtin-advisor"
import type { BuiltinRunOverview } from "../../../shared/mods/builtins"

export interface AdvisorScope {
  threadId: string
  workspace: string
  incarnation: string
  assertCurrent(): void
  /** Host facts only; excludes this advisor's own calls to prevent self-triggered invalidation. */
  factsIdentity?(): string
}
interface Settings {
  getSetting(key: string, fallback?: string): string
  compareAndSetSetting(key: string, expected: string | undefined, value: string): boolean
}
export interface AdvisorModelResult {
  text: string
  inputTokens?: number
  outputTokens?: number
}
export const ADVISOR_LIMITS = {
  dailyCalls: 10,
  cooldownMs: 60_000,
  outputTokens: 512,
  timeoutMs: 30_000
}
interface Entry {
  enabled: boolean
  nextAllowedAt: number
  controller?: AbortController
  result?: BuiltinAdvisorView["result"]
  settled?: Promise<void>
  resultFacts?: string
  dismissedFacts?: string
}
/** Optional, explicitly requested analysis. No tools, automatic retries, business writes or chat messages. */
export class BuiltinProjectAdvisor {
  private entries = new Map<string, Entry>()
  constructor(
    private readonly settings: Settings,
    private readonly now = () => Date.now()
  ) {}
  private key(scope: AdvisorScope) {
    return createHash("sha256")
      .update(JSON.stringify([scope.threadId, scope.workspace, scope.incarnation]))
      .digest("hex")
  }
  private entry(scope: AdvisorScope) {
    scope.assertCurrent()
    const key = this.key(scope)
    let entry = this.entries.get(key)
    if (!entry) {
      if (this.entries.size >= 64) {
        const disposable = [...this.entries].find(
          ([, value]) => !value.controller && !value.enabled
        )
        if (!disposable) throw Error("ADVISOR_SCOPE_LIMIT")
        this.entries.delete(disposable[0])
      }
      entry = { enabled: false, nextAllowedAt: 0 }
      this.entries.set(key, entry)
    }
    return entry
  }
  view(scope: AdvisorScope): BuiltinAdvisorView {
    const entry = this.entry(scope)
    if (entry.result && scope.factsIdentity && entry.resultFacts !== scope.factsIdentity())
      entry.result = undefined
    return {
      enabled: entry.enabled,
      running: !!entry.controller,
      ...(entry.result ? { result: structuredClone(entry.result) } : {}),
      nextAllowedAt: entry.nextAllowedAt,
      dailyLimit: ADVISOR_LIMITS.dailyCalls,
      outputTokenLimit: ADVISOR_LIMITS.outputTokens
    }
  }
  enable(scope: AdvisorScope, enabled: boolean) {
    if (typeof enabled !== "boolean") throw Error("ADVISOR_INVALID")
    const entry = this.entry(scope)
    entry.enabled = enabled
    if (!enabled) entry.controller?.abort(Error("ADVISOR_CANCELLED"))
    return this.view(scope)
  }
  async cancel(scope: AdvisorScope) {
    const entry = this.entry(scope)
    entry.controller?.abort(Error("ADVISOR_CANCELLED"))
    await entry.settled
  }
  dismiss(scope: AdvisorScope) {
    const entry = this.entry(scope)
    if (entry.controller) throw Error("ADVISOR_BUSY")
    entry.dismissedFacts = scope.factsIdentity?.()
    entry.result = undefined
    return this.view(scope)
  }
  private reserve() {
    const key = "builtin-project-advisor-daily-budget-v1"
    const raw = this.settings.getSetting(key, "")
    const day = new Date(this.now()).toISOString().slice(0, 10)
    let record = { day, count: 0 }
    if (raw) {
      try {
        const stored = JSON.parse(raw)
        if (
          typeof stored.day !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(stored.day) ||
          !Number.isSafeInteger(stored.count) ||
          stored.count < 0
        )
          throw Error()
        // Clock rollback must not reset the budget.
        if (stored.day >= day) record = stored
      } catch {
        throw Error("ADVISOR_BUDGET_INVALID")
      }
    }
    if (record.count >= ADVISOR_LIMITS.dailyCalls) throw Error("ADVISOR_DAILY_LIMIT")
    const next = JSON.stringify({ day: record.day, count: record.count + 1 })
    if (!this.settings.compareAndSetSetting(key, raw || undefined, next))
      throw Error("ADVISOR_BUDGET_CONFLICT")
  }
  async analyze(
    scope: AdvisorScope,
    overview: BuiltinRunOverview,
    invoke: (facts: string, signal: AbortSignal) => Promise<AdvisorModelResult>,
    signal?: AbortSignal
  ) {
    const entry = this.entry(scope)
    if (!entry.enabled) throw Error("ADVISOR_DISABLED")
    if ([...this.entries.values()].some((value) => value.controller)) throw Error("ADVISOR_BUSY")
    if (this.now() < entry.nextAllowedAt) throw Error("ADVISOR_COOLDOWN")
    if (overview.threadId !== scope.threadId || overview.workspace !== scope.workspace)
      throw Error("ADVISOR_SCOPE_CHANGED")
    const factsIdentity = scope.factsIdentity?.()
    if (
      factsIdentity &&
      (entry.dismissedFacts === factsIdentity ||
        (entry.result && entry.resultFacts === factsIdentity))
    )
      return this.view(scope)
    // Only bounded host-generated counts. No prompts, source files, paths, credentials or plugin prose.
    const facts = JSON.stringify({
      scope: overview.metrics.scope,
      retainedCalls: overview.metrics.sampled,
      succeeded: overview.metrics.succeeded,
      failed: overview.metrics.failed,
      running: overview.metrics.running,
      unknown: overview.metrics.unknown,
      outputBlocked: overview.policy.recordedBlocks,
      truncatedHistory: overview.metrics.limited,
      instructionObservation: overview.instructions.status,
      project: overview.project ?? { state: "unavailable" }
    })
    if (facts.length > 2000) throw Error("ADVISOR_INPUT_LIMIT")
    scope.assertCurrent()
    this.reserve()
    const controller = new AbortController()
    entry.controller = controller
    let settle!: () => void
    entry.settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    entry.nextAllowedAt = this.now() + ADVISOR_LIMITS.cooldownMs
    const combined = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(ADVISOR_LIMITS.timeoutMs),
      ...(signal ? [signal] : [])
    ])
    try {
      const result = await invoke(facts, combined)
      combined.throwIfAborted()
      scope.assertCurrent()
      if (factsIdentity && scope.factsIdentity?.() !== factsIdentity)
        throw Error("ADVISOR_FACTS_CHANGED")
      if (!entry.enabled || this.entries.get(this.key(scope)) !== entry)
        throw Error("ADVISOR_SCOPE_CHANGED")
      if (typeof result.text !== "string" || !result.text.trim() || result.text.length > 6000)
        throw Error("ADVISOR_OUTPUT_INVALID")
      const tokens = (value?: number) =>
        Number.isSafeInteger(value) && value! >= 0 ? value! : null
      entry.result = {
        text: result.text.trim(),
        at: this.now(),
        inputTokens: tokens(result.inputTokens),
        outputTokens: tokens(result.outputTokens)
      }
      entry.resultFacts = factsIdentity
      entry.controller = undefined
      return this.view(scope)
    } finally {
      if (entry.controller === controller) entry.controller = undefined
      settle()
      entry.settled = undefined
    }
  }
}
