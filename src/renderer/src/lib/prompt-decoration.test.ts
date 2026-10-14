import { expect, it } from "vitest"
import { movePromptDecorations, clampPromptDecorationGraphemes } from "./prompt-decoration"

it("moves surviving paint around inserted text without painting newly typed characters", () => {
  expect(movePromptDecorations("abcd", "abXYcd", [{ start: 0, end: 4, bold: true }]))
    .toEqual([{ start: 0, end: 2, bold: true }, { start: 4, end: 6, bold: true }])
})
it("floors both boundaries at the whole grapheme, including emoji, combining marks and ZWJ", () => {
  expect(clampPromptDecorationGraphemes("😀", [{ start: 0, end: 1 }])).toEqual([])
  expect(clampPromptDecorationGraphemes("a\u0301👨‍👩‍👧‍👦z", [{ start: 1, end: 3 }]))
    .toEqual([{ start: 0, end: 2 }])
})
it("removes deleted paint, clamps old ranges and preserves cursor-only paint", () => {
  expect(movePromptDecorations("abcd", "ad", [{ start: 1, end: 3 }])).toEqual([])
  expect(movePromptDecorations("abcd", "abcd", [{ start: -100, end: 100, underline: true }]))
    .toEqual([{ start: 0, end: 4, underline: true }])
})
