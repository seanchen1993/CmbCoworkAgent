import { describe, expect, it, vi } from "vitest"
import {
  fetchKnowledgeActiveList,
  parseKnowledgeActiveList
} from "./dashboard-knowledge-active-details"
import { isDashboardRequestCancelled } from "../services/dashboard-request-coordinator"

const row = {
  filePath: "LB4702/services/wmaatree/local_architecture.md",
  fileName: "local_architecture.md",
  subProduct: "LB47.02",
  deployUnit: "LB47.02_wmaatree",
  lastCommitDate: "2026-09-24 14:12:04",
  lastCommitUser: "任蔼80362398",
  roomId: "992391",
  roomName: "零售基础客群经营开发室(成都)"
}

describe("active knowledge update details", () => {
  it("preserves only the documented fields and orders by most recent update", () => {
    expect(
      parseKnowledgeActiveList([
        { ...row, lastCommitDate: "2026-09-23 17:58:15" },
        { ...row, filePath: "other/rules.md", extra: "not displayed" }
      ])
    ).toEqual([
      { ...row, filePath: "other/rules.md" },
      { ...row, lastCommitDate: "2026-09-23 17:58:15" }
    ])
    expect(parseKnowledgeActiveList([{ filePath: " rules.md ", roomName: null }])).toEqual([
      {
        filePath: "rules.md",
        fileName: "",
        subProduct: "",
        deployUnit: "",
        lastCommitDate: "",
        lastCommitUser: "",
        roomId: "",
        roomName: ""
      }
    ])
  })
  it.each([null, {}, [null], [{ filePath: "" }], [{ ...row, roomId: 992391 }]])(
    "rejects invalid responses without hiding records",
    (value) => {
      expect(() => parseKnowledgeActiveList(value)).toThrow()
    }
  )
  it.each([null, ["992391", "990866"]])(
    "POSTs the authorized room scope once without dates or auth",
    async (orgIds) => {
      const request = vi.fn(async () => Response.json([row]))
      expect(await fetchKnowledgeActiveList("http://kb.test/", orgIds, undefined, request)).toEqual(
        [row]
      )
      expect(request).toHaveBeenCalledExactlyOnceWith("http://kb.test/knowledge/active-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgIds }),
        signal: expect.any(AbortSignal)
      })
    }
  )
  it("distinguishes empty results, HTTP errors and missing configuration", async () => {
    expect(
      await fetchKnowledgeActiveList(
        "http://kb.test",
        null,
        undefined,
        vi.fn(async () => Response.json([]))
      )
    ).toEqual([])
    await expect(
      fetchKnowledgeActiveList(
        "http://kb.test",
        null,
        undefined,
        vi.fn(async () => new Response("error", { status: 500 }))
      )
    ).rejects.toThrow("HTTP 500")
    const request = vi.fn()
    await expect(fetchKnowledgeActiveList("", null, undefined, request)).rejects.toThrow("未配置")
    expect(request).not.toHaveBeenCalled()
  })
  it("cancels both before dispatch and after response parsing", async () => {
    const controller = new AbortController()
    const request = vi.fn(async () => {
      controller.abort()
      return Response.json([row])
    })
    await fetchKnowledgeActiveList("http://kb.test", null, controller.signal, request).then(
      () => {
        throw new Error("expected cancellation")
      },
      (error) => expect(isDashboardRequestCancelled(error)).toBe(true)
    )
    request.mockClear()
    await expect(
      fetchKnowledgeActiveList("http://kb.test", null, controller.signal, request)
    ).rejects.toThrow("cancelled")
    expect(request).not.toHaveBeenCalled()
  })
})
