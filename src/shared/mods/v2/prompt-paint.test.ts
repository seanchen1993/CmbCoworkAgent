import { expect, it } from "vitest"
import { validatePromptPaintArgs, validatePromptPaintResult } from "./prompt-paint"

it("requires a matching text baseline for nonempty paint and bounds display-only virtual text", () => {
  expect(() => validatePromptPaintArgs({ decorations: [] })).not.toThrow()
  expect(() => validatePromptPaintArgs({ decorations: [{ start: 0, end: 1 }] })).toThrow()
  expect(() =>
    validatePromptPaintArgs({
      text: "中文",
      decorations: [{ start: 0, end: 0, virtualText: "只显示，不提交", bold: true }]
    })
  ).not.toThrow()
  expect(() =>
    validatePromptPaintArgs({
      text: "x",
      decorations: [{ start: 0, end: 1, virtualText: "new\nline" }]
    })
  ).toThrow()
  expect(() => validatePromptPaintResult({ isPainted: true, text: "x", cursor: 2 })).toThrow()
})
