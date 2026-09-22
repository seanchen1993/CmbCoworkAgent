import { expect, it } from "vitest"
import { normalizeFunctionInput } from "./pinned-input"

it("pins model call identity while allowing model selection", () => {
  const original = { turnId: "a", index: 2, messageCount: 5, model: "one" }
  expect(normalizeFunctionInput("turn.step", { ...original, model: "two" }, original)).toEqual({
    ...original,
    model: "two"
  })
  expect(() => normalizeFunctionInput("turn.step", { agentId: "different" }, original)).toThrow(
    "MODS_PINNED_INPUT"
  )
  expect(() => normalizeFunctionInput("turn.step", { index: 3 }, original)).toThrow(
    "MODS_PINNED_INPUT"
  )
  expect(() => normalizeFunctionInput("turn.step", { model: "two" }, original)).toThrow(
    "MODS_PINNED_INPUT"
  )
})

it("compares pinned objects structurally, independently of property insertion order", () => {
  expect(
    normalizeFunctionInput(
      "command.run",
      { origin: { name: "a", kind: "plugin" } },
      { origin: { kind: "plugin", name: "a" } }
    )
  ).toEqual({ origin: { kind: "plugin", name: "a" } })
  expect(() =>
    normalizeFunctionInput(
      "command.run",
      { origin: { kind: "composer" } },
      { origin: { kind: "plugin", name: "a" } }
    )
  ).toThrow("MODS_PINNED_INPUT")
})
