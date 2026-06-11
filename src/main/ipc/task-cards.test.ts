import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const storageMocks = vi.hoisted(() => ({
  getUserInfo: vi.fn(),
  upsertUserInfoConfig: vi.fn()
}))

vi.mock("../storage", () => storageMocks)

import { listCurrentUserTaskCards } from "./task-cards"

const previousEnv = {
  CMB_TASK_CARDS_ENDPOINT: process.env.CMB_TASK_CARDS_ENDPOINT,
  CMB_LOGIN_INFO_ENDPOINT: process.env.CMB_LOGIN_INFO_ENDPOINT,
  CMB_TASK_CARDS_MOCK: process.env.CMB_TASK_CARDS_MOCK,
  VITE_LOGIN_PT: process.env.VITE_LOGIN_PT
}
let endpointSequence = 0

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  })
}

describe("task card access token refresh", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    storageMocks.getUserInfo.mockReset()
    storageMocks.upsertUserInfoConfig.mockReset()
    endpointSequence += 1
    process.env.CMB_TASK_CARDS_ENDPOINT = `https://task-cards.example.test/api/tasks-${endpointSequence}`
    process.env.CMB_LOGIN_INFO_ENDPOINT = "https://login.example.test/cowork/login-info"
    delete process.env.CMB_TASK_CARDS_MOCK
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (previousEnv.CMB_TASK_CARDS_ENDPOINT === undefined) {
      delete process.env.CMB_TASK_CARDS_ENDPOINT
    } else {
      process.env.CMB_TASK_CARDS_ENDPOINT = previousEnv.CMB_TASK_CARDS_ENDPOINT
    }
    if (previousEnv.CMB_LOGIN_INFO_ENDPOINT === undefined) {
      delete process.env.CMB_LOGIN_INFO_ENDPOINT
    } else {
      process.env.CMB_LOGIN_INFO_ENDPOINT = previousEnv.CMB_LOGIN_INFO_ENDPOINT
    }
    if (previousEnv.CMB_TASK_CARDS_MOCK === undefined) {
      delete process.env.CMB_TASK_CARDS_MOCK
    } else {
      process.env.CMB_TASK_CARDS_MOCK = previousEnv.CMB_TASK_CARDS_MOCK
    }
    if (previousEnv.VITE_LOGIN_PT === undefined) {
      delete process.env.VITE_LOGIN_PT
    } else {
      process.env.VITE_LOGIN_PT = previousEnv.VITE_LOGIN_PT
    }
  })

  it("refreshes user info and retries once when task card request returns 401", async () => {
    storageMocks.getUserInfo.mockReturnValue({
      sapId: "00000001",
      ystId: "yst-old",
      userName: "Dev User",
      ystRefreshToken: "refresh-token",
      ystCode: "yst-code",
      ystAccessToken: "old-token"
    })

    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce(new Response("expired", { status: 401, statusText: "Unauthorized" }))
      .mockResolvedValueOnce(
        jsonResponse({
          returnCode: "SUC0000",
          body: {
            sapId: "00000001",
            ystId: "yst-new",
            userName: "Dev User",
            ystRefreshToken: "next-refresh-token",
            ystIdToken: "next-id-token",
            ystAccessToken: "new-token"
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          returnCode: "SUC0000",
          body: {
            list: [{ taskKey: "M10000749-9", taskName: "提交任务卡" }],
            total: 1,
            pageSize: 1000,
            pageNum: 1
          }
        })
      )
    vi.stubGlobal("fetch", fetchMock)

    const result = await listCurrentUserTaskCards({ forceRefresh: true })

    expect(result.success).toBe(true)
    expect(result.cards).toHaveLength(1)
    expect(result.cards[0].taskKey).toBe("M10000749-9")
    expect(fetchMock).toHaveBeenCalledTimes(3)

    const firstTaskRequest = fetchMock.mock.calls[0][1] as RequestInit
    expect((firstTaskRequest.headers as Record<string, string>).Authorization).toBe(
      "Bearer old-token"
    )

    const refreshRequest = fetchMock.mock.calls[1][1] as RequestInit
    expect((refreshRequest.headers as Record<string, string>).ystRefreshToken).toBe("refresh-token")
    expect((refreshRequest.headers as Record<string, string>).ystCode).toBe("yst-code")

    const retriedTaskRequest = fetchMock.mock.calls[2][1] as RequestInit
    expect((retriedTaskRequest.headers as Record<string, string>).Authorization).toBe(
      "Bearer new-token"
    )
    expect(storageMocks.upsertUserInfoConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        ystId: "yst-new",
        ystRefreshToken: "next-refresh-token",
        ystIdToken: "next-id-token",
        ystAccessToken: "new-token"
      })
    )

    storageMocks.getUserInfo.mockReturnValue({
      sapId: "00000001",
      ystId: "yst-new",
      userName: "Dev User",
      ystRefreshToken: "next-refresh-token",
      ystCode: "yst-code",
      ystAccessToken: "new-token"
    })
    const cachedResult = await listCurrentUserTaskCards()
    expect(cachedResult.success).toBe(true)
    expect(cachedResult.fromCache).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("falls back to GET when refreshed POST still returns 401", async () => {
    storageMocks.getUserInfo.mockReturnValue({
      sapId: "00000001",
      ystId: "yst-old",
      userName: "Dev User",
      ystRefreshToken: "refresh-token",
      ystCode: "yst-code",
      ystAccessToken: "old-token"
    })

    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce(new Response("expired", { status: 401, statusText: "Unauthorized" }))
      .mockResolvedValueOnce(
        jsonResponse({
          returnCode: "SUC0000",
          body: {
            sapId: "00000001",
            ystId: "yst-new",
            userName: "Dev User",
            ystRefreshToken: "next-refresh-token",
            ystAccessToken: "new-token"
          }
        })
      )
      .mockResolvedValueOnce(
        new Response("post route unauthorized", { status: 401, statusText: "Unauthorized" })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          returnCode: "SUC0000",
          body: {
            list: [{ taskKey: "M10000749-10", taskName: "GET 成功" }],
            total: 1,
            pageSize: 1000,
            pageNum: 1
          }
        })
      )
    vi.stubGlobal("fetch", fetchMock)

    const result = await listCurrentUserTaskCards({ forceRefresh: true })

    expect(result.success).toBe(true)
    expect(result.cards[0].taskKey).toBe("M10000749-10")
    expect(fetchMock).toHaveBeenCalledTimes(4)

    const retriedPost = fetchMock.mock.calls[2][1] as RequestInit
    expect(retriedPost.method).toBe("POST")
    expect((retriedPost.headers as Record<string, string>).Authorization).toBe("Bearer new-token")

    const getFallback = fetchMock.mock.calls[3][1] as RequestInit
    expect(getFallback.method).toBe("GET")
    expect((getFallback.headers as Record<string, string>).Authorization).toBe("Bearer new-token")
  })

  it("returns loginRequired when token refresh business response fails", async () => {
    storageMocks.getUserInfo.mockReturnValue({
      sapId: "00000001",
      ystId: "yst-old",
      userName: "Dev User",
      ystRefreshToken: "refresh-token",
      ystCode: "yst-code",
      ystAccessToken: "old-token"
    })

    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce(new Response("expired", { status: 401, statusText: "Unauthorized" }))
      .mockResolvedValueOnce(
        jsonResponse({
          returnCode: "BIZ9000",
          errorMsg: "refresh token expired"
        })
      )
    vi.stubGlobal("fetch", fetchMock)

    const result = await listCurrentUserTaskCards({ forceRefresh: true })

    expect(result.success).toBe(false)
    expect(result.loginRequired).toBe(true)
    expect(result.error).toContain("登录凭据已过期")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(storageMocks.upsertUserInfoConfig).not.toHaveBeenCalled()
  })
})
