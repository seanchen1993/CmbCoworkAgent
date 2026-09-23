import { expect, it } from "vitest"
import {
  parsePerformanceOptions,
  summarizeSamples,
  qualifiesPerformanceRun
} from "../support/mods-v2-performance"

it("defaults to the complete v2 workload and makes smoke explicit", () => {
  expect(parsePerformanceOptions([])).toMatchObject({
    rounds: 5,
    samples: 1000,
    warmups: 100,
    idleSeconds: 300,
    soakSeconds: 7200,
    soakEvents: 10000,
    phase: "all"
  })
  const smoke = parsePerformanceOptions(["--smoke"])
  expect(smoke.samples).toBe(10)
  expect(qualifiesPerformanceRun(smoke)).toBe(false)
  expect(qualifiesPerformanceRun(parsePerformanceOptions([]))).toBe(true)
})

it.each([
  "--samples=0",
  "--rounds=1.5",
  "--soak-seconds=NaN",
  "--idle-seconds=-1",
  "--phase=unknown",
  "--constructor=1",
  "--surprise=true",
  "--samples=4",
  "--soak-events=10000001"
])("rejects invalid or duplicate arguments %s", (argument) => {
  expect(() => parsePerformanceOptions(["--samples=4", argument])).toThrow()
})

it("accepts bounded custom runs but never labels reduced samples a full qualification", () => {
  const options = parsePerformanceOptions([
    "--phase=soak",
    "--soak-seconds=7200",
    "--soak-events=12000",
    "--samples=20"
  ])
  expect(options.soakEvents).toBe(12000)
  expect(qualifiesPerformanceRun(options)).toBe(false)
})

it("uses nearest-rank percentiles without mutating raw samples", () => {
  const values = [5, 1, 4, 2, 3]
  expect(summarizeSamples(values)).toEqual({ count: 5, p50Ms: 3, p95Ms: 5, minMs: 1, maxMs: 5 })
  expect(values).toEqual([5, 1, 4, 2, 3])
  expect(summarizeSamples(Array.from({ length: 1000 }, (_, index) => index + 1)).p95Ms).toBe(950)
})

it.each([[], [NaN], [Infinity], [-1]].map((values) => ({ values })))(
  "refuses invalid timing evidence $values",
  ({ values }) => {
    expect(() => summarizeSamples(values)).toThrow()
  }
)
