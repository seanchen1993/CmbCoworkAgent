import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  MARKET_SKILL_CATALOG_CHANGED,
  MARKET_SKILL_LIST_MAX_ITEMS,
  MARKET_SKILL_LIST_MAX_RESPONSE_BYTES
} from "../../shared/market-skill-catalog"

const { notify } = vi.hoisted(() => ({ notify: vi.fn() }))
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: notify } }]
  }
}))
vi.mock("../storage", () => ({ getUserInfo: vi.fn() }))

describe("Main market skill catalog responses", () => {
  let request: ReturnType<typeof vi.fn<typeof fetch>>

  beforeEach(() => {
    vi.resetModules()
    notify.mockClear()
    vi.stubEnv("VITE_API_BASE_URL", "https://market.example")
    request = vi.fn<typeof fetch>()
    vi.stubGlobal("fetch", request)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it.each([
    undefined,
    "application/json",
    "application/problem+json",
    "text/plain",
    "application/octet-stream"
  ])(
    "accepts a valid catalog with %s MIME and retains source/visibility metadata",
    async (mime) => {
      const items = [
        {
          name: "author",
          id: "market-1",
          user_id: "owner-1",
          extra_json: JSON.stringify({
            grayOrgs: ["department"],
            sourceAccessUserIds: ["owner-1"]
          }),
          description: "Project plugin authoring",
          version: "1.0.0"
        }
      ]
      const response = new Response("\uFEFF" + JSON.stringify({ items }), {
        headers: mime ? { "Content-Type": mime } : undefined
      })
      if (!mime) response.headers.delete("content-type")
      request.mockResolvedValueOnce(response)
      const catalog = await import("./market-skill-catalog")
      await expect(catalog.refreshMarketSkillCatalog()).resolves.toEqual({ items, total: 1 })
      expect(catalog.readMarketSkillCatalog()).toEqual(items)
      expect(notify).toHaveBeenCalledExactlyOnceWith(MARKET_SKILL_CATALOG_CHANGED)
    }
  )

  it.each(
    [
      { success: false, items: [{ name: "valid" }] },
      { ok: false, items: [{ name: "valid" }] },
      { status: " Error ", items: [{ name: "valid" }] },
      { status: "FAIL", items: [{ name: "valid" }] },
      null,
      [],
      {},
      { items: null },
      { items: {} },
      { items: [{ name: "valid" }, null] },
      { items: [{ name: " " }] },
      { items: [{ name: "valid", description: {} }] }
    ].map((value) => ({ value }))
  )(
    "rejects unsuccessful or malformed catalog %# without publishing successful data",
    async ({ value }) => {
      request.mockResolvedValueOnce(new Response(JSON.stringify(value)))
      const catalog = await import("./market-skill-catalog")
      await expect(catalog.refreshMarketSkillCatalog()).rejects.toMatchObject({
        code: "REMOTE_JSON_RESPONSE_INVALID",
        status: 200
      })
      expect(catalog.readMarketSkillCatalog()).toEqual([])
      expect(notify).not.toHaveBeenCalled()
    }
  )

  it.each([
    { body: "<!doctype html><html>private-response-canary</html>", mime: "application/json" },
    { body: "{private-response-canary", mime: "text/plain" },
    { body: " ", mime: "application/json" },
    { body: JSON.stringify({ items: [{ name: "valid" }] }), mime: "text/html" }
  ])("returns bounded diagnostics for invalid remote responses %#", async ({ body, mime }) => {
    const response = new Response(body, { headers: { "Content-Type": mime } })
    Object.defineProperties(response, {
      redirected: { value: true },
      url: { value: "https://private.example/?token=secret-canary" }
    })
    request.mockResolvedValueOnce(response)
    const catalog = await import("./market-skill-catalog")
    const error = await catalog.refreshMarketSkillCatalog().catch((error) => error)
    expect(error).toMatchObject({
      name: "RemoteJsonResponseError",
      code: "REMOTE_JSON_RESPONSE_INVALID",
      status: 200,
      redirected: true,
      mime
    })
    expect(error.message.length).toBeLessThan(160)
    expect(error.stack).not.toMatch(
      /private-response-canary|private\.example|secret-canary|Unexpected token/
    )
    expect(error).not.toHaveProperty("cause")
    expect(error).not.toHaveProperty("body")
    expect(error).not.toHaveProperty("url")
  })

  it("bounds MIME diagnostic values instead of retaining remote header text", async () => {
    request.mockResolvedValueOnce(
      new Response("{private-response-canary", {
        headers: { "Content-Type": "private-header-canary/" + "x".repeat(1000) }
      })
    )
    const catalog = await import("./market-skill-catalog")
    await expect(catalog.refreshMarketSkillCatalog()).rejects.toMatchObject({ mime: "unknown" })
  })

  it("preserves the shared invalid JSON error identity", async () => {
    const { RemoteJsonResponseError } = await import("../../shared/json-response")
    request.mockResolvedValueOnce(new Response("{private-response-canary"))
    const catalog = await import("./market-skill-catalog")
    await expect(catalog.refreshMarketSkillCatalog()).rejects.toBeInstanceOf(
      RemoteJsonResponseError
    )
  })

  it("coalesces refreshes, retains the last completed snapshot in flight and clears a rejected result", async () => {
    const first = { items: [{ name: "first" }] }
    const next = { items: [{ name: "next" }] }
    request.mockResolvedValueOnce(new Response(JSON.stringify(first)))
    const catalog = await import("./market-skill-catalog")
    await catalog.refreshMarketSkillCatalog()
    const gate = Promise.withResolvers<Response>()
    request.mockReturnValueOnce(gate.promise)
    const pending = catalog.refreshMarketSkillCatalog()
    expect(catalog.refreshMarketSkillCatalog()).toBe(pending)
    expect(catalog.readMarketSkillCatalog()).toEqual(first.items)
    gate.resolve(new Response(JSON.stringify({ success: false, items: next.items })))
    await expect(pending).rejects.toMatchObject({ code: "REMOTE_JSON_RESPONSE_INVALID" })
    expect(catalog.readMarketSkillCatalog()).toEqual([])
    request.mockResolvedValueOnce(new Response(JSON.stringify(next)))
    await expect(catalog.refreshMarketSkillCatalog()).resolves.toEqual({ ...next, total: 1 })
    expect(request).toHaveBeenCalledTimes(3)
    expect(notify).toHaveBeenCalledTimes(3)
  })

  it("does not rebroadcast identical successful data and accepts a real empty catalog", async () => {
    const body = JSON.stringify({ items: [] })
    request.mockImplementation(async () => new Response(body))
    const catalog = await import("./market-skill-catalog")
    await expect(catalog.refreshMarketSkillCatalog()).resolves.toEqual({ items: [], total: 0 })
    await expect(catalog.refreshMarketSkillCatalog()).resolves.toEqual({ items: [], total: 0 })
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it("preserves the existing byte limit and truncates only the returned page", async () => {
    request.mockResolvedValueOnce(
      new Response("private-response-canary", {
        headers: { "Content-Length": String(MARKET_SKILL_LIST_MAX_RESPONSE_BYTES + 1) }
      })
    )
    const catalog = await import("./market-skill-catalog")
    await expect(catalog.refreshMarketSkillCatalog()).rejects.toThrow(
      "Market skill list is unavailable"
    )
    const items = Array.from({ length: MARKET_SKILL_LIST_MAX_ITEMS + 1 }, (_, index) => ({
      name: "item-" + index
    }))
    request.mockResolvedValueOnce(new Response(JSON.stringify({ items })))
    const page = await catalog.refreshMarketSkillCatalog()
    expect(page.total).toBe(items.length)
    expect(page.items).toHaveLength(MARKET_SKILL_LIST_MAX_ITEMS)
    expect(catalog.readMarketSkillCatalog()).toHaveLength(items.length)
  })
})
