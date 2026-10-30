import { describe, expect, it } from "vitest"
import { DesignQuestionStream, readCompleteDesignQuestions } from "./question-stream"

describe("incremental design questions", () => {
  it("publishes closed questions across arbitrary chunks without waiting for the form to close", () => {
    const first = {
      id: "scope",
      type: "chips",
      label: "包含哪些模块？",
      options: ["收入", '含括号 [ 和引号 " 的选项'],
      multi: true
    }
    const second = { id: "audience", type: "text", label: "给谁使用？" }
    const stream = new DesignQuestionStream()
    const partial =
      '<question-form id="discovery">{"questions":[' + JSON.stringify(first) + ',{"id":"audience"'
    const emitted: unknown[] = []
    for (const token of partial) emitted.push(...stream.push(token))
    expect(emitted).toEqual([first])
    expect(stream.push(',"type":"text","label":"给谁使用？"}')).toEqual([second])
    expect(stream.push("]}</question-form>")).toEqual([])
    expect(stream.questions).toEqual([first, second])
  })

  it("ignores thinking JSON, incomplete objects and duplicate question IDs", () => {
    const q = { id: "name", label: "名称", type: "text" }
    const stream = new DesignQuestionStream()
    expect(stream.push('<think>{"questions":[' + JSON.stringify(q))).toEqual([])
    expect(
      stream.push("]}</think>```json\n[" + JSON.stringify(q) + "," + JSON.stringify(q))
    ).toEqual([q])
    expect(stream.push(',{"id":"unfinished"')).toEqual([])
    expect(stream.questions).toEqual([q])
  })

  it("handles nested card arrays, escapes, wrapper objects and trailing text", () => {
    const q = {
      id: "style",
      type: "direction-cards",
      label: "方向",
      options: ["a"],
      cards: [{ id: "a", palette: ["oklch(98% 0 0)"], mood: "{轻盈}\\自然" }]
    }
    expect(
      readCompleteDesignQuestions(JSON.stringify({ questions: [q] }) + " [unrelated]")
    ).toEqual([q])
    expect(
      readCompleteDesignQuestions('{"questions":[{"label":"missing id"},' + JSON.stringify(q) + ",")
    ).toEqual([q])
  })
})
