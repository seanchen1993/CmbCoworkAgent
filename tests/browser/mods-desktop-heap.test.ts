import { describe, expect, it } from "vitest"
import { desktopHeapAssessment, type DesktopHeapSample } from "../support/mods-desktop-heap"
import { desktopCpuPoints } from "../support/mods-desktop-performance"

const samples = (): DesktopHeapSample[] =>
  Array.from({ length: 241 }, (_, index) => ({
    atMs: index * 30000,
    bytes: (100 + (index >= 220 ? 4 : 0)) * 1024 * 1024,
    rendererPid: 123,
    rendererCreatedAt: 10,
    jobs: 50,
    panes: 4
  }))
describe("natural desktop heap acceptance", () => {
  it("uses complete ten-minute windows, two hours, equal warm state and existing growth budget", () => {
    const result = desktopHeapAssessment(samples(), false)
    expect(result).toMatchObject({
      qualified: true,
      passed: true,
      initialSamples: 21,
      finalSamples: 21,
      growthBytes: 4 * 1024 * 1024,
      budgetBytes: 10 * 1024 * 1024
    })
  })
  it("does not turn short/GC/missing samples into formal performance evidence", () => {
    expect(desktopHeapAssessment([], false).qualified).toBe(false)
    expect(desktopHeapAssessment(samples().slice(0, -1), false).qualified).toBe(false)
    expect(desktopHeapAssessment(samples(), true)).toMatchObject({
      qualified: false,
      passed: false,
      statistic: "diagnostic-post-gc-renderer-heap",
      timingEligible: false
    })
    const gap = samples().filter((_, index) => index !== 2 && index !== 3)
    expect(desktopHeapAssessment(gap, false).qualified).toBe(false)
  })
  it("measures two hours between actual samples, including the first sample's IPC offset", () => {
    const shifted = samples().map((sample) => ({ ...sample, atMs: sample.atMs + 100 }))
    expect(desktopHeapAssessment(shifted, false).qualified).toBe(true)
    shifted.at(-1)!.atMs -= 1
    expect(desktopHeapAssessment(shifted, false).qualified).toBe(false)
  })
  it("rejects replaced renderer identities and different cache/pane states", () => {
    for (const mutation of [
      { rendererPid: 456 },
      { rendererCreatedAt: 20 },
      { jobs: 49 },
      { panes: 0 }
    ]) {
      const changed = samples()
      Object.assign(changed.at(-1)!, mutation)
      expect(desktopHeapAssessment(changed, false)).toMatchObject({
        qualified: false,
        passed: false
      })
    }
  })
  it("rejects missing middle samples or transient middle renderer replacement", () => {
    const gap = samples().filter((_, index) => index !== 120 && index !== 121)
    expect(desktopHeapAssessment(gap, false)).toMatchObject({ qualified: false, passed: false })
    for (const mutation of [{ rendererPid: 456 }, { rendererCreatedAt: 20 }]) {
      const changed = samples()
      Object.assign(changed[120], mutation)
      expect(desktopHeapAssessment(changed, false)).toMatchObject({
        qualified: false,
        passed: false
      })
    }
  })
  it("keeps sufficient evidence qualified when growth itself exceeds the budget", () => {
    const changed = samples().map((sample) => ({
      ...sample,
      bytes: sample.bytes + (sample.atMs >= 6600000 ? 20 * 1024 * 1024 : 0)
    }))
    expect(desktopHeapAssessment(changed, false)).toMatchObject({ qualified: true, passed: false })
  })
  it("rejects a reused PID with a different process creation time", () => {
    expect(
      desktopCpuPoints(
        [{ pid: 1, creationTime: 10, cpu: { cumulativeCPUUsage: 1 } }],
        [{ pid: 1, creationTime: 20, cpu: { cumulativeCPUUsage: 2 } }],
        1000
      )
    ).toBeNull()
  })
})
