import { expect, it } from "vitest"
import {
  parseIngressPerformanceOptions,
  summarizeIngressPair,
  qualifiesIngressMatrix
} from "../support/mods-v2-ingress-performance"

it("defaults to five rounds of 1000 actual ingress calls and marks smoke separately", () => {
  expect(parseIngressPerformanceOptions([])).toEqual({
    smoke: false,
    rounds: 5,
    samples: 1000,
    warmups: 100
  })
  const smoke = parseIngressPerformanceOptions(["--smoke"])
  expect(smoke).toEqual({ smoke: true, rounds: 1, samples: 10, warmups: 3 })
  expect(qualifiesIngressMatrix(smoke, 1, [0, 1, 8], ["project-off", "global-off"])).toBe(false)
})

it.each([
  "--phase=soak",
  "--rounds=0",
  "--samples=1.5",
  "--warmups=-1",
  "--constructor=1",
  "--smoke=false"
])("rejects invalid or unrelated arguments %s", (arg) => {
  expect(() => parseIngressPerformanceOptions([arg])).toThrow()
})

it("rejects duplicate flags and never qualifies incomplete or reduced evidence", () => {
  expect(() => parseIngressPerformanceOptions(["--rounds=5", "--rounds=5"])).toThrow()
  const full = parseIngressPerformanceOptions([])
  expect(qualifiesIngressMatrix(full, 5, [0, 1, 8], ["project-off", "global-off"])).toBe(true)
  expect(qualifiesIngressMatrix(full, 4, [0, 1, 8], ["project-off", "global-off"])).toBe(false)
  expect(qualifiesIngressMatrix(full, 5, [0, 1], ["project-off", "global-off"])).toBe(false)
  expect(qualifiesIngressMatrix(full, 5, [0, 1, 8], ["global-off"])).toBe(false)
  expect(
    qualifiesIngressMatrix({ ...full, samples: 10 }, 5, [0, 1, 8], ["project-off", "global-off"])
  ).toBe(false)
})

it("retains absolute latency and reports the fixed 5 percent limit without rounding a fail away", () => {
  expect(summarizeIngressPair([10, 10], [10.5, 10.5])).toMatchObject({
    baseline: { p95Ms: 10 },
    disabled: { p95Ms: 10.5 },
    withinBudget: true
  })
  expect(summarizeIngressPair([10, 10], [10.501, 10.501])).toMatchObject({ withinBudget: false })
  expect(() => summarizeIngressPair([0], [0])).toThrow()
  expect(() => summarizeIngressPair([1, 2], [1])).toThrow()
})

it("keeps instrumented diagnostic runs distinct from acceptance measurements", () => {
  const options = parseIngressPerformanceOptions(["--profile"])
  expect(options.profile).toBe(true)
  expect(qualifiesIngressMatrix(options, 5, [0, 1, 8], ["project-off", "global-off"])).toBe(false)
  expect(() => parseIngressPerformanceOptions(["--profile", "--profile"])).toThrow()
  expect(() => parseIngressPerformanceOptions(["--profile=false"])).toThrow()
})
