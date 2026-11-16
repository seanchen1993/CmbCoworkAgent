import { describe, expect, it } from "vitest"
import { normalizeQuestionDef } from "./managed-design-session"

describe("answerable design questions", () => {
  it.each(["chips", "radio", "select", "checkbox", "direction-cards"])(
    "falls back to a text input when a %s question has no usable choices",
    (type) => {
      for (const options of [undefined, [], [null, {}, "", "  ", { label: " " }]]) {
        expect(normalizeQuestionDef({ id: "page_type", type, label: "页面类型？", options, multi: true, required: true }))
          .toMatchObject({ id: "page_type", type: "text", label: "页面类型？", options: [], multi: false, required: true })
      }
    }
  )

  it("accepts choices as a compatibility alias while preferring usable canonical options", () => {
    expect(normalizeQuestionDef({ id: "type", type: "chips", choices: ["工具", "内容"] }))
      .toMatchObject({ type: "chips", options: ["工具", "内容"] })
    expect(normalizeQuestionDef({ id: "type", type: "chips", options: [" "], choices: ["工具"] }))
      .toMatchObject({ type: "chips", options: ["工具"] })
    expect(normalizeQuestionDef({ id: "type", type: "chips", options: ["表单"], choices: ["工具"] }))
      .toMatchObject({ type: "chips", options: ["表单"] })
  })

  it("removes blank and duplicate choices and preserves option values and labels through normalization", () => {
    const question = normalizeQuestionDef({
      id: "platform", type: "checkbox", required: true,
      options: ["  ", null, {}, { value: " desktop ", label: " 桌面网页 " },
        { value: "desktop", label: "重复项" }, "移动端", { value: "tablet" }]
    })!
    expect(question).toMatchObject({
      type: "chips", options: ["desktop", "移动端", "tablet"],
      optionLabels: { desktop: "桌面网页", 移动端: "移动端", tablet: "tablet" },
      multi: true, required: true
    })
    expect(normalizeQuestionDef(question)).toEqual(question)
  })
})
