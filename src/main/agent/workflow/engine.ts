import { promises as fsp, readFileSync, statSync } from "fs"
import { dirname, isAbsolute } from "path"
import fastGlob from "fast-glob"
import { runWorkflowScriptInSandbox } from "./sandbox"
import { validateWorkflowScript, MAX_WORKFLOW_SCRIPT_BYTES } from "./script"
import { sha256Hex, type WorkflowRunStore } from "./run-store"
import { resolveExistingWorkspacePath, resolveWorkspaceWritePath } from "./paths"
import { assertSupportedJsonSchema } from "./json-schema"
import { loadAgentProfiles, resolveProfileFromList } from "../agent-registry"
import {
  WORKFLOW_LOG_MAX_CHARS,
  WORKFLOW_MAX_AGENT_INVOCATIONS,
  WORKFLOW_MAX_COLLECTION_ITEMS,
  WORKFLOW_MAX_LOG_LINES,
  WORKFLOW_MAX_TOTAL_AGENTS,
  WORKFLOW_PROMPT_PREVIEW_MAX_CHARS,
  WORKFLOW_RESULT_MAX_CHARS,
  WORKFLOW_RESULT_PREVIEW_MAX_CHARS,
  WorkflowAbortError,
  WorkflowFatalError,
  WorkflowScriptError,
  describeWorkflowError,
  getWorkflowMaxConcurrency,
  getWorkflowMaxRuntimeMs,
  getWorkflowGlobMax,
  getWorkflowRunWallClockMs,
  isWorkflowAbortError,
  isWorkflowFatalError,
  truncateText,
  type ParsedWorkflowScript,
  type WorkflowAgentFailureReason,
  type WorkflowAgentOptions,
  type WorkflowJournalEntry,
  type WorkflowProgressEmitter,
  type WorkflowRunStats,
  type WorkflowSubagentRunner
} from "./types"

/**
 * Dynamic workflow execution engine.
 *
 * Runs a validated workflow script inside the deterministic sandbox and wires
 * up the orchestration primitives. Electron-free by design: the subagent
 * executor is injected, so the engine is unit-testable with a fake runner.
 *
 * Resume contract: our implementation of Claude Code's documented behavior
 * ("completed agents replay, the rest run live"). Matching is CONTENT-BASED: each
 * `agent()` call replays whenever its call-identity hash (child/prompt/schema/
 * resolved-model) has an unconsumed journal entry, independent of call order. An
 * edited or new call simply misses and runs live; unchanged calls still replay —
 * including under concurrency (pipeline/parallel), where call order differs
 * between the original and resumed runs. (The exact algorithm is not published;
 * this is a faithful reconstruction, not a guaranteed bit-for-bit match.)
 */

export interface WorkflowEngineOptions {
  parsed: ParsedWorkflowScript
  runStore: WorkflowRunStore
  args?: unknown
  tokenBudget?: number | null
  subagentRunner: WorkflowSubagentRunner
  emit: WorkflowProgressEmitter
  signal: AbortSignal
  maxConcurrency?: number
  /** Resolves `workflow({ scriptPath })` to a child script source inside the workspace. */
  workspacePath: string
  /** True while a subagent of this run is blocked on a pending user approval. The
   * inactivity watchdog treats such a run as waiting (not hung), so a background
   * run doesn't lose its work to the backstop while the user is away from an
   * approval prompt. */
  isAwaitingApproval?: () => boolean
  /** The thread's session-default model — what a subagent actually runs on when an
   * agent()/phase/profile specifies NO model (subagent.ts falls back to
   * deps.defaultModelId). It MUST fold into the call-identity hash: a resume after
   * the user switched the thread's model would otherwise replay the OLD default
   * model's cached result instead of re-running on the new one. (#1) */
  defaultModelId?: string
  /** Run-level exclusive file-write lock, shared with this run's subagent tool
   * writes (both keyed on the parent threadId). Injected so a script writeFile() and
   * a concurrent agent()'s tool write serialize TOGETHER instead of each in its own
   * silo (fileWriteChain vs the tool-concurrency lock). Falls back to the local chain
   * when absent (unit harness / embedded caller). (#2) */
  runExclusiveFileWrite?: <T>(fn: () => Promise<T>) => Promise<T>
}

export interface WorkflowEngineResult {
  status: "completed" | "error" | "aborted"
  result?: unknown
  error?: string
  /** Non-fatal advisory (e.g. completed but ran 0 agents). */
  warning?: string
  stats: WorkflowRunStats
}

interface SharedRuntime {
  limiter: <T>(fn: () => Promise<T>) => Promise<T>
  pendingAgentRuns: Set<Promise<unknown>>
  /** Total agent() invocations including failed/parked ones (drain/loop backstop). */
  invocations: number
  /** True once the invocation ceiling parked a call — the run did NOT do its work. */
  invocationCapHit: boolean
  /** Set once the script body returns: any agent() settling AFTER this is
   * fire-and-forget, so a fatal from it can be promoted without misclassifying a
   * fatal the script itself awaited and caught (which settles before this). */
  scriptReturned: boolean
  /** First fire-and-forget fatal (budget/agent-cap) seen — its rejection is
   * otherwise swallowed by suppressUnhandled, so record it to fail the run. */
  fatalError: Error | null
  agentCount: number
  agentsCached: number
  agentsFailed: number
  outputTokens: number
  depth: number
  callSeq: number
}

// Process-wide concurrency ceiling shared by ALL runs + nested children, so
// multiple concurrent workflow runs cannot sum past the cap and overwhelm a
// rate-limited backend. A per-run maxConcurrency only NARROWS a run's own limiter;
// it can never raise this global ceiling. Lazy-init so the env knob is read once.
let globalConcurrencyLimiter: ReturnType<typeof createLimiter> | null = null
function getGlobalConcurrencyLimiter(): ReturnType<typeof createLimiter> {
  if (!globalConcurrencyLimiter) {
    globalConcurrencyLimiter = createLimiter(getWorkflowMaxConcurrency())
  }
  return globalConcurrencyLimiter
}

export async function runWorkflowEngine(
  options: WorkflowEngineOptions
): Promise<WorkflowEngineResult> {
  const startedAt = Date.now()
  const runId = options.runStore.state.runId
  // Per-run limiter (NARROWable via maxConcurrency) composed UNDER the global
  // ceiling: a run is bounded by min(its own cap, the process-wide cap), and
  // concurrent runs can't collectively exceed the global cap. Order matters —
  // take the per-run slot FIRST, then the global slot, so a per-run-saturated run
  // doesn't hold a global slot while it queues.
  const perRunLimiter = createLimiter(options.maxConcurrency ?? getWorkflowMaxConcurrency())
  const shared: SharedRuntime = {
    limiter: <T>(fn: () => Promise<T>): Promise<T> =>
      perRunLimiter(() => getGlobalConcurrencyLimiter()(fn)),
    pendingAgentRuns: new Set(),
    invocations: 0,
    invocationCapHit: false,
    scriptReturned: false,
    fatalError: null,
    agentCount: 0,
    agentsCached: 0,
    agentsFailed: 0,
    outputTokens: 0,
    depth: 0,
    callSeq: 0
  }
  // Content-based replay (official semantics): index the journal by call-identity
  // HASH, not by call index. A resumed agent() replays whenever its hash has an
  // unconsumed journal entry — independent of call ORDER. That is what keeps a
  // concurrent pipeline (whose stage>=2 call order differs between the original
  // run's real latency and the resumed run's instant cache) at 100% cache-hit.
  // The same hash appearing N times → N entries consumed in arrival order (their
  // results are interchangeable, being the same input).
  const resumed = options.runStore.state.journal.length > 0
  const availableByHash = new Map<string, WorkflowJournalEntry[]>()
  for (const entry of options.runStore.state.journal) {
    const bucket = availableByHash.get(entry.hash)
    if (bucket) bucket.push(entry)
    else availableByHash.set(entry.hash, [entry])
  }
  // Append-only journal (mirrors MiMo-Code's crash-safe resume): on resume we do
  // NOT clear the seeded journal. Clearing it ("read into memory → wipe disk →
  // rebuild") opens a window where a crash AFTER the wipe but BEFORE the rebuild
  // loses ALL cached results, forcing every already-finished agent to re-run —
  // and for a file-editing subagent that re-applies non-idempotent edits onto an
  // already-modified workspace. Instead the disk journal is kept: cache hits do
  // NOT re-append (see the replay branch) and only LIVE calls append fresh, so the
  // file grows monotonically with no DUPLICATE entries. A CHANGED script or changed
  // args already drops the journal upstream (tool.ts → effectiveResumeJournal=
  // undefined). It is NOT strictly "no stale tail": a same-script run whose control
  // flow depends on workspace state (e.g. a file it reads changed) can take a
  // different branch and leave a prior entry whose hash the current run never looks
  // up — that entry is harmless (never consumed), it just lingers. Correctness
  // holds; only the on-disk byte size can drift.

  const stats = (): WorkflowRunStats => ({
    agentsTotal: shared.agentCount,
    agentsCached: shared.agentsCached,
    agentsFailed: shared.agentsFailed,
    outputTokens: shared.outputTokens,
    durationMs: Date.now() - startedAt
  })

  const finalize = async (
    status: "completed" | "error" | "aborted",
    result: unknown,
    error?: string,
    warning?: string,
    hadUnawaitedThenable = false
  ): Promise<WorkflowEngineResult> => {
    // A completed run whose return value carries an unawaited Promise would
    // serialize to {} silently — flag it so the empty result isn't mistaken for a
    // real one (the script almost certainly forgot an `await`). Detection happens
    // IN the vm (sandbox serializeScriptResult): by the time the value reaches
    // here it is already plain JSON and the Promise is gone.
    let effectiveWarning = warning
    if (status === "completed" && hadUnawaitedThenable) {
      const promiseWarning =
        "the return value contains a Promise that was never awaited — it serializes to {} (did you forget an `await`?)"
      effectiveWarning = effectiveWarning
        ? `${effectiveWarning}; ${promiseWarning}`
        : promiseWarning
    }
    const runStats = stats()
    options.runStore.update((run) => {
      run.status = status
      run.error = error
      run.warning = effectiveWarning
      run.result = boundJsonSafe(result, WORKFLOW_RESULT_MAX_CHARS)
      run.stats = runStats
      run.completedAt = new Date().toISOString()
      // No agent stays "running" in a settled run file.
      for (const agentRecord of run.agents) {
        if (agentRecord.status === "running") {
          agentRecord.status = status === "completed" ? "completed" : "error"
          agentRecord.error = agentRecord.error ?? (status === "completed" ? undefined : "aborted")
          agentRecord.endedAt = new Date().toISOString()
        }
      }
    })
    // Await the final durable write before announcing the run finished, so a
    // reader (the notification builder) always sees the persisted terminal state.
    await options.runStore.flush()
    options.emit({
      kind: "finished",
      runId,
      status,
      error,
      warning: effectiveWarning,
      stats: runStats
    })
    return { status, result, error, warning: effectiveWarning, stats: runStats }
  }

  // Engine-owned lifetime signal: follows the caller's signal, and is also
  // fired when the script settles with an error so in-flight fire-and-forget
  // subagents are cancelled instead of burning tokens for a dead run.
  const lifetime = new AbortController()
  const onCallerAbort = (): void => lifetime.abort()
  if (options.signal.aborted) lifetime.abort()
  else options.signal.addEventListener("abort", onCallerAbort, { once: true })

  // INACTIVITY backstop (not a total-runtime cap — legitimate runs span hours):
  // every progress event resets the clock; a run with NO events for the whole
  // window is treated as hung (e.g. a stuck await loop) and aborted. The window
  // exceeds the per-subagent timeout, so a slow-but-alive agent always produces
  // an agent_end (or timeout error) before it expires. Fires lifetime.abort();
  // raceWithAbort then unblocks the engine.
  // NOTE: this is a setInterval timer, so it cannot fire if the event loop
  // itself is starved. The vm sync timeout only bounds the script's FIRST
  // synchronous segment (top-level code before the first await); any synchronous
  // loop AFTER an await — whether an adversarial microtask spin (`while(true)
  // await null`) or just a buggy unguarded `while(cond){...}` continuation —
  // runs on the main event loop with no timeout and would freeze the whole app
  // (this watchdog included). agent() loops are protected by the setImmediate
  // yield in runAgent, but the engine cannot defend against every script body.
  // A true fix requires running the script off-thread (worker) so a hung
  // continuation can be killed; that is deferred (see run-manager notes).
  const inactivityWindowMs = getWorkflowRunWallClockMs()
  let lastActivityAt = Date.now()
  let timedOut = false
  let timeoutReason: "inactivity" | "runtime" = "inactivity"
  const emitWithHeartbeat: WorkflowProgressEmitter = (event) => {
    lastActivityAt = Date.now()
    options.emit(event)
  }
  const inactivityTimer = setInterval(() => {
    if (Date.now() - lastActivityAt > inactivityWindowMs) {
      // A run blocked ONLY on a pending user approval isn't hung — it's correctly
      // waiting for input. Don't abort it (reset the clock instead), or a
      // background run whose agent needs an approval the absent user hasn't
      // answered would lose all its completed work to this backstop. An individual
      // stuck agent is still bounded by the per-subagent timeout.
      if (options.isAwaitingApproval?.()) {
        lastActivityAt = Date.now()
        return
      }
      timedOut = true
      lifetime.abort()
      clearInterval(inactivityTimer)
    }
  }, 30_000)
  inactivityTimer.unref?.()

  // TOTAL-runtime backstop, ABOVE the inactivity window: a run that keeps emitting
  // (so inactivity never trips) but never converges is still bounded. Same macrotask
  // caveat as the inactivity timer — it cannot fire if the event loop is starved by
  // a post-await sync loop (that needs off-thread execution); it bounds long-but-alive runs.
  const maxRuntimeMs = getWorkflowMaxRuntimeMs()
  const runtimeDeadlineTimer = setTimeout(() => {
    timedOut = true
    timeoutReason = "runtime"
    lifetime.abort()
  }, maxRuntimeMs)
  runtimeDeadlineTimer.unref?.()

  const drainPendingAgents = async (): Promise<void> => {
    // A script may fire agent() calls without awaiting them; their results are
    // already journaled as they land, but finalize must not race their events.
    // Loop with a FRESH snapshot each round, and only conclude after one full
    // macrotask of quiescence — a settling agent's .then chain registers its
    // follow-up agent() marker in a microtask that can otherwise slip past a
    // plain size check. Once the run is aborted, new agent() calls park (their
    // markers release), so a fire-and-forget spawn chain converges here too.
    for (;;) {
      if (shared.pendingAgentRuns.size > 0) {
        await Promise.allSettled(Array.from(shared.pendingAgentRuns))
        continue
      }
      await new Promise<void>((resolveTick) => setImmediate(resolveTick))
      if (shared.pendingAgentRuns.size === 0) return
    }
  }

  const timeoutMessage = (): string =>
    timeoutReason === "runtime"
      ? `Workflow aborted after exceeding the ${Math.round(maxRuntimeMs / 60000)} min total-runtime limit`
      : `Workflow aborted after ${Math.round(inactivityWindowMs / 60000)} min with no progress (hung script)`

  try {
    // Emit `started` BEFORE building globals: buildWorkflowGlobals syncs the
    // default phase and fires a `phase` event for it (top-level and child). If
    // `started` (which resets the live currentPhase to null) ran AFTER that, it
    // would clobber the highlight for a top-level run's first declared phase (P3
    // live fix). `started` only needs meta, not the globals, so this is safe.
    emitWithHeartbeat({
      kind: "started",
      runId,
      name: options.parsed.meta.name,
      description: options.parsed.meta.description,
      phases: (options.parsed.meta.phases ?? []).map((phase) => phase.title),
      resumed
    })
    const globals = buildWorkflowGlobals({
      ...options,
      emit: emitWithHeartbeat,
      signal: lifetime.signal,
      shared,
      availableByHash,
      runId
    })
    const scriptResult = await runWorkflowScriptInSandbox({
      body: options.parsed.body,
      globals,
      signal: lifetime.signal
    })
    // The script body has returned; any agent() still settling during the drain is
    // fire-and-forget, so a fatal from it should fail the run (see shared.fatalError).
    shared.scriptReturned = true
    await drainPendingAgents()
    // A late abort during the drain (caller cancel or inactivity) must not be
    // mislabeled "completed" — the run was cut short even though the script
    // returned a value.
    if (lifetime.signal.aborted) {
      return await finalize("aborted", undefined, timedOut ? timeoutMessage() : "Workflow aborted")
    }
    // A runaway agent() loop that blew past the invocation ceiling parked its
    // calls and did NOT run them — the script may still "return", but reporting
    // "completed" would be a silent lie. Fail it loudly.
    if (shared.invocationCapHit) {
      return await finalize(
        "error",
        undefined,
        `agent invocation ceiling (${WORKFLOW_MAX_AGENT_INVOCATIONS}) exceeded — a runaway loop called agent() far more times than the ${WORKFLOW_MAX_TOTAL_AGENTS}-agent cap allows; those calls were not run. Restructure the script (bound the loop / await results) before retrying.`
      )
    }
    // A fire-and-forget agent() that hit a fatal (token budget / agent cap)
    // recorded it here — its rejection was swallowed, so the script could still
    // "return" cleanly. Promote the run to error instead of a misleading "completed".
    if (shared.fatalError) {
      return await finalize("error", undefined, describeWorkflowError(shared.fatalError))
    }
    // Completed but nothing actually ran (and nothing replayed from cache): the
    // workflow did no real work. Keep it completed (the script may legitimately
    // short-circuit on empty input) but flag it so the outcome isn't silent.
    const warning =
      shared.agentCount === 0 && shared.agentsCached === 0
        ? "this workflow completed without running any agent() — if that is unexpected, the script returned before doing work"
        : undefined
    return await finalize(
      "completed",
      scriptResult.value,
      undefined,
      warning,
      scriptResult.hadUnawaitedThenable
    )
  } catch (error) {
    lifetime.abort()
    await drainPendingAgents()
    if (timedOut) {
      return await finalize("aborted", undefined, timeoutMessage())
    }
    if (isWorkflowAbortError(error) || options.signal.aborted) {
      return await finalize("aborted", undefined, "Workflow aborted")
    }
    const message = describeWorkflowError(error)
    return await finalize("error", undefined, message)
  } finally {
    clearInterval(inactivityTimer)
    clearTimeout(runtimeDeadlineTimer)
    options.signal.removeEventListener("abort", onCallerAbort)
    // Run settled — abort the lifetime so buildWorkflowGlobals cancels any timer
    // the script left pending. Normal completion does NOT abort on its own, so
    // without this a stray setTimeout would leak and keep the event loop alive.
    lifetime.abort()
  }
}

interface GlobalsContext extends WorkflowEngineOptions {
  shared: SharedRuntime
  /** Journal entries bucketed by call-identity hash, consumed on replay. */
  availableByHash: Map<string, WorkflowJournalEntry[]>
  runId: string
  /** Set for nested workflow() children: the fixed phase-label prefix (display only). */
  childName?: string
  /** Set for nested workflow() children: sha of the child's SCRIPT, folded into the
   * call-identity hash so two different child files sharing the SAME meta.name don't
   * cross-hit each other's journal cache (#5). */
  childCacheKey?: string
}

/**
 * Upper bound on a script `setTimeout` delay. A longer sleep would just trip the
 * inactivity backstop anyway; clamping keeps a pathological `setTimeout(fn, 1e15)`
 * from registering a far-future timer.
 */
const WORKFLOW_MAX_SCRIPT_TIMER_MS = 5 * 60 * 1000

function buildWorkflowGlobals(context: GlobalsContext): Record<string, unknown> {
  const { shared, runId, emit, signal, runStore } = context
  const meta = context.parsed.meta
  const tokenBudget = context.tokenBudget ?? null
  // Load the agent registry ONCE per run — a fan-out of agentType calls must not
  // re-read .cmbcoworkagent/agents/ on every agent() call. A run therefore sees a
  // stable registry, consistent with the journal/hash contract (mid-run edits to
  // an agent file take effect on the next run, like editing the script would).
  const registryProfiles = loadAgentProfiles(context.workspacePath)
  // Shared resolution (exact, then case-insensitive for built-in NAMES even when
  // user-overridden) so a lowercase `explore` keeps working after an Explore.md
  // override — and identical to the Solo path's resolveAgentProfile.
  const resolveProfile = (name?: string): (typeof registryProfiles)[number] | null =>
    resolveProfileFromList(registryProfiles, name)

  // Agents created before any phase() call group under the first declared phase.
  // For a CHILD workflow the title is prefixed (matching phase() below) so it
  // inherits its OWN meta.phases[0] AND hits that phase's model override (the
  // `childName ▸ title` key registered below) — same as a top-level run, instead
  // of a bare childName that matches no phase entry. Falls back to childName when
  // the child declares no phases.
  const firstPhaseTitle = meta.phases?.[0]?.title
  let currentPhase: string | null = context.childName
    ? firstPhaseTitle
      ? `${context.childName} ▸ ${firstPhaseTitle}`
      : context.childName
    : (firstPhaseTitle ?? null)
  // Sync the default phase into the live run state for BOTH top-level and child
  // runs (P3): a child's first agent — created before the child calls phase() —
  // now hits its model override (currentPhase above), so the panel's current-phase
  // highlight must reflect the same `childName ▸ title` instead of staying on the
  // parent/null. phase() does the same for explicit phases (both prefixed).
  if (currentPhase) {
    runStore.update((run) => {
      run.currentPhase = currentPhase
      if (currentPhase && !run.phases.includes(currentPhase)) run.phases.push(currentPhase)
    })
    // Also drive the LIVE panel: emit a phase event so the renderer's currentPhase
    // (which is workflow_progress-driven, not read from the persisted run) highlights
    // the default phase too — not just phases reached via an explicit phase() call.
    // Fired after `started` (top-level) / after the parent's `started` (child), so
    // it isn't clobbered. Mirrors phase(). (P3 live fix)
    emit({ kind: "phase", runId, title: currentPhase })
  }

  const throwIfAborted = (): void => {
    if (signal.aborted) throw new WorkflowAbortError()
  }

  /**
   * Once the run is aborted, NEW primitive calls park forever instead of
   * throwing. The engine has already returned via its own abort race; throwing
   * here would let a catch-all retry loop in the dead script spin hot on the
   * macrotask queue for the app's lifetime. Parking suspends it at zero cost.
   */
  const parkForever = (): Promise<never> => new Promise<never>(() => {})

  // Phase-level model routing from meta.phases[].model (official semantics:
  // "Add `model` to a phase entry when that phase uses a specific model
  // override"). Child phases are also reachable under their prefixed title.
  const phaseModels = new Map<string, string>()
  for (const metaPhase of meta.phases ?? []) {
    if (!metaPhase.model?.trim()) continue
    phaseModels.set(metaPhase.title, metaPhase.model.trim())
    if (context.childName) {
      phaseModels.set(`${context.childName} ▸ ${metaPhase.title}`, metaPhase.model.trim())
    }
  }

  const budget = Object.freeze({
    total: tokenBudget,
    spent: () => shared.outputTokens,
    remaining: () =>
      tokenBudget == null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, tokenBudget - shared.outputTokens)
  })

  const log = (message: unknown): void => {
    const text = truncateText(String(message), WORKFLOW_LOG_MAX_CHARS)
    runStore.update((run) => {
      run.logs.push(text)
      if (run.logs.length > WORKFLOW_MAX_LOG_LINES) {
        run.logs.splice(0, run.logs.length - WORKFLOW_MAX_LOG_LINES)
      }
    })
    emit({ kind: "log", runId, message: text })
  }

  const phase = (title: unknown): void => {
    if (typeof title !== "string" || !title.trim()) {
      throw new TypeError("phase(title) expects a non-empty string")
    }
    const phaseTitle = context.childName ? `${context.childName} ▸ ${title.trim()}` : title.trim()
    currentPhase = phaseTitle
    runStore.update((run) => {
      run.currentPhase = phaseTitle
      if (!run.phases.includes(phaseTitle)) run.phases.push(phaseTitle)
    })
    emit({ kind: "phase", runId, title: phaseTitle })
  }

  /**
   * Suppresses unhandled-rejection noise for fire-and-forget primitive calls
   * (e.g. `agent(x)` / `parallel([...])` not awaited, then aborted or failed).
   * An awaiting script still observes the rejection through the returned
   * promise — attaching a handler only marks it handled, it does not consume
   * the rejection for other awaiters. Applied to EVERY async primitive.
   */
  const suppressUnhandled = <T extends unknown[], R>(
    impl: (...callArgs: T) => Promise<R>
  ): ((...callArgs: T) => Promise<R>) => {
    return (...callArgs: T): Promise<R> => {
      const promise = impl(...callArgs)
      promise.catch(() => {})
      return promise
    }
  }

  const agent = suppressUnhandled(
    (prompt: unknown, agentOptions?: unknown): Promise<unknown> => runAgent(prompt, agentOptions)
  )

  const runAgent = async (prompt: unknown, agentOptions?: unknown): Promise<unknown> => {
    // Register a lifetime marker SYNCHRONOUSLY at call time, so finalize's
    // drain sees this call even when it is spawned from a late .then chain.
    let release!: () => void
    const marker = new Promise<void>((resolve) => {
      release = resolve
    })
    shared.pendingAgentRuns.add(marker)
    shared.invocations += 1
    try {
      // Yield one macrotask before doing anything. Without this, a script loop
      // around an agent() that settles synchronously (cached replay,
      // budget-exhausted throw) spins purely on the microtask queue and
      // freezes the Electron main process — even the user's abort IPC can't
      // get in. setImmediate callbacks are FIFO, so lexical call order (and
      // with it the resume callSeq) is preserved.
      await new Promise<void>((resolveTick) => setImmediate(resolveTick))
      // Park (never settle) once aborted or past the hard invocation ceiling.
      // Parking — rather than throwing — breaks a fire-and-forget spawn chain
      // (`agent().then(spawn, spawn)`): the never-settling promise stops the
      // chain instead of feeding its catch handler another iteration.
      if (shared.invocations > WORKFLOW_MAX_AGENT_INVOCATIONS) {
        // Mark it so the run finalizes as ERROR, not a silent "completed" with
        // unfinished work — this only fires on a runaway agent() loop.
        shared.invocationCapHit = true
        return parkForever()
      }
      if (signal.aborted) {
        return parkForever()
      }
      return await executeAgentCall(prompt, agentOptions)
    } catch (error) {
      // A fatal (token budget / agent cap) must fail the WHOLE run even when this
      // agent() was fire-and-forget: its rejection is otherwise swallowed by the
      // bridge's suppressUnhandled, and the marker still resolves in `finally`, so
      // the drain's allSettled never sees it and the run would report a misleading
      // "completed". Record the first fatal; still rethrow so an awaiting caller
      // observes it too.
      // Only promote a fatal that lands AFTER the script returned — i.e. a
      // fire-and-forget agent() whose rejection is swallowed. A fatal the script
      // awaited and caught (e.g. a `while(true) await agent()` budget loop that
      // returns partial results) settles BEFORE scriptReturned and stays the
      // script's business — promoting it would wrongly fail a deliberate partial.
      if (isWorkflowFatalError(error) && shared.scriptReturned && !shared.fatalError) {
        shared.fatalError = error instanceof Error ? error : new WorkflowFatalError(String(error))
      }
      throw error
    } finally {
      // Runs before the returned promise is adopted, so even the parked path
      // releases its marker and can never deadlock the drain.
      shared.pendingAgentRuns.delete(marker)
      release()
    }
  }

  const executeAgentCall = async (prompt: unknown, agentOptions?: unknown): Promise<unknown> => {
    const request = normalizeAgentArgs(prompt, agentOptions)

    if (shared.agentCount >= WORKFLOW_MAX_TOTAL_AGENTS) {
      throw new WorkflowFatalError(
        `agent limit exceeded (${WORKFLOW_MAX_TOTAL_AGENTS} agents per workflow run)`
      )
    }
    if (tokenBudget != null && budget.remaining() <= 0) {
      throw new WorkflowFatalError(
        `workflow token budget exhausted (${tokenBudget} tokens) — return the partial results you have`
      )
    }

    // An explicit { phase } gets the same childName prefix phase() applies (P2),
    // so a child's `agent(x, { phase: "Scan" })` lands on the same `childName ▸ Scan`
    // group as the child's own phase("Scan") — hitting the child's model override and
    // not colliding with a parent/sibling "Scan". currentPhase is already prefixed.
    const explicitPhase = request.options.phase
    const assignedPhase = explicitPhase
      ? context.childName
        ? `${context.childName} ▸ ${explicitPhase}`
        : explicitPhase
      : currentPhase
    // Resolve agentType → profile (built-in Explore/Plan/verification or a user
    // file under .cmbcoworkagent/agents/). A known profile contributes a focused
    // role prompt, a tool-access workload, and a default model; an unknown
    // agentType fails closed below so a typo cannot silently run the full-
    // permission default agent.
    const agentProfile = resolveProfile(request.agentType)
    if (request.agentType && !agentProfile) {
      // Fail CLOSED, not open: the script explicitly asked for a specific agent,
      // so a typo or a deleted .cmbcoworkagent/agents/<name>.md must NOT silently
      // downgrade to the default FULL-permission agent (that would drop the
      // intended read-only/no-write restriction). Surface it so the author fixes
      // the name or restores the file. (Case is already tolerated for built-ins
      // by resolveProfile; this only fires for genuinely unknown agents.)
      throw new Error(
        `Unknown agentType "${request.agentType}": no built-in (Explore/Plan/verification) or ` +
          `user agent (.cmbcoworkagent/agents/${request.agentType}.md) matches. Fix the name/case ` +
          `or create the file. Refusing to fall back to a full-permission agent.`
      )
    }
    // Precedence: explicit opts.model > the phase's model override > the profile's
    // default model.
    const resolvedModel =
      request.options.model ??
      (assignedPhase ? phaseModels.get(assignedPhase) : undefined) ??
      agentProfile?.model
    if (request.ignoredIsolation) {
      log(
        `opts.isolation "${request.ignoredIsolation}" is not supported here — running in the shared workspace (file writes are serialized across the run)`
      )
    }
    // Reserve the slot and the resume key synchronously (no await in between),
    // so a parallel() fan-out cannot overshoot the agent cap or race callSeq.
    shared.agentCount += 1
    const callIndex = shared.callSeq++
    const agentIndex = shared.agentCount
    const label = request.options.label?.trim() || defaultAgentLabel(assignedPhase, agentIndex)
    const promptPreview = truncateText(request.prompt, WORKFLOW_PROMPT_PREVIEW_MAX_CHARS)
    // Call-identity hash = the official cache key fields (child/prompt/schema/
    // RESOLVED model). NOTE: phase and label are intentionally EXCLUDED — they do
    // not affect the subagent's output, and (matching official semantics) keeping
    // them out is what lets a reordered/concurrent call still match its journal.
    // The resolved model IS included, so editing a phase's model invalidates that
    // call's cache.
    const callHash = sha256Hex(
      JSON.stringify({
        // Child identity keys on the SCRIPT (childCacheKey), NOT the display name —
        // two child files sharing a meta.name must not share journal cache (#5).
        child: context.childCacheKey ?? null,
        prompt: request.prompt,
        schema: request.options.schema ?? null,
        // resolvedModel === undefined means this agent runs on the SESSION DEFAULT
        // (subagent.ts falls back to deps.defaultModelId). Fold that default in so
        // switching the thread's model invalidates the cache — else a resume
        // replays the old default model's result. (#1)
        model: resolvedModel ?? context.defaultModelId ?? null,
        // A known agentType changes the subagent's role prompt and tool workload,
        // so it MUST be part of the identity — otherwise a resume after editing a
        // call's agentType would wrongly replay the old agent's output. Omitted
        // agentType collapses to null (the default agent); unknown agentTypes
        // fail closed before reaching this hash.
        agentType: agentProfile?.name ?? null,
        // The NAME alone is not enough: a user can edit a same-named agent file
        // (.cmbcoworkagent/agents/<name>.md) to change its role prompt or tool
        // policy — all of which are passed to the subagent (see subagentRunner
        // call: roleSystemPrompt/disallowedTools/shellAccess). Fold the resolved
        // profile's behaviour-affecting fields into the hash so such an edit
        // invalidates the journal entry (resume re-runs instead of replaying the
        // stale agent). model is already covered by `model` (resolvedModel) above.
        agentProfile: agentProfile
          ? {
              systemPrompt: agentProfile.systemPrompt,
              disallowedTools: [...agentProfile.disallowedTools].sort(),
              shellAccess: agentProfile.shellAccess
            }
          : null
      })
    )

    // Content-based replay: consume one journal entry whose hash matches this
    // call's identity, regardless of call index. Index-independence is what makes
    // a concurrent pipeline replay (its stage>=2 call order differs run-to-run).
    const bucket = context.availableByHash.get(callHash)
    const cached = bucket && bucket.length > 0 ? bucket.shift() : undefined
    if (cached) {
      // Replays spend nothing against the token BUDGET (the original run's token
      // count is surfaced for UI/stats only) — but a replay STILL counts against
      // the 1000-agent cap (agentCount was incremented above), since the cap
      // bounds lifetime agents. So resume is "free" for tokens, not for the cap.
      const replayedTokens =
        typeof cached.outputTokens === "number" && Number.isFinite(cached.outputTokens)
          ? cached.outputTokens
          : 0
      shared.agentsCached += 1
      // Append-only journal: a cache HIT does NOT re-append. The seeded entry that
      // produced this hit is already durably on disk (we no longer clear it on
      // resume), so re-appending would only duplicate it. Only LIVE calls append
      // (the else branch below). This is what lets resume avoid the wipe-and-
      // rebuild window — see the journal note at the top of runWorkflowEngine.
      recordAgentState(runStore, {
        index: agentIndex,
        label,
        phase: assignedPhase,
        status: "cached",
        outputTokens: replayedTokens,
        promptPreview,
        resultPreview:
          typeof cached.result === "string"
            ? truncateText(cached.result, WORKFLOW_RESULT_PREVIEW_MAX_CHARS)
            : undefined
      })
      // A replay is instantaneous — one agent_end event keeps a large resume
      // from flooding the renderer with start/end pairs.
      emit({
        kind: "agent_end",
        runId,
        agentIndex,
        label,
        phase: assignedPhase,
        status: "cached",
        outputTokens: replayedTokens,
        durationMs: 0,
        resultPreview:
          typeof cached.result === "string"
            ? truncateText(cached.result, WORKFLOW_RESULT_PREVIEW_MAX_CHARS)
            : undefined
      })
      // Copy on the way out: the journal entry is live persisted state, and a
      // script mutating a replayed object in place must not corrupt it.
      return cached.hasStructured ? toJsonSafe(cached.structured) : cached.result
    }

    const execution = shared.limiter(async () => {
      // The run may have been aborted while this call waited for a slot —
      // don't announce agents that will never start.
      if (signal.aborted) throw new WorkflowAbortError()
      const startedAt = Date.now()
      emit({ kind: "agent_start", runId, agentIndex, label, phase: assignedPhase, promptPreview })
      recordAgentState(runStore, {
        index: agentIndex,
        label,
        phase: assignedPhase,
        status: "running",
        outputTokens: 0,
        promptPreview
      })
      try {
        throwIfAborted()
        const result = await context.subagentRunner({
          prompt: request.prompt,
          schema: request.options.schema,
          model: resolvedModel,
          agentIndex,
          label,
          phase: assignedPhase,
          signal,
          roleSystemPrompt: agentProfile?.systemPrompt,
          disallowedTools: agentProfile?.disallowedTools,
          shellAccess: agentProfile?.shellAccess
        })
        throwIfAborted()

        const text = truncateText(result.text, WORKFLOW_RESULT_MAX_CHARS)
        shared.outputTokens += result.outputTokens
        // Structured payloads can't be truncated without breaking their shape;
        // an oversized one is simply not journaled so the run file stays bounded.
        // With content-based matching, only THIS call re-runs on resume (its hash
        // has no journal entry); other calls are unaffected — no tail is dropped.
        const structuredSafe = request.options.schema ? toJsonSafe(result.structured) : undefined
        const structuredOversized =
          structuredSafe !== undefined &&
          JSON.stringify(structuredSafe).length > WORKFLOW_RESULT_MAX_CHARS
        if (structuredOversized) {
          log(
            `${label}: structured result too large to journal — only this call re-runs on resume (content-based matching; other agents still replay from cache)`
          )
        } else if (result.modelFellBack) {
          // The requested opts.model was unavailable and the runtime fell back to
          // the default. Don't journal: a resume taken after the requested model
          // is available must RE-RUN this call (and use the requested model then),
          // not replay the default-model output as if it were the requested one's.
          log(
            `${label}: requested model fell back to the session default — not journaled, so a resume re-runs it with the requested model if it's available then`
          )
        } else {
          runStore.appendJournal({
            index: callIndex,
            hash: callHash,
            result: text,
            structured: structuredSafe,
            hasStructured: Boolean(request.options.schema),
            outputTokens: result.outputTokens
          })
        }
        recordAgentState(runStore, {
          index: agentIndex,
          label,
          phase: assignedPhase,
          status: "completed",
          outputTokens: result.outputTokens,
          resultPreview: truncateText(result.text, WORKFLOW_RESULT_PREVIEW_MAX_CHARS)
        })
        emit({
          kind: "agent_end",
          runId,
          agentIndex,
          label,
          phase: assignedPhase,
          status: "completed",
          outputTokens: result.outputTokens,
          durationMs: Date.now() - startedAt,
          resultPreview: truncateText(result.text, WORKFLOW_RESULT_PREVIEW_MAX_CHARS)
        })
        // Return the JSON-safe copy (not the raw runner object) so the live
        // path matches the cached-replay path (which returns toJsonSafe too) and
        // never hands a host-realm object to a caller that bypasses the sandbox
        // bridge (e.g. a direct unit test).
        return request.options.schema ? structuredSafe : text
      } catch (error) {
        if (signal.aborted || isWorkflowAbortError(error)) throw new WorkflowAbortError()
        if (isWorkflowFatalError(error)) throw error

        const message = describeWorkflowError(error)
        // Classify the failure for the side-channel agent_end event so the UI/operator
        // can triage WHY agent() returned null without grepping free-text. Does NOT
        // change the null contract. (timeout text comes from subagent.ts; structured_
        // output from the structured-output validator; else generic agent-error.)
        const reason: WorkflowAgentFailureReason = message.includes("timed out")
          ? "timeout"
          : message.includes("structured_output")
            ? "structured-output"
            : "agent-error"
        shared.agentsFailed += 1
        recordAgentState(runStore, {
          index: agentIndex,
          label,
          phase: assignedPhase,
          status: "error",
          error: truncateText(message, 1_000),
          outputTokens: 0
        })
        emit({
          kind: "agent_end",
          runId,
          agentIndex,
          label,
          phase: assignedPhase,
          status: "error",
          reason,
          outputTokens: 0,
          durationMs: Date.now() - startedAt,
          error: truncateText(message, 1_000)
        })
        // Recoverable failure: matches the documented contract — agent()
        // resolves to null and the script decides how to proceed.
        return null
      }
    })
    return execution
  }

  const parallel = async (thunks: unknown): Promise<unknown[]> => {
    if (signal.aborted) return parkForever()
    if (!Array.isArray(thunks)) {
      throw new TypeError("parallel() expects an array of functions")
    }
    if (thunks.length > WORKFLOW_MAX_COLLECTION_ITEMS) {
      throw new WorkflowFatalError(
        `parallel() accepts at most ${WORKFLOW_MAX_COLLECTION_ITEMS} items (got ${thunks.length})`
      )
    }
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError(
        "parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)"
      )
    }
    return Promise.all(
      (thunks as Array<() => unknown>).map(async (thunk, index) => {
        try {
          return await thunk()
        } catch (error) {
          if (signal.aborted || isWorkflowAbortError(error)) throw error
          if (isWorkflowFatalError(error)) throw error
          log(`parallel[${index}] failed: ${describeWorkflowError(error)}`)
          return null
        }
      })
    )
  }

  const pipeline = async (items: unknown, ...stages: unknown[]): Promise<unknown[]> => {
    if (signal.aborted) return parkForever()
    if (!Array.isArray(items)) {
      throw new TypeError("pipeline() expects an array as the first argument")
    }
    if (items.length > WORKFLOW_MAX_COLLECTION_ITEMS) {
      throw new WorkflowFatalError(
        `pipeline() accepts at most ${WORKFLOW_MAX_COLLECTION_ITEMS} items (got ${items.length})`
      )
    }
    if (stages.length === 0 || stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError(
        "pipeline() stages must be functions: pipeline(items, item => agent(...), result => ...)"
      )
    }
    const stageFns = stages as Array<(prev: unknown, original: unknown, index: number) => unknown>
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item
        for (const stage of stageFns) {
          try {
            throwIfAborted()
            value = await stage(value, item, index)
          } catch (error) {
            if (signal.aborted || isWorkflowAbortError(error)) throw error
            if (isWorkflowFatalError(error)) throw error
            log(`pipeline[${index}] failed: ${describeWorkflowError(error)}`)
            return null
          }
        }
        return value
      })
    )
  }

  const workflowFn = async (nameOrRef: unknown, childArgs?: unknown): Promise<unknown> => {
    if (signal.aborted) return parkForever()
    if (context.childName || shared.depth >= 1) {
      throw new WorkflowFatalError("workflow() cannot be called from within a child workflow")
    }
    const { source, name } = loadChildWorkflowSource(context.workspacePath, nameOrRef)
    let parsedChild: ParsedWorkflowScript
    try {
      parsedChild = validateWorkflowScript(source)
    } catch (error) {
      throw new WorkflowScriptError(
        `child workflow "${name}" is invalid: ${describeWorkflowError(error)}`
      )
    }
    shared.depth += 1
    log(`running child workflow ${parsedChild.meta.name}`)
    try {
      const childGlobals = buildWorkflowGlobals({
        ...context,
        parsed: parsedChild,
        args: childArgs,
        childName: parsedChild.meta.name,
        // Key the journal on the child SCRIPT content, so two different child files
        // with the same meta.name can't cross-hit each other's cache (#5).
        childCacheKey: sha256Hex(source)
      })
      // A child workflow's return value is consumed by the parent script; its
      // value is already vm-serialized plain JSON (no hostile getters survive).
      return (
        await runWorkflowScriptInSandbox({
          body: parsedChild.body,
          globals: childGlobals,
          signal
        })
      ).value
    } finally {
      shared.depth -= 1
    }
  }

  // Guest file IO (read/write/glob/exists), workspace-jailed. Lets the script
  // enumerate work units (glob) and read/write files directly instead of burning a
  // subagent on it. Paths are confined to the workspace (realpath containment, plus
  // a symlink-parent defense on write); reads/writes are size-capped; writes are
  // serialized so concurrent writeFile() calls can't interleave or race a mkdir.
  const FILE_READ_MAX_BYTES = 1_048_576
  const FILE_WRITE_MAX_BYTES = 1_048_576
  // Default 10k; overridable SMALLER via CMB_WORKFLOW_GLOB_MAX for tests only.
  // Parsed/guarded in types so a bad value (negative / Infinity / non-numeric)
  // can neither disable nor raise the cap.
  const MAX_GLOB_RESULTS = getWorkflowGlobMax()
  let fileWriteChain: Promise<void> = Promise.resolve()
  const readFile = async (filePath: unknown): Promise<string> => {
    throwIfAborted()
    if (typeof filePath !== "string") throw new TypeError("readFile(path) expects a string path")
    const resolved = resolveExistingWorkspacePath(
      context.workspacePath,
      filePath,
      `readFile "${filePath}"`
    )
    const stat = await fsp.stat(resolved)
    // Must be a REGULAR file: reading a FIFO/socket/device parks until a writer
    // appears, tying up a libuv thread-pool slot indefinitely (and a sync read of
    // one would freeze the main process). Reject anything non-regular up front.
    if (!stat.isFile()) {
      throw new WorkflowFatalError(`readFile "${filePath}" is not a regular file`)
    }
    if (stat.size > FILE_READ_MAX_BYTES) {
      throw new WorkflowFatalError(
        `readFile "${filePath}" is too large (${stat.size} bytes > ${FILE_READ_MAX_BYTES} limit)`
      )
    }
    return await fsp.readFile(resolved, "utf-8")
  }
  const exists = async (filePath: unknown): Promise<boolean> => {
    if (typeof filePath !== "string") throw new TypeError("exists(path) expects a string path")
    try {
      // resolveExistingWorkspacePath throws if the path is missing OR outside the
      // workspace; either way the script should see false (never leak which).
      resolveExistingWorkspacePath(context.workspacePath, filePath, `exists "${filePath}"`)
      return true
    } catch {
      return false
    }
  }
  const glob = async (pattern: unknown): Promise<string[]> => {
    throwIfAborted()
    if (typeof pattern !== "string") throw new TypeError("glob(pattern) expects a string pattern")
    // STREAM + count as we walk, so the moment we cross MAX_GLOB_RESULTS we abort
    // the traversal itself — never materializing the full path array for a
    // pathological pattern. (A post-hoc length check on `await fastGlob(...)` would
    // only protect the downstream fan-out, AFTER the whole tree was walked and the
    // giant array allocated on the main process.)
    const stream = fastGlob.stream(pattern, {
      cwd: context.workspacePath,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      absolute: false,
      suppressErrors: true,
      // Skip the universal build/VCS noise. A workflow orchestrating over a repo
      // virtually never wants node_modules/.git, and on a real project including
      // them both floods the fan-out with junk and blows the result set past
      // MAX_GLOB_RESULTS. (dist is intentionally NOT excluded — it's project-specific
      // and sometimes holds source the script legitimately wants.)
      ignore: ["**/node_modules/**", "**/.git/**"]
    })
    const safe: string[] = []
    for await (const entry of stream) {
      const m = String(entry)
      // Defensive: drop any match that escaped the cwd.
      if (m.startsWith("..") || isAbsolute(m)) continue
      safe.push(m)
      if (safe.length > MAX_GLOB_RESULTS) {
        // Throwing breaks the for-await, whose return() tears the stream down, so we
        // stop enumerating the tree instead of walking it to completion + allocating
        // the whole array.
        throw new WorkflowFatalError(
          `glob("${pattern}") matched more than ${MAX_GLOB_RESULTS} files (limit ${MAX_GLOB_RESULTS}) — narrow the pattern`
        )
      }
    }
    // SORT for deterministic fan-out order (the resume journal keys on call order,
    // so order must be stable between the original and resumed runs).
    return safe.sort()
  }
  const writeFile = async (filePath: unknown, content: unknown): Promise<void> => {
    throwIfAborted()
    if (typeof filePath !== "string") {
      throw new TypeError("writeFile(path, content) expects a string path")
    }
    if (typeof content !== "string") {
      throw new TypeError("writeFile(path, content) expects string content")
    }
    // Byte length, not String#length: content.length counts UTF-16 code units, so a
    // multi-byte (CJK/emoji) payload could slip well past the byte cap. readFile
    // bounds by stat.size (real bytes) — match that here.
    const contentBytes = Buffer.byteLength(content, "utf-8")
    if (contentBytes > FILE_WRITE_MAX_BYTES) {
      throw new WorkflowFatalError(
        `writeFile "${filePath}" content is too large (${contentBytes} > ${FILE_WRITE_MAX_BYTES} byte limit)`
      )
    }
    const resolved = resolveWorkspaceWritePath(
      context.workspacePath,
      filePath,
      `writeFile "${filePath}"`
    )
    const performWrite = async (): Promise<void> => {
      await fsp.mkdir(dirname(resolved), { recursive: true })
      // If the target already exists it must be a REGULAR file: writing to an
      // existing FIFO/socket/device would block (the write parks for a reader),
      // tying up a libuv thread-pool slot indefinitely. ENOENT (not yet created)
      // is the normal case and is fine — we're about to create it.
      const existing = await fsp.stat(resolved).catch(() => null)
      if (existing && !existing.isFile()) {
        throw new WorkflowFatalError(
          `writeFile "${filePath}" target exists and is not a regular file`
        )
      }
      await fsp.writeFile(resolved, content, "utf-8")
    }
    // Route through the run-level exclusive write lock when injected, so a script
    // writeFile() and a subagent's tool write (both keyed on the parent threadId)
    // serialize TOGETHER, not just within their own silos. Fall back to the local
    // chain when no lock is injected (unit harness / embedded caller). (#2)
    if (context.runExclusiveFileWrite) {
      await context.runExclusiveFileWrite(performWrite)
    } else {
      const write = fileWriteChain.then(performWrite)
      fileWriteChain = write.then(
        () => undefined,
        () => undefined
      )
      await write
    }
  }

  // Abort-aware setTimeout/clearTimeout. Scripts legitimately sleep (rate-limit
  // backoff, polling external state), but a vm context has no host timers, so
  // without these a `setTimeout(...)` throws ReferenceError. Callbacks are
  // skipped once the run is torn down, timers are unref'd (never keep the
  // process alive), the delay is clamped, and every pending timer is cancelled
  // on abort so none can fire after the run settles.
  // Hand the script a plain NUMBER id, never the host Timeout object — a host
  // object would hand the script a `.constructor.constructor` escape out of the
  // vm realm. clearTimeout resolves the id back to the real handle here.
  const pendingTimers = new Map<number, ReturnType<typeof setTimeout>>()
  let timerSeq = 0
  const scriptSetTimeout = (callback: unknown, delay: unknown, ...args: unknown[]): unknown => {
    if (typeof callback !== "function") return undefined
    // Coerce delay only for primitives (number/string) — never call Number() on an
    // OBJECT, whose valueOf/toString runs host-side with no timeout after the first
    // await (the host-side coercion DoS class, same as log()/agent opts). A hostile
    // `{ valueOf(){ while(1){} } }` delay becomes 0 instead of freezing the app.
    const ms =
      typeof delay === "number" || typeof delay === "string"
        ? Math.min(Math.max(0, Number(delay) || 0), WORKFLOW_MAX_SCRIPT_TIMER_MS)
        : 0
    const timerId = (timerSeq += 1)
    const handle = setTimeout(() => {
      pendingTimers.delete(timerId)
      if (signal.aborted) return
      try {
        // Forward extra args like the host setTimeout: `setTimeout(cb, ms, a, b)`
        // invokes `cb(a, b)`, so `new Promise(r => setTimeout(r, ms, value))`
        // resolves with `value` instead of undefined. (args are vm values the
        // host only relays back to the vm callback — never read here.)
        ;(callback as (...callbackArgs: unknown[]) => void)(...args)
      } catch (error) {
        // A throwing timer callback must never crash the host process. Log it so
        // a script bug isn't silently lost; the run still proceeds (if the script
        // awaited a side effect of this callback it then hits the inactivity
        // timeout, which is the correct degradation).
        console.warn("[Workflow] script setTimeout callback threw:", error)
      }
    }, ms)
    // NOT unref'd: a script awaiting `setTimeout` (sleep/backoff) needs the timer
    // to keep the run alive until it fires. Stray timers are cancelled when the
    // run settles (lifetime abort below), so this can't leak past the run.
    pendingTimers.set(timerId, handle)
    return timerId
  }
  const scriptClearTimeout = (timerId: unknown): void => {
    const handle = pendingTimers.get(timerId as number)
    if (handle === undefined) return
    clearTimeout(handle)
    pendingTimers.delete(timerId as number)
  }
  signal.addEventListener(
    "abort",
    () => {
      for (const handle of pendingTimers.values()) clearTimeout(handle)
      pendingTimers.clear()
    },
    { once: true }
  )

  return {
    agent,
    parallel: suppressUnhandled(parallel),
    pipeline: suppressUnhandled(pipeline),
    workflow: suppressUnhandled(workflowFn),
    phase,
    log,
    budget,
    setTimeout: scriptSetTimeout,
    clearTimeout: scriptClearTimeout,
    readFile: suppressUnhandled(readFile),
    writeFile: suppressUnhandled(writeFile),
    glob: suppressUnhandled(glob),
    exists: suppressUnhandled(exists),
    args: toJsonSafe(context.args)
  }
}

function normalizeAgentArgs(
  prompt: unknown,
  rawOptions: unknown
): {
  prompt: string
  options: WorkflowAgentOptions
  agentType?: string
  ignoredIsolation?: string
} {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new TypeError("agent(prompt, opts) expects a non-empty prompt string")
  }
  if (rawOptions === undefined || rawOptions === null) {
    return { prompt, options: {} }
  }
  if (typeof rawOptions !== "object" || Array.isArray(rawOptions)) {
    throw new TypeError("agent(prompt, opts) expects opts to be an object")
  }
  const candidate = rawOptions as Record<string, unknown>
  const options: WorkflowAgentOptions = {}
  // agentType selects a registry profile (built-in Explore/Plan/verification or a
  // user file under .cmbcoworkagent/agents/). Resolution happens in
  // executeAgentCall where the workspace path is known; an unknown name fails
  // closed there so it cannot silently run the full-permission default agent.
  // Type-validate like the other opts AND fail closed on a malformed value: a
  // non-string / empty agentType (e.g. `agentType: someVar` where the var turned
  // into an object/number, or an empty string) must throw — NOT silently fall
  // back to the full-permission default agent, which would drop an intended
  // permissions boundary. Only a genuinely absent (undefined) agentType is the
  // legitimate "use the default agent" case.
  let agentType: string | undefined
  if (candidate.agentType !== undefined) {
    if (typeof candidate.agentType !== "string" || !candidate.agentType.trim()) {
      throw new TypeError("agent opts.agentType must be a non-empty string")
    }
    agentType = candidate.agentType.trim()
  }
  if (candidate.label !== undefined) {
    if (typeof candidate.label !== "string")
      throw new TypeError("agent opts.label must be a string")
    options.label = candidate.label
  }
  if (candidate.phase !== undefined) {
    if (typeof candidate.phase !== "string")
      throw new TypeError("agent opts.phase must be a string")
    options.phase = candidate.phase
  }
  if (candidate.model !== undefined) {
    if (typeof candidate.model !== "string")
      throw new TypeError("agent opts.model must be a string")
    options.model = candidate.model
  }
  if (candidate.schema !== undefined) {
    if (
      typeof candidate.schema !== "object" ||
      candidate.schema === null ||
      Array.isArray(candidate.schema)
    ) {
      throw new TypeError("agent opts.schema must be a JSON Schema object")
    }
    // Deep-copy across the vm realm boundary so later script mutations cannot
    // change the schema we hash/validate against.
    options.schema = JSON.parse(JSON.stringify(candidate.schema)) as Record<string, unknown>
    // Fail closed NOW, while the schema author (the script) can still react —
    // an unsupported construct would otherwise validate vacuously and let
    // garbage structured output through.
    assertSupportedJsonSchema(options.schema)
  }
  // worktree/remote isolation isn't supported here (subagents already run in
  // their own session, and file writes are serialized across the run). Rather
  // than throw — which would crash a whole script just because a mid-tier model
  // pulled `isolation: 'worktree'` from training — warn and ignore. agentType is
  // stricter because a miss there could drop an intended permissions boundary.
  const ignoredIsolation =
    typeof candidate.isolation === "string" && candidate.isolation.trim()
      ? candidate.isolation.trim()
      : candidate.isolation !== undefined
        ? "(unsupported)"
        : undefined
  return { prompt, options, agentType, ignoredIsolation }
}

function recordAgentState(
  runStore: WorkflowRunStore,
  record: {
    index: number
    label: string
    phase: string | null
    status: "running" | "completed" | "error" | "cached"
    error?: string
    outputTokens: number
    promptPreview?: string
    resultPreview?: string
  }
): void {
  // Delegates to the store's O(1) by-index upsert (was an O(n) array scan per
  // call → O(n²) over a large run).
  runStore.upsertAgent(record)
}

function loadChildWorkflowSource(
  workspacePath: string,
  nameOrRef: unknown
): { source: string; name: string } {
  // Only { scriptPath } is supported. (A by-name registry would need a save
  // mechanism that doesn't exist here, so accepting `name` would be a dead path
  // that always 404s and just confuses the model.)
  const scriptPath =
    typeof nameOrRef === "object" &&
    nameOrRef !== null &&
    typeof (nameOrRef as { scriptPath?: unknown }).scriptPath === "string"
      ? (nameOrRef as { scriptPath: string }).scriptPath
      : undefined
  if (!scriptPath) {
    throw new TypeError('workflow() expects { scriptPath: "…" }')
  }
  // Realpath-based containment check (blocks symlink escapes too).
  const resolved = resolveExistingWorkspacePath(
    workspacePath,
    scriptPath,
    `workflow "${scriptPath}"`
  )
  // Cap the size BEFORE reading the whole file synchronously — a script could
  // point at a huge workspace file and stall/OOM the main process otherwise
  // (mirrors the top-level scriptPath guard in tool.ts).
  try {
    const st = statSync(resolved)
    // Regular-file guard: a FIFO/socket/device would make the synchronous
    // readFileSync below block the main process (a FIFO read parks for a writer).
    if (!st.isFile()) {
      throw new WorkflowScriptError(`workflow "${scriptPath}" is not a regular file`)
    }
    if (st.size > MAX_WORKFLOW_SCRIPT_BYTES) {
      throw new WorkflowScriptError(
        `workflow "${scriptPath}" is too large (${st.size} bytes > ${MAX_WORKFLOW_SCRIPT_BYTES} limit)`
      )
    }
  } catch (error) {
    if (error instanceof WorkflowScriptError) throw error
    throw new WorkflowScriptError(`workflow "${scriptPath}" could not be read at ${resolved}`)
  }
  try {
    return { source: readFileSync(resolved, "utf-8"), name: scriptPath }
  } catch {
    throw new WorkflowScriptError(`workflow "${scriptPath}" not found at ${resolved}`)
  }
}

function defaultAgentLabel(phase: string | null, index: number): string {
  return phase ? `${phase} · agent ${index}` : `agent ${index}`
}

function createLimiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: Array<() => void> = []
  // Direct slot hand-off: on release, transfer the slot to the next waiter
  // WITHOUT dropping `active` to limit-1 first. The naive "active--; wake next"
  // briefly exposes a free slot that a synchronously-arriving call can grab
  // while the woken waiter also takes it — overshooting the cap. Handing off
  // keeps `active` pinned at the limit through the transfer, so concurrency
  // never exceeds `limit`.
  const acquire = async (): Promise<void> => {
    if (active < limit) {
      active += 1
      return
    }
    await new Promise<void>((resolveSlot) => queue.push(resolveSlot))
    // Woken by release(), which kept our slot reserved — do not re-increment.
  }
  const release = (): void => {
    const next = queue.shift()
    if (next) {
      next()
    } else {
      active -= 1
    }
  }
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

/** Converts vm-realm values into plain JSON-safe host values (drops functions/cycles). */
export function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value)) as unknown
  } catch {
    return String(value)
  }
}

/** toJsonSafe, but oversized values collapse to a truncated string so persisted files stay bounded. */
function boundJsonSafe(value: unknown, maxChars: number): unknown {
  const safe = toJsonSafe(value)
  if (safe === undefined) return undefined
  try {
    const serialized = JSON.stringify(safe)
    if (serialized.length <= maxChars) return safe
    return truncateText(serialized, maxChars)
  } catch {
    return String(safe)
  }
}
