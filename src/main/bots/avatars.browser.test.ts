import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"
import { createCanvas } from "@napi-rs/canvas"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotDocumentReader } from "./document-reader"
import { createBotAPI } from "./rpc"
import type { BotAvatarChange } from "../../shared/bot-avatar"

it.skipIf(process.env.CMB_AVATAR_UI_TEST !== "1")(
  "crops a real image, recovers a lost save after reload, updates group pictures and removes the photo",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-avatar-ui-"))
    const output = resolve("output/bot-avatars")
    await mkdir(output, { recursive: true })
    const store = new BotStore(join(root, "bots.sqlite"))
    const owner = store.createBot({
      nonce: "owner",
      name: "研发助手",
      avatarShape: "cloud",
      avatarColor: "violet"
    })
    const other = store.createBot({ nonce: "other", name: "评审助手" })
    const host = new BotHost(
      store,
      undefined,
      4,
      undefined,
      undefined,
      undefined,
      undefined,
      new BotDocumentReader({
        entry: resolve("src/main/bots/document-worker-entry.ts"),
        execArgv: ["--import", "tsx"]
      })
    )
    const api = createBotAPI(host)
    const browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
      args: ["--disable-updater-scheduler"]
    })
    const page = await browser.newPage({ viewport: { width: 1040, height: 840 } })
    page.setDefaultTimeout(10_000)
    const requests: BotAvatarChange[] = []
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
          contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotAvatarEditor}from'./src/renderer/src/components/bots/BotAvatarEditor';import{BotAvatar}from'./src/renderer/src/components/bots/BotAvatar';import{useBotWorkspaceStore as useStore}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';import'./src/renderer/src/components/bots/bot-workspace.css';window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');window.api={bots:new Proxy({},{get:(_,method)=>(input)=>window.apiCall(method,input)})};function Fixture(){const bot=useStore(state=>state.snapshot.bots.find(bot=>bot.id===${JSON.stringify(owner.bot.id)}));const[open,setOpen]=useState(null);return <main className="bot-workspace block! p-10 text-foreground"><div className="fixture-head flex items-center gap-3"><BotAvatar agentId={bot.id} size="xl"/><div><h1 className="text-xl font-medium">{bot.name}</h1><button onClick={()=>setOpen(bot)}>更换头像图片</button></div></div><div className="fixture-group mt-8 flex items-center gap-3"><BotAvatar agentId="group" kind="group" memberIds={[bot.id,${JSON.stringify(other.bot.id)}]} size="xl"/><span>项目协作组</span></div>{open&&<BotAvatarEditor key={open.id} bot={open} close={()=>setOpen(null)}/>}</main>};(async()=>{useStore.setState({snapshot:await window.api.bots.snapshot(),host:await window.api.bots.status()});createRoot(document.getElementById('root')).render(<Fixture/>);})();`,
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
        "snapshot",
        "status",
        "avatar",
        "changeAvatar",
        "messages",
        "reactions",
        "threadSummaries"
      ])
      await page.exposeFunction("apiCall", async (method: string, input: unknown) => {
        if (!allowed.has(method)) throw new Error(`Unexpected UI method ${method}`)
        if (method === "changeAvatar") requests.push(input as BotAvatarChange)
        const result = await (
          api[method as keyof typeof api] as (input: unknown) => Promise<unknown>
        )(input)
        if (method === "changeAvatar" && requests.length === 1)
          throw new Error("Fixture: avatar acknowledgement lost")
        return result
      })
      await page.route("http://127.0.0.1:39197/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><head><meta charset="utf-8"><style>${css.build(scanner.scan())}\n${bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? ""}</style></head><body><div id="root"></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text.replaceAll("</script", "<\\/script")}</script></body></html>`
        })
      )
      await page.goto("http://127.0.0.1:39197")
      const open = async () =>
        page.getByRole("button", { name: "更换头像图片", exact: true }).click()
      await open()
      await page.getByLabel("上传头像图片", { exact: true }).setInputFiles({
        name: "invalid.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
      })
      await page.getByRole("alert").filter({ hasText: "请选择 PNG" }).waitFor()
      const canvas = createCanvas(640, 400),
        context = canvas.getContext("2d")
      const gradient = context.createLinearGradient(0, 0, 640, 400)
      gradient.addColorStop(0, "#1084fe")
      gradient.addColorStop(1, "#9159fe")
      context.fillStyle = gradient
      context.fillRect(0, 0, 640, 400)
      context.fillStyle = "#ffffff"
      context.beginPath()
      context.arc(340, 170, 75, 0, Math.PI * 2)
      context.fill()
      context.fillStyle = "#21213a"
      context.fillRect(310, 158, 12, 18)
      context.fillRect(357, 158, 12, 18)
      await page.getByLabel("上传头像图片", { exact: true }).setInputFiles({
        name: "team.png",
        mimeType: "image/png",
        buffer: await canvas.encode("png")
      })
      await page.getByLabel("头像缩放", { exact: true }).fill("1.5")
      const stage = page.getByRole("img", { name: "头像裁剪区域，方向键调整位置" })
      const rect = (await stage.boundingBox())!
      await page.mouse.move(rect.x + 140, rect.y + 140)
      await page.mouse.down()
      await page.mouse.move(rect.x + 158, rect.y + 130, { steps: 5 })
      await page.mouse.up()
      await stage.focus()
      await page.keyboard.press("ArrowRight")
      await page.screenshot({ path: join(output, "avatar-crop-light.png"), animations: "disabled" })
      await page.getByRole("button", { name: "保存头像", exact: true }).click()
      await page.getByRole("alert").filter({ hasText: "avatar acknowledgement lost" }).waitFor()
      const first = store.getBot(owner.bot.id)
      expect(first.revision).toBe(2)
      await page.reload()
      await open()
      await page.getByRole("button", { name: "核对原操作", exact: true }).click()
      await page.getByRole("dialog").waitFor({ state: "detached" })
      expect(requests[1]).toEqual(requests[0])
      expect(store.getBot(owner.bot.id).revision).toBe(2)
      await page.locator('.fixture-head [data-avatar-kind="photo"]').waitFor()
      expect(await page.locator(".fixture-group img").count()).toBe(1)
      expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
        requests[0].pngBase64
      )
      await page.evaluate("window.fixtureTheme('codex-dark')")
      await page.screenshot({ path: join(output, "avatar-saved-dark.png"), animations: "disabled" })
      await open()
      await page.getByRole("button", { name: "移除图片", exact: true }).click()
      await page.getByRole("dialog").waitFor({ state: "detached" })
      await page.locator('.fixture-head [data-avatar-shape="cloud"]').waitFor()
      expect(store.getBot(owner.bot.id).avatarHash).toBeNull()
      expect(await page.locator(".fixture-group img").count()).toBe(0)
      expect(errors).toEqual([])
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
