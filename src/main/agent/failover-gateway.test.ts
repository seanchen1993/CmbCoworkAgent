import { describe, expect, it } from "vitest"
import {
  extractBodyReason,
  extractErrorDetail,
  isRetryableApiError,
  isRetryableManagedProviderError
} from "./failover"

describe("gateway errors", () => {
  it.each([403, 434, 503])(
    "classifies a wrapped structured status %s through its cause",
    (status) => {
      const original = Object.assign(new Error("网关响应异常"), { status })
      const wrapped = new Error("All models failed: 模型调用异常", {
        cause: new Error("wrapped", { cause: original })
      })
      expect(isRetryableManagedProviderError(wrapped)).toBe(status === 503)
      expect(extractErrorDetail(wrapped).status).toBe(status)
    }
  )

  it("recognizes a wrapped network code without parsing the aggregate message", () => {
    const wrapped = new Error("All models failed: 请求失败", {
      cause: Object.assign(new Error("请求失败"), { code: "ECONNREFUSED" })
    })
    expect(isRetryableManagedProviderError(wrapped)).toBe(true)
    const cyclic = new Error("unclassified")
    Object.assign(cyclic, { cause: cyclic })
    expect(isRetryableManagedProviderError(cyclic)).toBe(false)
  })

  it.each([400, 401, 403, 404, 405, 434, 480, 481, 482, 483, 485])(
    "honors structured status %s over network-looking details",
    (status) => {
      const error = Object.assign(new Error("terminated: upstream 503 timeout"), {
        status,
        code: "ECONNRESET"
      })
      expect(isRetryableManagedProviderError(error)).toBe(false)
      expect(isRetryableManagedProviderError({ response: { status }, message: "timeout" })).toBe(
        false
      )
    }
  )

  it.each([408, 409, 429, 432, 433, 500, 503, 504, 580, 581, 585])(
    "retries temporary managed status %s",
    (status) => {
      expect(isRetryableManagedProviderError({ status, message: "authentication failed" })).toBe(
        true
      )
    }
  )

  it("recognizes structured network failures and does not retry an unknown failure", () => {
    expect(isRetryableManagedProviderError({ code: "ECONNRESET" })).toBe(true)
    expect(isRetryableManagedProviderError({ code: "ETIMEDOUT" })).toBe(true)
    expect(isRetryableManagedProviderError(new Error("request could not be processed"))).toBe(false)
    expect(isRetryableManagedProviderError(new Error("model not found"))).toBe(false)
  })

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
