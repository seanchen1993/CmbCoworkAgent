import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type {
  FunctionTurnComplete,
  FunctionTurnStart,
  FunctionTurnUsage
} from "../../../shared/mods/v2/turn"
import { FunctionTurnObservation } from "./turn-observation"

export interface FunctionTurnBinding {
  workspace: string
  threadId: string
  runId: string
  turnId: string
  text: string
  signal: AbortSignal
  cancel(): void
  assertCurrent(): void
}

export interface FunctionChildTurnBinding extends Omit<FunctionTurnBinding, "text" | "cancel"> {
  agentId: string
  parentRunId?: string
}

export interface FunctionChildTurnObserver {
  observe(response: unknown): void
  finish(reason: "answer" | "error"): void
}

type TurnEnding = {
  answer?: string
  reason: "answer" | "aborted" | "error"
  usage?: FunctionTurnUsage
}

interface TurnEntry {
  binding: FunctionTurnBinding | FunctionChildTurnBinding
  startedAt: number
  starting: Promise<void>
  terminal?: FunctionTurnComplete
  dispatching: boolean
  controller: AbortController
  observation: FunctionTurnObservation
  suspended?: boolean
}

export interface FunctionTurnLifecycleHost {
  start(binding: FunctionTurnBinding, input: FunctionTurnStart, signal: AbortSignal): Promise<void>
  complete(
    binding: FunctionTurnBinding | FunctionChildTurnBinding,
    input: FunctionTurnComplete,
    signal: AbortSignal
  ): Promise<void>
  isBusy(threadId: string): boolean
  onIdle(listener: (threadId: string) => void): () => void
  error(error: unknown): void
}

/** Logical turn facts outlive execution authority. Completion never waits while a thread is leased. */
export class FunctionTurnLifecycle {
  private readonly entries = new Map<string, TurnEntry>()
  private readonly running = new Map<string, TurnEntry>()
  private readonly children = new Map<string, TurnEntry>()
  private readonly unsubscribe: () => void
  private closed = false

  constructor(
    private readonly host: FunctionTurnLifecycleHost,
    private readonly now = performance.now.bind(performance)
  ) {
    this.unsubscribe = host.onIdle((threadId) => this.drain(threadId))
  }

  private key(threadId: string, runId: string): string {
    return JSON.stringify([threadId, runId])
  }

  start(binding: FunctionTurnBinding): Promise<void> {
    if (this.closed) return Promise.reject(new ModFunctionError("MODS_TURN_CLOSED"))
    binding.signal.throwIfAborted()
    binding.assertCurrent()
    const key = this.key(binding.threadId, binding.runId)
    const existing = this.entries.get(key)
    if (existing) {
      if (
        "agentId" in existing.binding ||
        existing.binding.turnId !== binding.turnId ||
        existing.binding.workspace !== binding.workspace ||
        existing.terminal
      )
        return Promise.reject(new ModFunctionError("MODS_TURN_SCOPE_CHANGED"))
      return existing.starting
    }
    const previous = this.running.get(binding.threadId)
    if (
      previous?.suspended &&
      previous.binding.turnId === binding.turnId &&
      previous.binding.workspace === binding.workspace
    ) {
      this.entries.delete(this.key(binding.threadId, previous.binding.runId))
      previous.binding = binding
      previous.suspended = false
      this.entries.set(key, previous)
      return previous.starting
    }
    if (previous?.suspended)
      this.finish(binding.threadId, previous.binding.runId, { reason: "aborted" })
    if (this.entries.size >= 100) return Promise.reject(new ModFunctionError("MODS_TURN_CAPACITY"))
    const entry: TurnEntry = {
      binding,
      startedAt: this.now(),
      starting: Promise.resolve(),
      dispatching: false,
      controller: new AbortController(),
      observation: new FunctionTurnObservation()
    }
    this.entries.set(key, entry)
    this.running.set(binding.threadId, entry)
    // Set identity before any hook runs; retries reuse this start even if an optional hook failed.
    entry.starting = Promise.resolve().then(() => {
      entry.controller.signal.throwIfAborted()
      return this.host.start(
        binding,
        {
          text: binding.text,
          turnId: binding.turnId
        },
        entry.controller.signal
      )
    })
    return entry.starting
  }

  /** Qos/mzn: a child has its own turn, no start event and no dependency on its parent's lease. */
  startChild(binding: FunctionChildTurnBinding): FunctionChildTurnObserver {
    if (this.closed) throw new ModFunctionError("MODS_TURN_CLOSED")
    binding.signal.throwIfAborted()
    binding.assertCurrent()
    const key = this.key(binding.threadId, binding.runId)
    if (this.entries.has(key)) throw new ModFunctionError("MODS_TURN_SCOPE_CHANGED")
    if (this.entries.size >= 100) throw new ModFunctionError("MODS_TURN_CAPACITY")
    const entry: TurnEntry = {
      binding,
      startedAt: this.now(),
      starting: Promise.resolve(),
      dispatching: false,
      controller: new AbortController(),
      observation: new FunctionTurnObservation()
    }
    this.entries.set(key, entry)
    this.children.set(this.key(binding.threadId, binding.agentId), entry)
    return {
      observe: (response) => {
        if (this.entries.get(key) !== entry || entry.terminal) return
        binding.assertCurrent()
        entry.observation.observe(response)
      },
      finish: (reason) => {
        if (this.entries.get(key) === entry) this.finishEntry(entry, { reason })
      }
    }
  }

  observeChildStream(
    threadId: string,
    parentRunId: string,
    agentId: string,
    payload: unknown,
    mode: "delta" | "snapshot"
  ): void {
    const entry = this.children.get(this.key(threadId, agentId))
    if (
      !entry ||
      entry.terminal ||
      !("agentId" in entry.binding) ||
      entry.binding.parentRunId !== parentRunId
    )
      return
    entry.binding.assertCurrent()
    entry.observation.observeStream(payload, mode)
  }

  abort(workspace: string, threadId: string, turnId: string): void {
    const entry = this.running.get(threadId)
    if (!entry || entry.terminal || entry.suspended || "agentId" in entry.binding)
      throw new ModFunctionError("MODS_TURN_NOT_RUNNING")
    if (entry.binding.workspace !== workspace || entry.binding.turnId !== turnId)
      throw new ModFunctionError("MODS_TURN_SCOPE_CHANGED")
    if (entry.binding.signal.aborted) throw new ModFunctionError("MODS_TURN_ENDING")
    entry.binding.assertCurrent()
    entry.binding.cancel()
  }

  observe(threadId: string, runId: string, response: unknown): void {
    const entry = this.running.get(threadId)
    if (!entry || entry.binding.runId !== runId || entry.terminal || entry.suspended) return
    entry.binding.assertCurrent()
    entry.observation.observe(response)
  }

  suspend(threadId: string, runId: string): void {
    const entry = this.entries.get(this.key(threadId, runId))
    if (entry && !entry.terminal) entry.suspended = true
  }

  observeStream(
    threadId: string,
    runId: string,
    payload: unknown,
    mode: "delta" | "snapshot"
  ): void {
    const entry = this.running.get(threadId)
    if (!entry || entry.binding.runId !== runId || entry.terminal || entry.suspended) return
    entry.binding.assertCurrent()
    entry.observation.observeStream(payload, mode)
  }

  finish(threadId: string, runId: string, result: TurnEnding): void {
    const entry = this.entries.get(this.key(threadId, runId))
    if (entry) this.finishEntry(entry, result)
  }

  private clearActive(entry: TurnEntry): void {
    const { threadId } = entry.binding
    if (this.running.get(threadId) === entry) this.running.delete(threadId)
    if ("agentId" in entry.binding) {
      const key = this.key(threadId, entry.binding.agentId)
      if (this.children.get(key) === entry) this.children.delete(key)
    }
  }

  private finishEntry(entry: TurnEntry, result: TurnEnding): void {
    if (!entry || entry.terminal) return
    const { threadId, runId } = entry.binding
    let observation: ReturnType<FunctionTurnObservation["snapshot"]>
    try {
      observation = entry.observation.snapshot()
    } catch (error) {
      this.entries.delete(this.key(threadId, runId))
      this.clearActive(entry)
      entry.controller.abort(error)
      this.host.error(error)
      return
    }
    const { refusal, ...facts } = observation
    const ending =
      entry.binding.signal.aborted || result.reason === "aborted"
        ? { reason: "aborted" as const }
        : refusal
          ? { reason: "refusal" as const, refusal }
          : { reason: result.reason }
    entry.terminal = {
      ...facts,
      ...result,
      ...ending,
      turnId: entry.binding.turnId,
      ...("agentId" in entry.binding ? { agentId: entry.binding.agentId } : {}),
      durationMs: Math.max(0, this.now() - entry.startedAt),
      isAborted: ending.reason === "aborted"
    }
    this.clearActive(entry)
    if ("agentId" in entry.binding) this.dispatch(entry, false)
    else this.drain(threadId)
  }

  private drain(threadId: string): void {
    if (this.closed || this.host.isBusy(threadId)) return
    // Preserve completion ordering within one session, without a cross-session lock.
    const candidates = [...this.entries.values()].filter(
      (entry) =>
        entry.binding.threadId === threadId && entry.terminal && !("agentId" in entry.binding)
    )
    if (candidates.some((entry) => entry.dispatching)) return
    const entry = candidates[0]
    if (!entry) return
    this.dispatch(entry, true)
  }

  private dispatch(entry: TurnEntry, waitForIdle: boolean): void {
    const { threadId } = entry.binding
    entry.dispatching = true
    void entry.starting
      .catch(() => {})
      .then(async () => {
        entry.controller.signal.throwIfAborted()
        // An async startup may have allowed another physical run to claim the thread.
        if (waitForIdle && this.host.isBusy(threadId)) return
        await this.host.complete(entry.binding, entry.terminal!, entry.controller.signal)
        if (this.entries.get(this.key(threadId, entry.binding.runId)) === entry)
          this.entries.delete(this.key(threadId, entry.binding.runId))
      })
      .catch((error) => {
        if (this.entries.get(this.key(threadId, entry.binding.runId)) === entry)
          this.entries.delete(this.key(threadId, entry.binding.runId))
        if (!entry.controller.signal.aborted) this.host.error(error)
      })
      .finally(() => {
        entry.dispatching = false
        this.drain(threadId)
      })
  }

  invalidate(workspace?: string, threadId?: string): void {
    for (const [key, entry] of this.entries) {
      if (workspace && entry.binding.workspace !== workspace) continue
      if (threadId && entry.binding.threadId !== threadId) continue
      entry.controller.abort(new ModFunctionError("MODS_TURN_SCOPE_CHANGED"))
      this.entries.delete(key)
      this.clearActive(entry)
    }
  }

  close(): void {
    this.closed = true
    this.unsubscribe()
    this.invalidate()
  }

  get stats() {
    return { entries: this.entries.size, running: this.running.size }
  }
}

/** Frozen upstream hdr/XFs counts admitted attempts, including a wrong or already-ended turn id. */
export class FunctionTurnAbortBudget {
  private readonly attempts = new Map<string, { count: number; lastAt: number }>()
  constructor(private readonly now = performance.now.bind(performance)) {}

  take(plugin: string): void {
    const previous = this.attempts.get(plugin) ?? { count: 0, lastAt: -Infinity }
    if (previous.count >= 50) throw new ModFunctionError("MODS_TURN_ABORT_BUDGET")
    const now = this.now()
    if (now - previous.lastAt < 2000) throw new ModFunctionError("MODS_TURN_ABORT_RATE")
    this.attempts.set(plugin, { count: previous.count + 1, lastAt: now })
  }
}
