import { expect, it } from "vitest"
import {
  validateFunctionConfigDescription,
  validateFunctionConfigSetInput,
  validateFunctionConfigSetResult
} from "./config"

it("validates the real fixed config facts and refuses an unproven result envelope", () => {
  const input = {
    key: "gitChangeNoticeEnabled",
    value: false,
    previous: true,
    provider: { plugin: "engine", tier: "core" },
    origin: { kind: "plugin", name: "rules" }
  }
  expect(() => validateFunctionConfigSetInput(input)).not.toThrow()
  expect(() => validateFunctionConfigSetInput({ ...input, origin: { kind: "plugin" } })).toThrow()
  expect(() => validateFunctionConfigSetInput({ ...input, permission: "allow" })).toThrow()
  expect(() =>
    validateFunctionConfigSetInput({ ...input, provider: { plugin: "engine", tier: ["core"] } })
  ).toThrow()
  expect(() => validateFunctionConfigSetResult({ value: false })).not.toThrow()
  expect(() => validateFunctionConfigSetResult({ deny: "Locked" })).not.toThrow()
  expect(() => validateFunctionConfigSetResult({ value: false, deny: "fake" })).toThrow()
})

it("description can only describe and hide the fixed row", () => {
  const result = { label: "Git change notice", description: "Help", isHidden: false }
  expect(() => validateFunctionConfigDescription(result)).not.toThrow()
  expect(() => validateFunctionConfigDescription({ ...result, key: "fake" })).toThrow()
  expect(() => validateFunctionConfigDescription({ ...result, value: true })).toThrow()
  expect(() =>
    validateFunctionConfigDescription(
      { ...result, key: "gitChangeNoticeEnabled", provider: { plugin: "engine", tier: "core" } },
      true
    )
  ).not.toThrow()
})
