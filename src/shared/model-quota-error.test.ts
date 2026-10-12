import { expect, it } from "vitest"
import { isModelQuotaError, isModelQuotaResponse } from "./model-quota-error"
import { classifyApiError, extractErrorDetail, getApiErrorInfo } from "../main/agent/api-errors"

const quota = "已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"

it.each([
  { error: { message: quota, type: "rate_limit_error" } },
  { error: { message: "Token Plan usage limit reached. (2056)" } },
  { base_resp: { status_code: 2056, status_msg: "usage limit exceeded" } },
  { error: { code: "insufficient_quota", message: "quota exceeded" } }
])("recognizes explicit provider quota without treating all HTTP 429 as quota", (body) => {
  expect(isModelQuotaResponse(429, JSON.stringify(body))).toBe(true)
  expect(isModelQuotaResponse(500, JSON.stringify(body))).toBe(false)
})

it.each([
  { error: { message: "rate limit exceeded (1002)" } },
  { error: { message: "rate limit: request 2056" } },
  { error: { message: "Token Plan request rejected (2056)" } },
  { error: { message: "token limit (1039)" } },
  { code: 2056, message: "unrelated gateway code" }
])("preserves ordinary throttling or unrelated numeric codes", (body) => {
  expect(isModelQuotaResponse(429, JSON.stringify(body))).toBe(false)
})

it("rejects malformed, partial and oversized response bodies", () => {
  expect(isModelQuotaResponse(429, undefined)).toBe(false)
  expect(isModelQuotaResponse(429, quota)).toBe(false)
  expect(isModelQuotaResponse(429, '{"error":{"code":"insufficient_quota"')).toBe(false)
  expect(
    isModelQuotaResponse(429, JSON.stringify({ error: { message: quota } }) + " ".repeat(16384))
  ).toBe(false)
})

it("requires thrown errors and provider status, follows bounded causes and avoids getters", () => {
  expect(isModelQuotaError(new Error(quota))).toBe(false)
  expect(isModelQuotaError({ status: 429, message: quota })).toBe(false)
  const provider = Object.assign(new Error(quota), { status: 429 })
  expect(isModelQuotaError(new Error("wrapped", { cause: provider }))).toBe(true)
  const cyclic = new Error("unknown")
  cyclic.cause = cyclic
  expect(isModelQuotaError(cyclic)).toBe(false)
  const accessor = new Error("unknown")
  Object.defineProperty(accessor, "status", {
    get: () => {
      throw new Error("unsafe")
    }
  })
  expect(isModelQuotaError(accessor)).toBe(false)
})

it("uses the quota label over generic 429 and keeps ordinary API errors unchanged", () => {
  const provider = Object.assign(new Error(quota), { status: 429 })
  expect(classifyApiError(provider)).toBe("quota_exceeded")
  expect(classifyApiError({ status: 429, message: quota })).toBe("rate_limit")
  const detail = extractErrorDetail(provider)
  expect(detail).toMatchObject({
    code: "quota_exceeded",
    status: 429,
    statusLabel: "模型额度已用尽"
  })
  expect(detail.reason).toBe(quota)
  expect(
    extractErrorDetail(new Error("wrapped"), {
      status: 429,
      rawBody: JSON.stringify({ base_resp: { status_code: 2056 } })
    }).code
  ).toBe("quota_exceeded")
  expect(getApiErrorInfo(429, "rate_limit")?.label).toBe("请求速率限制")
  expect(getApiErrorInfo(429, "quota_exceeded")?.label).toBe("模型额度已用尽")
})
