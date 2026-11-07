/** Independent browser acceptance of an already completed source tree. Never implements its code. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, relative, resolve } from "node:path"
import { once } from "node:events"
import { chromium } from "playwright"

function hashes(directory: string, base = directory): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return Object.entries(hashes(path, base))
      return [[relative(base, path), createHash("sha256").update(readFileSync(path)).digest("hex")]]
    })
  )
}

async function main() {
  assert(process.env.CMB_WORKBENCH_COMPLETED_PROJECT, "EXPLICIT_COMPLETED_PROJECT_REQUIRED")
  const project = resolve(process.env.CMB_WORKBENCH_COMPLETED_PROJECT)
  const output = resolve(
    process.env.CMB_WORKBENCH_BROWSER_OUTPUT || "output/frontend-api-workbench-completed-source"
  )
  mkdirSync(output, { recursive: true })
  const before = hashes(project)
  const server: import("node:http").Server = createRequire(join(project, "package.json"))(
    join(project, "server.cjs")
  ).createDemoServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}`
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  const report: {
    passed: boolean
    project: string
    verified: string[]
    errors: string[]
    requests: string[]
    error?: string
  } = { passed: false, project, verified: [], errors: [], requests: [] }
  try {
    browser = await chromium.launch({
      headless: true,
      ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
    page.setDefaultTimeout(12000)
    page.on("pageerror", (error) => report.errors.push(error.message))
    page.on("request", (request) => {
      if (request.url().startsWith(url + "/api/"))
        report.requests.push(request.url().slice(url.length))
    })
    await page.goto(url)
    await page.getByTestId("revenue").filter({ hasText: "9824.50" }).waitFor()
    assert.equal(await page.locator("#orders tbody tr").count(), 3)
    assert.equal(await page.getByTestId("amount").first().innerText(), "129.00")
    await page.getByTestId("notification-error").filter({ hasText: "通知服务暂时不可用" }).waitFor()
    assert.equal(await page.locator(".trend").count(), 7)
    report.verified.push("units, initial orders, trends and genuine notification 503")
    await page.getByRole("button", { name: "下一页", exact: true }).click()
    await page.getByRole("button", { name: "查看 DEMO-004 详情", exact: true }).waitFor()
    await page.getByLabel("订单状态", { exact: true }).selectOption("shipped")
    await page.getByRole("button", { name: "查询", exact: true }).click()
    await page.getByRole("button", { name: "查看 DEMO-002 详情", exact: true }).waitFor()
    assert.equal(await page.locator("#orders tbody tr").count(), 2)
    assert.match(await page.locator(".pagination").innerText(), /第 1 \/ 1 页/)
    report.verified.push("pagination and filter resets page")
    await page.getByLabel("订单状态", { exact: true }).selectOption("")
    await page.getByLabel("搜索订单", { exact: true }).fill("星野")
    await page.getByRole("button", { name: "查询", exact: true }).click()
    await page.getByRole("button", { name: "查看 DEMO-001 详情", exact: true }).waitFor()
    assert.equal(await page.locator("#orders tbody tr").count(), 1)
    await page.getByRole("button", { name: "查看 DEMO-001 详情", exact: true }).click()
    await page.getByTestId("detail-total").waitFor()
    assert.equal(await page.getByTestId("detail-total").innerText(), "¥ 129.00")
    await page.getByRole("button", { name: "关闭详情", exact: true }).click()
    await page.getByLabel("仓库", { exact: true }).selectOption("south")
    await page.getByTestId("stock-SKU-100").filter({ hasText: "可用 40" }).waitFor()
    report.verified.push("search, detail and warehouse changes")
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    await page.route("**/api/orders?*", async (route) => {
      await gate
      await route.continue()
    })
    await page.getByLabel("搜索订单", { exact: true }).fill("没有这条订单")
    await page.getByRole("button", { name: "查询", exact: true }).click()
    try {
      await page.getByRole("status").filter({ hasText: "正在加载订单" }).waitFor()
      assert(await page.getByRole("button", { name: "查询", exact: true }).isDisabled())
    } finally {
      release()
    }
    await page.locator("#orders .empty").waitFor()
    assert.equal(await page.locator("#orders tbody tr").count(), 0)
    await page.unroute("**/api/orders?*")
    report.verified.push("loading, duplicate-submit prevention and empty state (held request)")
    await page.route("**/api/orders?*", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "列表暂时不可用" })
      })
    })
    await page.getByRole("button", { name: "查询", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "列表暂时不可用" }).waitFor()
    assert(await page.getByRole("button", { name: "查询", exact: true }).isEnabled())
    await page.unroute("**/api/orders?*")
    await page.getByLabel("搜索订单", { exact: true }).fill("")
    await page.getByRole("button", { name: "查询", exact: true }).click()
    await page.getByRole("button", { name: "查看 DEMO-001 详情", exact: true }).waitFor()
    report.verified.push("list failure and retry recovery (injected 503)")
    assert.deepEqual(report.errors, [])
    await page.screenshot({ path: join(output, "model-completed-source.png"), fullPage: true })
    assert.deepEqual(hashes(project), before, "Acceptance must not modify the completed source")
    report.passed = true
    console.log("PASS independent completed-source browser acceptance")
  } catch (error) {
    report.error = error instanceof Error ? error.message : "BROWSER_ACCEPTANCE_FAILED"
    throw error
  } finally {
    await browser?.close().catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2))
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "BROWSER_ACCEPTANCE_FAILED")
  process.exitCode = 1
})
