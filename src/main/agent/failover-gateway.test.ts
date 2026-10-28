import { describe, expect, it } from "vitest"
import { extractBodyReason, extractErrorDetail, isRetryableApiError } from "./failover"

describe("gateway errors", () => {
  it("shows balance exhaustion and never retries it through another model", () => {
    const error = Object.assign(new Error("434 当前用户账号的码豆余额已不足"), { status: 434 })
    expect(isRetryableApiError(error)).toBe(false)
    expect(isRetryableApiError(new Error("HTTP 434: balance exhausted"))).toBe(false)
    const detail = extractErrorDetail(error)
    expect(detail.statusLabel).toBe("码豆余额不足")
    expect(detail.hint).toContain("充值")
  })

  it("preserves the gateway error message without guessing why status 485 occurred", () => {
    const rawBody = JSON.stringify({
      returnCode: "XCDZB485",
      errorMsg: "模型服务内部异常或当前任务上下文超过最大限度"
    })
    expect(extractBodyReason(rawBody)).toBe("模型服务内部异常或当前任务上下文超过最大限度")
    expect(
      extractErrorDetail(new Error("API error"), { status: 485, rawBody, requestId: "req-test" })
        .reason
    ).toContain("模型服务内部异常")
  })
})
