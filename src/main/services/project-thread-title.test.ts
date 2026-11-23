import { describe, expect, it } from "vitest"
import { generateTitle } from "./title-generator"
import { generateProjectThreadTitle } from "./project-thread-title"

describe("project thread title", () => {
  const binding = { projectId: "project", slug: "feature" }
  const message = "请继续完成当前阶段的任务"

  it("places the selected skill name before its description", async () => {
    expect(await generateProjectThreadTitle(message, " 方案设计 ", binding, " 编写技术方案 ")).toBe(
      "方案设计·编写技术方案"
    )
  })

  it.each(["方案设计", undefined])(
    "limits the description to 15 characters with skill name %j",
    async (name) => {
      const description = "一二三四五六七八九十一二三四五"
      const expected = name ? `${name}·${description}` : description
      expect(await generateProjectThreadTitle(message, name, binding, ` ${description} `)).toBe(
        expected
      )
      expect(await generateProjectThreadTitle(message, name, binding, ` ${description}六七 `)).toBe(
        expected
      )
    }
  )

  it.each([undefined, "", " "])(
    "uses only the name when the description is absent: %j",
    async (description) => {
      expect(await generateProjectThreadTitle(message, "方案设计", binding, description)).toBe(
        "方案设计"
      )
    }
  )

  it.each([undefined, "", " "])(
    "uses only the description when the name is absent: %j",
    async (name) => {
      expect(await generateProjectThreadTitle(message, name, binding, " 编写技术方案 ")).toBe(
        "编写技术方案"
      )
    }
  )

  it.each([undefined, "", " "])(
    "falls back to the message when both fields are absent: %j",
    async (name) => {
      for (const description of [undefined, "", " "]) {
        const text = message + "详细说明".repeat(20)
        expect(await generateProjectThreadTitle(text, name, binding, description)).toBe(
          generateTitle(text)
        )
      }
    }
  )

  it.each([undefined, null, {}, { projectId: "project" }, { slug: "feature" }])(
    "keeps ordinary threads on the existing title rules: %j",
    async (context) => {
      expect(await generateProjectThreadTitle(message, "方案设计", context, "编写技术方案")).toBe(
        generateTitle(message)
      )
    }
  )
})
