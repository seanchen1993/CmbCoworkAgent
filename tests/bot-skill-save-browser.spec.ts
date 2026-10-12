/** Real React/Chrome + durable SQLite, with the actual renderer contextBridge failure shape.
 * It does not claim an Electron IPC or model acceptance test. */
import assert from "node:assert/strict"
import { mkdir, readFile, mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:http"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import type { BotSnapshot } from "../src/shared/bot-types"
import type { BotSaveSkillInput } from "../src/shared/bot-skill-save"

interface SkillFixtureWindow extends Window {
  fixtureQuota: boolean
  fixtureClearFail: boolean
  fixtureReloadFail: boolean
  fixtureReload(): Promise<void>
  fixtureReloadCalls: number
  fixtureSaveSettlements: number
  fixtureSelect(id: string): void
  fixtureTheme(theme: string): void
  fixtureWorkspace: {
    getState(): { snapshot: BotSnapshot }
    setState(value: { snapshot: BotSnapshot }): void
  }
}

async function main() {
  const started = new Date().toISOString(),
    directory = await mkdtemp(join(tmpdir(), "cmb-skill-ui-"))
  const store = new BotStore(join(directory, "bots.sqlite"))
  const owner = store.createBot({ nonce: "ui-owner", name: "需求 Bot" }).bot
  const quality = store.createBot({
    nonce: "ui-quality",
    name: "质量 Bot"
  }).bot
  const snapshot = store.snapshot(),
    renderer = resolve("src/renderer/src"),
    output = resolve("output/bot-skill-save")
  await mkdir(output, { recursive: true })
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
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotSkillCreateForm}from'./src/renderer/src/components/bots/BotSkillCreateForm';import{BotSkillCard}from'./src/renderer/src/components/bots/BotSkillCard';import{BotSkillSaveRecovery}from'./src/renderer/src/components/bots/BotSkillSaveRecovery';import{useBotWorkspaceStore}from'@/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';applyThemePreference('codex-light');window.fixtureTheme=applyThemePreference;window.fixtureSaveSettlements=0;window.api={bots:{saveSkill:async input=>{try{return await window.fixtureSaveSkill(input)}finally{window.fixtureSaveSettlements++}}}};window.fixtureQuota=false;window.fixtureClearFail=false;window.fixtureReloadFail=false;window.fixtureReloadCalls=0;const set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;Storage.prototype.setItem=function(key,value){if(window.fixtureQuota&&key.startsWith('bot-skill-save-pending:'))throw new Error('quota');return set.call(this,key,value)};Storage.prototype.removeItem=function(key){if(window.fixtureClearFail&&key.startsWith('bot-skill-save-pending:'))throw new Error('cleanup');return remove.call(this,key)};Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.fixtureCopied=text}}});
    function Fixture(){const[visible,show]=useState(true);const[botId,setBotId]=useState('${owner.id}');const[skills,setSkills]=useState([]);const epoch=useBotWorkspaceStore(state=>state.snapshot.dataEpoch);window.fixtureSkills=setSkills;window.fixtureSelect=id=>{setSkills([]);setBotId(id)};window.fixtureVisible=show;const reload=async()=>{window.fixtureReloadCalls++;if(window.fixtureReloadFail)throw new Error('refresh');setSkills(await window.fixtureReadSkills(botId))};window.fixtureReload=reload;return <main className="min-h-screen bg-background p-6 text-foreground"><div className="mx-auto max-w-xl space-y-4"><h1 className="text-lg font-medium">{botId==='${owner.id}'?'需求 Bot':'质量 Bot'} · 技能</h1><button onClick={()=>show(!visible)}>关闭/打开技能面板</button>{visible&&<section key={botId} data-bot-id={botId} className="space-y-4"><BotSkillSaveRecovery botId={botId} activeSkillIds={skills.map(item=>item.id)} reload={reload}/>{skills.map(skill=><BotSkillCard key={skill.id} skill={skill} trials={[]} reload={reload}/>)}<BotSkillCreateForm botId={botId} reload={reload}/></section>}</div></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
      resolveDir: process.cwd(),
      loader: "tsx"
    },
    plugins: [
      {
        name: "skill-scope-fixture",
        setup(context) {
          context.onResolve({ filter: /bot-workspace-store$/ }, () => ({
            path: "fixture-workspace",
            namespace: "fixture"
          }))
          context.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "ts",
            resolveDir: process.cwd(),
            contents: `import{create}from'zustand';export const useBotWorkspaceStore=create(()=>({snapshot:${JSON.stringify(snapshot)},host:{capabilities:['skill-save-receipts','mutation-data-epoch-v2']}}));window.fixtureWorkspace=useBotWorkspaceStore;`
          }))
        }
      }
    ],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css.build(scanner.scan())}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    response.end(html)
  })
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("missing server address")
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const page = await browser.newPage({
    viewport: { width: 1000, height: 980 }
  })
  page.setDefaultTimeout(10_000)
  const errors: string[] = [],
    calls: BotSaveSkillInput[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  let loseReply = false,
    mismatchReply = false,
    holdReply: (() => void) | null = null,
    holdNext = false,
    holdReadNext = false,
    holdReadReply: (() => void) | null = null
  try {
    await page.exposeFunction("fixtureReadSkills", async (botId: string) => {
      const skills = store.skills(botId)
      if (holdReadNext) {
        holdReadNext = false
        await new Promise<void>((release) => {
          holdReadReply = release
        })
      }
      return skills
    })
    await page.exposeFunction("fixtureSaveSkill", async (input: BotSaveSkillInput) => {
      calls.push(input)
      let response: unknown
      try {
        const saved = store.saveSkill(input)
        if (loseReply) {
          loseReply = false
          response = {
            botFailure: { code: "connection_closed", message: "回执未收到" }
          }
        } else if (mismatchReply) {
          mismatchReply = false
          response = { ...saved, instructions: "Incorrect receipt" }
        } else response = saved
      } catch (error) {
        const failure = error as Error & { code?: string }
        response = {
          botFailure: {
            code: failure.code ?? "unknown",
            message: failure.message
          }
        }
      }
      if (holdNext) {
        holdNext = false
        await new Promise<void>((release) => {
          holdReply = release
        })
      }
      return response
    })
    await page.goto(`http://127.0.0.1:${address.port}`)
    const reopen = async () => {
      await page.getByRole("button", { name: "关闭/打开技能面板", exact: true }).click()
      await page.getByRole("button", { name: "关闭/打开技能面板", exact: true }).click()
    }
    const publish = async () => {
      await page.evaluate(async () => {
        await (window as unknown as SkillFixtureWindow).fixtureReload()
      })
    }
    const card = () => page.locator("article[id^=bot-skill-]")
    const openManagement = async () => {
      const summary = card().getByText("管理技能", { exact: true })
      if ((await summary.locator("..").getAttribute("open")) === null) await summary.click()
    }
    const create = () =>
      page.locator("form").filter({
        has: page.getByRole("heading", { name: "保存技能", exact: true })
      })
    const waitForBackendHold = async (read: () => unknown) => {
      const deadline = Date.now() + 5000
      while (!read()) {
        assert.ok(Date.now() < deadline, "expected backend reply to reach its hold")
        await new Promise<void>((done) => setTimeout(done, 20))
      }
    }
    const cases: string[] = []
    await create().getByRole("textbox", { name: "名称", exact: true }).fill("核对订单")
    await create().getByRole("textbox", { name: "内容", exact: true }).fill("读取订单并核对金额")
    loseReply = true
    await create().getByRole("button", { name: "保存", exact: true }).click()
    await page.getByText("尚未收到保存结果。", { exact: false }).waitFor()
    assert.equal(store.skills(owner.id).length, 1)
    assert.equal(
      await create().getByRole("textbox", { name: "名称", exact: true }).isDisabled(),
      true
    )
    await reopen()
    await create().getByRole("button", { name: "重试核对保存", exact: true }).click()
    await card().getByRole("heading", { name: "核对订单", exact: true }).waitFor()
    assert.equal(calls[0].nonce, calls[1].nonce)
    assert.equal(store.skills(owner.id).length, 1)
    cases.push("lost create ACK + reopen exact nonce returns one durable skill")

    await openManagement()
    await card().getByRole("button", { name: "修订技能 核对订单", exact: true }).click()
    await card()
      .getByRole("textbox", { name: "技能步骤", exact: true })
      .fill("读取订单、核对金额和证据")
    loseReply = true
    await card().getByRole("button", { name: "保存新版本", exact: true }).click()
    await page.getByText("尚未收到保存结果。", { exact: false }).waitFor()
    await publish()
    assert.equal(store.skills(owner.id)[0].version, 2)
    await reopen()
    await card().getByRole("button", { name: "重试核对保存", exact: true }).click()
    await card().getByText("版本 2 ·", { exact: false }).waitFor()
    await page.waitForFunction(() => !document.querySelector('input[aria-label="技能名称"]'))
    assert.deepEqual(calls[2], calls[3])
    assert.equal(store.skills(owner.id)[0].version, 2)
    cases.push("lost edit ACK survives polling/new version and reopen without revision three")

    loseReply = true
    await openManagement()
    await card().getByRole("button", { name: "停用", exact: true }).click()
    await page.getByText("尚未收到保存结果。", { exact: false }).waitFor()
    await publish()
    await reopen()
    await openManagement()
    assert.equal(await card().getByRole("button", { name: "启用", exact: true }).isDisabled(), true)
    await card().getByRole("button", { name: "重试核对保存", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('input[aria-label="技能名称"]'))
    assert.deepEqual(calls[4], calls[5])
    assert.equal(store.skills(owner.id)[0].enabled, false)
    assert.equal(store.skills(owner.id)[0].version, 3)
    cases.push("unknown toggle cannot turn into inverse enable after refresh")

    await openManagement()
    await card().getByRole("button", { name: "修订技能 核对订单", exact: true }).click()
    await card().getByRole("textbox", { name: "技能步骤", exact: true }).fill("第四版核对")
    await page.evaluate(() => {
      ;(window as unknown as SkillFixtureWindow).fixtureReloadFail = true
    })
    await card().getByRole("button", { name: "保存新版本", exact: true }).click()
    await page.getByText("技能已保存，列表同步失败。", { exact: false }).waitFor()
    const savedCalls = calls.length
    await page.evaluate(() => {
      ;(window as unknown as SkillFixtureWindow).fixtureReloadFail = false
    })
    await card().getByRole("button", { name: "同步保存结果", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('input[aria-label="技能名称"]'))
    assert.equal(calls.length, savedCalls)
    assert.equal(store.skills(owner.id)[0].version, 4)
    cases.push("accepted write + refresh failure retries read only")

    await openManagement()
    await card().getByRole("button", { name: "修订技能 核对订单", exact: true }).click()
    await card().getByRole("textbox", { name: "技能步骤", exact: true }).fill("old editing draft")
    const beforeConcurrent = store.skills(owner.id)[0]
    store.saveSkill({ ...beforeConcurrent, instructions: "其他会话已修改" })
    await publish()
    await card().getByText("技能已更新，请取消后重新编辑当前版本。", { exact: true }).waitFor()
    assert.equal(
      await card().getByRole("button", { name: "保存新版本", exact: true }).isDisabled(),
      true
    )
    assert.equal(calls.length, savedCalls)
    await card().getByRole("button", { name: "取消", exact: true }).click()
    cases.push("polling cannot replace the captured editing CAS")

    await openManagement()
    await card().getByRole("button", { name: "修订技能 核对订单", exact: true }).click()
    await card().getByRole("textbox", { name: "技能步骤", exact: true }).fill("第六版")
    await page.evaluate(() => {
      ;(window as unknown as SkillFixtureWindow).fixtureClearFail = true
    })
    await card().getByRole("button", { name: "保存新版本", exact: true }).click()
    await page.getByText("保存结果已确认，本机操作记录尚未清除。", { exact: false }).waitFor()
    const beforeCleanup = calls.length
    await page.evaluate(() => {
      ;(window as unknown as SkillFixtureWindow).fixtureClearFail = false
    })
    await card().getByRole("button", { name: "同步保存结果", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('input[aria-label="技能名称"]'))
    assert.equal(calls.length, beforeCleanup)
    cases.push("accepted write + local cleanup failure keeps the known receipt")

    await create().getByRole("textbox", { name: "名称", exact: true }).fill("未提交")
    await create().getByRole("textbox", { name: "内容", exact: true }).fill("storage unavailable")
    await page.evaluate(() => {
      ;(window as unknown as SkillFixtureWindow).fixtureQuota = true
    })
    await create().getByRole("button", { name: "保存", exact: true }).click()
    await page.getByText("无法保留技能保存记录", { exact: false }).waitFor()
    assert.equal(calls.length, beforeCleanup)
    await page.evaluate(() => {
      ;(window as unknown as SkillFixtureWindow).fixtureQuota = false
    })
    cases.push("quota failure blocks submitting an untracked request")

    loseReply = true
    await card().getByRole("button", { name: "启用", exact: true }).click()
    await page.getByText("尚未收到保存结果。", { exact: false }).waitFor()
    const deleted = store.skills(owner.id)[0]
    store.deleteSkill({
      nonce: "remove-while-save-unknown",
      botId: owner.id,
      skillId: deleted.id,
      version: deleted.version
    })
    await publish()
    const orphan = page.getByRole("region", { name: "已移除技能的待确认保存" })
    await orphan.waitFor()
    await orphan.getByRole("button", { name: "重试核对保存", exact: true }).click()
    await orphan.waitFor({ state: "hidden" })
    assert.equal(store.skills(owner.id).length, 0)
    assert.equal(store.skillVersion(owner.id, deleted.id, deleted.version).enabled, false)
    cases.push("disappeared soft-deleted skill still acknowledges original receipt without revival")

    holdNext = true
    await create().getByRole("button", { name: "保存", exact: true }).click()
    await page.waitForFunction(() => !!document.querySelector('input[aria-label="名称"]:disabled'))
    await page.evaluate((id) => {
      ;(window as unknown as SkillFixtureWindow).fixtureSelect(id)
    }, quality.id)
    await page.getByRole("heading", { name: "质量 Bot · 技能", exact: true }).waitFor()
    assert.ok(holdReply)
    holdReply!()
    holdReply = null
    await page.waitForFunction(
      () => document.querySelector('input[aria-label="名称"]')?.getAttribute("value") === ""
    )
    assert.equal(store.skills(quality.id).length, 0)
    cases.push("late previous-Bot save cannot publish into new selected UI")

    await create().getByRole("textbox", { name: "名称", exact: true }).fill("质量核对")
    await create().getByRole("textbox", { name: "内容", exact: true }).fill("独立质量步骤")
    mismatchReply = true
    await create().getByRole("button", { name: "保存", exact: true }).click()
    await page.getByText("保存回执与原请求不一致", { exact: false }).waitFor()
    await create().getByRole("button", { name: "重试核对保存", exact: true }).click()
    await card().getByRole("heading", { name: "质量核对", exact: true }).waitFor()
    assert.equal(store.skills(quality.id).length, 1)
    cases.push("mismatched receipt cannot clear durable intent")

    loseReply = true
    await openManagement()
    await card().getByRole("button", { name: "停用", exact: true }).click()
    await page.getByText("尚未收到保存结果。", { exact: false }).waitFor()
    const beforeEpoch = calls.length
    store.db.run("INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES(?,?,?,?)", [
      "workspace.restored",
      "restored",
      "{}",
      1
    ])
    await page.evaluate(() => {
      const s = (window as unknown as SkillFixtureWindow).fixtureWorkspace
      s.setState({
        snapshot: { ...s.getState().snapshot, dataEpoch: "restored" }
      })
    })
    await page
      .getByText("数据已恢复，请关闭后重新打开技能面板。", { exact: true })
      .first()
      .waitFor()
    await reopen()
    await page.getByText("有恢复前的保存记录", { exact: true }).waitFor()
    assert.equal(calls.length, beforeEpoch)
    const originalSave = calls[calls.length - 1],
      originalReceipt = store.skillVersion(
        originalSave.botId,
        originalSave.id!,
        originalSave.version! + 1
      ),
      beforeReplay = store.snapshot().cursor
    assert.deepEqual(store.saveSkill(originalSave), originalReceipt)
    assert.equal(store.snapshot().cursor, beforeReplay, "Accepted historical receipt is read-only")
    assert.throws(
      () => store.saveSkill({ ...originalSave, nonce: "fresh-retired-skill-request" }),
      /工作区数据已恢复/
    )
    cases.push(
      "restore retains old intent, reads original receipt without writes and rejects a fresh stale request"
    )
    // Match production: BotResources is keyed by Bot, and each skill by skill ID.
    // A data restore can therefore leave the same card mounted while its RPC settles.
    const nextEpoch = async (id: string) => {
      store.db.run("INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES(?,?,?,?)", [
        "workspace.restored",
        id,
        "{}",
        2
      ])
      await page.evaluate((epoch) => {
        const workspace = (window as unknown as SkillFixtureWindow).fixtureWorkspace
        workspace.setState({ snapshot: { ...workspace.getState().snapshot, dataEpoch: epoch } })
      }, id)
    }
    const prepareCard = async (label: string) => {
      const bot = store.createBot({
        nonce: label.replaceAll(" ", "-"),
        expectedDataEpoch: store.dataEpoch(),
        name: label
      }).bot
      await page.evaluate((id) => {
        ;(window as unknown as SkillFixtureWindow).fixtureSelect(id)
      }, bot.id)
      await page.locator(`section[data-bot-id="${bot.id}"]`).waitFor()
      await create().getByRole("textbox", { name: "名称", exact: true }).fill(label)
      await create().getByRole("textbox", { name: "内容", exact: true }).fill("Initial steps")
      await create().getByRole("button", { name: "保存", exact: true }).click()
      await card().getByRole("heading", { name: label, exact: true }).waitFor()
      return { bot, skill: store.skills(bot.id)[0] }
    }
    for (const outcome of ["success", "definitive rejection"] as const) {
      const { bot, skill } = await prepareCard(`Held ${outcome}`)
      await openManagement()
      await card()
        .getByRole("button", { name: `修订技能 Held ${outcome}`, exact: true })
        .click()
      await card().getByRole("textbox", { name: "技能步骤", exact: true }).fill("Keep this draft")
      if (outcome === "definitive rejection")
        store.saveSkill({
          ...skill,
          nonce: `fixture-concurrent-${skill.id}-${skill.version}`,
          expectedDataEpoch: store.dataEpoch(),
          instructions: "Concurrent current version"
        })
      holdNext = true
      await card().getByRole("button", { name: "保存新版本", exact: true }).click()
      await page.waitForFunction(() => !!document.querySelector("article button:disabled"))
      await waitForBackendHold(() => holdReply)
      assert.ok(holdReply)
      const recordKey = `bot-skill-save-pending:${encodeURIComponent(bot.id)}:${encodeURIComponent(skill.id)}`
      const raw = await page.evaluate((key) => localStorage.getItem(key), recordKey)
      assert.ok(raw)
      await card().evaluate((node) => node.setAttribute("data-original-card", "held"))
      const reloads = await page.evaluate(
        () => (window as unknown as SkillFixtureWindow).fixtureReloadCalls
      )
      await nextEpoch(`restored-${outcome.replaceAll(" ", "-")}`)
      assert.equal(await card().getAttribute("data-original-card"), "held")
      const settled = await page.evaluate(
        () => (window as unknown as SkillFixtureWindow).fixtureSaveSettlements
      )
      holdReply!()
      holdReply = null
      await page.waitForFunction(
        (before) => (window as unknown as SkillFixtureWindow).fixtureSaveSettlements > before,
        settled
      )
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), recordKey), raw)
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll("article button")].some((button) =>
            button.textContent?.includes("保存中")
          )
      )
      assert.equal(
        await page.evaluate(() => (window as unknown as SkillFixtureWindow).fixtureReloadCalls),
        reloads
      )
      assert.equal(
        await card().getByRole("textbox", { name: "技能步骤", exact: true }).inputValue(),
        "Keep this draft"
      )
      await reopen()
      await page.getByText("有恢复前的保存记录", { exact: true }).waitFor()
      cases.push(`same mounted Card retains exact retired intent after late ${outcome}`)
    }

    const refreshing = await prepareCard("Held list refresh")
    await openManagement()
    await card().getByRole("button", { name: "修订技能 Held list refresh", exact: true }).click()
    await card().getByRole("textbox", { name: "技能步骤", exact: true }).fill("Keep after refresh")
    holdReadNext = true
    await card().getByRole("button", { name: "保存新版本", exact: true }).click()
    await page.waitForFunction(() => !!document.querySelector("article button:disabled"))
    await waitForBackendHold(() => holdReadReply)
    assert.ok(holdReadReply)
    const refreshingKey = `bot-skill-save-pending:${encodeURIComponent(refreshing.bot.id)}:${encodeURIComponent(refreshing.skill.id)}`
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), refreshingKey), null)
    await nextEpoch("restored-during-refresh")
    holdReadReply!()
    holdReadReply = null
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll("article button")].some((button) =>
          button.textContent?.includes("保存中")
        )
    )
    assert.equal(
      await card().getByRole("textbox", { name: "技能步骤", exact: true }).inputValue(),
      "Keep after refresh"
    )
    cases.push("refresh settling after restore cannot return a successful save into old Card state")
    await page.screenshot({
      animations: "disabled",
      path: join(output, "skill-save-light.png"),
      fullPage: true
    })
    await page.evaluate(() => {
      ;(window as unknown as SkillFixtureWindow).fixtureTheme("codex-dark")
    })
    await page.screenshot({
      animations: "disabled",
      path: join(output, "skill-save-dark.png"),
      fullPage: true
    })
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ passed: cases.length, cases, errors, started }))
  } catch (error) {
    await page.screenshot({
      animations: "disabled",
      path: join(output, "epoch-failure.png"),
      fullPage: true
    })
    console.log(JSON.stringify({ failureBody: await page.locator("body").innerText() }))
    throw error
  } finally {
    holdReply?.()
    holdReadReply?.()
    await browser.close()
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done()))
    )
    store.close()
    await rm(directory, { recursive: true, force: true })
    console.log(
      JSON.stringify({
        physicalClose: new Date().toISOString(),
        serverListening: server.listening
      })
    )
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
