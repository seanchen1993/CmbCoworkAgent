import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { createApi } from "../src/api.js"

const { createDemoServer } = createRequire(import.meta.url)("../server.cjs")
const server = createDemoServer()
let base
let api
before(async () => {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  base = `http://127.0.0.1:${server.address().port}`
  api = createApi(base)
})
after(
  () =>
    new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections()
    })
)
test("layout and fixed backend are available before implementation", async () => {
  assert.match(await (await fetch(base)).text(), /青禾运营台/)
  assert.equal((await (await fetch(base + "/api/orders")).json()).total, 8)
  assert.equal((await fetch(base + "/api/orders?page=0")).status, 400)
})
test("session and summary map backend units", async () => {
  assert.equal((await api.session()).user.name, "陈晓")
  const summary = await api.overview()
  assert.equal(summary.revenue, 9824.5)
  assert.equal(summary.orderCount, 128)
  assert.equal(summary.conversionPercent, 12.6)
})
test("status list, one-based pagination and query filters", async () => {
  assert((await api.statuses()).some((row) => row.value === "shipped"))
  const first = await api.orders({ page: 1, pageSize: 3 })
  assert.equal(first.total, 8)
  assert.equal(first.items.length, 3)
  assert.equal(first.items[0].id, "DEMO-001")
  assert.equal(first.items[0].amount, 129)
  const next = await api.orders({ page: 2, pageSize: 3 })
  assert.equal(next.items[0].id, "DEMO-004")
  assert.equal(next.page, 2)
  const shipped = await api.orders({ status: "shipped", page: 1, pageSize: 3 })
  assert.equal(shipped.total, 2)
  assert(shipped.items.every((row) => row.status === "shipped"))
  const search = await api.orders({ q: "星野", page: 1, pageSize: 3 })
  assert.equal(search.total, 1)
  assert.equal(search.items[0].id, "DEMO-001")
  assert.equal((await api.orders({ q: "不存在", page: 1, pageSize: 3 })).total, 0)
})
test("detail unwraps order envelope, preserves products, rejects missing records", async () => {
  const detail = await api.detail("DEMO-001")
  assert.equal(detail.amount, 129)
  assert.equal(detail.items[0].quantity, 1)
  assert.match(detail.shippingAddress, /演示路/)
  await assert.rejects(() => api.detail("MISSING"), /订单不存在/)
})
test("warehouses, inventory and trend units", async () => {
  assert.equal((await api.warehouses()).length, 2)
  const east = await api.inventory("east")
  const south = await api.inventory("south")
  assert.equal(east[0].available, 28)
  assert.equal(east[0].reserved, 4)
  assert.equal(south[0].available, 40)
  const trends = await api.trends()
  assert.equal(trends.length, 7)
  assert.equal(trends[0].day, "2026-10-31")
  assert.equal(trends[0].revenue, 142)
})
test("HTTP errors are not silently treated as empty successful responses", async () => {
  await assert.rejects(() => api.notifications(), /通知服务暂时不可用/)
  await assert.rejects(() => api.inventory("missing"), /仓库不存在/)
})
test("adapter uses supplied transport and URL-encodes queries", async () => {
  const calls = []
  const traced = createApi(base, async (url, options) => {
    calls.push(String(url))
    return fetch(url, options)
  })
  await traced.orders({ q: "星野 & 茶", status: "paid", page: 1, pageSize: 3 })
  assert.equal(calls.length, 1)
  assert.equal(new URL(calls[0]).searchParams.get("q"), "星野 & 茶")
  assert.equal(new URL(calls[0]).searchParams.get("status"), "paid")
})
