import { expect, it } from "vitest"
import {
  applyPromptEdit, cumulativePromptEdit, validatePromptEditInput, validatePromptEditResult,
  validatePromptSuggestInput, validatePromptSuggestResult
} from "./prompt-edit"

it("constructs the entire unconfirmed burst from the confirmed baseline", () => {
  const input = cumulativePromptEdit({ text: "approved", cursor: 8 },
    { text: "approvedXY", cursor: 10 })
  expect(input).toEqual({ origin: { kind: "composer" }, text: "approved", cursor: 8,
    start: 8, end: 8, inputText: "XY" })
  expect(applyPromptEdit(input)).toEqual({ text: "approvedXY", cursor: 10 })
  expect(input).not.toHaveProperty("key")
})
it("does not guess another repeated character as the native splice", () => {
  expect(cumulativePromptEdit({ text: "aa", cursor: 0 }, { text: "aaa", cursor: 1 }))
    .toMatchObject({ text: "aa", cursor: 0, start: 0, end: 2, inputText: "aaa" })
})
it("keeps UTF-16 offsets, replacement/deletion and bare cursor movement exact", () => {
  for (const [before, after] of [["a😀z", "a🙂z"], ["abcd", "ad"], ["abc", "a插入bc"]]) {
    const result = applyPromptEdit(cumulativePromptEdit({ text: before, cursor: before.length },
      { text: after, cursor: after.length }))
    expect(result.text).toBe(after)
  }
  expect(applyPromptEdit(cumulativePromptEdit({ text: "abc", cursor: 3 },
    { text: "abc", cursor: 1 }))).toEqual({ text: "abc", cursor: 1 })
})
it("validates pinned key shape and rejects impossible offsets/private metadata", () => {
  const input = cumulativePromptEdit({ text: "", cursor: 0 }, { text: "x", cursor: 1 },
    { key: "x", shift: true })
  expect(() => validatePromptEditInput(input)).not.toThrow()
  expect(() => validatePromptEditInput({ ...input, start: -1 })).toThrow()
  expect(() => validatePromptEditInput({ ...input, end: 1 })).toThrow()
  expect(() => validatePromptEditInput({ ...input, owner: "fake" })).toThrow()
  expect(() => validatePromptEditInput({ ...input, key: { key: "x", ctrl: false } })).toThrow()
})
it("bounds visible results and accepts out-of-range decoration spans for display clamping", () => {
  expect(() => validatePromptEditResult({ text: "OK", cursor: 2,
    decorations: [{ start: -5, end: 20, bold: true }] })).not.toThrow()
  expect(() => validatePromptEditResult({ text: "OK", cursor: 3 })).toThrow()
  expect(() => validatePromptEditResult({ text: "OK", cursor: 0, decorations: [{ start: 0,
    end: 1, html: "<x>" }] })).toThrow()
  expect(() => validatePromptEditResult({ text: "x".repeat(64001), cursor: 0 })).toThrow()
})
it("keeps suggestions as proposals and rejects fabricated display fields", () => {
  expect(() => validatePromptSuggestInput({ text: "Next", origin: { kind: "plugin", name: "p" } }))
    .not.toThrow()
  expect(() => validatePromptSuggestInput({ text: "Next", origin: { kind: "composer" } })).toThrow()
  expect(() => validatePromptSuggestResult({ isShown: false })).not.toThrow()
  expect(() => validatePromptSuggestResult({ isShown: true, sent: true })).toThrow()
})
