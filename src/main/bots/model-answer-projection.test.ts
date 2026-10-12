import { expect, it } from "vitest"
import { BotModelAnswerProjection } from "./model-answer-projection"

it("projects split reasoning tags without ever exposing a tag fragment or private reasoning", () => {
  const answer = new BotModelAnswerProjection()
  for (const chunk of ["<thi", "nk>", "PRIVATE", "</thi", "nk>"])
    expect(answer.push(chunk)).toBe(false)
  expect(answer.text).toBe("")
  answer.push("A省20元")
  answer.push("，B快2天")
  expect(answer.finish()).toBe("A省20元，B快2天")
})

it("removes only the line separator of a stripped reasoning wrapper, preserving body indentation and ordinary whitespace", () => {
  for (const body of [
    "ONE_LINE",
    "    indented\n  body",
    "```ts\n  code\n```",
    "<think>literal</think>"
  ]) {
    const raw = `<think>PRIVATE</think>\r\n\n${body}`
    for (const typed of [false, true]) {
      const complete = new BotModelAnswerProjection(),
        chunks = new BotModelAnswerProjection()
      const push = (projection: BotModelAnswerProjection, content: string) =>
        typed
          ? projection.pushMessage({ content, additional_kwargs: { reasoning: "PRIVATE" } })
          : projection.push(content)
      push(complete, raw)
      for (const character of raw) push(chunks, character)
      // An untyped leading <think> remains the existing ambiguous legacy case;
      // typed provider reasoning keeps subsequent literal XML as body data.
      if (!typed && body.startsWith("<think>")) continue
      expect(complete.finish()).toBe(body)
      expect(chunks.finish()).toBe(body)
    }
  }
  for (const content of ["\n\n    ordinary\n", "    code\n", "text\n\n<think>literal</think>"]) {
    const plain = new BotModelAnswerProjection()
    plain.push(content)
    expect(plain.finish()).toBe(content)
  }
  const structural = new BotModelAnswerProjection()
  structural.push([
    { type: "thinking", thinking: "PRIVATE" },
    { type: "text", text: "\n\n    original\n" }
  ])
  expect(structural.finish()).toBe("\n\n    original\n")
})

it("shares the existing structural answer extractor and leaves the original provider content intact", () => {
  const raw = [
    { type: "thinking", thinking: "PRIVATE_THINKING" },
    { type: "reasoning", text: "PRIVATE_REASONING" },
    { type: "text", text: "visible" },
    { type: "output_text", text: " answer" }
  ]
  const before = JSON.stringify(raw)
  const answer = new BotModelAnswerProjection()
  answer.push(raw)
  expect(answer.finish()).toBe("visible answer")
  expect(JSON.stringify(raw)).toBe(before)
})

it("projects complete authoritative content consistently with character-sized deltas", () => {
  const raw = "<THINK>first secret</THINK>A省20元，B快2天"
  const complete = new BotModelAnswerProjection(),
    chunks = new BotModelAnswerProjection()
  complete.push(raw)
  for (const character of raw) chunks.push(character)
  expect(complete.finish()).toBe("A省20元，B快2天")
  expect(chunks.finish()).toBe(complete.finish())
  const ordinary = new BotModelAnswerProjection()
  ordinary.push("普通内容与 <think-like> 文本")
  expect(ordinary.finish()).toBe("普通内容与 <think-like> 文本")
})

it("refuses leading unfinished reasoning and yields no body for a complete think-only reply", () => {
  for (const content of ["<think>PRIVATE"]) {
    const answer = new BotModelAnswerProjection()
    answer.push(content)
    expect(() => answer.finish()).toThrow("尚未完成")
    expect(answer.text).not.toContain("PRIVATE")
  }
  const complete = new BotModelAnswerProjection()
  complete.push("<think>PRIVATE</think>")
  expect(complete.finish()).toBe("")
})

it("bounds provider data independently from the persisted body instead of dropping the front of a stream", () => {
  const body = new BotModelAnswerProjection()
  body.push("x".repeat(128_000))
  expect(body.text).toHaveLength(128_000)
  expect(() => body.push("x")).toThrow("正文超出上限")
  const reasoning = new BotModelAnswerProjection()
  expect(() => reasoning.push("<think>" + "x".repeat(256_000))).toThrow("生成上限")
  expect(reasoning.text).toBe("")
})

it("keeps XML/code examples after the body begins and literal trailing prefix characters", () => {
  for (const raw of [
    "XML example: <think>literal</think>",
    "```xml\n<think>literal</think>\n```",
    "answer <",
    "answer <thi",
    "<",
    "<thi",
    "</think>literal close",
    "<think>provider reason</think>XML example <think>literal</think> <thi"
  ]) {
    const complete = new BotModelAnswerProjection(),
      chunks = new BotModelAnswerProjection()
    complete.push(raw)
    for (const character of raw) chunks.push(character)
    const expected = raw.startsWith("<think>provider reason</think>")
      ? raw.slice("<think>provider reason</think>".length)
      : raw
    expect(complete.finish()).toBe(expected)
    expect(chunks.finish()).toBe(expected)
  }
})

it("uses typed provider reasoning to distinguish a real wrapper from a leading literal body example", () => {
  const actual = new BotModelAnswerProjection()
  actual.pushMessage({
    content: "<think>provider reason</think><think>literal</think> <thi",
    additional_kwargs: { reasoning: "provider reason" }
  })
  expect(actual.finish()).toBe("<think>literal</think> <thi")
  const literal = new BotModelAnswerProjection()
  literal.pushMessage({
    content: "<think>literal example</think>",
    additional_kwargs: { reasoning: "separately exposed provider reason" }
  })
  expect(literal.finish()).toBe("<think>literal example</think>")
  const structural = new BotModelAnswerProjection()
  structural.push([
    { type: "thinking", thinking: "PRIVATE" },
    { type: "text", text: "<think>literal example</think>" }
  ])
  expect(structural.finish()).toBe("<think>literal example</think>")
})
