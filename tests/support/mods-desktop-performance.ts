import { summarizeSamples } from "./mods-v2-performance"

interface CpuSample {
  pid: number
  cpu: { cumulativeCPUUsage?: number }
}
export function desktopCpuPoints(
  before: CpuSample[],
  after: CpuSample[],
  elapsedMs: number
): number | null {
  if (
    !before.length ||
    before.length !== after.length ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0
  )
    return null
  const previous = new Map(before.map((p) => [p.pid, p.cpu.cumulativeCPUUsage]))
  if (previous.size !== before.length || new Set(after.map((p) => p.pid)).size !== after.length)
    return null
  let seconds = 0
  for (const p of after) {
    const from = previous.get(p.pid),
      to = p.cpu.cumulativeCPUUsage
    if (
      from === undefined ||
      to === undefined ||
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      to < from
    )
      return null
    seconds += to - from
  }
  return (seconds * 100000) / elapsedMs
}

export interface DesktopStreamSample {
  ttftMs: number
  streamMs: number
  characters: number
}
export function desktopStreamBudget(
  baseline: DesktopStreamSample[],
  enabled: DesktopStreamSample[]
) {
  if (
    !baseline.length ||
    baseline.length !== enabled.length ||
    baseline.some((s, i) => s.characters !== enabled[i].characters)
  )
    throw Error("DESKTOP_STREAM_UNPAIRED")
  for (const sample of [...baseline, ...enabled])
    if (
      !Number.isFinite(sample.streamMs) ||
      sample.streamMs <= 0 ||
      !Number.isSafeInteger(sample.characters) ||
      sample.characters <= 0
    )
      throw Error("DESKTOP_STREAM_INVALID")
  const before = summarizeSamples(baseline.map((s) => s.ttftMs))
  const after = summarizeSamples(enabled.map((s) => s.ttftMs))
  const addedTtftP95Ms = after.p95Ms - before.p95Ms
  const time = (values: DesktopStreamSample[]) => values.reduce((sum, s) => sum + s.streamMs, 0)
  const characters = baseline.reduce((sum, s) => sum + s.characters, 0)
  const baselineCharactersPerSecond = (characters * 1000) / time(baseline)
  const enabledCharactersPerSecond = (characters * 1000) / time(enabled)
  const throughputRatio = time(baseline) / time(enabled)
  return {
    baselineTtft: before,
    enabledTtft: after,
    addedTtftP95Ms,
    baselineCharactersPerSecond,
    enabledCharactersPerSecond,
    throughputRatio,
    passed: after.p95Ms <= before.p95Ms + 40 && throughputRatio >= 0.95
  }
}
