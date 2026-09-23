import { parsePerformanceOptions, summarizeSamples } from "./mods-v2-performance"

export interface IngressPerformanceOptions {
  smoke: boolean
  profile?: true
  rounds: number
  samples: number
  warmups: number
}

export function parseIngressPerformanceOptions(args: string[]): IngressPerformanceOptions {
  const profiles = args.filter((arg) => arg === "--profile")
  if (profiles.length > 1) throw Error("Duplicate ingress profile flag")
  const ordinary = args.filter((arg) => arg !== "--profile")
  for (const arg of ordinary)
    if (!/^--(?:smoke|rounds|samples|warmups)(?:=|$)/.test(arg))
      throw Error(`Unrelated ingress argument: ${arg}`)
  const { smoke, rounds, samples, warmups } = parsePerformanceOptions(ordinary)
  return { smoke, rounds, samples, warmups, ...(profiles.length ? { profile: true as const } : {}) }
}

export function qualifiesIngressMatrix(
  options: IngressPerformanceOptions,
  completedRounds: number,
  pluginProfiles: number[],
  disabledProfiles: string[]
): boolean {
  return (
    !options.smoke &&
    !options.profile &&
    options.rounds >= 5 &&
    options.samples >= 1000 &&
    options.warmups >= 100 &&
    completedRounds === options.rounds &&
    [0, 1, 8].every((count) => pluginProfiles.includes(count)) &&
    ["project-off", "global-off"].every((profile) => disabledProfiles.includes(profile))
  )
}

export function summarizeIngressPair(baselineValues: number[], disabledValues: number[]) {
  if (baselineValues.length !== disabledValues.length) throw Error("Unpaired ingress samples")
  const baseline = summarizeSamples(baselineValues)
  const disabled = summarizeSamples(disabledValues)
  if (baseline.p95Ms <= 0) throw Error("Invalid zero baseline")
  return {
    baseline,
    disabled,
    p95DeltaMs: disabled.p95Ms - baseline.p95Ms,
    p95DeltaPercent: (disabled.p95Ms / baseline.p95Ms - 1) * 100,
    // Compare absolute values so a floating point representation of exactly 5%
    // cannot spuriously exceed the fixed budget. No rounded decision or tolerance.
    withinBudget: disabled.p95Ms <= baseline.p95Ms * 1.05
  }
}
