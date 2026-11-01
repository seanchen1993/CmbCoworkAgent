import { rendererHeapWindow } from "./performance-acceptance"

export interface DesktopHeapSample {
  atMs: number
  bytes: number
  rendererPid: number
  rendererCreatedAt: number
  jobs: number
  panes: number
}

/** Natural heap under the same warmed, bounded history and steady workload at both ends. */
export function desktopHeapAssessment(samples: readonly DesktopHeapSample[], forcedGc: boolean) {
  if (samples.length < 2) return { qualified: false, passed: false, reason: "insufficient-samples" }
  const initialEnd = samples.findIndex((sample) => sample.atMs - samples[0].atMs >= 600000)
  const last = samples.at(-1)!
  const finalStart = samples.findLastIndex((sample) => last.atMs - sample.atMs >= 600000)
  if (initialEnd < 0 || finalStart < 0)
    return { qualified: false, passed: false, reason: "insufficient-ten-minute-windows" }
  const initial = samples.slice(0, initialEnd + 1)
  const final = samples.slice(finalStart)
  const matchedState = [...initial, ...final].every(
    (sample) =>
      sample.rendererPid === samples[0].rendererPid &&
      sample.rendererCreatedAt === samples[0].rendererCreatedAt &&
      sample.jobs === 50 &&
      sample.panes === 4
  )
  const observed = rendererHeapWindow({
    initial,
    final,
    comparableIdleAndCacheState: matchedState,
    forcedGc
  })
  const regular = (values: readonly DesktopHeapSample[]) =>
    values.every(
      (sample, index) =>
        !index ||
        (sample.atMs > values[index - 1].atMs && sample.atMs - values[index - 1].atMs <= 60000)
    )
  const consistentRenderer = samples.every(
    (sample) =>
      sample.rendererPid === samples[0].rendererPid &&
      sample.rendererCreatedAt === samples[0].rendererCreatedAt
  )
  const qualified =
    observed.durationMs >= 7200000 &&
    matchedState &&
    !forcedGc &&
    initial.at(-1)!.atMs < final[0].atMs &&
    regular(samples) &&
    consistentRenderer
  return {
    ...observed,
    qualified,
    passed: qualified && observed.rendererWindowPassed,
    initialSamples: initial.length,
    finalSamples: final.length,
    matchedState,
    consistentRenderer,
    scope:
      "Natural renderer used heap in matching warm steady-workload windows; not whole-application live heap"
  }
}
