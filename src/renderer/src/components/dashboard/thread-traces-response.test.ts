import { describe, expect, it } from "vitest"
import { unwrapThreadTracesResponse } from "./thread-traces-response"

/**
 * 会话列表改成摘要预览（不含 `_raw`）之后，`dashboard:threadTraces` 是完整对话的
 * 唯一来源。原先每个加载器都写 `res.success ? res.data : []`，失败与「确实没有
 * trace」在调用方眼里完全一样，于是 TraceExplorer 把失败当成一次空的成功写进
 * threadTraceCache——而它的守卫是 `if (threadTraceCache[id]) return`，空数组也是
 * truthy，该会话本次会话期内就再也不会重试了。
 */
describe("threadTraces 响应解包", () => {
  it("成功时返回 trace 列表", () => {
    const data = [{ traceId: "t1" }, { traceId: "t2" }]
    expect(unwrapThreadTracesResponse({ success: true, data })).toHaveLength(2)
  })

  it("成功但真的没有 trace 时返回空列表（这是可以缓存的）", () => {
    expect(unwrapThreadTracesResponse({ success: true, data: [] })).toEqual([])
    expect(unwrapThreadTracesResponse({ success: true })).toEqual([])
  })

  it("失败时抛出，且带上主进程给的原因", () => {
    expect(() =>
      unwrapThreadTracesResponse({
        success: false,
        error: "本次查询返回的数据量过大，请缩小时间范围或减少每页条数后重试"
      })
    ).toThrow("数据量过大")
  })

  it("失败但没给原因时也抛出，不静默变成空成功", () => {
    expect(() => unwrapThreadTracesResponse({ success: false })).toThrow("加载完整会话失败")
    expect(() => unwrapThreadTracesResponse(undefined)).toThrow("加载完整会话失败")
    expect(() => unwrapThreadTracesResponse(null)).toThrow("加载完整会话失败")
  })

  it("success 为真但 data 不是数组时不抛，按空处理", () => {
    // 这是协议层的宽容：主进程说成功了，就不该因为载荷形状把整页判成失败。
    expect(unwrapThreadTracesResponse({ success: true, data: "oops" })).toEqual([])
  })
})
