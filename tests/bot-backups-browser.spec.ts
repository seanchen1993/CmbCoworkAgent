/** Real backup UI and offline data service; disposable data only. */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { BotHost } from "../src/main/bots/host"
import { createBotAPI } from "../src/main/bots/rpc"
import { executeBotBackup, listBotBackups } from "../src/main/bots/backups"
import { botBackupRequest } from "../src/shared/bot-backup"
import { BotBackupScheduler } from "../src/main/bots/backup-scheduler"

async function main() {
  const directory = await mkdtemp(join(tmpdir(), "bot-backups-ui-"))
  const renderer = resolve("src/renderer/src"),
    output = resolve("output/bot-backups")
  await mkdir(output, { recursive: true })
  let store = new BotStore(join(directory, "bots.sqlite"))
  const owner = store.createBot({ nonce: "one", name: "备份内的助手" })
  const forgotten = store.saveMemory({ botId: owner.bot.id, text: "恢复后不得重新出现的记忆" })
  const hosts: BotHost[] = []
  const makeAPI = () => {
    const host = new BotHost(store)
    host.backups = new BotBackupScheduler(store.backupSchedule, directory, host.id)
    hosts.push(host)
    return createBotAPI(host)
  }
  let api = makeAPI(),
    maintenance = false,
    loseResponse = true,
    loseConfigResponse = true
  const requests: string[] = []
  const configRequests: string[] = []
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
      contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {BotBackups} from './src/renderer/src/components/bots/BotBackups';import {BotStorage} from './src/renderer/src/components/bots/BotStorage';import {Toaster} from 'sonner';import {applyThemePreference} from './src/renderer/src/lib/theme-preference';
    window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');window.api={bots:new Proxy({}, {get:(_,method)=>(input)=>window.botCall(method,input)}),botBackups:{list:()=>window.backupCall('list'),execute:input=>window.backupCall('execute',input),reveal:()=>{}}};
    const status={checkedAt:Date.now(),complete:true,level:'hard',volumes:[{name:'Bot 数据所在磁盘',totalBytes:100*1024**3,availableBytes:2*1024**3,level:'hard',sampledAt:Date.now()}]};
    function Fixture(){const [storage,setStorage]=useState(true);return <>{storage?<BotStorage status={status} close={()=>setStorage(false)} openBackups={()=>setStorage(false)}/>:<BotBackups close={()=>{}}/>}<Toaster/></>}
    createRoot(document.getElementById('root')).render(<Fixture/>);`,
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
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } }),
    errors: string[] = []
  page.setDefaultTimeout(10_000)
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.exposeFunction("botCall", async (method: keyof typeof api, input: unknown) => {
      if (maintenance || !Object.hasOwn(api, method)) throw new Error("维护中")
      const result = await (api[method] as (input: unknown) => Promise<unknown>)(input)
      if (method === "changeBackupSchedule") {
        configRequests.push((input as { nonce: string }).nonce)
        if (loseConfigResponse) {
          loseConfigResponse = false
          throw new Error("配置响应中断，请确认上次操作")
        }
      }
      return result
    })
    await page.exposeFunction("backupCall", async (method: string, input: unknown) => {
      if (method === "list") return listBotBackups(directory)
      const request = botBackupRequest.parse(input)
      maintenance = true
      await hosts.at(-1)!.backups!.close()
      store.close()
      try {
        const result = await executeBotBackup(directory, request)
        if (request.action === "create") {
          requests.push(request.nonce)
          if (loseResponse) {
            loseResponse = false
            throw new Error("响应中断，请重试备份")
          }
        }
        return result
      } finally {
        store = new BotStore(join(directory, "bots.sqlite"))
        api = makeAPI()
        maintenance = false
      }
    })
    await page.route("http://127.0.0.1:39175/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.build(scanner.scan())}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`
      })
    )
    await page.goto("http://127.0.0.1:39175")
    await page
      .getByRole("dialog", { name: "磁盘容量", exact: true })
      .getByText("可用 2.0 GiB / 共 100.0 GiB", { exact: true })
      .waitFor()
    await page.screenshot({
      path: join(output, "storage-cleanup-entry.png"),
      animations: "disabled"
    })
    assert.equal((await listBotBackups(directory)).length, 0)
    await page.getByRole("button", { name: "管理历史备份", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByText("还没有备份", { exact: true }).waitFor()
    const schedule = dialog.getByRole("region", { name: "定时备份", exact: true })
    await schedule.getByRole("switch", { name: "启用定时备份" }).click()
    await schedule.getByRole("spinbutton").fill("6")
    await schedule.getByRole("button", { name: "保存配置", exact: true }).click()
    await schedule.getByRole("alert").getByText("配置响应中断，请确认上次操作").waitFor()
    assert.equal(store.backupSchedule.read().revision, 1)
    await page.reload()
    await page.getByRole("button", { name: "管理历史备份", exact: true }).click()
    await schedule.getByRole("button", { name: "确认上次配置", exact: true }).click()
    await schedule.getByText("定时备份已启用", { exact: true }).waitFor()
    assert.equal(configRequests[0], configRequests[1])
    assert.equal(store.backupSchedule.read().revision, 1)
    assert.equal(store.backupSchedule.read().intervalHours, 6)
    await dialog.getByRole("button", { name: "创建备份", exact: true }).click()
    await dialog.getByRole("alert").getByText("响应中断，请重试备份").waitFor()
    await dialog.getByRole("button", { name: "重试备份", exact: true }).click()
    await dialog.getByText("1 份备份", { exact: true }).waitFor()
    assert.equal(requests[0], requests[1])
    assert.equal((await listBotBackups(directory)).length, 1)
    store.createBot({ nonce: "new", name: "备份后新增" })
    store.deleteMemory(owner.bot.id, forgotten.id, forgotten.revision)
    await dialog.getByRole("button", { name: "恢复", exact: true }).click()
    await dialog.getByRole("button", { name: "取消", exact: true }).click()
    assert.equal(store.snapshot().bots.length, 2)
    await dialog.getByRole("button", { name: "恢复", exact: true }).click()
    await dialog.getByText("已删除的资料和已撤回的共享技能不会恢复", { exact: false }).waitFor()
    assert.equal(await page.evaluate(() => document.characterSet), "UTF-8")
    assert.ok(
      await dialog.evaluate(
        (element) => Number.parseFloat(getComputedStyle(element).borderRadius) > 0
      )
    )
    await page.screenshot({ path: join(output, "restore-confirmation.png") })
    await dialog.getByRole("button", { name: "确认恢复", exact: true }).click()
    await dialog.getByText("2 份备份", { exact: true }).waitFor()
    assert.equal(store.backupSchedule.read().enabled, false)
    assert.deepEqual(store.memories(owner.bot.id), [])
    await schedule.getByRole("switch", { name: "启用定时备份" }).waitFor()
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="启用定时备份"]')?.getAttribute("aria-checked") ===
        "false"
    )
    assert.deepEqual(
      store.snapshot().bots.map((bot) => bot.name),
      ["备份内的助手"]
    )
    await dialog.getByText("恢复前自动保存", { exact: false }).waitFor()
    await page.evaluate("window.fixtureTheme('codex-dark')")
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[role="dialog"]')
      if (!dialog) return false
      const background = getComputedStyle(dialog).backgroundColor.match(/\d+/g)?.map(Number)
      return !!background && background.slice(0, 3).every((value) => value < 60)
    })
    await page.screenshot({ path: join(output, "backups-dark.png"), animations: "disabled" })
    await page.setViewportSize({ width: 700, height: 800 })
    assert.ok(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
    await page.screenshot({ path: join(output, "backups-narrow.png"), animations: "disabled" })
    await dialog.getByRole("button", { name: "删除此备份", exact: true }).first().click()
    await dialog.getByRole("button", { name: "确认删除", exact: true }).click()
    await dialog.getByText("1 份备份", { exact: true }).waitFor()
    assert.equal(store.snapshot().bots.length, 1)
    assert.deepEqual(errors, [])
    await writeFile(
      join(output, "results.json"),
      JSON.stringify(
        {
          passed: [
            "lost-response-idempotence",
            "schedule-lost-response-reload",
            "schedule-disabled-after-restore",
            "disk-pressure-review-entry-no-deletion",
            "restore-cancel",
            "restore-real-data",
            "pre-restore-snapshot",
            "delete-confirmation",
            "dark-theme"
          ],
          errors
        },
        null,
        2
      )
    )
    console.log("PASS: Bot backups UI and real offline service")
  } catch (error) {
    console.error(await page.locator("body").innerText())
    await page.screenshot({ path: join(output, "failure.png") })
    throw error
  } finally {
    await browser.close()
    for (const host of hosts) await host.backups!.close()
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
