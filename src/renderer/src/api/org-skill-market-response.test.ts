import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv("VITE_OPEN_ASSISTANT_HUB_GATEWAY_URL", "https://org.example.test/prefix/")
  vi.stubEnv("VITE_LOGIN_INFO_ENDPOINT", "https://login.example.test/cowork/login-info")
  vi.stubGlobal("location", { protocol: "file:" })
  vi.stubGlobal("window", {
    api: {
      models: {
        getUserInfo: vi.fn().mockResolvedValue(null),
        upsertUserInfo: vi.fn().mockResolvedValue(undefined)
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("optional organization skill service", () => {
  it.each(["file:", "http:", "https:"])(
    "does not request an absent gateway on a %s document",
    async (protocol) => {
      vi.stubEnv("VITE_OPEN_ASSISTANT_HUB_GATEWAY_URL", "  ")
      vi.stubGlobal("location", { protocol })
      const fetch = vi.fn()
      vi.stubGlobal("fetch", fetch)
      const { orgSkillMarketApi } = await import("./org-skill-market")
      await expect(orgSkillMarketApi.getOrgSkills()).rejects.toMatchObject({
        code: "BACKEND_NOT_CONFIGURED"
      })
      await expect(orgSkillMarketApi.getOrgSkillLabels()).rejects.toMatchObject({
        code: "BACKEND_NOT_CONFIGURED"
      })
      expect(fetch).not.toHaveBeenCalled()
      expect(window.api.models.getUserInfo).not.toHaveBeenCalled()
    }
  )

  it.each(["undefined", "null", "proxy", "http://", "https://", "ftp://host", "//"])(
    "rejects an invalid configured gateway before fetch: %s",
    async (base) => {
      vi.stubEnv("VITE_OPEN_ASSISTANT_HUB_GATEWAY_URL", base)
      vi.stubGlobal("location", { protocol: "https:" })
      const fetch = vi.fn()
      vi.stubGlobal("fetch", fetch)
      const { orgSkillMarketApi } = await import("./org-skill-market")
      await expect(orgSkillMarketApi.getOrgSkills()).rejects.toMatchObject({
        code: "BACKEND_NOT_CONFIGURED"
      })
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it.each([
    ["/proxy/", "/proxy/gw/mgr/open-api/skill/labels"],
    ["./proxy/", "./proxy/gw/mgr/open-api/skill/labels"],
    ["/", "/gw/mgr/open-api/skill/labels"],
    ["//gateway.example.test/proxy/", "//gateway.example.test/proxy/gw/mgr/open-api/skill/labels"]
  ])("preserves an explicit HTTP document proxy %s", async (base, endpoint) => {
    vi.stubEnv("VITE_OPEN_ASSISTANT_HUB_GATEWAY_URL", base)
    vi.stubGlobal("location", { protocol: "https:" })
    const fetch = vi.fn().mockResolvedValue(json({ returnCode: "SUC0000", body: [] }))
    vi.stubGlobal("fetch", fetch)
    const { orgSkillMarketApi } = await import("./org-skill-market")
    await expect(orgSkillMarketApi.getOrgSkillLabels()).resolves.toEqual([])
    expect(fetch).toHaveBeenCalledWith(endpoint, expect.any(Object))
  })

  it.each(["/proxy", "./proxy", "/"])(
    "does not use a relative proxy from a file document: %s",
    async (base) => {
      vi.stubEnv("VITE_OPEN_ASSISTANT_HUB_GATEWAY_URL", base)
      const fetch = vi.fn()
      vi.stubGlobal("fetch", fetch)
      const { orgSkillMarketApi } = await import("./org-skill-market")
      await expect(orgSkillMarketApi.getOrgSkills()).rejects.toMatchObject({
        code: "BACKEND_NOT_CONFIGURED"
      })
      expect(fetch).not.toHaveBeenCalled()
    }
  )
})

describe("organization skill JSON contracts", () => {
  it.each(["getOrgSkills", "getOrgSkillLabels"] as const)(
    "keeps HTML failures safe without refreshing login: %s",
    async (method) => {
      const fetch = vi.fn().mockImplementation(
        async () =>
          new Response("<!doctype html><html>private-token=fixture</html>", {
            headers: { "content-type": "application/json" }
          })
      )
      vi.stubGlobal("fetch", fetch)
      const { orgSkillMarketApi } = await import("./org-skill-market")
      const error = await orgSkillMarketApi[method]().catch((error) => error)
      expect(error).toMatchObject({ name: "RemoteJsonResponseError", status: 200 })
      expect(error.message).toContain("组织技能服务返回了网页")
      expect(String(error.stack)).not.toMatch(/doctype|private-token|Unexpected token/)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(window.api.models.upsertUserInfo).not.toHaveBeenCalled()
    }
  )

  it.each([
    null,
    [],
    "fixture",
    7,
    {},
    { returnCode: 7 },
    { returnCode: "SUC0000", body: [] },
    { returnCode: "SUC0000", body: "fixture" },
    { returnCode: "SUC0000", body: { list: {} } },
    { returnCode: "SUC0000", body: { list: [null] } }
  ])("rejects a malformed successful list envelope", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body)))
    const { orgSkillMarketApi } = await import("./org-skill-market")
    await expect(orgSkillMarketApi.getOrgSkills()).rejects.toMatchObject({
      name: "RemoteJsonResponseError",
      code: "REMOTE_JSON_RESPONSE_INVALID"
    })
  })

  it.each([null, {}, { list: null }, { list: [] }])(
    "preserves the existing successful empty-list compatibility",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ returnCode: "SUC0000", body })))
      const { orgSkillMarketApi } = await import("./org-skill-market")
      await expect(orgSkillMarketApi.getOrgSkills()).resolves.toMatchObject({
        success: true,
        data: [],
        total: 0
      })
    }
  )

  it.each([
    { name: { bad: true } },
    { slug: { bad: true } },
    { description: { bad: true } },
    { sourceOriginName: {} },
    { createdAt: {} },
    { updatedAt: [] },
    { subscriptionCount: {} },
    { manager: [] },
    { manager: { name: {} } },
    { manager: { userId: {} } },
    { versions: {} },
    { versions: [null] },
    { versions: [{ name: {} }] },
    { versions: [{ skillId: {} }] },
    { labels: {} },
    { labels: [null] },
    { labels: [{ labelName: {} }] }
  ])("rejects malformed fields before mapping a list item", async (invalid) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          returnCode: "SUC0000",
          body: {
            list: [
              {
                id: 1,
                slug: "fixture-skill",
                name: "Fixture skill",
                versions: [],
                labels: [],
                ...invalid
              }
            ]
          }
        })
      )
    )
    const { orgSkillMarketApi } = await import("./org-skill-market")
    await expect(orgSkillMarketApi.getOrgSkills()).rejects.toMatchObject({
      code: "REMOTE_JSON_RESPONSE_INVALID"
    })
  })

  it("retains sparse optional card fields and null compatibility", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          returnCode: "SUC0000",
          body: {
            list: [
              {
                id: 1,
                slug: "fixture-skill",
                name: "Fixture skill",
                description: null,
                manager: null,
                versions: null,
                labels: null,
                createdAt: null
              }
            ]
          }
        })
      )
    )
    const { orgSkillMarketApi } = await import("./org-skill-market")
    await expect(orgSkillMarketApi.getOrgSkills()).resolves.toMatchObject({
      success: true,
      data: [{ name: "fixture-skill", chinese_name: "Fixture skill" }]
    })
  })

  it.each([null, {}, [null], [{ labelId: 7, labelName: "label" }]])(
    "rejects malformed label bodies",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ returnCode: "SUC0000", body })))
      const { orgSkillMarketApi } = await import("./org-skill-market")
      await expect(orgSkillMarketApi.getOrgSkillLabels()).rejects.toMatchObject({
        code: "REMOTE_JSON_RESPONSE_INVALID"
      })
    }
  )

  it("preserves normal records, headers, query encoding and missing JSON MIME compatibility", async () => {
    window.api.models.getUserInfo = vi.fn().mockResolvedValue({ ystIdToken: "fixture-token" })
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          returnCode: "SUC0000",
          body: {
            total: 1,
            list: [
              {
                id: 1,
                slug: "fixture-skill",
                name: "Fixture skill",
                versions: [],
                labels: []
              }
            ]
          }
        })
      )
    )
    vi.stubGlobal("fetch", fetch)
    const { orgSkillMarketApi } = await import("./org-skill-market")
    await expect(
      orgSkillMarketApi.getOrgSkills(2, 4, ["a b"], "hello world")
    ).resolves.toMatchObject({ success: true, total: 1, data: [{ name: "fixture-skill" }] })
    expect(fetch.mock.calls[0][0]).toBe(
      "https://org.example.test/prefix/gw/mgr/open-api/skill/page?pageNum=2&pageSize=4&queryAll=true&queryType=null&labelIds=a%20b&keyword=hello%20world"
    )
    expect(new Headers(fetch.mock.calls[0][1].headers).get("Authorization")).toBe("fixture-token")
  })

  it.each([new DOMException("Cancelled", "AbortError"), new TypeError("Failed to fetch")])(
    "does not reclassify or retry request failures",
    async (failure) => {
      const fetch = vi.fn().mockRejectedValue(failure)
      vi.stubGlobal("fetch", fetch)
      const { orgSkillMarketApi } = await import("./org-skill-market")
      await expect(orgSkillMarketApi.getOrgSkills()).rejects.toBe(failure)
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  )

  it("does not expose or retry an HTML 502 body", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response("<!doctype html>private-fixture", {
        status: 502,
        headers: { "content-type": "text/html" }
      })
    )
    vi.stubGlobal("fetch", fetch)
    const { orgSkillMarketApi } = await import("./org-skill-market")
    const error = await orgSkillMarketApi.getOrgSkills().catch((error) => error)
    expect(error.message).toContain("组织技能服务返回了网页")
    expect(String(error.stack)).not.toMatch(/doctype|private-fixture/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("preserves a valid JSON business error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          {
            returnCode: "BUSINESS_FAILED",
            errorMsg: "Fixture business rejection"
          },
          502
        )
      )
    )
    const { orgSkillMarketApi } = await import("./org-skill-market")
    await expect(orgSkillMarketApi.getOrgSkills()).rejects.toThrow("Fixture business rejection")
  })
})

describe("organization skill login recovery remains bounded", () => {
  it.each(["401-html", "SCG1005"])(
    "refreshes once and preserves the original authorization flow for %s",
    async (failure) => {
      let user = { ystRefreshToken: "fixture-refresh", ystIdToken: "fixture-old-token" }
      let listRequests = 0
      const upsert = vi.fn(async (next: typeof user) => {
        user = next
      })
      vi.stubGlobal("window", {
        api: {
          models: {
            getUserInfo: vi.fn(async () => user),
            upsertUserInfo: upsert
          }
        }
      })
      const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
        if (url.startsWith("https://login.example.test/"))
          return json({
            returnCode: "SUC0000",
            body: {
              ystAccessToken: "fixture-new-access",
              ystIdToken: "fixture-new-token"
            }
          })
        listRequests += 1
        if (listRequests > 1) return json({ returnCode: "SUC0000", body: { list: [] } })
        return failure === "401-html"
          ? new Response("<!doctype html>private-fixture", { status: 401 })
          : json({ returnCode: "SCG1005", errorMsg: "Fixture session expired" })
      })
      vi.stubGlobal("fetch", fetch)
      const { orgSkillMarketApi } = await import("./org-skill-market")
      await expect(orgSkillMarketApi.getOrgSkills()).resolves.toMatchObject({
        success: true,
        data: []
      })
      expect(listRequests).toBe(2)
      expect(fetch).toHaveBeenCalledTimes(3)
      expect(upsert).toHaveBeenCalledTimes(1)
      expect(new Headers(fetch.mock.calls[2][1]?.headers).get("Authorization")).toBe(
        "fixture-new-token"
      )
    }
  )

  it("does not repeatedly refresh an expired retry and retains the login guidance", async () => {
    vi.stubGlobal("window", {
      api: {
        models: {
          getUserInfo: vi.fn().mockResolvedValue({
            ystRefreshToken: "fixture-refresh",
            ystIdToken: "fixture-old-token"
          }),
          upsertUserInfo: vi.fn().mockResolvedValue(undefined)
        }
      }
    })
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) =>
      url.startsWith("https://login.example.test/")
        ? json({
            returnCode: "SUC0000",
            body: {
              ystAccessToken: "fixture-new-access",
              ystIdToken: "fixture-new-token"
            }
          })
        : json({ returnCode: "SCG1005", errorMsg: "Fixture session expired" })
    )
    vi.stubGlobal("fetch", fetch)
    const { orgSkillMarketApi, isOrgSkillLoginRequiredError } = await import("./org-skill-market")
    const error = await orgSkillMarketApi.getOrgSkills().catch((error) => error)
    expect(error.message).toBe("登录凭据已过期，请重新登录后再查看组织级技能")
    expect(isOrgSkillLoginRequiredError(error)).toBe(true)
    expect(isOrgSkillLoginRequiredError(new Error("login failed or HTML"))).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
