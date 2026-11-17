import { describe, expect, it, vi } from "vitest"
import {
  fetchKnowledgeUserDetailList,
  parseKnowledgeUserDetails
} from "./dashboard-knowledge-user-details"
import { isDashboardRequestCancelled } from "../services/dashboard-request-coordinator"

const row = {
  userName: "刘彤80244281",
  roomName: "零售信息应用开发六室(杭州)",
  totalNum: 420,
  abandonedNum: 4,
  recentNum: 416,
  updateActiveNum: 196,
  readActiveNum: 0
}

describe("user knowledge detail list", () => {
  it("preserves the full list, zero counts and users with only an ID without merging names", () => {
    const rows = [row, { ...row, roomName: "另一室" }, { ...row, userName: "80312613" }]
    expect(parseKnowledgeUserDetails(rows.map((item) => ({ ...item, extra: true })))).toEqual(rows)
    expect(
      parseKnowledgeUserDetails([{ ...row, userName: " 张三 ", roomName: null }])[0]
    ).toMatchObject({ userName: "张三", roomName: "" })
  })
  it.each([
    null,
    {},
    [null],
    [{ ...row, totalNum: -1 }],
    [{ ...row, recentNum: null }],
    [{ ...row, readActiveNum: "0" }],
    [{ ...row, updateActiveNum: 1.5 }],
    [{ ...row, roomName: 123 }]
  ])("rejects malformed data instead of displaying false zeroes", (value) => {
    expect(() => parseKnowledgeUserDetails(value)).toThrow()
  })
  it.each([null, ["992391", "990866"]])(
    "POSTs the room scope once and keeps all rows without paging or dates",
    async (orgIds) => {
      const rows = Array.from({ length: 75 }, (_, i) => ({ ...row, userName: String(i) }))
      const request = vi.fn(async () => Response.json(rows))
      expect(
        await fetchKnowledgeUserDetailList("http://kb.test/", orgIds, undefined, request)
      ).toEqual(rows)
      expect(request).toHaveBeenCalledExactlyOnceWith("http://kb.test/knowledge/user-detail-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgIds }),
        signal: expect.any(AbortSignal)
      })
    }
  )
  it("distinguishes empty results, HTTP failures and missing configuration", async () => {
    expect(
      await fetchKnowledgeUserDetailList(
        "http://kb.test",
        null,
        undefined,
        vi.fn(async () => Response.json([]))
      )
    ).toEqual([])
    await expect(
      fetchKnowledgeUserDetailList(
        "http://kb.test",
        null,
        undefined,
        vi.fn(async () => new Response("error", { status: 503 }))
      )
    ).rejects.toThrow("HTTP 503")
    const request = vi.fn()
    await expect(fetchKnowledgeUserDetailList("", null, undefined, request)).rejects.toThrow(
      "未配置"
    )
    expect(request).not.toHaveBeenCalled()
  })
  it("cancels before dispatch and discards results if the room changed while reading", async () => {
    const controller = new AbortController()
    const request = vi.fn(async () => {
      controller.abort()
      return Response.json([row])
    })
    await fetchKnowledgeUserDetailList("http://kb.test", null, controller.signal, request).then(
      () => {
        throw new Error("expected cancellation")
      },
      (error) => expect(isDashboardRequestCancelled(error)).toBe(true)
    )
    request.mockClear()
    await expect(
      fetchKnowledgeUserDetailList("http://kb.test", null, controller.signal, request)
    ).rejects.toThrow("cancelled")
    expect(request).not.toHaveBeenCalled()
  })
})
