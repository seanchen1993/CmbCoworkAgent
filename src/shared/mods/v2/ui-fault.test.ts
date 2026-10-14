import { expect, it } from "vitest"
import { functionUiFaultReason, validateFunctionUiFault } from "./ui-fault"
import { normalizeFunctionInput } from "./pinned-input"

const input = {
  surface: "desktop",
  component: "Pane",
  requestId: "board",
  element: "client",
  module: "surface.js",
  phase: "run",
  reason: "failure"
}

it("pins every fact and preserves omitted notification fields", () => {
  expect(normalizeFunctionInput("ui.fault", {}, input)).toEqual(input)
  for (const key of Object.keys(input)) {
    expect(() => normalizeFunctionInput("ui.fault", { [key]: "forged" }, input)).toThrow(
      "MODS_PINNED_INPUT"
    )
  }
})

it("requires a bounded native desktop drawing fault input", () => {
  expect(() => validateFunctionUiFault(input)).not.toThrow()
  for (const value of [
    { ...input, reason: "" },
    { ...input, reason: "x".repeat(201) },
    { ...input, reason: "x\n" },
    { ...input, extra: true },
    { ...input, component: "ToolProgress" },
    { ...input, phase: "invented" }
  ]) {
    expect(() => validateFunctionUiFault(value)).toThrow("MODS_UI_FAULT_INPUT")
  }
})

it("accepts the actual desktop site components without allowing synthetic Client authority", () => {
  expect(() => validateFunctionUiFault({ ...input, component: "AbovePrompt" })).not.toThrow()
  expect(() => validateFunctionUiFault({ ...input, component: "AskUserQuestion" })).not.toThrow()
  expect(() => validateFunctionUiFault({ ...input, component: "Client" })).toThrow()
})

it("removes control characters and supplies a safe empty fallback", () => {
  expect(functionUiFaultReason("a\n\u0000b\u0080")).toBe("a b")
  expect(functionUiFaultReason("x".repeat(201))).toBe("x".repeat(199) + "…")
  expect(functionUiFaultReason(undefined)).toBe("the module failed without a message")
})
