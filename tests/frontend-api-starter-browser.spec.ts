/** Fixture completion proves the exercise is solvable; this is NOT a real-model E2E. */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Server } from "node:http"
import { chromium } from "playwright"

// Kept only in the repository's test suite, never in the delivered starter archive.
const completedAdapter = `export function createApi(base = "", fetcher = globalThis.fetch) {
  const amount = order => ({ ...order, amount: order.totalAmountCents / 100 })
  async function request(path, query) {
    const suffix = query ? "?" + new URLSearchParams(query) : ""
    const response = await fetcher(base + path + suffix)
    const body = await response.json()
    if (!response.ok) throw new Error(body.message || "HTTP " + response.status)
    return body
  }
  return {
    session: () => request("/api/session"),
    overview: async () => {
      const data = await request("/api/overview")
      return { ...data, revenue: data.revenueCents / 100, conversionPercent: data.conversionRate * 100 }
    },
    statuses: async () => (await request("/api/order-statuses")).statuses,
    orders: async ({ page = 1, pageSize = 3, q = "", status = "" } = {}) => {
      const data = await request("/api/orders", { page, pageSize, q, status })
      return { ...data, items: data.orders.map(amount) }
    },
    detail: async id => amount((await request("/api/orders/" + encodeURIComponent(id))).order),
    warehouses: async () => (await request("/api/warehouses")).warehouses,
    inventory: async warehouse => (await request("/api/inventory", { warehouse })).items.map(row => ({
      ...row, available: row.availableStock, reserved: row.reservedStock
    })),
    trends: async () => (await request("/api/trends")).points.map(row => ({ ...row, revenue: row.revenueCents / 100 })),
    notifications: () => request("/api/notifications")
  }
}`

const implementations = {
  "// TODO(search): reset page to 1 and reload orders using current filters.":
    "page.value = 1\n      await loadOrders()",
  "// TODO(page): change page within [1, ceil(total / 3)] and reload orders.":
    "page.value = Math.max(1, Math.min(Math.ceil(total.value / 3), page.value + delta))\n      await loadOrders()",
  "// TODO(detail): fetch selected detail; show failures and clear stale detail.":
    'detail.value = null\n      error.value = ""\n      try { detail.value = await api.detail(id) } catch (cause) { error.value = cause.message }',
  "// TODO(warehouse): reload inventory for the chosen warehouse; show failures.":
    'error.value = ""\n      try { inventory.value = await api.inventory(warehouse.value) } catch (cause) { error.value = cause.message }'
}

function protectedHashes(root: string) {
  const files = ["server.cjs", "package.json", "AGENTS.md", "TASK.md"]
  for (const directory of ["docs", "tests", "scripts", "public/vendor"])
    for (const name of readdirSync(join(root, directory))) files.push(directory + "/" + name)
  return Object.fromEntries(
    files.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(join(root, file)))
        .digest("hex")
    ])
  )
}

async function main() {
  const source = resolve(process.env.WORKBENCH_STARTER_ROOT ?? "examples/frontend-api-starter")
  const output = resolve("output/frontend-api-starter-browser")
  mkdirSync(output, { recursive: true })
  const copy = mkdtempSync(join(tmpdir(), "frontend-api-starter-"))
  cpSync(source, copy, { recursive: true, filter: (file) => !file.split(/[\\/]/).includes("dist") })
  const protectedBefore = protectedHashes(copy)
  const run = (...args: string[]) =>
    spawnSync(process.execPath, args, { cwd: copy, encoding: "utf8", windowsHide: true })
  const baseline = run("--test", "tests/acceptance.test.mjs")
  assert.equal(baseline.status, 1)
  assert.match(baseline.stdout, /TODO：接口尚未接入/)
  assert.match(baseline.stdout, /# pass 1/)
  assert.match(baseline.stdout, /# fail 6/)
  assert.equal(
    run("scripts/build.mjs").status,
    0,
    "starter syntax/build must work before completion"
  )
  const { createDemoServer } = createRequire(import.meta.url)(join(copy, "server.cjs")) as {
    createDemoServer(): Server
  }
  const server = createDemoServer()
  await new Promise<void>((yes, no) => {
    server.once("error", no)
    server.listen(0, "127.0.0.1", yes)
  })
  const address = server.address()
  assert(address && typeof address !== "string")
  const base = `http://127.0.0.1:${address.port}`
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch({
      headless: true,
      ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(base)
    await page.getByRole("heading", { name: "青禾运营台", exact: true }).waitFor()
    await page.getByRole("alert").filter({ hasText: "TODO：接口尚未接入" }).waitFor()
    assert.equal(await page.locator("[v-cloak]").count(), 0)
    assert.equal(await page.evaluate("Vue.version"), "3.5.24")
    await page.screenshot({ path: join(output, "unfinished.png"), fullPage: true })
    assert.equal((await page.request.get(base + "/health")).status(), 200)
    assert.match(await (await page.request.get(base + "/api-docs-correct")).text(), /shipped/)
    assert.match(await (await page.request.get(base + "/api-docs")).text(), /delivered/)
    assert.equal((await page.request.post(base + "/api/orders")).status(), 405)

    // A normal refactor into source helper modules must remain runnable.
    mkdirSync(join(copy, "src/helpers"))
    writeFileSync(join(copy, "src/helpers/request.js"), "export const identity = 'module-loaded'\n")
    assert.equal(
      await page.evaluate(async () => (await import("/src/helpers/request.js")).identity),
      "module-loaded"
    )
    writeFileSync(join(copy, "src/helpers/config.json"), '{"limit":3}')
    assert.equal((await page.request.get(base + "/src/helpers/config.json")).status(), 200)
    writeFileSync(join(copy, "src/.private.js"), "not public")
    for (const route of [
      "/server.cjs",
      "/package.json",
      "/src/.private.js",
      "/src/missing.js",
      "/src/%2e%2e%2fserver.cjs",
      "/src/%zz.js",
      "/src/helpers/%2f..%2f..%2fserver.cjs"
    ]) {
      assert.equal((await page.request.get(base + route)).status(), 404, route)
    }
    const outside = mkdtempSync(join(tmpdir(), "frontend-api-not-public-"))
    writeFileSync(join(outside, "private.js"), "must not leak")
    const link = join(copy, "src/linked")
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir")
    try {
      assert.equal((await page.request.get(base + "/src/linked/private.js")).status(), 404)
    } finally {
      unlinkSync(link)
    }

    writeFileSync(join(copy, "src/api.js"), completedAdapter)
    let app = readFileSync(join(copy, "src/app.js"), "utf8")
    for (const [marker, code] of Object.entries(implementations)) {
      assert(app.includes(marker), `missing fixture marker: ${marker}`)
      app = app.replace(marker, code)
    }
    writeFileSync(join(copy, "src/app.js"), app)
    const completed = run("--test", "tests/acceptance.test.mjs")
    assert.equal(completed.status, 0, completed.stdout + completed.stderr)
    assert.equal(run("scripts/build.mjs").status, 0)
    assert.deepEqual(protectedHashes(copy), protectedBefore)

    await page.reload()
    await page.getByTestId("revenue").filter({ hasText: "9824.50" }).waitFor()
    assert.equal(await page.locator("#orders tbody tr").count(), 3)
    assert.equal(await page.getByTestId("amount").first().innerText(), "129.00")
    await page.getByTestId("notification-error").filter({ hasText: "通知服务暂时不可用" }).waitFor()
    assert.equal(await page.locator(".trend").count(), 7)
    await page.getByRole("button", { name: "下一页", exact: true }).click()
    await page.getByRole("button", { name: "查看 DEMO-004 详情", exact: true }).waitFor()
    await page.getByLabel("订单状态", { exact: true }).selectOption("shipped")
    await page.getByRole("button", { name: "查询", exact: true }).click()
    await page.getByRole("button", { name: "查看 DEMO-002 详情", exact: true }).waitFor()
    assert.equal(await page.locator("#orders tbody tr").count(), 2)
    assert.match(await page.locator(".pagination").innerText(), /第 1 \/ 1 页/)
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

    // A held request proves loading state, disabled submit, and eventual empty state.
    let release!: () => void
    const gate = new Promise<void>((yes) => {
      release = yes
    })
    await page.route("**/api/orders?*", async (route) => {
      await gate
      await route.continue()
    })
    await page.getByLabel("搜索订单", { exact: true }).fill("没有这条订单")
    await page.getByRole("button", { name: "查询", exact: true }).click()
    await page.getByRole("status").filter({ hasText: "正在加载订单" }).waitFor()
    assert(await page.getByRole("button", { name: "查询", exact: true }).isDisabled())
    release()
    await page.locator("#orders .empty").waitFor()
    assert.equal(await page.locator("#orders tbody tr").count(), 0)
    await page.unroute("**/api/orders?*")
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
    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(output, "fixture-completed.png"), fullPage: true })
    assert.deepEqual(protectedHashes(copy), protectedBefore)
    writeFileSync(
      join(output, "result.json"),
      JSON.stringify(
        {
          passed: true,
          realModel: false,
          mode: "controlled fixture completion only",
          copy,
          initial: { passed: 1, failed: 6 },
          completed: { passed: 7, failed: 0 },
          browser: [
            "baseline renders",
            "units",
            "pagination",
            "filter",
            "query",
            "detail",
            "warehouse",
            "503",
            "loading",
            "empty",
            "failure recovery"
          ],
          protectedHashes: protectedBefore
        },
        null,
        2
      )
    )
    console.log(
      "PASS frontend API starter: baseline red, controlled completion green, real browser interactions (not model E2E)"
    )
  } finally {
    await browser?.close()
    await new Promise<void>((yes) => {
      server.close(() => yes())
      server.closeAllConnections()
    })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
