/** Actual offline Vue UI + local HTTP APIs, including intentional integration faults. */
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Server } from "node:http"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output/frontend-api-vue-demo-browser")
  const demoRoot = resolve(
    process.env.WORKBENCH_DEMO_ROOT ?? "examples/frontend-api-workbench/demo"
  )
  mkdirSync(output, { recursive: true })
  assert.equal(
    createHash("sha256")
      .update(readFileSync(resolve(demoRoot, "public/vendor/vue.global.prod.js")))
      .digest("hex"),
    "9847847474877fae5997b30db1674c99d3f8ae36b475af3224a1f79c274530a9"
  )
  const require = createRequire(import.meta.url)
  const { createDemoServer } = require(resolve(demoRoot, "server.cjs")) as {
    createDemoServer(): Server
  }
  const server = createDemoServer()
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await new Promise<void>((yes, no) => {
      server.once("error", no)
      server.listen(0, "127.0.0.1", () => yes())
    })
    const address = server.address()
    assert(address && typeof address !== "string")
    const base = "http://127.0.0.1:" + address.port
    browser = await chromium.launch({
      headless: true,
      ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const pageErrors: string[] = []
    const requests: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.message))
    page.on("request", (request) => requests.push(request.url()))
    await page.goto(base + "/demo")
    await page.getByRole("heading", { name: "让模型带着证据做联调", exact: true }).waitFor()
    assert.equal(await page.getByLabel("页面地址", { exact: true }).inputValue(), base + "/orders")
    assert.equal(
      await page.getByLabel("接口文档", { exact: true }).inputValue(),
      base + "/api-docs"
    )
    await page.evaluate(`Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText() { return Promise.reject(Error("clipboard fixture denied")) } }
    })`)
    await page.getByRole("button", { name: "复制检查范围", exact: true }).click()
    await page.getByText("内容已选中，请按 Ctrl+C 复制。", { exact: true }).waitFor()
    assert(
      await page.getByLabel("检查范围", { exact: true }).evaluate((element) => {
        const field = element as HTMLTextAreaElement
        return field.selectionEnd === field.value.length && field.selectionStart === 0
      })
    )
    await page.screenshot({ path: resolve(output, "demo-guide.png"), fullPage: true })
    await page.goto(base + "/orders")
    await page.getByText("页面数据加载结束", { exact: true }).waitFor()
    await page.screenshot({ path: resolve(output, "vue-overview.png") })
    assert.equal(await page.evaluate("Vue.version"), "3.5.24")
    assert.equal(await page.locator("[v-cloak]").count(), 0)
    assert.equal(await page.locator("#orders tbody tr").count(), 3)
    assert.equal(await page.getByTestId("order-amount").first().innerText(), "0.00")
    assert.equal(await page.getByTestId("revenue").innerText(), "¥ 982450.00")
    assert.equal(await page.locator(".bar").count(), 7)
    assert.match(await page.locator("#trends").innerText(), /142.00/)
    assert.match(await page.locator("#trends").innerText(), /416.00/)
    assert.match(await page.locator("header").innerText(), /陈晓.*运营主管/)
    await page.getByText("暂无通知", { exact: true }).waitFor()
    const overview = await (await page.request.get(base + "/api/overview")).json()
    assert.equal(overview.revenueCents / 100, 9824.5)

    // Same actual record displayed correctly in detail but incorrectly in the list.
    await page.getByRole("button", { name: "查看 DEMO-001 详情", exact: true }).click()
    await page.getByTestId("detail-total").waitFor()
    assert.equal(await page.getByTestId("detail-total").innerText(), "¥ 129.00")
    await page.screenshot({ path: resolve(output, "vue-order-detail.png"), fullPage: true })
    await page.getByRole("button", { name: "关闭详情", exact: true }).click()
    const detail = await (await page.request.get(base + "/api/orders/DEMO-001")).json()
    assert.equal(detail.order.totalAmountCents, 12900)
    assert.equal(detail.data, undefined)
    assert.equal((await page.request.get(base + "/api/orders/missing")).status(), 404)

    const firstPage = await page.locator("#orders tbody tr td:first-child strong").allTextContents()
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/orders?page=1&")),
      page.getByRole("button", { name: "下一页", exact: true }).click()
    ])
    await page.waitForFunction(() =>
      document.querySelector("[data-testid=page-number]")?.textContent?.includes("第 2")
    )
    assert.deepEqual(
      await page.locator("#orders tbody tr td:first-child strong").allTextContents(),
      firstPage
    )
    const correctSecond = await (
      await page.request.get(base + "/api/orders?page=2&pageSize=3")
    ).json()
    assert.deepEqual(
      correctSecond.orders.map((row: { id: string }) => row.id),
      ["DEMO-004", "DEMO-005", "DEMO-006"]
    )
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/orders?page=0&")),
      page.getByRole("button", { name: "上一页", exact: true }).click()
    ])

    await page.getByLabel("订单状态", { exact: true }).selectOption("shipped")
    await page.getByRole("button", { name: "查询", exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll("#orders tbody tr").length === 2)
    assert.deepEqual(
      await page.locator("#orders tbody tr td:first-child strong").allTextContents(),
      ["DEMO-002", "DEMO-006"]
    )
    assert.equal((await page.request.get(base + "/api/orders?status=delivered")).status(), 400)
    await page.getByLabel("订单状态", { exact: true }).selectOption("")
    await page.getByLabel("搜索订单", { exact: true }).fill("阅读台灯")
    await page.getByRole("button", { name: "查询", exact: true }).click()
    await page.waitForFunction(() =>
      document.querySelector("#orders tbody")?.textContent?.includes("DEMO-003")
    )
    assert.deepEqual(
      await page.locator("#orders tbody tr td:first-child strong").allTextContents(),
      ["DEMO-003", "DEMO-007"]
    )
    await page.getByLabel("搜索订单", { exact: true }).fill("不存在的客户")
    await page.getByRole("button", { name: "查询", exact: true }).click()
    await page.getByText("未找到匹配订单", { exact: true }).waitFor()

    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/inventory?warehouse=south")),
      page.getByLabel("库存仓库", { exact: true }).selectOption("south")
    ])
    const south = await (await page.request.get(base + "/api/inventory?warehouse=south")).json()
    assert.equal(south.items[0].availableStock, 40)
    assert.equal(south.items[0].quantity, undefined)
    assert.match(await page.getByTestId("stock").first().innerText(), /^0\s/)
    const notify = await page.request.get(base + "/api/notifications")
    assert.equal(notify.status(), 503)
    assert.equal(notify.headers()["retry-after"], "30")
    assert.equal((await notify.json()).retryable, true)
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/notifications")),
      page.getByRole("button", { name: "刷新通知", exact: true }).click()
    ])
    assert.equal(await page.getByText("暂无通知", { exact: true }).count(), 1)

    const mixed = await (await page.request.get(base + "/api-docs")).text()
    const correct = await (await page.request.get(base + "/api-docs-correct")).text()
    for (const route of [
      "/api/session",
      "/api/overview",
      "/api/orders",
      "/api/order-statuses",
      "/api/orders/{id}",
      "/api/warehouses",
      "/api/inventory",
      "/api/trends",
      "/api/notifications"
    ]) {
      assert(mixed.includes(route), route)
      assert(correct.includes(route), route)
    }
    for (const [wrong, right] of [
      ['"value":"delivered"', '"value":"shipped"'],
      ['{"data":{"id"', '{"order":{"id"'],
      ['"quantity":28', '"availableStock":28'],
      ['"date":"2026-10-31","sales":142.00', '"day":"2026-10-31","revenueCents":14200']
    ]) {
      assert(mixed.includes(wrong))
      assert(!correct.includes(wrong))
      assert(correct.includes(right))
    }
    const blocked = await page.request.get(
      base + "/" + encodeURIComponent("验收答案-请勿提交给模型.txt")
    )
    assert.equal(blocked.status(), 404)
    assert.equal((await page.request.post(base + "/api/orders")).status(), 405)
    for (const query of ["page=-1", "pageSize=0", "pageSize=21", "page=abc"])
      assert.equal((await page.request.get(base + "/api/orders?" + query)).status(), 400)
    assert.equal((await page.request.get(base + "/api/inventory?warehouse=bad")).status(), 400)

    await page.getByLabel("搜索订单", { exact: true }).fill("")
    await page.getByRole("button", { name: "查询", exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll("#orders tbody tr").length === 3)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.evaluate(() => {
        document.documentElement.style.scrollBehavior = "auto"
        window.scrollTo(0, 0)
      })
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await page.screenshot({
        path: resolve(output, "vue-orders-" + width + ".png"),
        fullPage: true
      })
    }
    assert(
      requests.every((url) => url.startsWith(base + "/")),
      "No CDN or external requests"
    )
    assert.equal(
      new Set(requests.filter((url) => url.includes("/api/")).map((url) => new URL(url).pathname))
        .size,
      9
    )
    assert.deepEqual(pageErrors, [])
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          passed: true,
          vueVersion: "3.5.24",
          apiTypesObserved: 9,
          viewportWidths: [1440, 390],
          noExternalNetwork: true,
          pageErrors,
          intentionalFrontendDefects: [
            "revenue unit",
            "list amount field",
            "pagination offset",
            "stock field",
            "503 masked as empty"
          ],
          intentionalDocumentDefects: [
            "status enum",
            "detail envelope",
            "stock field",
            "trend fields and units"
          ],
          expectedServiceFault: "notifications 503",
          checked: [
            "initial load",
            "details",
            "pagination",
            "status filtering",
            "search",
            "empty results",
            "warehouse switch",
            "trends",
            "notifications",
            "both documents",
            "invalid query",
            "GET only"
          ],
          liveModelInvoked: false
        },
        null,
        2
      ) + "\n"
    )
    console.log(
      "PASS offline Vue 3 demo: 9 API types, interactions, 5 seeded UI faults, 4 document mismatches, mobile/desktop"
    )
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
