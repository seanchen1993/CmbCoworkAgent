/** Measurement contracts, not a substitute for native functional/security assertions. */
export const performanceScales = [400, 2000, 10000] as const
export type HistoryScale = (typeof performanceScales)[number]

export function historyScale(value = "400"): HistoryScale {
  const count = Number(value)
  if (!performanceScales.some((scale) => scale === count))
    throw Error("PERFORMANCE_UNSUPPORTED_HISTORY_SCALE")
  return count as HistoryScale
}

export function assertLegalSourceScale(input: {
  installedSources: number
  activeSources: number
  compiledFiles: number
  sourceBytes: number
}): void {
  if (Object.values(input).some((value) => !Number.isSafeInteger(value) || value < 0))
    throw Error("PERFORMANCE_INVALID_SOURCE_SCALE")
  if (input.activeSources > input.installedSources) throw Error("PERFORMANCE_INVALID_SOURCE_SCALE")
  if (input.activeSources > 8) throw Error("PERFORMANCE_EXPECT_CHAIN_CAPACITY_REJECTION")
  if (input.compiledFiles > 128 || input.sourceBytes > 2 * 1024 * 1024)
    throw Error("PERFORMANCE_EXPECT_SOURCE_LIMIT_REJECTION")
}

function finiteSamples(values: readonly number[]): void {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0))
    throw Error("PERFORMANCE_INVALID_SAMPLES")
}

/** Nearest rank: ceil(p * N), one based. Never interpolates away a tail observation. */
export function nearestRank(values: readonly number[], percentile: number): number {
  finiteSamples(values)
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1)
    throw Error("PERFORMANCE_INVALID_PERCENTILE")
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * percentile) - 1]
}

export function readableDuration(input: {
  requestedAtMs: number
  readableAtMs: number
  sourceGuardMs?: number
}): number {
  finiteSamples([input.requestedAtMs, input.readableAtMs, input.sourceGuardMs ?? 0])
  const duration = input.readableAtMs - input.requestedAtMs
  if (duration < 0) throw Error("PERFORMANCE_INVALID_CLOCK_ORDER")
  // Guard is an attribution inside this interval. It is never subtracted.
  return duration
}

export interface ReadSample {
  kind: "cold" | "hot-valid" | "evicted" | "expired" | "dynamic"
  durationMs: number
  /** Cold read needs a fresh native fixture/session identity, not another hot interaction. */
  fixtureId: string
}
export interface TimingRun {
  id: string
  variant: "before" | "after"
  samples: readonly ReadSample[]
  profiled: boolean
  refreshHz: number
}

/** Fixed-machine lane only; the CI smoke lane must not advertise this result. */
export function assessReadTiming(runs: readonly TimingRun[]): {
  passed: boolean
  reasons: string[]
  rows: Array<{ id: string; hotP95?: number; coldP95?: number }>
} {
  const reasons: string[] = []
  const rows: Array<{ id: string; hotP95?: number; coldP95?: number }> = []
  if (runs.length !== 10 || new Set(runs.map((run) => run.id)).size !== runs.length)
    reasons.push("require-five-distinct-runs-per-variant")
  const coldFixtures = new Set<string>()
  for (const variant of ["before", "after"] as const)
    if (runs.filter((run) => run.variant === variant).length !== 5)
      reasons.push(`${variant}:require-five-runs`)
  for (const [index, run] of runs.entries()) {
    if (index && runs[index - 1].variant === run.variant) reasons.push(`${run.id}:not-alternating`)
    if (run.profiled || run.refreshHz !== 60) reasons.push(`${run.id}:not-unprofiled-60hz`)
    const hot = run.samples.filter((sample) => sample.kind === "hot-valid")
    const cold = run.samples.filter((sample) => sample.kind === "cold")
    for (const sample of run.samples) {
      finiteSamples([sample.durationMs])
      if (!sample.fixtureId.trim()) throw Error("PERFORMANCE_MISSING_FIXTURE_ID")
    }
    if (hot.length < 30) reasons.push(`${run.id}:insufficient-hot-samples`)
    if (cold.length < 6) reasons.push(`${run.id}:insufficient-cold-samples`)
    for (const sample of cold) {
      if (coldFixtures.has(sample.fixtureId)) reasons.push(`${run.id}:reused-cold-fixture`)
      coldFixtures.add(sample.fixtureId)
    }
    const row = {
      id: run.id,
      hotP95: hot.length
        ? nearestRank(
            hot.map((sample) => sample.durationMs),
            0.95
          )
        : undefined,
      coldP95: cold.length
        ? nearestRank(
            cold.map((sample) => sample.durationMs),
            0.95
          )
        : undefined
    }
    rows.push(row)
    // Baseline can legitimately fail the target. Every after-run must independently pass.
    if (run.variant === "after" && (row.hotP95 ?? Infinity) > 100) reasons.push(`${run.id}:hot-p95`)
    if (run.variant === "after" && (row.coldP95 ?? Infinity) > 800)
      reasons.push(`${run.id}:cold-p95`)
  }
  return { passed: reasons.length === 0, reasons, rows }
}

export interface ProcessSample {
  pid: number
  creationTime: number
  type: string
  cumulativeCpuSeconds?: number
  workingSetKiB: number
}

/** Renderer-only screen, not a whole-application leak verdict. GC diagnostics are not timing runs. */
export function rendererHeapWindow(input: {
  initial: readonly { atMs: number; bytes: number }[]
  final: readonly { atMs: number; bytes: number }[]
  comparableIdleAndCacheState: boolean
  forcedGc: boolean
}) {
  const windowComplete = (samples: readonly { atMs: number; bytes: number }[]) => {
    finiteSamples(samples.map((sample) => sample.bytes))
    finiteSamples(samples.map((sample) => sample.atMs))
    const increasing = samples.every(
      (sample, index) => !index || sample.atMs > samples[index - 1].atMs
    )
    const spanMs = samples.at(-1)!.atMs - samples[0].atMs
    const regular = samples.every(
      (sample, index) => !index || sample.atMs - samples[index - 1].atMs <= 60000
    )
    return increasing && regular && spanMs >= 10 * 60 * 1000
  }
  const initialComplete = windowComplete(input.initial)
  const finalComplete = windowComplete(input.final)
  const beforeMedianBytes = nearestRank(
    input.initial.map((sample) => sample.bytes),
    0.5
  )
  const afterMedianBytes = nearestRank(
    input.final.map((sample) => sample.bytes),
    0.5
  )
  const growthBytes = afterMedianBytes - beforeMedianBytes
  const budgetBytes = Math.max(10 * 1024 * 1024, beforeMedianBytes * 0.1)
  const durationMs = input.final.at(-1)!.atMs - input.initial[0].atMs
  const sufficient =
    initialComplete &&
    finalComplete &&
    input.final[0].atMs > input.initial.at(-1)!.atMs &&
    durationMs >= 2 * 60 * 60 * 1000 &&
    input.comparableIdleAndCacheState
  return {
    durationMs,
    beforeMedianBytes,
    afterMedianBytes,
    growthBytes,
    budgetBytes,
    rendererWindowPassed: sufficient && growthBytes <= budgetBytes,
    statistic: input.forcedGc
      ? "diagnostic-post-gc-renderer-heap"
      : "renderer-used-heap-not-live-heap",
    wholeApplicationLeakAssessed: false,
    timingEligible: !input.forcedGc
  }
}

/** Observed Electron processes only; thread/QuickJS attribution is explicitly unavailable. */
export function processObservation(
  before: readonly ProcessSample[],
  after: readonly ProcessSample[],
  elapsedMs: number
) {
  finiteSamples([elapsedMs])
  if (elapsedMs === 0) throw Error("PERFORMANCE_INVALID_SAMPLE_INTERVAL")
  const rows = after.map((sample) => {
    const previous = before.find(
      (item) => item.pid === sample.pid && item.creationTime === sample.creationTime
    )
    const delta =
      previous?.cumulativeCpuSeconds !== undefined && sample.cumulativeCpuSeconds !== undefined
        ? sample.cumulativeCpuSeconds - previous.cumulativeCpuSeconds
        : undefined
    return {
      ...sample,
      cpuDeltaSeconds: delta !== undefined && Number.isFinite(delta) && delta >= 0 ? delta : null
    }
  })
  const disappeared = before.filter(
    (item) =>
      !after.some((sample) => sample.pid === item.pid && sample.creationTime === item.creationTime)
  )
  const complete =
    rows.length > 0 && rows.every((row) => row.cpuDeltaSeconds !== null) && !disappeared.length
  return {
    scope: "electron-reported-processes" as const,
    elapsedMs,
    rows,
    disappeared: disappeared.map(({ pid, creationTime, type }) => ({ pid, creationTime, type })),
    completeObservedInterval: complete,
    observedCpuSeconds: complete
      ? rows.reduce((sum, row) => sum + (row.cpuDeltaSeconds ?? 0), 0)
      : null,
    wholeApplicationCpuMeasured: false,
    workerThreadAndQuickJsAttribution: "not-separated" as const
  }
}

export const rollbackRegressionEntries = [
  {
    boundary: "source-change-and-revocation",
    path: "src/main/mods/v2/runtime-source-sites.integration.test.ts"
  },
  {
    boundary: "late-owner-and-guest-results",
    path: "src/main/mods/v2/runtime-source-handoff.integration.test.ts"
  },
  {
    boundary: "unknown-actions-no-replay",
    path: "src/main/mods/v2/platform-action-persistence.test.ts"
  },
  { boundary: "physical-task-cleanup", path: "tests/mods-runtime-recovery-packaged-e2e.spec.ts" },
  { boundary: "native-protection-and-history", path: "tests/chat-history-interaction-e2e.spec.ts" }
] as const

export function releaseStatus(input: {
  functionalPassed: boolean
  timingPassed: boolean
  soakPassed: boolean
  packagedPassed: boolean
  packagingAuthorized: boolean
}): "passed" | "pending-authorization" | "incomplete" {
  if (!input.packagingAuthorized) return "pending-authorization"
  return input.functionalPassed && input.timingPassed && input.soakPassed && input.packagedPassed
    ? "passed"
    : "incomplete"
}
