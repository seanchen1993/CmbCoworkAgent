/** Real React/Chromium + temporary SQLite + authenticated Bot RPC.
 * Only the outer workspace facade and a deliberately lost reply are controlled.
 * Does not launch or replace the user's running application/Host.
 */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { BotHost } from "../src/main/bots/host"
import { BotRpcServer } from "../src/main/bots/rpc"
import { BotTransportClient } from "../src/main/bots/transport-client"
import { BOT_PROTOCOL_VERSION } from "../src/shared/bot-types"

async function main() {
  const root = resolve("."),
    renderer = join(root, "src/renderer/src")
  const directory = await mkdtemp(join(tmpdir(), "cmb-hermes-core-ui-"))
  const output = join(root, "output/bot-hermes-core")
  await mkdir(output, { recursive: true })
  let now = Date.now()
  const store = new BotStore(join(directory, "bots.sqlite"), () => now)
  const owner = store.createBot({ nonce: "owner", name: "研发助手" })
  const skill = store.saveSkill({
    botId: owner.bot.id,
    name: "项目质量检查",
    instructions: "检查测试、构建和结果证据",
    enabled: true
  })
  const routine = store.saveRoutine({
    botId: owner.bot.id,
    name: "每日项目检查",
    prompt: "核对项目进展",
    enabled: true,
    timezone: "Asia/Shanghai",
    schedule: { kind: "interval", anchor: now + 60_000, everyMs: 60_000 }
  })
  now += 60_000
  store.dispatchDueRoutines()
  const run = store.claim("fixture")!
  store.finish(run.lease, "succeeded", "已检查项目")
  const host = new BotHost(store),
    token = randomBytes(32).toString("hex")
  const server = new BotRpcServer(host, token)
  let client: BotTransportClient | undefined,
    browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let http: ReturnType<typeof createServer> | undefined
  const cases: string[] = [],
    errors: string[] = []
  const calls: { method: string; input: unknown }[] = []
  let loseReply = false
  try {
    const socket =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cmb-hermes-${token.slice(0, 16)}`
        : join(directory, "s.sock")
    await server.listen(socket)
    client = new BotTransportClient({
      version: BOT_PROTOCOL_VERSION,
      hostId: host.id,
      pid: process.pid,
      socketPath: socket,
      token
    })
    const status = await client.call("status"),
      snapshot = store.snapshot()
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
        loader: "tsx",
        resolveDir: root,
        contents: `
import React from 'react';import{createRoot}from'react-dom/client';
import{BotSkillMaintenancePanel}from'./src/renderer/src/components/bots/BotSkillMaintenance';
import{BotRoutineDispatchLog}from'./src/renderer/src/components/bots/BotRoutineDispatchHistory';
import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';
window.api={bots:new Proxy({},{get:(_,method)=>input=>window.fixtureCall(method,input)})};
window.fixtureTheme=applyThemePreference;applyThemePreference('codex-dark');
createRoot(document.getElementById('root')).render(<main className='bot-workspace min-h-screen bg-background p-8 text-foreground'><section className='mx-auto max-w-xl space-y-5'><header><h1 className='text-lg font-semibold'>研发助手 · 技能</h1><p className='mt-1 text-xs text-muted-foreground'>管理经过验证的工作方法</p></header><BotSkillMaintenancePanel botId=${JSON.stringify(owner.bot.id)} reload={async()=>{}}/><BotRoutineDispatchLog botId=${JSON.stringify(owner.bot.id)} routineId=${JSON.stringify(routine.id)} timezone='Asia/Shanghai'/></section></main>);`
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      jsx: "automatic",
      outfile: join(directory, "ui.js"),
      alias: { "@": renderer },
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
      plugins: [
        {
          name: "outer-workspace-facade",
          setup(context) {
            context.onResolve({ filter: /bot-workspace-store$/ }, () => ({
              path: "workspace",
              namespace: "fixture"
            }))
            context.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              loader: "ts",
              resolveDir: root,
              contents: `import{create}from'zustand';export const useBotWorkspaceStore=create(()=>({snapshot:${JSON.stringify(snapshot)},host:${JSON.stringify(status)}}));window.fixtureWorkspace=useBotWorkspaceStore;`
            }))
          }
        }
      ]
    })
    const script = bundle.outputFiles.find((file) => file.path.endsWith(".js"))!
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${css.build(scanner.scan())}${await readFile(join(renderer, "components/bots/bot-workspace.css"), "utf8")}</style><body><div id="root"></div><script>${script.text}</script></body></html>`
    http = createServer((_, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.end(html)
    })
    await new Promise<void>((done) => http!.listen(0, "127.0.0.1", done))
    const address = http.address()
    assert(address && typeof address !== "string")
    browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true
    })
    const page = await browser.newPage({ viewport: { width: 920, height: 760 } })
    page.setDefaultTimeout(10_000)
    page.on("pageerror", (error) => errors.push(error.message))
    const invoke = client.call.bind(client) as (method: string, input?: unknown) => Promise<unknown>
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      calls.push({ method, input })
      const result = await invoke(method, input)
      if (loseReply && method === "changeSkillMaintenance") {
        loseReply = false
        throw new Error("Test: committed reply was lost")
      }
      return result
    })
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.getByRole("button", { name: /技能维护/ }).click()
    await page.getByRole("button", { name: "纳入维护", exact: true }).click()
    await page.getByRole("button", { name: "取消维护", exact: true }).waitFor()
    assert.equal(
      store.skillMaintenance.view({ botId: owner.bot.id, expectedDataEpoch: "initial" }).entries[0]
        .managed,
      true
    )
    cases.push("manage through authenticated RPC")
    await page.getByRole("button", { name: "固定保留 项目质量检查", exact: true }).click()
    await page.getByRole("button", { name: "取消固定 项目质量检查", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "归档", exact: true }).isDisabled(), true)
    await page.getByRole("button", { name: "取消固定 项目质量检查", exact: true }).click()
    await page.getByRole("button", { name: "固定保留 项目质量检查", exact: true }).waitFor()
    await page.getByRole("button", { name: "归档", exact: true }).click()
    await page.getByRole("button", { name: "恢复", exact: true }).waitFor()
    assert.equal(store.skills(owner.bot.id)[0].enabled, false)
    await page.getByRole("button", { name: "恢复", exact: true }).click()
    await page.getByRole("button", { name: "归档", exact: true }).waitFor()
    assert.equal(
      store.skillLibrary.current(owner.bot.id, skill.id).instructions,
      skill.instructions
    )
    cases.push("pin protection and reversible archive")
    await page.getByRole("checkbox").check()
    await page.waitForFunction(
      () => document.querySelector("input[type=checkbox]")?.getAttribute("disabled") === null
    )
    assert.equal(
      store.skillMaintenance.view({ botId: owner.bot.id, expectedDataEpoch: "initial" }).policy
        .enabled,
      true
    )
    await page.getByRole("button", { name: "立即检查", exact: true }).click()
    await page.getByRole("status").getByText("本次归档 0 项，检查完成", { exact: true }).waitFor()
    assert.equal(
      store.skillMaintenance.view({ botId: owner.bot.id, expectedDataEpoch: "initial" }).policy
        .lastRunAt,
      now
    )
    loseReply = true
    await page.getByRole("button", { name: "取消维护", exact: true }).click()
    await page.getByRole("button", { name: "核对原操作结果", exact: true }).waitFor()
    await page.getByRole("button", { name: "核对原操作结果", exact: true }).click()
    await page.getByRole("button", { name: "纳入维护", exact: true }).waitFor()
    const lost = calls.filter(
      (call) =>
        call.method === "changeSkillMaintenance" &&
        (call.input as { action: string }).action === "unmanage"
    )
    assert.equal(lost.length, 2)
    assert.deepEqual(lost[0].input, lost[1].input)
    assert.equal(
      Number(
        store.db.exec("SELECT COUNT(*) FROM bot_events WHERE kind='skill.unmanage'")[0].values[0][0]
      ),
      1
    )
    cases.push("lost acknowledgement retries the same receipt without duplicate mutation")
    for (const action of ["pin", "unpin"] as const) {
      const entry = store.skillMaintenance.view({
        botId: owner.bot.id,
        expectedDataEpoch: "initial"
      }).entries[0]
      store.skillMaintenance.change({
        botId: owner.bot.id,
        expectedDataEpoch: "initial",
        nonce: `other-window-${action}`,
        skillId: skill.id,
        version: entry.version,
        revision: entry.revision,
        action
      })
      await page.evaluate((snapshot) => {
        const fixture = window as unknown as {
          fixtureWorkspace: { setState(value: object): void }
        }
        fixture.fixtureWorkspace.setState({ snapshot })
      }, store.snapshot())
      await page
        .getByRole("button", {
          name: `${action === "pin" ? "取消固定" : "固定保留"} 项目质量检查`,
          exact: true
        })
        .waitFor()
    }
    cases.push("workspace events refresh open maintenance state without a new timer")
    await page.getByRole("button", { name: "查看调度记录", exact: true }).click()
    await page.getByText(/已触发 · 已完成/).waitFor()
    assert.equal(
      calls.some((call) => call.method === "routineDispatchHistory"),
      true
    )
    await page.screenshot({ path: join(output, "dark.png"), animations: "disabled" })
    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(value: string): void }).fixtureTheme("codex-light")
    )
    await page.screenshot({ path: join(output, "light.png"), animations: "disabled" })
    await page.setViewportSize({ width: 420, height: 850 })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false
    )
    await page.screenshot({ path: join(output, "narrow.png"), animations: "disabled" })
    cases.push("dispatch receipts, dark/light styling and narrow layout")
    const mutationCount = calls.filter((call) =>
      ["changeSkillMaintenance", "configureSkillMaintenance", "runSkillMaintenance"].includes(
        call.method
      )
    ).length
    await page.evaluate(() => {
      const fixture = window as unknown as {
        fixtureWorkspace: { getState(): { snapshot: object }; setState(value: object): void }
      }
      fixture.fixtureWorkspace.setState({
        snapshot: { ...fixture.fixtureWorkspace.getState().snapshot, dataEpoch: "replacement" }
      })
    })
    await page.getByRole("alert").first().waitFor()
    assert.equal(
      calls.filter((call) =>
        ["changeSkillMaintenance", "configureSkillMaintenance", "runSkillMaintenance"].includes(
          call.method
        )
      ).length,
      mutationCount
    )
    cases.push("replacement workspace retires old view without issuing mutations")
    assert.deepEqual(errors, [])
    await writeFile(
      join(output, "result.json"),
      JSON.stringify(
        {
          status: "PASS",
          cases,
          pageErrors: errors,
          scope:
            "Actual Chromium/React + SQLite + authenticated RPC; no packaged-app/native-platform claims"
        },
        null,
        2
      )
    )
    console.log(JSON.stringify({ status: "PASS", cases, output }))
  } finally {
    await browser?.close()
    if (http) {
      http.closeAllConnections()
      await new Promise<void>((done, reject) =>
        http!.close((error) => (error ? reject(error) : done()))
      )
    }
    client?.close()
    if (server.server.listening) await server.close()
    await host.stop()
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
