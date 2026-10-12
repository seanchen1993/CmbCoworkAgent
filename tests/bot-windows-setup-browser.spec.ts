/** Actual React/Chrome/settings card and persisted exact nonce. Main privilege
 * effects are a controlled narrow transport; Windows kernel acceptance lives
 * in windows-native-kernel.test.ts and is never implied by this fixture. */
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import type { BotWindowsNativeSetupStatus } from "../src/shared/bot-windows-native-setup"
async function main() {
  const root = resolve(import.meta.dirname, ".."),
    renderer = join(root, "src/renderer/src"),
    output = join(root, "output/bot-windows-setup")
  await mkdir(output, { recursive: true })
  const stylesheet = await compile(
    (await readFile(join(renderer, "index.css"), "utf8")).replace(
      /^@import "@fontsource[^\n]+\n/gm,
      ""
    ),
    { base: renderer, onDependency: () => {} }
  )
  const scanner = new Scanner({
    sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
  })
  const bundle = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotWindowsSandboxSetup}from'./src/renderer/src/components/customize/BotWindowsSandboxSetup';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';window.api={botWindowsSandbox:{status:()=>window.fixtureStatus(),initialize:input=>window.fixtureSetup(input)},botShellResources:{revealDiagnostics:()=>window.fixtureReveal()}};window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');function Fixture(){const[visible,setVisible]=useState(true);window.fixtureVisible=setVisible;return visible?<main style={{padding:24}}><BotWindowsSandboxSetup/></main>:null};createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    outfile: join(output, "fixture.js"),
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }
  })
  const scope = "a".repeat(64),
    pendingKey = "cmbdevclaw.windows-native-setup.pending.v1"
  let state: BotWindowsNativeSetupStatus = {
      state: "setup_available",
      scope,
      message: "需要一次管理员初始化。"
    },
    outcome: "lost" | "unknown" | "completed" | "rejected" = "lost",
    failRead = false,
    reads = 0,
    reveals = 0
  const calls: Array<{ nonce: string; scope: string }> = [],
    checks: string[] = [],
    errors: string[] = []
  const browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true
    }),
    page = await browser.newPage({ viewport: { width: 960, height: 760 } })
  page.setDefaultTimeout(10000)
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.exposeFunction("fixtureStatus", async () => {
      reads++
      if (failRead) {
        failRead = false
        return { botFailure: { code: "transport_error", message: "controlled read failure" } }
      }
      return state
    })
    await page.exposeFunction("fixtureSetup", async (input: { nonce: string; scope: string }) => {
      calls.push(input)
      if (outcome === "lost")
        return { botFailure: { code: "transport_error", message: "controlled lost ACK" } }
      if (outcome === "unknown")
        return {
          nonce: input.nonce,
          success: false,
          definitive: false,
          status: { state: "requires_review", scope, message: "本次初始化待核对。" }
        }
      if (outcome === "rejected")
        return {
          nonce: input.nonce,
          success: false,
          definitive: true,
          status: { state: "unavailable", scope, message: "本次请求未开始初始化。" }
        }
      state = { state: "initialized", scope, message: "管理员初始化已完成。" }
      return { nonce: input.nonce, success: true, definitive: true, status: state }
    })
    await page.exposeFunction("fixtureReveal", async () => {
      reveals++
    })
    await page.route("http://127.0.0.1:43137/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset='utf-8'><style>${stylesheet.build(scanner.scan())}${bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? ""}</style><div id='root'></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text}</script>`
      })
    )
    await page.goto("http://127.0.0.1:43137/")
    await page.getByRole("button", { name: "管理员初始化", exact: true }).waitFor()
    await page.waitForFunction(
      () => !document.querySelector("section button")?.hasAttribute("disabled")
    )
    assert.equal(reads, 1)
    assert.equal(calls.length, 0)
    checks.push("Settings reads once and never elevates automatically")
    await page.getByRole("button", { name: "管理员初始化", exact: true }).click()
    await page.getByRole("button", { name: "核对本次初始化", exact: true }).waitFor()
    assert.equal(calls.length, 1)
    const first = JSON.parse(
      (await page.evaluate((key) => localStorage.getItem(key), pendingKey)) || "null"
    )
    assert.deepEqual(first, calls[0])
    checks.push(
      "Lost ACK persists exact nonce before the request and does not start a fresh operation"
    )
    await page.evaluate(() => Reflect.get(window, "fixtureVisible")(false))
    await page
      .getByRole("heading", { name: "Bot 命令隔离环境", exact: true })
      .waitFor({ state: "detached" })
    await page.evaluate(() => Reflect.get(window, "fixtureVisible")(true))
    await page.getByRole("button", { name: "核对本次初始化", exact: true }).waitFor()
    outcome = "unknown"
    await page.waitForFunction(
      () => !document.querySelector("section button")?.hasAttribute("disabled")
    )
    await page.getByRole("button", { name: "核对本次初始化", exact: true }).click()
    await page.getByText("本次初始化待核对。", { exact: true }).waitFor()
    assert.deepEqual(calls[1], first)
    await page.getByRole("button", { name: "查看命令现场", exact: true }).click()
    assert.equal(reveals, 1)
    checks.push(
      "Close/reopen retries the original request and offers reachable read-only diagnostics"
    )
    outcome = "completed"
    await page.getByRole("button", { name: "核对本次初始化", exact: true }).click()
    await page.getByText("管理员初始化已完成。", { exact: true }).waitFor()
    assert.deepEqual(calls[2], first)
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), pendingKey), null)
    assert.equal(await page.getByRole("button", { name: "管理员初始化", exact: true }).count(), 0)
    checks.push(
      "Matching known completion clears pending identity and refreshes current setup state"
    )
    failRead = true
    await page.getByRole("button", { name: "重新检查", exact: true }).click()
    await page.getByText("controlled read failure", { exact: true }).waitFor()
    assert.equal(await page.getByText("已初始化", { exact: true }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "管理员初始化", exact: true }).count(), 0)
    checks.push("Failed status refresh removes stale initialization readiness")
    state = { state: "setup_available", scope, message: "需要一次管理员初始化。" }
    await page.evaluate((key) => {
      Reflect.get(window, "fixtureVisible")(false)
      localStorage.setItem(key, "invalid record")
    }, pendingKey)
    await page
      .getByRole("heading", { name: "Bot 命令隔离环境", exact: true })
      .waitFor({ state: "detached" })
    await page.evaluate(() => Reflect.get(window, "fixtureVisible")(true))
    await page.getByRole("button", { name: "清除损坏记录", exact: true }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "管理员初始化", exact: true }).isDisabled(),
      true
    )
    await page.getByRole("button", { name: "清除损坏记录", exact: true }).click()
    await page.waitForFunction(
      () => !document.querySelector("section button")?.hasAttribute("disabled")
    )
    assert.equal(calls.length, 3)
    outcome = "rejected"
    await page.getByRole("button", { name: "管理员初始化", exact: true }).click()
    await page.waitForFunction((key) => localStorage.getItem(key) === null, pendingKey)
    assert.notEqual(calls[3].nonce, first.nonce)
    checks.push(
      "Corrupt bytes require explicit discard and typed no-effect rejection clears only its new request"
    )
    // Pending is removed before the explicit current-status refresh settles.
    // Observe that refresh before checking there is no background poller.
    await page.getByRole("button", { name: "管理员初始化", exact: true }).waitFor()
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLButtonElement>("section button")].some(
        (button) => button.textContent?.trim() === "管理员初始化" && !button.disabled
      )
    )
    const idleReads = reads
    await page.waitForTimeout(300)
    assert.equal(reads, idleReads)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(output, "settings-light.png") })
    await page.evaluate(() => Reflect.get(window, "fixtureTheme")("codex-dark"))
    await page.screenshot({ path: join(output, "settings-dark.png") })
    const colors = await page
      .getByRole("button", { name: "重新检查", exact: true })
      .evaluate((button) => ({
        text: getComputedStyle(button).color,
        background: getComputedStyle(button.closest("section")!).backgroundColor,
        body: getComputedStyle(document.body).color,
        foreground: getComputedStyle(document.querySelector("section h2")!).color
      }))
    console.log(JSON.stringify({ darkButtonColors: colors }))
    assert.equal(colors.text, colors.foreground, "dark secondary action uses readable foreground")
    await writeFile(
      join(output, "results.json"),
      JSON.stringify(
        {
          checks,
          scope:
            "actual React/Chrome and narrow controlled setup transport; no Windows kernel claim",
          reads,
          setupRequests: calls.length
        },
        null,
        2
      ) + "\n"
    )
    console.log(`Windows setup settings browser checks passed: ${checks.length}`)
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
