import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { expect, it } from "vitest"
import { FunctionTurnObservation } from "./turn-observation"

it("counts real responses once, separates cached input, and retains the last API model", () => {
  const view = new FunctionTurnObservation()
  const first = new AIMessage({
    id: "one",
    content: "one",
    response_metadata: { model_name: "first" },
    usage_metadata: {
      input_tokens: 50,
      output_tokens: 5,
      total_tokens: 55,
      input_token_details: { cache_read: 30, cache_creation: 10 }
    }
  })
  view.observe(new HumanMessage("not a response"))
  view.observe(first)
  view.observe(first)
  view.observe(
    new AIMessage({
      id: "two",
      content: [
        { type: "reasoning", text: "hidden" },
        { type: "text", text: "final" }
      ],
      response_metadata: {
        model: "second",
        usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 8 }
      }
    })
  )
  expect(view.snapshot()).toEqual({
    answer: "final",
    usage: {
      model: "second",
      input_tokens: 14,
      output_tokens: 7,
      cache_read_input_tokens: 38,
      cache_creation_input_tokens: 10
    }
  })
})

it("omits incomplete usage instead of inventing an API model or partial total", () => {
  const view = new FunctionTurnObservation()
  view.observe(
    new AIMessage({
      content: "answer",
      usage_metadata: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
    })
  )
  expect(view.snapshot()).toEqual({ answer: "answer" })
})

it("retains an interrupted visible text stream, replaces snapshots, and excludes reasoning", () => {
  const view = new FunctionTurnObservation()
  const part = (id: string, content: unknown) => [
    { id: ["AIMessageChunk"], kwargs: { id, content } },
    {}
  ]
  view.observeStream(part("one", "hel"), "delta")
  view.observeStream(
    part("one", [
      { type: "reasoning", text: "hidden" },
      { type: "text", text: "lo" }
    ]),
    "delta"
  )
  expect(view.snapshot()).toEqual({ answer: "hello" })
  view.observeStream(part("one", "replacement"), "snapshot")
  expect(view.snapshot()).toEqual({ answer: "replacement" })
  view.observe(new AIMessage({ id: "one", content: "complete" }))
  view.observeStream(part("one", "late fragment"), "delta")
  expect(view.snapshot()).toEqual({ answer: "complete" })
  view.observeStream(part("two", "partial next"), "delta")
  expect(view.snapshot()).toEqual({ answer: "partial next" })
})
