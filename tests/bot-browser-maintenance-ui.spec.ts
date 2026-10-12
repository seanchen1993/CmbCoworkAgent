/** Real React surface and offline profile owner; isolated fixture data only. */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import {
  executeBotBrowserMaintenance,
  listBotBrowserCheckpoints
} from "../src/main/bots/browser-maintenance"
import { botBrowserMaintenanceRequest } from "../src/shared/bot-browser-maintenance"

async function main() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-browser-maintenance-ui-")))
  const profile = join(root, "browser-profile/Default"),
    output = resolve("output/bot-browser-maintenance")
  await Promise.all([mkdir(profile, { recursive: true }), mkdir(output, { recursive: true })])
  await writeFile(join(profile, "Preferences"), "before")
  const renderer = resolve("src/renderer/src")
  const css = await compile(
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
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {BotBrowserMaintenance} from './src/renderer/src/components/bots/BotBrowserMaintenance';import {applyThemePreference} from './src/renderer/src/lib/theme-preference';import {useBotWorkspaceStore} from './src/renderer/src/lib/bot-workspace-store';
      applyThemePreference('codex-light');window.fixtureTheme=applyThemePreference;
      window.api={botBrowserMaintenance:{list:()=>window.maintenanceCall('list'),execute:input=>window.maintenanceCall('execute',input)}};
      window.fixtureRefreshes=0;
      useBotWorkspaceStore.setState({refresh:async()=>{window.fixtureRefreshes++;throw new Error('Host reconnecting after maintenance')}});
      createRoot(document.getElementById('root')).render(<BotBrowserMaintenance close={()=>{}}/>);`,
      resolveDir: process.cwd(),
      loader: "tsx"
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const page = await browser.newPage({ viewport: { width: 1150, height: 900 } }),
    errors: string[] = []
  page.setDefaultTimeout(10_000)
  page.on("pageerror", (error) => errors.push(error.message))
  let loseResponse = true,
    rejectCreate = true
  const blockedMessage = "有命令尚未确认停止，请核对任务和现场记录。"
  const createNonces: string[] = [],
    nonces: string[] = []
  try {
    await page.exposeFunction("maintenanceCall", async (method: string, input: unknown) => {
      if (method === "list") return listBotBrowserCheckpoints(root)
      const request = botBrowserMaintenanceRequest.parse(input)
      if (request.action === "create") {
        createNonces.push(request.nonce)
        if (rejectCreate) {
          rejectCreate = false
          return { botFailure: { code: "runtime_failed", message: blockedMessage } }
        }
      }
      const result = await executeBotBrowserMaintenance(root, request)
      if (request.action === "restore") {
        nonces.push(request.nonce)
        if (loseResponse) {
          loseResponse = false
          throw new Error("恢复响应中断，请核对上次操作")
        }
      }
      return result
    })
    await page.route("http://127.0.0.1:39178/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<html><head><style>${css.build(scanner.scan())}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`
      })
    )
    await page.goto("http://127.0.0.1:39178")
    await page.getByText("还没有浏览器恢复点", { exact: true }).waitFor()
    await page.getByRole("button", { name: "保存恢复点", exact: true }).click()
    await page.getByRole("button", { name: "确认", exact: true }).click()
    const blockedAlert = page.getByRole("alert").filter({ hasText: blockedMessage })
    await blockedAlert.waitFor()
    assert.equal(
      (await blockedAlert.textContent())!.includes("Error invoking remote method"),
      false
    )
    assert.equal(await page.evaluate("window.fixtureRefreshes"), 0)
    assert.equal(await readFile(join(profile, "Preferences"), "utf8"), "before")
    assert.equal((await listBotBrowserCheckpoints(root)).length, 0)
    const pending = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("cmb:bot-browser-maintenance:pending")!)
    )
    assert.equal(pending.action, "create")
    assert.equal(pending.nonce, createNonces[0])
    await page.getByRole("button", { name: "核对上次操作", exact: true }).click()
    await page.getByText("1 / 20 份恢复点", { exact: true }).waitFor()
    assert.equal(createNonces.length, 2)
    assert.equal(createNonces[0], createNonces[1])
    await page.waitForFunction("window.fixtureRefreshes === 1")
    assert.equal(await page.getByRole("region", { name: "确认浏览器维护", exact: true }).count(), 0)
    assert.equal(
      await page.evaluate(() =>
        Object.keys(localStorage).some((key) => key.includes("browser-maintenance"))
      ),
      false
    )
    await writeFile(join(profile, "Preferences"), "after")
    const checkpoint = (await listBotBrowserCheckpoints(root))[0]
    await page
      .getByTestId(`browser-checkpoint-${checkpoint.id}`)
      .getByRole("button", { name: "恢复", exact: true })
      .click()
    await page.screenshot({ path: join(output, "restore-light.png"), animations: "disabled" })
    await page.evaluate("window.fixtureTheme('codex-dark')")
    await page.screenshot({ path: join(output, "restore-dark.png"), animations: "disabled" })
    await page.getByRole("button", { name: "确认", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "恢复响应中断，请核对上次操作" }).waitFor()
    assert.equal(await readFile(join(profile, "Preferences"), "utf8"), "before")
    await writeFile(join(profile, "Preferences"), "later-user-change")
    await page.reload()
    await page.getByRole("button", { name: "核对上次操作", exact: true }).click()
    await page
      .getByRole("region", { name: "确认浏览器维护", exact: true })
      .waitFor({ state: "hidden" })
    assert.equal(nonces.length, 2)
    assert.equal(nonces[0], nonces[1])
    assert.equal(await readFile(join(profile, "Preferences"), "utf8"), "later-user-change")
    assert.equal((await listBotBrowserCheckpoints(root)).length, 2)
    await page.getByRole("button", { name: "重置浏览器", exact: true }).click()
    await page.getByRole("button", { name: "取消", exact: true }).click()
    assert.equal(await readFile(join(profile, "Preferences"), "utf8"), "later-user-change")
    await page.getByRole("button", { name: "重置浏览器", exact: true }).click()
    await page.getByRole("button", { name: "确认", exact: true }).click()
    await page.getByText("3 / 20 份恢复点", { exact: true }).waitFor()
    await assert.rejects(readFile(join(profile, "Preferences")), { code: "ENOENT" })
    await page
      .getByTestId(`browser-checkpoint-${checkpoint.id}`)
      .getByRole("button", { name: "删除恢复点", exact: true })
      .click()
    await page.getByRole("button", { name: "确认", exact: true }).click()
    await page.getByTestId(`browser-checkpoint-${checkpoint.id}`).waitFor({ state: "hidden" })
    assert.equal((await listBotBrowserCheckpoints(root)).length, 2)
    assert.deepEqual(errors, [])
    console.log(
      "PASS profile checkpoint create/restore/reset/delete, lost response reconciliation, refresh failure after commit, cancellation, light/dark UI"
    )
  } finally {
    await browser.close()
    await rm(root, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
