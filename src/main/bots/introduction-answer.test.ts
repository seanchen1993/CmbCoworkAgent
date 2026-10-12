import { expect, it } from "vitest"
import { BotIntroductionAnswer } from "./introduction-answer"

it("never publishes a split inline think tag or reasoning text and preserves later answer deltas", () => {
  const answer = new BotIntroductionAnswer()
  for (const part of ["<thi", "nk>", "private thought", "</thi", "nk>"])
    expect(answer.push(part)).toBe(false)
  expect(answer.text).toBe("")
  answer.push("你好")
  answer.push("，先做什么？")
  expect(answer.finish()).toBe("你好，先做什么？")
})

it("uses the existing structural body extractor and excludes typed thinking/reasoning blocks", () => {
  const answer = new BotIntroductionAnswer()
  answer.push([
    { type: "thinking", thinking: "private" },
    { type: "reasoning", text: "private" },
    { type: "text", text: "你好！" },
    { type: "output_text", text: "从哪开始？" }
  ])
  expect(answer.finish()).toBe("你好！从哪开始？")
})

it("does not accept think-only or unfinished tagged reasoning as a completed body", () => {
  const unfinished = new BotIntroductionAnswer()
  unfinished.push("<think>private")
  expect(unfinished.text).toBe("")
  expect(() => unfinished.finish()).toThrow("尚未完成")
  const complete = new BotIntroductionAnswer()
  complete.push("<think>private</think>")
  expect(complete.finish()).toBe("")
  const split = new BotIntroductionAnswer()
  split.push("<thi")
  expect(() => split.finish()).toThrow("尚未完成")
})

it("projects the same complete message and byte-split stream, with bounded body and provider data", () => {
  const text = "<think>first</think>你好，<think>second</think>先做什么？"
  const complete = new BotIntroductionAnswer(),
    chunks = new BotIntroductionAnswer()
  complete.push(text)
  for (const part of text) chunks.push(part)
  expect(chunks.finish()).toBe(complete.finish())
  const largeBody = new BotIntroductionAnswer()
  expect(() => largeBody.push("x".repeat(16_001))).toThrow("正文")
  const largeThought = new BotIntroductionAnswer()
  expect(() => largeThought.push("<think>" + "x".repeat(128_001))).toThrow("生成")
})
