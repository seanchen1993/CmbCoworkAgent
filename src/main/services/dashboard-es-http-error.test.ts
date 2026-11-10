import { expect, it } from "vitest"
import { getDashboardEsHttpErrorStatus } from "./dashboard-es-client"

it("recognizes the production HTTP 400 through Error and serialized worker causes", () => {
  const workerError = new Error("请检查网络连接后重试", {
    cause: {
      code: "DASHBOARD_ES_HTTP_ERROR",
      message: `ES 400: {"error":{"root_cause":[{"reason":"expected ']' at position 60"}]}}`
    }
  })
  const wrapped = new Error("请检查网络连接后重试", { cause: workerError })
  expect(getDashboardEsHttpErrorStatus(wrapped)).toBe(400)
})

it("handles a truncated ES error body", () => {
  expect(
    getDashboardEsHttpErrorStatus({
      code: "DASHBOARD_ES_HTTP_ERROR",
      message: 'ES 400: {"error":{"root_cause":['
    })
  ).toBe(400)
})

it("keeps other HTTP statuses distinguishable", () => {
  expect(
    getDashboardEsHttpErrorStatus({ code: "DASHBOARD_ES_HTTP_ERROR", message: "ES 403: forbidden" })
  ).toBe(403)
})

it.each([
  null,
  new Error("fetch failed"),
  { message: "ES 400: unrelated text" },
  { code: "DASHBOARD_ES_HTTP_ERROR", message: "ES 4000" }
])("does not classify network or malformed failures as HTTP 400: %j", (error) => {
  expect(getDashboardEsHttpErrorStatus(error)).toBeNull()
})
