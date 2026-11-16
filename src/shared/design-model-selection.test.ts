import { describe, expect, it } from "vitest"
import { normalizeDesignModelId } from "./design-model-selection"

describe("Design model selection", () => {
  it.each([
    ["builtin:minimax", "builtin:minimax"],
    ["custom:minimax", "custom:minimax"],
    ["minimax", "custom:minimax"],
    ["custom:builtin:minimax", "builtin:minimax"],
    ["  builtin:minimax  ", "builtin:minimax"],
    ["", null],
    ["  ", null],
    [null, null],
    [undefined, null]
  ])("normalizes %j to %j without changing the model source", (input, expected) => {
    expect(normalizeDesignModelId(input)).toBe(expected)
    expect(normalizeDesignModelId(normalizeDesignModelId(input))).toBe(expected)
  })
})
