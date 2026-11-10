import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveMarketSourceAccess } from "./market-source-access"

const state = vi.hoisted(() => ({ user: { sapId: "12345678", ystId: "user123" } }))
vi.mock("../storage", () => ({ getUserInfo: () => state.user }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  state.user = { sapId: "12345678", ystId: "user123" }
})
function serve(items: unknown[]) {
  vi.stubEnv("VITE_API_BASE_URL", "https://market.example")
  const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ items })))
  vi.stubGlobal("fetch", request)
  return request
}
describe("main-owned market policy resolution", () => {
  it("uses fresh server metadata and the current account for owners and allowlisted users", async () => {
    const request = serve([{ name: "project", user_id: "12345678 / Name / Org" }])
    expect(await resolveMarketSourceAccess("plugin", { name: "project", id: "project" })).toBe(
      "owner"
    )
    expect(request.mock.calls[0][0]).toBe(
      "https://market.example/api/trajectories/marketplace/list/plugin"
    )
    serve([
      { name: "project", user_id: "another", extra_json: '{"sourceAccessUserIds":["user123"]}' }
    ])
    expect(await resolveMarketSourceAccess("skill", { name: "project" })).toBe("whitelist")
    serve([{ name: "project", user_id: "another" }])
    expect(await resolveMarketSourceAccess("skill", { name: "project" })).toBeUndefined()
  })
  it("denies mismatched, duplicate, oversized or unavailable metadata", async () => {
    serve([{ name: "project", id: "actual", user_id: "12345678" }])
    expect(
      await resolveMarketSourceAccess("plugin", { name: "project", id: "wrong" })
    ).toBeUndefined()
    serve([
      { name: "project", user_id: "12345678" },
      { name: "project", user_id: "12345678" }
    ])
    expect(await resolveMarketSourceAccess("plugin", { name: "project" })).toBeUndefined()
    vi.stubGlobal("fetch", async () => new Response("x".repeat(2 * 1024 * 1024 + 1)))
    expect(await resolveMarketSourceAccess("plugin", { name: "project" })).toBeUndefined()
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline")
    })
    expect(await resolveMarketSourceAccess("plugin", { name: "project" })).toBeUndefined()
  })
  it("rejects a grant when the account changed during the request", async () => {
    serve([])
    vi.stubGlobal("fetch", async () => {
      state.user = { sapId: "other", ystId: "other" }
      return new Response(JSON.stringify({ items: [{ name: "project", user_id: "12345678" }] }))
    })
    expect(await resolveMarketSourceAccess("plugin", { name: "project" })).toBeUndefined()
  })
})
