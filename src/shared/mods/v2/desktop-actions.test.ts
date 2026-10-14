import { expect, it } from "vitest"
import {
  validateCopyInput,
  validateCopyResult,
  validatePaneInfo,
  validateSelection
} from "./desktop-actions"

it("requires actual string enums rather than coercible arrays", () => {
  expect(() => validateCopyInput({ text: "text", surface: ["desktop"] })).toThrow("ARGUMENTS")
  expect(() => validateCopyResult({ isCopied: false, reason: ["refused"] })).toThrow("RESULT")
  expect(() => validateCopyInput({ text: "text", surface: "desktop" })).not.toThrow()
})
it("bounds bytes and refuses impossible focus/placement and extra private fields", () => {
  expect(() => validateSelection({ text: "汉".repeat(24000) })).toThrow()
  expect(() => validateSelection({ text: "x", owner: "private" })).toThrow()
  expect(() =>
    validatePaneInfo([{ id: "p", title: "P", isFocused: true, isShown: false, isPlaced: true }])
  ).toThrow()
})
