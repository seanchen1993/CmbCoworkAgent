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

it("omits usage when no actual response supplies a model and valid usage", () => {
  const view = new FunctionTurnObservation()
  view.observe(
    new AIMessage({
      content: "answer",
      usage_metadata: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
    })
  )
  expect(view.snapshot()).toEqual({ answer: "answer" })
})

it("replaces same-response usage and preserves other known usage when a response has none", () => {
  const view = new FunctionTurnObservation()
  const response = (id: string, count: number, model = id) =>
    new AIMessage({
      id,
      content: id,
      response_metadata: { model },
      usage_metadata: { input_tokens: count, output_tokens: 2, total_tokens: count + 2 }
    })
  view.observe(response("one", 3))
  view.observe(new AIMessage({ id: "missing", content: "no usage" }))
  view.observe(response("two", 5))
  view.observe(response("one", 8, "updated-one"))
  view.observe(new AIMessage({ id: "one", content: "later text without usage" }))
  view.observe(response("malformed", -5))
  expect(view.snapshot()).toEqual({
    answer: "malformed",
    usage: {
      // Map replacement preserves the insertion order of the first valid observation.
      model: "two",
      input_tokens: 13,
      output_tokens: 4,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    }
  })
  const projected = view.snapshot()
  projected.usage!.input_tokens = 999
  expect(view.snapshot().usage!.input_tokens).toBe(13)
})

it("deduplicates no-id objects without retaining them and handles missing then valid usage", () => {
  const view = new FunctionTurnObservation()
  const first = new AIMessage({ content: "first" })
  view.observe(first)
  view.observe(
    new AIMessage({
      id: "second",
      content: "second",
      response_metadata: { model: "second-model" },
      usage_metadata: { input_tokens: 4, output_tokens: 1, total_tokens: 5 }
    })
  )
  first.response_metadata = { model: "first-model" }
  first.usage_metadata = { input_tokens: 6, output_tokens: 2, total_tokens: 8 }
  view.observe(first)
  view.observe(first)
  expect(view.snapshot()).toMatchObject({
    answer: "first",
    usage: { model: "first-model", input_tokens: 10, output_tokens: 3 }
  })
})

it("keeps usage bounded and omits totals that exceed exact integer capacity", () => {
  const view = new FunctionTurnObservation()
  for (let index = 0; index <= 10000; index++)
    view.observe(
      new AIMessage({
        id: String(index),
        content: "answer",
        response_metadata: { model: "model" },
        usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      })
    )
  expect(view.snapshot()).toEqual({ answer: "answer" })
  const oversized = new FunctionTurnObservation()
  for (let index = 0; index < 2; index++)
    oversized.observe(
      new AIMessage({
        id: String(index),
        content: "answer",
        response_metadata: { model: "model" },
        usage_metadata: {
          input_tokens: Number.MAX_SAFE_INTEGER,
          output_tokens: 1,
          total_tokens: Number.MAX_SAFE_INTEGER
        }
      })
    )
  expect(oversized.snapshot()).toEqual({ answer: "answer" })
})

it("keeps explicit refusal facts independent from mutable returned snapshots", () => {
  const view = new FunctionTurnObservation()
  view.observe(
    new AIMessage({ content: "Refused", additional_kwargs: { refusal: "Provider explanation" } })
  )
  const first = view.snapshot()
  expect(first.refusal).toEqual({ category: null, explanation: "Provider explanation" })
  first.refusal!.explanation = "changed"
  expect(view.snapshot().refusal?.explanation).toBe("Provider explanation")
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
