/** Actual WelcomeSkills, market API/parser and loopback HTTP; only native IPC is a fixture. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output", `welcome-market-recovery-${randomUUID()}`)
  mkdirSync(output, { recursive: true })
  const requests: Array<{ scenario: string; path: string; mode: string }> = []
  const modes = new Map<string, string>()
  const held: ServerResponse[] = []
  const featured = {
    name: "uninstalled-featured",
    version: "1.0.0",
    featured: "精品",
    chinese_name: "尚未安装的远端精品",
    category: "通用场景",
    description: "Read-only retry fixture"
  }
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://127.0.0.1").pathname
    const scenario = path.split("/")[1]
    const mode = modes.get(scenario) ?? "bad"
    requests.push({ scenario, path, mode })
    if (path.endsWith("/list/skill")) {
      if (mode === "hold") {
        held.push(response)
        return
      }
      if (mode === "good" || mode === "initial" || mode === "empty") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ items: mode === "empty" ? [] : [featured] }))
      } else if (scenario === "shape" || scenario === "item") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify(
            scenario === "shape"
              ? { items: null }
              : { items: [{ name: { value: "PRIVATE_MARKET_BODY" } }] }
          )
        )
      } else {
        response.writeHead(200, {
          "content-type": scenario === "mime" ? "application/json" : "text/html"
        })
        response.end("<!doctype html><html>PRIVATE_MARKET_BODY</html>")
      }
    } else if (path.includes("/download/")) {
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="fixture.zip"',
        "content-length": "4"
      })
      response.end(Buffer.from([1, 2, 3, 4]))
    } else if (path === "/") {
      response.writeHead(200, { "content-type": "text/html" })
      response.end('<html><body><div id="root"></div></body></html>')
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address === "object")
  const base = `http://127.0.0.1:${address.port}`
  const bundled = await build({
    entryPoints: ["tests/support/welcome-skills-market-fixture.tsx"],
    write: false,
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: {
      "process.env.NODE_ENV": '"test"',
      "import.meta.env.VITE_API_BASE_URL": "window.welcomeMarketBase",
      "import.meta.env.VITE_SKILL_API_URL": '""',
      "import.meta.env.DEV": "false",
      "import.meta.env": "{}"
    }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(!existsSync(chromium.executablePath()) && process.platform === "win32"
      ? { channel: "msedge" }
      : {})
  })
  const results: unknown[] = []
  try {
    for (const scenario of ["html", "mime", "shape", "item", "initial", "cancel"]) {
      modes.set(scenario, scenario === "initial" ? "initial" : "bad")
      const page = await browser.newPage()
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      try {
        await page.goto(base)
        await page.evaluate(
          (value) => Object.assign(window, { welcomeMarketBase: value }),
          `${base}/${scenario}`
        )
        await page.addScriptTag({ content: bundled.outputFiles[0].text })
        if (scenario === "initial") {
          await page.waitForFunction("window.welcomeMarketFixture.installed===1")
          assert.equal(await page.evaluate("window.welcomeMarketFixture.uploads"), 1)
          assert.equal(
            requests.filter(
              (item) => item.scenario === scenario && item.path.includes("/download/")
            ).length,
            1
          )
        } else {
          await page.getByRole("status").filter({ hasText: "应用市场推荐暂时无法加载" }).waitFor()
          const local = page.getByRole("button", { name: /定时任务管理/ }).first()
          await local.click()
          assert.equal(
            await page.getByRole("textbox", { name: "聊天草稿" }).inputValue(),
            "尚未发送的草稿\n/skill scheduler-assistant"
          )
          modes.set(scenario, scenario === "cancel" ? "hold" : "good")
          await page.getByRole("button", { name: "重新加载推荐", exact: true }).click()
          if (scenario === "cancel") {
            const deadline = Date.now() + 5000
            while (held.length === 0) {
              assert(Date.now() < deadline, "Retry must reach the real HTTP server")
              await new Promise((done) => setTimeout(done, 20))
            }
            await page.getByRole("button", { name: "隐藏推荐", exact: true }).click()
            for (const response of held.splice(0))
              response.end(JSON.stringify({ items: [featured] }))
            modes.set(scenario, "empty")
            const before = requests.filter(
              (item) => item.scenario === scenario && item.path.endsWith("/list/skill")
            ).length
            await page.getByRole("button", { name: "显示推荐", exact: true }).click()
            const remountDeadline = Date.now() + 5000
            while (
              requests.filter(
                (item) => item.scenario === scenario && item.path.endsWith("/list/skill")
              ).length <= before
            ) {
              assert(
                Date.now() < remountDeadline,
                "An aborted response must not become a success cache"
              )
              await new Promise((done) => setTimeout(done, 20))
            }
          } else
            await page
              .getByRole("button", { name: "重新加载推荐", exact: true })
              .waitFor({ state: "detached" })
          await page.waitForLoadState("networkidle")
          assert.equal(
            requests.filter(
              (item) => item.scenario === scenario && item.path.includes("/download/")
            ).length,
            0,
            "Manual retry showing an uninstalled featured item must not download it"
          )
          assert.equal(await page.evaluate("window.welcomeMarketFixture.uploads"), 0)
          assert.equal(await page.evaluate("window.welcomeMarketFixture.deletes"), 0)
          assert.equal(await page.evaluate("window.welcomeMarketFixture.sends"), 0)
          assert.equal(
            await page.getByRole("textbox", { name: "聊天草稿" }).inputValue(),
            "尚未发送的草稿\n/skill scheduler-assistant"
          )
        }
        assert(
          !/PRIVATE_MARKET_BODY|Response is not JSON|Unexpected token/.test(
            await page.locator("body").innerText()
          )
        )
        assert.deepEqual(errors, [])
        await page.screenshot({ path: resolve(output, `${scenario}.png`), fullPage: true })
        results.push({ scenario, passed: true, errors })
      } catch (error) {
        await page.screenshot({ path: resolve(output, `${scenario}-failure.png`), fullPage: true })
        throw error
      } finally {
        await page.close()
      }
    }
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          passed: true,
          scope:
            "Actual WelcomeSkills and real HTTP/parser. Native identity/upload are fixtures; no project run or model request.",
          results,
          requests
        },
        null,
        2
      )
    )
    console.log(`PASS welcome market recovery ${results.length} scenarios; ${output}`)
  } finally {
    await browser.close()
    for (const response of held) response.destroy()
    await new Promise<void>((done) => server.close(() => done()))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
