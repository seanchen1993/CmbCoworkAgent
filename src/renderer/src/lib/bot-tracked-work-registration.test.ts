import { expect, it, vi } from "vitest"
import { botTrackedWorkKey } from "../../../shared/bot-work-pages"
import {
  BotTrackedWorkRegistry,
  botTrackedWorkError,
  observeBotTrackedWorkRegistration,
  type BotTrackedWorkIssue
} from "./bot-tracked-work"

it("only exposes a registration issue to its exact supported Host/epoch/target", () => {
  const scope = JSON.stringify(["host", "epoch", { kind: "run", botId: "bot", runId: "run" }])
  const issue = { scope, message: "capacity" }
  expect(botTrackedWorkError(issue, scope, true)).toBe("capacity")
  expect(botTrackedWorkError(issue, scope, false)).toBeUndefined()
  for (const next of [
    JSON.stringify(["new-host", "epoch", { kind: "run", botId: "bot", runId: "run" }]),
    JSON.stringify(["host", "restored", { kind: "run", botId: "bot", runId: "run" }]),
    JSON.stringify(["host", "epoch", { kind: "run", botId: "bot", runId: "another" }]),
    JSON.stringify(["host", "epoch", ""])
  ])
    expect(botTrackedWorkError(issue, next, true)).toBeUndefined()
})

it("recovers two rejected mounted consumers one freed slot at a time without disturbing active registrations", () => {
  const registry = new BotTrackedWorkRegistry()
  const firstTarget = { kind: "run", botId: "bot", runId: "first" } as const
  const first = registry.register(firstTarget),
    duplicate = registry.register(firstTarget)
  const originals = Array.from({ length: 63 }, (_, index) =>
    registry.register({ kind: "run", botId: "bot", runId: `original-${index}` })
  )
  const targets = ["waiting-a", "waiting-b"].map(
    (runId) => ({ kind: "run", botId: "bot", runId }) as const
  )
  const registers = targets.map((target) => vi.fn(() => registry.register(target)))
  const issues: (BotTrackedWorkIssue | undefined)[] = []
  const stops = targets.map((_, index) =>
    observeBotTrackedWorkRegistration(
      `scope-${index}`,
      registers[index],
      (retry) => registry.onCapacityAvailable(retry),
      (issue) => {
        issues[index] = issue
      }
    )
  )
  expect(issues.every(Boolean)).toBe(true)
  first()
  expect(registers.map((register) => register.mock.calls.length)).toEqual([1, 1])
  duplicate()
  expect(registry.has(botTrackedWorkKey(targets[0]))).toBe(true)
  expect(registry.has(botTrackedWorkKey(targets[1]))).toBe(false)
  expect(issues[0]).toBeUndefined()
  expect(issues[1]?.scope).toBe("scope-1")
  expect(registry.list()).toHaveLength(64)
  originals[0]()
  expect(registry.has(botTrackedWorkKey(targets[1]))).toBe(true)
  expect(issues[1]).toBeUndefined()
  expect(registers.map((register) => register.mock.calls.length)).toEqual([2, 3])
  originals[1]()
  expect(registers.map((register) => register.mock.calls.length)).toEqual([2, 3])
  for (const stop of stops) {
    stop()
    stop()
  }
  for (const release of originals) release()
  expect(registry.list()).toHaveLength(0)
})

it("retires a failed consumer before a capacity event and ignores an already captured late retry", () => {
  const registry = new BotTrackedWorkRegistry()
  const releases = Array.from({ length: 64 }, (_, index) =>
    registry.register({ kind: "run", botId: "bot", runId: `run-${index}` })
  )
  const register = vi.fn(() => registry.register({ kind: "run", botId: "bot", runId: "retired" }))
  const publish = vi.fn()
  let lateRetry!: () => void
  const stop = observeBotTrackedWorkRegistration(
    "old-scope",
    register,
    (retry) => {
      lateRetry = retry
      return registry.onCapacityAvailable(retry)
    },
    publish
  )
  expect(register).toHaveBeenCalledOnce()
  stop()
  releases[0]()
  lateRetry()
  expect(register).toHaveBeenCalledOnce()
  expect(publish).toHaveBeenCalledOnce()
  for (const release of releases) release()
  expect(registry.list()).toHaveLength(0)
})
