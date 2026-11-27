import { describe, expect, it } from "vitest"
import {
  isImeComposing,
  resolveNormalizedInputValue,
  sanitizeHarnessNameInput
} from "./harness-ime-input"

describe("harness IME input normalization", () => {
  it("preserves pinyin syllable spaces during Sogou IME composition and sanitizes on commit", () => {
    let value = "百福"
    let composing = true

    // Simulate Sogou Pinyin inserting a syllable-separator space while typing "查询" (cha xun).
    value = resolveNormalizedInputValue(
      "百福cha",
      isImeComposing(composing, { isComposing: true }),
      sanitizeHarnessNameInput
    )
    expect(value).toBe("百福cha")

    value = resolveNormalizedInputValue(
      "百福cha xun",
      isImeComposing(composing, { isComposing: true }),
      sanitizeHarnessNameInput
    )
    expect(value).toBe("百福cha xun")

    // Composition ends and commits the Chinese characters without swallowing "福".
    composing = false
    value = resolveNormalizedInputValue(
      "百福查询",
      isImeComposing(composing, { isComposing: false }),
      sanitizeHarnessNameInput
    )
    expect(value).toBe("百福查询")
  })

  it("strips whitespace after composition ends or on direct non-IME edits", () => {
    expect(
      resolveNormalizedInputValue("百福 查询", false, sanitizeHarnessNameInput)
    ).toBe("百福查询")
    expect(
      resolveNormalizedInputValue("  PRJ 001\t", false, sanitizeHarnessNameInput)
    ).toBe("PRJ001")
  })

  it("respects nativeEvent.isComposing even if the composition ref is false", () => {
    expect(isImeComposing(false, { isComposing: true })).toBe(true)
    expect(
      resolveNormalizedInputValue(
        "百福cha xun",
        isImeComposing(false, { isComposing: true }),
        sanitizeHarnessNameInput
      )
    ).toBe("百福cha xun")
  })

  it("returns raw values unchanged when no normalizer is supplied", () => {
    expect(resolveNormalizedInputValue("项目 名称", false)).toBe("项目 名称")
    expect(resolveNormalizedInputValue("项目 名称", true)).toBe("项目 名称")
  })
})
