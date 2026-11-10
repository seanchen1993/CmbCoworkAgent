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
  it.each(["skill", "plugin"] as const)(
    "binds %s source access to the downloaded package bytes",
    async (type) => {
      const name = "项目 / #1"
      const request = serve([{ name, user_id: "12345678" }])
      const content = Uint8Array.from([1, 2, 3]).buffer
      request
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ items: [{ name, user_id: "12345678" }] }))
        )
        .mockResolvedValueOnce(new Response(content))
      expect(await resolveMarketSourceAccess(type, { name }, content)).toBe("owner")
      expect(request.mock.calls[1][0]).toBe(
        `https://market.example/api/trajectories/marketplace/download/${type}/${encodeURIComponent(name)}`
      )
      request
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ items: [{ name, user_id: "12345678" }] }))
        )
        .mockResolvedValueOnce(new Response("another resource's package"))
      expect(await resolveMarketSourceAccess(type, { name }, content)).toBeUndefined()
    }
  )
  it.each(["offline", "oversized", "stream-overflow", "account-switch"])(
    "denies installation grants on %s during package verification",
    async (failure) => {
      const request = serve([{ name: "project", user_id: "12345678" }])
      request
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ items: [{ name: "project", user_id: "12345678" }] }))
        )
        .mockImplementationOnce(async () => {
          if (failure === "offline") throw new Error("offline")
          if (failure === "oversized")
            return new Response("x", { headers: { "content-length": String(33 * 1024 * 1024) } })
          if (failure === "stream-overflow")
            return new Response(new Uint8Array(32 * 1024 * 1024 + 1))
          state.user = { sapId: "other", ystId: "other" }
          return new Response(new Uint8Array([1, 2, 3]))
        })
      expect(
        await resolveMarketSourceAccess(
          "plugin",
          { name: "project" },
          Uint8Array.from([1, 2, 3]).buffer
        )
      ).toBeUndefined()
    }
  )
  it("does not download packages for unprivileged accounts", async () => {
    const request = serve([{ name: "project", user_id: "other" }])
    expect(
      await resolveMarketSourceAccess("plugin", { name: "project" }, new ArrayBuffer(0))
    ).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(1)
  })
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
