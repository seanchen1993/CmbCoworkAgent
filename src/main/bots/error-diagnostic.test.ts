import { afterEach, expect, it, vi } from "vitest"
import { APIError, APIConnectionError } from "openai"
import { BotDomainError } from "../../shared/bot-types"
import { unwrapBotIpcResult } from "../../shared/bot-ipc-result"
import { botIpcFailure, serializeBotFailure } from "./error-diagnostic"
import { createConfiguredCmbModel } from "../models/model-factory"
import {
  botModelInvocationObserver,
  botModelAttemptPending,
  captureBotModelAttemptFailure
} from "./model-error-diagnostic-scope"
import { botModelCallDiagnostics } from "./model-call-diagnostics"

afterEach(() => vi.restoreAllMocks())

function model(send: typeof fetch, purpose: "agent" | "context-compaction" = "agent") {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "info").mockImplementation(() => {})
  let calls = 0
  return createConfiguredCmbModel(
    {
      id: "fixture",
      model: "fixture",
      baseUrl: "https://fixture.invalid/v1",
      apiKey: "opaque-credential-private"
    },
    {
      purpose,
      observeInvocation: botModelInvocationObserver(["opaque-credential-private"]),
      fetch: (url, init) =>
        botModelCallDiagnostics({
          callId: `call-${++calls}`,
          botId: "fixture",
          purpose: "task",
          knownSecrets: ["opaque-credential-private"]
        }).send(send, url, init)
    }
  )
}

it("preserves real SDK provider headers/cause but ignores unverified ID-shaped properties", () => {
  const sdk = APIError.generate(
    429,
    { message: "quota" },
    "quota",
    new Headers({ "x-request-id": "provider-real" })
  )
  const failure = serializeBotFailure(new Error("wrapped", { cause: sdk }))
  expect(failure.diagnostic).toMatchObject({ status: 429, requestId: "provider-real" })
  const arbitrary = Object.assign(new Error("tool denied"), {
    requestID: "fake-provider",
    request_id: "fake-provider",
    requestId: "fake-provider"
  })
  expect(serializeBotFailure(arbitrary).diagnostic).not.toHaveProperty("requestId")
})

it("keeps safe diagnostics through IPC and rejects malformed identifiers", () => {
  const error = new BotDomainError("model_failed", "Authorization: Bearer PRIVATE_CREDENTIAL", {
    code: "model_failed",
    callId: "call-real",
    requestId: "provider-real"
  })
  const wire = botIpcFailure(error)
  expect(wire.botFailure.message).not.toContain("PRIVATE_CREDENTIAL")
  expect(() => unwrapBotIpcResult(wire)).toThrow(
    expect.objectContaining({ diagnostic: error.diagnostic })
  )
  expect(() =>
    unwrapBotIpcResult({
      botFailure: {
        code: "error",
        message: "failure",
        diagnostic: { code: "error", requestId: "https://secret.invalid/key" }
      }
    })
  ).toThrow(expect.objectContaining({ code: "invalid_error_packet" }))
})

it("does not reintroduce a credential-bearing raw SDK header after owned provenance removed it", () => {
  const key = "opaque-credential-private"
  const sdk = APIError.generate(
    401,
    { message: `rejected ${key}` },
    "rejected",
    new Headers({ "x-request-id": key })
  )
  captureBotModelAttemptFailure(sdk, { status: 401, requestId: key, callId: "call-safe" }, [key])
  const failure = serializeBotFailure(sdk)
  expect(JSON.stringify(failure)).not.toContain(key)
  expect(failure.diagnostic).toEqual({
    code: "authentication_failed",
    status: 401,
    callId: "call-safe"
  })
})

it("covers withConfig and tool binding real SDK invocations without leaking provider credentials", async () => {
  const llm = model(
    async () =>
      new Response(JSON.stringify({ error: { message: "rejected opaque-credential-private" } }), {
        status: 429,
        headers: { "content-type": "application/json", "x-request-id": "provider-bound" }
      })
  )
  for (const bound of [llm.withConfig({ tags: ["test"] }), llm.bindTools([])]) {
    const error = await bound.invoke("hello").catch((failure: unknown) => failure)
    const failure = serializeBotFailure(error)
    expect(failure.message).not.toContain("opaque-credential-private")
    expect(failure.diagnostic).toMatchObject({ status: 429, requestId: "provider-bound" })
    expect(failure.diagnostic?.callId).toMatch(/^call-[12]$/)
  }
})

it("associates SSE/parser and LangChain empty-output failures with that exact response", async () => {
  for (const body of ["data: broken-json\n\n", "data: [DONE]\n\n"]) {
    const llm = model(
      async () =>
        new Response(body, {
          headers: { "content-type": "text/event-stream", "x-request-id": "provider-stream" }
        }),
      "context-compaction"
    )
    const bound = llm.withConfig({ tags: ["stream"] })
    const error = await (
      body.includes("broken-json")
        ? (async () => {
            for await (const chunk of await bound.stream("hello")) void chunk
          })()
        : bound.invoke("hello")
    ).catch((failure: unknown) => failure)
    expect(
      serializeBotFailure(error).diagnostic,
      JSON.stringify({ body, failure: serializeBotFailure(error) })
    ).toMatchObject({ status: 200, requestId: "provider-stream", callId: "call-1" })
  }
})

it("clears earlier HTTP IDs before a later network attempt and never assigns successful model metadata to a tool error", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {})
  const observer = botModelInvocationObserver()
  const error = await observer
    .run(async () => {
      await botModelCallDiagnostics({ callId: "http", botId: "bot", purpose: "task" }).send(
        async () =>
          new Response("rejected", { status: 500, headers: { "x-request-id": "old-provider" } }),
        "https://fixture.invalid"
      )
      return botModelCallDiagnostics({ callId: "network", botId: "bot", purpose: "task" }).send(
        async () => {
          throw new Error("fetch failed")
        },
        "https://fixture.invalid"
      )
    })
    .catch((failure: unknown) => failure)
  expect(serializeBotFailure(error).diagnostic).toEqual({
    code: "network_error",
    callId: "network"
  })
  await observer.run(async () =>
    botModelCallDiagnostics({ callId: "success", botId: "bot", purpose: "task" }).send(
      async () => new Response("ok", { headers: { "x-request-id": "successful-provider" } }),
      "https://fixture.invalid"
    )
  )
  expect(
    serializeBotFailure(Object.assign(new Error("EACCES"), { code: "EACCES" })).diagnostic
  ).toEqual({ code: "runtime_failed" })
})

it("keeps concurrent bound invocations attached to their own response and call", async () => {
  const releases = new Map<string, (response: Response) => void>()
  const llm = model(async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
    return new Promise<Response>((resolve) => releases.set(request.messages[0]!.content, resolve))
  })
  const first = llm.invoke("first").catch((error: unknown) => error)
  const second = llm
    .withConfig({ tags: ["second"] })
    .invoke("second")
    .catch((error: unknown) => error)
  await vi.waitFor(() => expect(releases.size).toBe(2))
  const response = (id: string) =>
    new Response(JSON.stringify({ error: { message: "rejected" } }), {
      status: 429,
      headers: { "x-request-id": id, "content-type": "application/json" }
    })
  releases.get("second")!(response("second-response"))
  const secondFailure = serializeBotFailure(await second)
  releases.get("first")!(response("first-response"))
  const firstFailure = serializeBotFailure(await first)
  expect(firstFailure.diagnostic).toMatchObject({ requestId: "first-response", callId: "call-1" })
  expect(secondFailure.diagnostic).toMatchObject({ requestId: "second-response", callId: "call-2" })
})

it("never assigns a prior retry's provider ID when the next admission is locally revoked before reservation", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {})
  const observer = botModelInvocationObserver()
  const error = await observer
    .run(async () => {
      await botModelCallDiagnostics({ callId: "prior-retry", botId: "bot", purpose: "task" }).send(
        async () =>
          new Response("quota", { status: 429, headers: { "x-request-id": "prior-provider" } }),
        "https://fixture.invalid"
      )
      botModelAttemptPending()
      throw new APIConnectionError({
        message: "Connection error",
        cause: new BotDomainError("harness_context_changed", "权限已撤销")
      })
    })
    .catch((failure: unknown) => failure)
  expect(serializeBotFailure(error).diagnostic).toEqual({ code: "harness_context_changed" })
})

it("reports a common parallel local admission failure without borrowing model request IDs", () => {
  const errors = Array.from(
    { length: 4 },
    (_, index) =>
      new BotDomainError("local_permission_retired", "本机许可已撤销，此操作尚未执行", {
        code: "local_permission_retired",
        callId: `different-call-${index}`
      })
  )
  const failure = serializeBotFailure(
    new AggregateError(errors, "Multiple errors occurred during superstep 188")
  )
  expect(failure).toEqual({
    code: "local_permission_retired",
    message: "本机许可已撤销，此操作尚未执行",
    diagnostic: { code: "local_permission_retired" }
  })
})
it("does not collapse mixed aggregate failures or invoke an aggregate/index getter", () => {
  const domain = new BotDomainError("local_permission_retired", "已撤销")
  const sdk = APIError.generate(
    429,
    { message: "quota" },
    "quota",
    new Headers({ "x-request-id": "other-call" })
  )
  const mixed = serializeBotFailure(new AggregateError([domain, sdk], "parallel failure"))
  expect(mixed).toEqual({
    code: "runtime_failed",
    message: "parallel failure",
    diagnostic: { code: "runtime_failed" }
  })
  const getter = vi.fn(() => {
    throw Error("must not run")
  })
  const aggregate = new AggregateError([domain], "safe failure")
  Object.defineProperty(aggregate, "errors", { get: getter })
  expect(serializeBotFailure(aggregate).message).toBe("safe failure")
  const indexed = new AggregateError([domain], "safe indexed")
  Object.defineProperty(indexed.errors, "0", { get: getter })
  expect(serializeBotFailure(indexed).message).toBe("safe indexed")
  expect(getter).not.toHaveBeenCalled()
  expect(serializeBotFailure(new AggregateError(Array(65).fill(domain), "bounded")).code).toBe(
    "runtime_failed"
  )
})
it("redacts a common aggregate domain message and respects cyclic cause bounds", () => {
  const domain = new BotDomainError("local_permission_retired", "opaque-secret-value")
  const wrapped = new Error("wrapper", { cause: domain })
  Object.defineProperty(domain, "cause", { value: wrapped })
  const failure = serializeBotFailure(
    new Error("outer", { cause: new AggregateError([wrapped, domain], "parallel") }),
    {
      knownSecrets: ["opaque-secret-value"]
    }
  )
  expect(failure.code).toBe("local_permission_retired")
  expect(JSON.stringify(failure)).not.toContain("opaque-secret-value")
})
