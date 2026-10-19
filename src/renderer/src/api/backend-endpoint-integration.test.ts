import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../js/mmjUtils", () => ({ insertLog: vi.fn() }))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal("location", { protocol: "file:" })
  vi.stubEnv("VITE_API_BASE_URL", "")
  vi.stubEnv("VITE_OPEN_ASSISTANT_HUB_GATEWAY_URL", "")
  vi.stubGlobal("window", { api: { models: { getUserInfo: vi.fn().mockResolvedValue(null) } } })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("original optional remote API entries", () => {
  it("performs zero fetches for all missing file-document endpoints, without mock success", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const { marketApi } = await import("./market")
    const { getMarketPlugins } = await import("./market-plugins")
    const { orgSkillMarketApi } = await import("./org-skill-market")
    const { threadsApi } = await import("./index")
    expect(await marketApi.getSkills()).toMatchObject({ success: false, errorCode: "BACKEND_NOT_CONFIGURED" })
    expect(await marketApi.getMcps()).toMatchObject({ success: false, errorCode: "BACKEND_NOT_CONFIGURED" })
    expect(await marketApi.getPlugins({ allowMockOnError: true })).toMatchObject({ success: false })
    expect(await getMarketPlugins()).toMatchObject({ success: false })
    await expect(orgSkillMarketApi.getOrgSkills()).rejects.toMatchObject({ code: "BACKEND_NOT_CONFIGURED" })
    await expect(orgSkillMarketApi.getOrgSkillLabels()).rejects.toMatchObject({ code: "BACKEND_NOT_CONFIGURED" })
    await expect(orgSkillMarketApi.fetchInstallFile({
      name: "test", description: "test", filename: "test.zip", created_at: "2026-10-19",
      orgSkillId: 1, orgSkillVersionId: 2
    }))
      .rejects.toMatchObject({ code: "BACKEND_NOT_CONFIGURED" })
    await expect(threadsApi.upload({ unique_id: "probe", file: new File(["{}"], "probe.json") }))
      .rejects.toMatchObject({ code: "BACKEND_NOT_CONFIGURED" })
    expect(fetch).not.toHaveBeenCalled()
    expect(window.api.models.getUserInfo).not.toHaveBeenCalled()
  })

  it("preserves configured original paths, original org Authorization, and success response shapes", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.test/prefix")
    vi.stubEnv("VITE_OPEN_ASSISTANT_HUB_GATEWAY_URL", "https://org.example.test/prefix/")
    const getUserInfo = vi.fn().mockResolvedValue({ ystIdToken: "fixture-token" })
    vi.stubGlobal("window", { api: { models: { getUserInfo } } })
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>().mockImplementation(async (url) => {
      if (url.includes("/gw/")) return new Response(JSON.stringify({ returnCode: "SUC0000", body: { list: [], total: 0 } }))
      if (url.endsWith("/upload")) return new Response(null, { status: 204 })
      return new Response(JSON.stringify({ items: [{ name: "actual" }] }), { headers: { "content-type": "application/json" } })
    })
    vi.stubGlobal("fetch", fetch)
    const { marketApi } = await import("./market")
    const { orgSkillMarketApi } = await import("./org-skill-market")
    const { threadsApi } = await import("./index")
    expect(await marketApi.getSkills()).toMatchObject({ success: true, data: [{ name: "actual" }] })
    expect(fetch.mock.calls[0][0]).toBe("https://api.example.test/prefix/api/trajectories/marketplace/list/skill")
    expect(await orgSkillMarketApi.getOrgSkills(2, 4, ["a b"], "hello")).toMatchObject({ success: true, data: [] })
    expect(fetch.mock.calls[1][0]).toBe("https://org.example.test/prefix/gw/mgr/open-api/skill/page?pageNum=2&pageSize=4&queryAll=true&queryType=null&labelIds=a%20b&keyword=hello")
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get("Authorization")).toBe("fixture-token")
    expect(await threadsApi.upload({ unique_id: "probe", file: new File(["{}"], "probe.json") })).toEqual({ success: true })
    expect(fetch.mock.calls[2][0]).toBe("https://api.example.test/prefix/api/trajectories/threads/upload")
  })

  it("keeps configured upload transport failure a transport rejection, not configuration or success", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "http://localhost:3000")
    const failure = new TypeError("Failed to fetch")
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure))
    const { threadsApi } = await import("./index")
    await expect(threadsApi.upload({ unique_id: "probe", file: new File(["{}"], "probe.json") }))
      .rejects.toBe(failure)
  })

  it("preserves a caller's already-aborted upload without creating a timer or request", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const controller = new AbortController()
    const reason = new DOMException("Cancelled", "AbortError")
    controller.abort(reason)
    const { threadsApi } = await import("./index")
    await expect(threadsApi.upload({ unique_id: "probe", file: new File(["{}"], "probe.json") }, controller.signal))
      .rejects.toBe(reason)
    expect(fetch).not.toHaveBeenCalled()
  })
})
