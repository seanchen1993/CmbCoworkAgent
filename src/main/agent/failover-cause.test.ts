import { expect, it } from "vitest"
import { isRetryableApiError } from "./failover"

it("retains explicit provider status through graph wrappers", () => {
  const provider = Object.assign(new Error("server unavailable"), { status: 503 })
  expect(isRetryableApiError(new Error("graph failed", { cause: provider }))).toBe(true)
  expect(
    isRetryableApiError(
      new Error("graph failed", {
        cause: { response: { status: 429 } }
      })
    )
  ).toBe(true)
})

it.each([400, 401, 403])(
  "does not retry a wrapped %s under a network-looking wrapper",
  (status) => {
    const provider = Object.assign(new Error("provider rejected"), { status })
    expect(isRetryableApiError(new Error("503 network error", { cause: provider }))).toBe(false)
  }
)

it("cancellation wins over retry-looking messages and HTTP status anywhere in the chain", () => {
  const aborted = Object.assign(new Error("stopped"), { name: "AbortError" })
  const provider = Object.assign(new Error("unavailable", { cause: aborted }), { status: 503 })
  expect(isRetryableApiError(new Error("network error", { cause: provider }))).toBe(false)
})

it("bounds cyclic and excessive chains without inferring a retry from unknown failures", () => {
  const cyclic = new Error("unknown", { cause: undefined })
  cyclic.cause = cyclic
  expect(isRetryableApiError(cyclic)).toBe(false)
  let nested = Object.assign(new Error("unavailable"), { status: 503 }) as Error
  for (let index = 0; index < 64; index++) nested = new Error("wrapper", { cause: nested })
  expect(isRetryableApiError(nested)).toBe(false)
})
