import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  assertLegalSourceScale,
  assessReadTiming,
  historyScale,
  nearestRank,
  processObservation,
  readableDuration,
  rendererHeapWindow,
  releaseStatus,
  rollbackRegressionEntries,
  type TimingRun
} from "../support/performance-acceptance"

function runs(): TimingRun[] {
  return Array.from({ length: 10 }, (_, index) => ({
    id: `run-${index}`,
    variant: index % 2 ? "after" : "before",
    profiled: false,
    refreshHz: 60,
    samples: [
      ...Array.from({ length: 30 }, () => ({
        kind: "hot-valid" as const,
        durationMs: 80,
        fixtureId: `hot-${index}`
      })),
      ...Array.from({ length: 6 }, (_, cold) => ({
        kind: "cold" as const,
        durationMs: 700,
        fixtureId: `cold-${index}-${cold}`
      }))
    ]
  }))
}

describe("performance evidence integrity", () => {
  it("includes a slow source guard in the end-to-end readable interval", () => {
    expect(readableDuration({ requestedAtMs: 100, readableAtMs: 300, sourceGuardMs: 180 })).toBe(
      200
    )
    expect(() => readableDuration({ requestedAtMs: 300, readableAtMs: 100 })).toThrow("CLOCK_ORDER")
  })

  it("uses nearest rank and rejects invalid observations rather than dropping them", () => {
    expect(
      nearestRank(
        Array.from({ length: 20 }, (_, i) => i + 1),
        0.95
      )
    ).toBe(19)
    for (const values of [[], [NaN], [Infinity], [-1]])
      expect(() => nearestRank(values, 0.95)).toThrow("INVALID_SAMPLES")
  })

  it("does not conceal one failed after-run in pooled fast observations", () => {
    const input = runs()
    expect(assessReadTiming(input).passed).toBe(true)
    input[1].samples = input[1].samples.map((sample) => ({ ...sample, durationMs: 900 }))
    expect(assessReadTiming(input)).toMatchObject({
      passed: false,
      reasons: expect.arrayContaining(["run-1:hot-p95", "run-1:cold-p95"])
    })
  })

  it("cannot count hot, evicted or dynamic samples as independent cold reads", () => {
    const input = runs()
    input[1].samples = input[1].samples.map((sample) => ({ ...sample, kind: "dynamic" }))
    expect(assessReadTiming(input).reasons).toContain("run-1:insufficient-cold-samples")
    const reused = runs()
    reused[3].samples = reused[1].samples
    expect(assessReadTiming(reused).reasons).toContain("run-3:reused-cold-fixture")
  })

  it("refuses profiled or wrong-refresh captures as fixed-machine timing evidence", () => {
    const input = runs()
    input[1].refreshHz = 144
    input[3].profiled = true
    expect(assessReadTiming(input).reasons).toEqual(
      expect.arrayContaining(["run-1:not-unprofiled-60hz", "run-3:not-unprofiled-60hz"])
    )
  })

  it("separates installed inventory from legal active sources and import limits", () => {
    expect(() =>
      assertLegalSourceScale({
        installedSources: 20,
        activeSources: 8,
        compiledFiles: 128,
        sourceBytes: 2 * 1024 * 1024
      })
    ).not.toThrow()
    expect(() =>
      assertLegalSourceScale({
        installedSources: 20,
        activeSources: 20,
        compiledFiles: 24,
        sourceBytes: 1
      })
    ).toThrow("CHAIN_CAPACITY")
    expect(() =>
      assertLegalSourceScale({
        installedSources: 1,
        activeSources: 1,
        compiledFiles: 256,
        sourceBytes: 1
      })
    ).toThrow("SOURCE_LIMIT")
    expect(historyScale("10000")).toBe(10000)
    expect(() => historyScale("20000")).toThrow("UNSUPPORTED")
  })

  it("does not convert PID reuse, exited processes or missing CPU counters into zero CPU", () => {
    const before = [
      { pid: 10, creationTime: 1, type: "Browser", cumulativeCpuSeconds: 5, workingSetKiB: 100 }
    ]
    const after = [{ ...before[0], creationTime: 2, cumulativeCpuSeconds: 1 }]
    expect(processObservation(before, after, 1000)).toMatchObject({
      completeObservedInterval: false,
      observedCpuSeconds: null,
      wholeApplicationCpuMeasured: false
    })
    expect(processObservation(before, [], 1000).completeObservedInterval).toBe(false)
    expect(
      processObservation(before, [{ ...before[0], cumulativeCpuSeconds: undefined }], 1000)
        .observedCpuSeconds
    ).toBeNull()
    expect(
      processObservation(before, [{ ...before[0], cumulativeCpuSeconds: 6 }], 1000)
    ).toMatchObject({ observedCpuSeconds: 1, wholeApplicationCpuMeasured: false })
  })

  it("keeps package release pending without authorization and points to real rollback suites", () => {
    expect(
      releaseStatus({
        functionalPassed: true,
        timingPassed: true,
        soakPassed: true,
        packagedPassed: true,
        packagingAuthorized: false
      })
    ).toBe("pending-authorization")
    for (const entry of rollbackRegressionEntries)
      expect(existsSync(entry.path), entry.path).toBe(true)
  })
  it("does not call a short or differently filled renderer heap capture a whole-app leak pass", () => {
    const input = {
      initial: Array.from({ length: 11 }, (_, index) => ({
        atMs: index * 60000,
        bytes: 100 * 1024 * 1024
      })),
      final: Array.from({ length: 11 }, (_, index) => ({
        atMs: (110 + index) * 60000,
        bytes: 105 * 1024 * 1024
      })),
      comparableIdleAndCacheState: true,
      forcedGc: false
    }
    expect(rendererHeapWindow(input)).toMatchObject({
      rendererWindowPassed: true,
      wholeApplicationLeakAssessed: false,
      statistic: "renderer-used-heap-not-live-heap"
    })
    expect(
      rendererHeapWindow({ ...input, final: [{ atMs: 1000, bytes: 105 * 1024 * 1024 }] })
        .rendererWindowPassed
    ).toBe(false)
    expect(
      rendererHeapWindow({ ...input, comparableIdleAndCacheState: false }).rendererWindowPassed
    ).toBe(false)
    expect(rendererHeapWindow({ ...input, forcedGc: true }).timingEligible).toBe(false)
    expect(
      rendererHeapWindow({
        ...input,
        final: input.final.map((sample) => ({ ...sample, bytes: 120 * 1024 * 1024 }))
      }).rendererWindowPassed
    ).toBe(false)
  })
})
