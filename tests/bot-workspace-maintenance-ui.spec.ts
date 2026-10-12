/** Real React surface and offline work-file owner; isolated fixture data only. */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import {
  executeBotWorkspaceMaintenance,
  listBotWorkspaceCheckpoints
} from "../src/main/bots/workspace-maintenance"
import { BotSharedWorkspace } from "../src/main/bots/shared-workspace"
import { botWorkspaceMaintenanceRequest } from "../src/shared/bot-workspace-maintenance"

async function main() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-workspace-maintenance-ui-")))
  const workspace = await BotSharedWorkspace.open(root)
  const profile = workspace.path,
    output = resolve("output/bot-workspace-maintenance")
  await Promise.all([mkdir(profile, { recursive: true }), mkdir(output, { recursive: true })])
  await writeFile(join(profile, "notes.md"), "before")
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
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {BotWorkspaceMaintenance} from './src/renderer/src/components/bots/BotWorkspaceMaintenance';import {applyThemePreference} from './src/renderer/src/lib/theme-preference';import {useBotWorkspaceStore} from './src/renderer/src/lib/bot-workspace-store';
      applyThemePreference('codex-light');window.fixtureTheme=applyThemePreference;
      window.api={botWorkspaceMaintenance:{list:()=>window.maintenanceCall('list'),execute:input=>window.maintenanceCall('execute',input),revealRecovery:()=>window.maintenanceCall('reveal')}};
      window.fixtureRefreshes=0;
      useBotWorkspaceStore.setState({refresh:async()=>{window.fixtureRefreshes++;throw new Error('Host reconnecting after maintenance')}});
      createRoot(document.getElementById('root')).render(<BotWorkspaceMaintenance close={()=>{}}/>);`,
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
  let loseResponse = true
  const nonces: string[] = []
  try {
    await page.exposeFunction("maintenanceCall", async (method: string, input: unknown) => {
      if (method === "list") return listBotWorkspaceCheckpoints(root)
      if (method === "reveal") return undefined
      const request = botWorkspaceMaintenanceRequest.parse(input)
      const result = await executeBotWorkspaceMaintenance(root, request)
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
    await page.getByText("还没有共享工作文件恢复点", { exact: true }).waitFor()
    await page.getByRole("button", { name: "保存恢复点", exact: true }).click()
    await page.getByRole("button", { name: "确认", exact: true }).click()
    await page.getByText("1 / 20 份恢复点", { exact: true }).waitFor()
    await page.getByRole("button", { name: "查看保留的原文件" }).click()
    await page.waitForFunction("window.fixtureRefreshes === 1")
    assert.equal(
      await page.getByRole("region", { name: "确认共享工作文件维护", exact: true }).count(),
      0
    )
    assert.equal(
      await page.evaluate(() =>
        Object.keys(localStorage).some((key) => key.includes("workspace-maintenance"))
      ),
      false
    )
    await writeFile(join(profile, "notes.md"), "after")
    const checkpoint = (await listBotWorkspaceCheckpoints(root))[0]
    await page
      .getByTestId(`workspace-checkpoint-${checkpoint.id}`)
      .getByRole("button", { name: "恢复", exact: true })
      .click()
    await page.screenshot({ path: join(output, "restore-light.png"), animations: "disabled" })
    await page.evaluate("window.fixtureTheme('codex-dark')")
    await page.screenshot({ path: join(output, "restore-dark.png"), animations: "disabled" })
    await page.setViewportSize({ width: 420, height: 800 })
    await page.screenshot({ path: join(output, "restore-narrow.png"), animations: "disabled" })
    await page.setViewportSize({ width: 1150, height: 900 })
    await page.getByRole("button", { name: "确认", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "恢复响应中断，请核对上次操作" }).waitFor()
    assert.equal(await readFile(join(profile, "notes.md"), "utf8"), "before")
    await writeFile(join(profile, "notes.md"), "later-user-change")
    await page.reload()
    await page.getByRole("button", { name: "核对上次操作", exact: true }).click()
    await page
      .getByRole("region", { name: "确认共享工作文件维护", exact: true })
      .waitFor({ state: "hidden" })
    assert.equal(nonces.length, 2)
    assert.equal(nonces[0], nonces[1])
    assert.equal(await readFile(join(profile, "notes.md"), "utf8"), "later-user-change")
    assert.equal((await listBotWorkspaceCheckpoints(root)).length, 2)
    await page.getByRole("button", { name: "重置共享工作文件", exact: true }).click()
    await page.getByRole("button", { name: "取消", exact: true }).click()
    assert.equal(await readFile(join(profile, "notes.md"), "utf8"), "later-user-change")
    await page.getByRole("button", { name: "重置共享工作文件", exact: true }).click()
    await page.getByRole("button", { name: "确认", exact: true }).click()
    await page.getByText("3 / 20 份恢复点", { exact: true }).waitFor()
    await assert.rejects(readFile(join(profile, "notes.md")), { code: "ENOENT" })
    await page
      .getByTestId(`workspace-checkpoint-${checkpoint.id}`)
      .getByRole("button", { name: "删除恢复点", exact: true })
      .click()
    await page.getByRole("button", { name: "确认", exact: true }).click()
    await page.getByTestId(`workspace-checkpoint-${checkpoint.id}`).waitFor({ state: "hidden" })
    assert.equal((await listBotWorkspaceCheckpoints(root)).length, 2)
    assert.deepEqual(errors, [])
    console.log(
      "PASS workspace checkpoint create/restore/reset/delete, lost response reconciliation, refresh failure after commit, cancellation, light/dark UI"
    )
  } finally {
    await browser.close()
    await rm(root, { recursive: true, force: true })
    await rm(`${root}.workspace`, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
