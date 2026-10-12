import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { expect, it } from "vitest"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { createBotAPI } from "./rpc"
import { readBotSkillCatalog } from "./skill-catalog-reader"

it.skipIf(process.env.CMB_SKILL_TRIAL_UI_TEST !== "1")(
  "runs the real skill panels, recovers a lost trial receipt after catalog update and binds only reviewed versions",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-skill-trial-ui-"))
    const output = resolve("output/bot-external-trials")
    await mkdir(output, { recursive: true })
    const source = {
      builtinSkillsDir: join(root, "builtin"),
      customSkillsDir: join(root, "custom"),
      pluginsStorePath: join(root, "plugins.json"),
      disabledSkillsPath: join(root, "disabled.json"),
      disabledSkillsRevision: 0,
      globalRevision: 0
    }
    await mkdir(source.builtinSkillsDir)
    await mkdir(join(source.customSkillsDir, "review"), { recursive: true })
    await writeFile(source.pluginsStorePath, "[]")
    await writeFile(source.disabledSkillsPath, "[]")
    const file = join(source.customSkillsDir, "review", "SKILL.md")
    await writeFile(
      file,
      "---\nname: 对账核验\ncompatibility: Node.js 22\n---\n读取本次输入，逐项核对差异并交付原始证据。"
    )
    const store = new BotStore(join(root, "bots.sqlite"))
    const owner = store.createBot({ nonce: "owner", name: "对账助手" })
    const other = store.createBot({ nonce: "other", name: "其他项目" })
    const api = createBotAPI(new BotHost(store))
    const sync = async () => store.externalSkills.apply(await readBotSkillCatalog(source))
    await sync()
    const installedId = store.externalSkills.list(owner.bot.id)[0].id
    const original = store.saveSkill({
      botId: other.bot.id,
      name: "共享评审",
      instructions: "审查输入并交付评审记录",
      enabled: true
    })
    const shared = store.skillLibrary.publish({
      nonce: "publish",
      botId: other.bot.id,
      skillId: original.id,
      version: 1,
      libraryRevision: 0
    })
    const browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
      args: ["--disable-updater-scheduler"]
    })
    const page = await browser.newPage({ viewport: { width: 1160, height: 940 } })
    page.setDefaultTimeout(10_000)
    let lost = false
    const requests: unknown[] = []
    try {
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
          contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotResources}from'./src/renderer/src/components/bots/BotResources';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');window.api={bots:new Proxy({},{get:(_,method)=>(input)=>window.apiCall(method,input)})};useBotWorkspaceStore.setState({host:${JSON.stringify(await api.status())},snapshot:${JSON.stringify(store.snapshot())}});function Fixture(){const[tab,setTab]=useState(null);const[other,setOther]=useState(false);return <main className="p-8 text-foreground"><h1 className="text-xl font-medium">项目技能</h1><button onClick={()=>setOther(!other)}>切换 Bot</button><button onClick={()=>setTab('skills')}>打开技能</button><button onClick={()=>setTab('routines')}>打开例程</button>{tab&&<BotResources key={String(other)+tab} bot={other?${JSON.stringify(other.bot)}:${JSON.stringify(owner.bot)}} tab={tab} close={()=>setTab(null)}/>}</main>}createRoot(document.getElementById('root')).render(<Fixture/>);`,
          loader: "tsx",
          resolveDir: process.cwd()
        },
        bundle: true,
        platform: "browser",
        format: "iife",
        write: false,
        outfile: join(root, "ui.js"),
        jsx: "automatic",
        alias: { "@": renderer },
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }
      })
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      const allowed = new Set([
        "skills",
        "skillTrials",
        "skillLibrary",
        "availableSkills",
        "installedSkills",
        "inspectInstalledSkill",
        "trialSkill",
        "reviewSkillTrial",
        "saveRoutine",
        "routines",
        "snapshot",
        "status",
        "events"
      ])
      await page.exposeFunction("apiCall", async (method: string, input: unknown) => {
        if (!allowed.has(method)) throw new Error(`Unexpected UI method: ${method}`)
        if (method === "trialSkill") requests.push(input)
        const result = await (
          api[method as keyof typeof api] as (input: unknown) => Promise<unknown>
        )(input)
        if (method === "trialSkill" && !lost) {
          lost = true
          throw new Error("Fixture: acknowledgement lost after durable trial")
        }
        return result
      })
      await page.route("http://127.0.0.1:39194/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><head><meta charset="utf-8"><style>${css.build(scanner.scan())}</style></head><body><div id="root"></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text.replaceAll("</script", "<\\/script")}</script></body></html>`
        })
      )
      await page.goto("http://127.0.0.1:39194")
      const openInstalled = async () => {
        await page.getByRole("button", { name: "打开技能", exact: true }).click()
        await page.getByRole("tab", { name: "CMBDevClaw 技能", exact: true }).click()
        await page.getByRole("button", { name: /对账核验/ }).click()
      }
      await openInstalled()
      expect(await page.getByLabel("修订技能 对账核验").count()).toBe(0)
      await page.getByRole("button", { name: "试跑", exact: true }).click()
      await page.getByLabel("本次输入", { exact: true }).fill("订单 42，核对实际金额")
      await page.getByLabel("验收条件", { exact: true }).fill("返回订单 42 的金额与差异证据")
      await page.screenshot({
        path: join(output, "installed-trial-light.png"),
        animations: "disabled"
      })
      await page.getByRole("button", { name: "开始试跑", exact: true }).click()
      await page.getByRole("alert").filter({ hasText: "acknowledgement lost" }).waitFor()
      const first = store.skillTrials(owner.bot.id)[0]
      expect(first.version).toBe(1)
      await writeFile(
        file,
        "---\nname: 对账核验\ncompatibility: Node.js 22\n---\n读取输入，先核对编号，再核对金额和差异证据。"
      )
      await sync()
      await page.reload()
      await openInstalled()
      expect(await page.getByLabel("本次输入", { exact: true }).inputValue()).toBe(
        "订单 42，核对实际金额"
      )
      expect(await page.getByLabel("本次输入", { exact: true }).isDisabled()).toBe(true)
      await page.getByRole("button", { name: "重试核对试跑", exact: true }).click()
      await page.getByRole("button", { name: "试跑", exact: true }).waitFor()
      expect(requests[0]).toEqual(requests[1])
      expect(store.skillTrials(owner.bot.id)).toHaveLength(1)
      // The queued old version fails the normal execution fence. Its review cannot certify v2.
      const stale = store.claim("test-host")!
      expect(() =>
        store.skillReferences.assertCurrent(store.skillReferences.forRun(stale.run.id))
      ).toThrow("新版本")
      store.finish(stale.lease, "failed", "技能版本已更新")
      await page.getByRole("button", { name: "试跑", exact: true }).click()
      await page.getByLabel("本次输入", { exact: true }).fill("订单 43")
      await page.getByLabel("验收条件", { exact: true }).fill("订单 43 与凭证一致")
      await page.getByRole("button", { name: "开始试跑", exact: true }).click()
      await page.getByRole("button", { name: "试跑", exact: true }).waitFor()
      const current = store.claim("test-host")!
      expect(store.trialForRun(current.run.id)?.version).toBe(2)
      store.finish(current.lease, "succeeded", "订单 43 与凭证一致，差异为 0")
      await page.getByText("版本 2 · 等待验收", { exact: true }).click()
      await page
        .locator("details[open]")
        .getByLabel("试跑验收依据")
        .fill("已人工比对原始凭证，金额与差异正确")
      await page.locator("details[open]").getByRole("button", { name: "通过", exact: true }).click()
      await page.getByRole("button", { name: "设为例程", exact: true }).waitFor()
      expect(store.externalSkills.current(owner.bot.id, installedId).verified).toBe(true)
      expect(store.externalSkills.current(other.bot.id, installedId).verified).toBe(false)
      await page.evaluate("window.fixtureTheme('codex-dark')")
      await page.screenshot({
        path: join(output, "installed-reviewed-dark.png"),
        animations: "disabled"
      })
      await page.getByRole("button", { name: "设为例程", exact: true }).click()
      const editor = page
        .getByRole("dialog")
        .filter({ has: page.getByRole("heading", { name: "将技能设为例程", exact: true }) })
      await editor.getByRole("button", { name: "保存", exact: true }).click()
      await page.getByRole("button", { name: "设为例程", exact: true }).waitFor()
      const routine = store.routines(owner.bot.id)[0]
      expect(routine.skillReferences).toEqual([
        { botId: owner.bot.id, id: installedId, version: 2, name: "对账核验" }
      ])
      await page.getByRole("tab", { name: "我的技能库", exact: true }).click()
      await page.getByRole("button", { name: "试跑", exact: true }).click()
      await page.getByLabel("本次输入", { exact: true }).fill("评审记录 7")
      await page.getByLabel("验收条件", { exact: true }).fill("保留依据")
      await page.getByRole("button", { name: "开始试跑", exact: true }).click()
      await page.getByRole("button", { name: "试跑", exact: true }).waitFor()
      const sharedClaim = store.claim("test-host")!
      expect(store.trialForRun(sharedClaim.run.id)?.skillId).toBe(shared.id)
      store.finish(sharedClaim.lease, "succeeded", "评审证据 7")
      await page.getByText("版本 1 · 等待验收", { exact: true }).click()
      await page.getByLabel("试跑验收依据").fill("已对比原记录")
      await page.locator("details[open]").getByRole("button", { name: "通过", exact: true }).click()
      await page.getByRole("button", { name: "设为例程", exact: true }).waitFor()
      expect(store.skillLibrary.current(owner.bot.id, shared.id).verified).toBe(true)
      expect(store.skillLibrary.current(other.bot.id, shared.id).verified).toBe(false)
      expect(errors).toEqual([])
      expect(store.db.exec("PRAGMA foreign_key_check")[0]?.values ?? []).toEqual([])
    } catch (error) {
      await page.screenshot({ path: join(output, "failure.png"), animations: "disabled" })
      throw error
    } finally {
      await browser.close()
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000
)
