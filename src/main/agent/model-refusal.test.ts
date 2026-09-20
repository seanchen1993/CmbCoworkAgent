import { describe, expect, it } from "vitest"
import { readModelRefusal } from "./model-refusal"

describe("provider refusal facts", () => {
  it.each([
    [
      {
        response_metadata: {
          stop_reason: "refusal",
          stop_details: { category: "policy", explanation: "why" }
        }
      },
      { category: "policy", explanation: "why" }
    ],
    [{ response_metadata: { stop_reason: "refusal" } }, { category: null, explanation: null }],
    [
      { additional_kwargs: { refusal: "Cannot comply" } },
      { category: null, explanation: "Cannot comply" }
    ],
    [
      { response_metadata: { finish_reason: "content_filter" } },
      { category: null, explanation: null }
    ],
    [
      { content: [{ type: "refusal", refusal: "Refused" }] },
      { category: null, explanation: "Refused" }
    ]
  ])("reads only explicit structured refusal metadata: %j", (message, refusal) => {
    expect(readModelRefusal(message)).toEqual(refusal)
  })

  it.each([
    { content: "I cannot help with that", response_metadata: { finish_reason: "stop" } },
    { additional_kwargs: { refusal: null } },
    { additional_kwargs: { refusal: "" } },
    { content: [{ type: "text", text: "refusal" }] },
    { response_metadata: { finish_reason: "length" } }
  ])("does not infer a refusal from prose, missing fields or truncation: %j", (message) => {
    expect(readModelRefusal(message)).toBeUndefined()
  })
})
