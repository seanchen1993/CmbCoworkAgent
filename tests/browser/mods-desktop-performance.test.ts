import { expect, it } from "vitest"
import { desktopCpuPoints, desktopStreamBudget } from "../support/mods-desktop-performance"

it("retains whole-app CPU time and refuses missing, replaced or regressing processes", () => {
  const before = [
    { pid: 1, cpu: { cumulativeCPUUsage: 10 } },
    { pid: 2, cpu: { cumulativeCPUUsage: 5 } }
  ]
  const after = [
    { pid: 1, cpu: { cumulativeCPUUsage: 10.8 } },
    { pid: 2, cpu: { cumulativeCPUUsage: 5.7 } }
  ]
  expect(desktopCpuPoints(before, after, 300000)).toBeCloseTo(0.5)
  expect(desktopCpuPoints(before, after.slice(0, 1), 300000)).toBeNull()
  expect(
    desktopCpuPoints(before, [...after, { pid: 3, cpu: { cumulativeCPUUsage: 0 } }], 300000)
  ).toBeNull()
  expect(desktopCpuPoints(before, [{ pid: 1, cpu: {} }, after[1]], 300000)).toBeNull()
  expect(desktopCpuPoints(after, before, 300000)).toBeNull()
})

it("uses the fixed 40 ms / 95 percent stream limits without concealing failures", () => {
  const sample = (ttftMs: number, streamMs: number) => ({ ttftMs, streamMs, characters: 1000 })
  expect(desktopStreamBudget([sample(100, 950)], [sample(140, 1000)])).toMatchObject({
    addedTtftP95Ms: 40,
    throughputRatio: 0.95,
    passed: true
  })
  expect(desktopStreamBudget([sample(100, 950)], [sample(140.01, 1000)]).passed).toBe(false)
  expect(desktopStreamBudget([sample(100, 950)], [sample(140, 1001)]).passed).toBe(false)
  expect(() =>
    desktopStreamBudget([sample(100, 950)], [{ ...sample(140, 1000), characters: 999 }])
  ).toThrow()
})
