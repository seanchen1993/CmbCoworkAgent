import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import { ChatOpenAI } from "@langchain/openai"
import { describe, expect, it } from "vitest"
import { classifyApiError, isEmptyModelResponseError, isResumableStreamFailure } from "./failover"

/**
 * Guards the real failure this classification exists for: the gateway answers
 * HTTP 200 with a well-formed but contentless SSE body, so the fetch layer sees
 * a success and only LangChain notices there was nothing to aggregate.
 *
 * This drives an actual ChatOpenAI call rather than asserting on a hand-built
 * Error, so a change to LangChain's wording fails here instead of silently
 * turning the retry back off.
 */

/**
 * LangChain only takes the streaming-aggregation branch — the one that throws
 * on an empty result — when a callback handler opts into streaming. LangGraph
 * installs such a handler for every `.stream()` run, which is why the app hits
 * this path and a bare `model.invoke()` does not.
 */
class StreamingPreferringHandler extends BaseCallbackHandler {
  name = "empty-sse-test"
  lc_prefer_streaming = true
}

function emptySseFetch(): typeof fetch {
  return (async () =>
    new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    })) as unknown as typeof fetch
}

describe("HTTP 200 with an empty SSE body", () => {
  it("surfaces an error our classifier retries", async () => {
    const model = new ChatOpenAI({
      model: "gpt-4o-mini",
      apiKey: "test-key",
      maxRetries: 0,
      configuration: { fetch: emptySseFetch() }
    })

    const error = await model.invoke("hi", { callbacks: [new StreamingPreferringHandler()] }).then(
      () => null,
      (err: unknown) => err
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("Received empty response from chat model call.")
    expect(isEmptyModelResponseError(error)).toBe(true)
    expect(isResumableStreamFailure(error)).toBe(true)
    expect(classifyApiError(error)).toBe("empty_response")
  })
})
