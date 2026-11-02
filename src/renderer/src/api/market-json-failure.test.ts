import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { marketApi, MARKET_SKILL_LIST_MAX_ITEMS, readBoundedMarketJsonResponse } from "./market"
import { getMarketPlugins } from "./market-plugins"
import { RemoteJsonResponseError } from "./json-response"

vi.mock("./market-flags", () => ({ USE_MARKET_MOCK_ON_ERROR: false }))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

beforeEach(() => {
  vi.stubEnv("VITE_API_BASE_URL", "https://market.invalid.test")
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const requests = {
  skills: () => marketApi.getSkills(),
  mcps: () => marketApi.getMcps(),
  plugins: () => marketApi.getPlugins(),
  pluginReader: () => getMarketPlugins()
}
const badResponses = [
  ["HTML", "<!doctype html><html>PRIVATE_MARKET_BODY</html>", "text/html"],
  ["mislabeled HTML", "<!doctype html><html>PRIVATE_MARKET_BODY</html>", "application/json"],
  ["broken JSON", '{"private":"PRIVATE_MARKET_BODY"', "application/json"],
  ["empty", "", "application/json"],
  ["null", "null", "application/json"],
  ["array", "[]", "application/json"],
  ["wrong items", '{"items":null}', "application/json"],
  ["wrong name", '{"items":[{"name":{"secret":"PRIVATE_MARKET_BODY"}}]}', "application/json"],
  [
    "wrong label",
    '{"items":[{"name":"one","chinese_name":{"secret":"PRIVATE_MARKET_BODY"}}]}',
    "application/json"
  ],
  ["wrong category", '{"items":[{"name":"one","category":{}}]}', "application/json"]
] as const

describe.each(Object.entries(requests))("safe market %s response", (_name, request) => {
  it.each(badResponses)(
    "rejects %s without displaying the raw response",
    async (_kind, body, mime) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(body, {
              headers: { "content-type": mime }
            })
        )
      )
      const result = await request()
      expect(result.success).toBe(false)
      expect(result.data).toBeUndefined()
      expect(result.error).toMatch(/应用市场.*(?:网页|数据)/)
      expect(result.error).not.toMatch(/PRIVATE_MARKET_BODY|Unexpected token|Response is not JSON/)
    }
  )

  it.each(["application/json", "application/problem+json", "text/plain"])(
    "preserves valid lists using %s",
    async (mime) => {
      const items = [{ name: "one", category: "通用场景", version: "1.0.0" }]
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ items }), {
              headers: { "content-type": mime }
            })
        )
      )
      expect(await request()).toMatchObject({ success: true, data: items })
    }
  )

  it("keeps HTTP failures as failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 }))
    )
    expect(await request()).toMatchObject({ success: false })
  })
})

it("keeps the existing skill item limit and accurate remaining-page signal", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: Array.from({ length: MARKET_SKILL_LIST_MAX_ITEMS + 1 }, (_, index) => ({
              name: `skill-${index}`
            }))
          }),
          { headers: { "content-type": "application/json" } }
        )
    )
  )
  const result = await marketApi.getSkills()
  expect(result.success).toBe(true)
  expect(result.data).toHaveLength(MARKET_SKILL_LIST_MAX_ITEMS)
  expect(result.total).toBe(MARKET_SKILL_LIST_MAX_ITEMS + 1)
  expect(result.hasNextPage).toBe(true)
})

it("preserves cancellation identity and cancels the bounded JSON reader", async () => {
  const controller = new AbortController()
  const reason = new DOMException("cancel market read", "AbortError")
  const cancel = vi.fn()
  const response = new Response(new ReadableStream({ cancel }))
  controller.abort(reason)
  await expect(readBoundedMarketJsonResponse(response, 4096, controller.signal)).rejects.toBe(
    reason
  )
  expect(cancel).toHaveBeenCalled()
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(reason))
  await expect(marketApi.getSkills({ signal: controller.signal })).rejects.toBe(reason)
})

it("uses the same safe parser when a bounded response has no streaming reader", async () => {
  const response = new Response("<!doctype html><html>PRIVATE_MARKET_BODY</html>")
  Object.defineProperty(response, "body", { value: null })
  await expect(readBoundedMarketJsonResponse(response, 4096)).rejects.toBeInstanceOf(
    RemoteJsonResponseError
  )
})
