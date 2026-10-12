import { viteUrlAssetsFixture } from "./fixtures/vite-url-assets"
/** Core UI-06 acceptance; original components, inherited Chinese UI, English data and native browser locale/TZ. */
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"

const root = fileURLToPath(new URL("../", import.meta.url))
const output = resolve(root, "output/bot-presentation")
const renderer = resolve(root, "src/renderer/src")
const timestamp = Date.parse("2026-03-08T07:00:00.000Z")
const messages = [
  "需求分析与研发质量检查。项目背景、验证证据和待决事项需要完整保留，工作交接后能够接续处理。".repeat(
    6
  ),
  "Maintain project context and verified evidence across task handoffs. This paragraph must wrap without covering controls or losing text. ".repeat(
    6
  ),
  "repository_identifier_" + "abcdefghijklmnopqrstuvwxyz".repeat(12)
]
const bot = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "ProjectReliability_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(3),
  title:
    "长期协作助手 — Reliable development partner with retained project context, evidence and task ownership.",
  instructions: messages.join("\n\n"),
  modelRef: null,
  workspacePath: null,
  revision: 1,
  hidden: false,
  pinned: false,
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: null
}

async function main(): Promise<void> {
  await mkdir(output, { recursive: true })
  const sourceHtml = await readFile(resolve(root, "src/renderer/index.html"), "utf8")
  const declaredLanguage = sourceHtml.match(/<html\s+lang="([^"]+)"/)?.[1]
  assert.equal(
    declaredLanguage,
    "zh-CN",
    "The inherited Chinese UI must declare its actual language"
  )
  const css = await compile(
    (await readFile(resolve(renderer, "index.css"), "utf8")).replace(
      /^@import "@fontsource[^\n]+\n/gm,
      ""
    ),
    { base: renderer, onDependency: () => {} }
  )
  const scanner = new Scanner({
    sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
  })
  const font = (
    await readFile(
      resolve(root, "node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2")
    )
  ).toString("base64")
  const highlight = await build({
    entryPoints: [resolve(renderer, "components/tabs/code-highlight-worker.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false
  })
  const bundle = await build({
    stdin: {
      loader: "tsx",
      resolveDir: root,
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';
      import{AppearancePanel}from'./src/renderer/src/components/customize/AppearancePanel';
      import{useBotUserBubbleTint}from'./src/renderer/src/lib/use-bot-user-bubble-tint';
      import{BotMessageText}from'./src/renderer/src/components/bots/BotMessageText';
      import{BotMessageTime}from'./src/renderer/src/components/bots/BotMessageTime';
      import{BotRoutineCard}from'./src/renderer/src/components/bots/BotRoutineCard';
      import{BotInspector}from'./src/renderer/src/components/bots/BotInspector';
      import{BotAvatar}from'./src/renderer/src/components/bots/BotAvatar';
      import{BotConversationRowActions}from'./src/renderer/src/components/bots/BotConversationRowActions';
      import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';
      import{useAppStore}from'./src/renderer/src/lib/store';
      import{setThemePreference,setThemeModePreference,getThemePreference,initializeThemePreference,getBotMessageTintEnabled,setBotMessageTintEnabled}from'./src/renderer/src/lib/theme-preference';
      import './src/renderer/src/components/bots/bot-workspace.css';
      const bot=${JSON.stringify(bot)},texts=${JSON.stringify(messages)},timestamp=${timestamp};
      window.fixtureTheme=setThemePreference;window.fixtureSystem=()=>setThemeModePreference('system');window.fixtureThemeValue=getThemePreference;initializeThemePreference();
      window.fixtureMutations=0;window.electron={process:{platform:${JSON.stringify(process.platform)}}};
      useBotWorkspaceStore.setState({host:{capabilities:['bot-profile-title']},snapshot:{dataEpoch:'epoch',bots:[bot],conversations:[],runs:[]}});
      const noop=()=>{};
      function Fixture(){const[show,setShow]=useState(false);const[appearance,setAppearance]=useState(false);const[scene,setScene]=useState({kind:'direct',bot:{...bot,avatarColor:'red'}});const tint=useBotUserBubbleTint(scene.kind,scene.bot);window.fixtureScene=setScene;window.fixtureAppearance=setAppearance;window.fixtureTintEnabled=getBotMessageTintEnabled;window.fixtureTint=setBotMessageTintEnabled;window.fixtureInspect=setShow;return <main className="bot-workspace flex h-screen w-full">
        <aside className="bot-sidebar flex shrink-0 flex-col"><header className="flex h-16 items-center px-4"><h1>Bots</h1></header><nav className="bot-conversation-list px-3"><BotConversationRowActions bot={bot} name={bot.name} conversationId="conversation" dataEpoch="epoch" unread={false} onSettings={()=>setShow(true)}>{(name)=><button className="bot-list-row" aria-label={bot.name} onClick={()=>setShow(true)}><span className="bot-list-persona"><BotAvatar agentId={scene.bot.id} color={scene.bot.avatarColor}/></span><span className="bot-list-row-copy min-w-0"><span className="block truncate text-sm font-medium">{name}</span><span className="block truncate text-xs text-muted-foreground">{bot.title}</span></span></button>}</BotConversationRowActions></nav></aside>
        <section className="flex min-w-0 flex-1 flex-col"><header className="bot-header flex shrink-0 items-center gap-3"><h2 className="min-w-0 flex-1 truncate">{bot.name}</h2><button type="button" data-inspect onClick={()=>setShow(true)} aria-label="查看 Bot 详情">详情</button></header>
          <div data-transcript className="bot-transcript min-h-0 flex-1 overflow-y-auto"><div className="bot-transcript-content" style={tint} data-user-bubble-tint={!!tint||undefined} data-tint-bot={scene.bot.id} data-tint-color={scene.bot.avatarColor} data-tint-kind={scene.kind}><BotMessageTime createdAt={timestamp}/>{texts.map((text,index)=><div key={index} data-item-index={index}><article className="bot-message" data-sender={index===1?'bot':'user'} data-message={index}><div className="bot-message-bubble"><BotMessageText message={{id:'message-'+index,conversationId:'conversation',sender:index===1?'bot':'user',botId:index===1?bot.id:null,sequence:index+1,createdAt:timestamp,text,runId:null,replyTo:null,attachments:[]}} conversationFor={()=>undefined} open={noop}/></div></article></div>)}
          <BotRoutineCard routine={{id:'routine',botId:bot.id,name:bot.title,prompt:texts[1],schedule:{kind:'once',at:timestamp},timezone:'America/New_York',enabled:true,nextAt:timestamp,revision:1,createdAt:timestamp}} busy={false} toggle={()=>window.fixtureMutations++}/></div></div>
          <div className="bot-composer-dock"><textarea data-composer className="bot-composer-input" placeholder="交办工作 / Delegate the next task" /></div></section>
        {appearance&&<div data-appearance className="fixed inset-0 z-50 overflow-y-auto bg-background"><button data-close-appearance onClick={()=>setAppearance(false)}>关闭外观</button><AppearancePanel/></div>}
        <div data-peer-control hidden className="bot-transcript-content"><article className="bot-message" data-sender="user"><div className="bot-message-bubble">peer neutral</div></article></div>
        {show&&<BotInspector bot={bot} conversationId="conversation" tab="details" onTabChange={noop} settings={noop} resource={noop} close={()=>setShow(false)}/>}</main>};createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    outfile: resolve(output, "presentation.js"),
    jsx: "automatic",
    alias: { "@": renderer },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.DEV": "false",
      __APP_VERSION__: '"presentation-test"'
    },
    plugins: [
      viteUrlAssetsFixture(),
      {
        name: "original-highlight-worker",
        setup(builder) {
          builder.onResolve({ filter: /code-highlight-worker\?worker$/ }, () => ({
            path: "highlight",
            namespace: "worker"
          }))
          builder.onLoad({ filter: /.*/, namespace: "worker" }, () => ({
            loader: "js",
            contents: `export default class extends Worker { constructor(options) { const url = URL.createObjectURL(new Blob([${JSON.stringify(highlight.outputFiles[0].text)}], {type:"text/javascript"})); super(url, options); URL.revokeObjectURL(url); } }`
          }))
          builder.onResolve({ filter: /^@\/lib\/thread-context$/ }, () => ({
            path: "unused-standard-thread",
            namespace: "presentation"
          }))
          builder.onLoad({ filter: /.*/, namespace: "presentation" }, () => ({
            loader: "js",
            contents:
              "export const useThreadStateSelector=(_id,selector)=>selector({workspacePath:null,workspaceFiles:[]});"
          }))
        }
      }
    ]
  })
  const style = `${css.build(scanner.scan())}\n${bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? ""}\n@font-face{font-family:Inter;font-style:normal;font-weight:400;src:url(data:font/woff2;base64,${font}) format('woff2')}`
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const results: unknown[] = []
  console.log("Bot presentation browser start", new Date().toISOString())
  try {
    for (const timezoneId of ["UTC", "Asia/Shanghai", "America/New_York"]) {
      for (const locale of ["zh-CN", "en-US"]) {
        const context = await browser.newContext({
          timezoneId,
          locale,
          viewport: { width: 1280, height: 850 }
        })
        try {
          const page = await context.newPage()
          const errors: string[] = []
          page.on("pageerror", (error) => errors.push(error.message))
          page.setDefaultTimeout(5000)
          await page.route("**/*", (route) =>
            route.request().url() === "http://127.0.0.1/presentation"
              ? route.fulfill({
                  contentType: "text/html",
                  body: `<html lang="${declaredLanguage}"><head><style>${style}</style></head><body><div id="root"></div></body></html>`
                })
              : route.abort()
          )
          await page.addInitScript(() => {
            const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
            const add = window.addEventListener.bind(window)
            const remove = window.removeEventListener.bind(window)
            window.addEventListener = ((
              type: string,
              listener: EventListenerOrEventListenerObject,
              options?: boolean | AddEventListenerOptions
            ) => {
              if (type === "cmb:theme-preference-changed" || type === "storage") {
                const values = listeners.get(type) ?? new Set()
                values.add(listener)
                listeners.set(type, values)
              }
              add(type, listener, options)
            }) as typeof window.addEventListener
            window.removeEventListener = ((
              type: string,
              listener: EventListenerOrEventListenerObject,
              options?: boolean | EventListenerOptions
            ) => {
              listeners.get(type)?.delete(listener)
              remove(type, listener, options)
            }) as typeof window.removeEventListener
            ;(window as unknown as { fixtureThemeListeners(): number[] }).fixtureThemeListeners =
              () =>
                ["cmb:theme-preference-changed", "storage"].map(
                  (type) => listeners.get(type)?.size ?? 0
                )
          })
          await page.goto("http://127.0.0.1/presentation")
          await page.addScriptTag({ content: bundle.outputFiles[0].text })
          await page.locator("[data-composer]").waitFor()
          await page.evaluate(() => document.fonts.ready)
          const date = await page.locator("time").evaluate((element) => ({
            visible: element.textContent,
            iso: element.getAttribute("dateTime"),
            local: new Date(element.getAttribute("dateTime")!),
            zone: Intl.DateTimeFormat().resolvedOptions().timeZone
          }))
          assert.equal(date.iso, new Date(timestamp).toISOString())
          const expected = await page.evaluate((value) => {
            const d = new Date(value)
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
          }, timestamp)
          assert.equal(date.visible, expected)
          assert.equal(date.zone, timezoneId)
          const routineText = await page.locator("#bot-routine-routine small").textContent()
          assert.ok(routineText?.includes("America/New_York"))
          assert.ok(
            routineText?.includes(
              await page.evaluate(
                (value) =>
                  new Date(value).toLocaleString(undefined, { timeZone: "America/New_York" }),
                timestamp
              )
            )
          )
          for (const width of [1280, 1024, 768, 520]) {
            await page.setViewportSize({ width, height: 850 })
            for (const theme of ["codex-light", "codex-dark"] as const) {
              await page.evaluate(
                (theme) =>
                  (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme(theme),
                theme
              )
              await page.locator("[data-composer]").focus()
              const geometry = await page.evaluate(() => ({
                overflow: document.documentElement.scrollWidth - innerWidth,
                font: getComputedStyle(document.querySelector(".bot-message-bubble")!).fontFamily,
                bodyFont: getComputedStyle(document.body).fontFamily,
                texts: [...document.querySelectorAll("[data-message] .bot-message-bubble")].map(
                  (el) => el.textContent
                ),
                widths: [...document.querySelectorAll("[data-message] .bot-message-bubble")].map(
                  (el) => el.getBoundingClientRect().width
                ),
                transcriptWidth: document
                  .querySelector("[data-transcript]")!
                  .getBoundingClientRect().width,
                focused: document.activeElement?.hasAttribute("data-composer"),
                mode: document.documentElement.dataset.colorScheme,
                declaredLanguage: document.documentElement.lang
              }))
              assert.ok(
                geometry.overflow <= 1,
                `${width}/${locale}/${theme}: horizontal overflow ${geometry.overflow}`
              )
              assert.equal(geometry.font, geometry.bodyFont)
              assert.match(geometry.font, /Inter/)
              assert.deepEqual(geometry.texts, messages)
              assert.ok(geometry.widths.every((value) => value <= geometry.transcriptWidth + 1))
              assert.equal(geometry.focused, true)
              assert.equal(geometry.mode, theme === "codex-dark" ? "dark" : "light")
              assert.equal(geometry.declaredLanguage, "zh-CN")
              const inspect = page.locator("[data-inspect]")
              await inspect.focus()
              await page.keyboard.press("Enter")
              const panel = page.locator(".bot-inspector-panel")
              await panel.waitFor()
              await panel.evaluate(async (element) => {
                for (const animation of element.getAnimations()) await animation.finished
              })
              const bounds = await panel.boundingBox()
              if (!bounds || bounds.x < -1 || bounds.x + bounds.width > width + 1) {
                await page.screenshot({ path: resolve(output, "panel-overflow.png") })
                console.error(
                  JSON.stringify(
                    {
                      timezoneId,
                      locale,
                      width,
                      theme,
                      bounds,
                      geometry,
                      html: (await page.content()).slice(-6000)
                    },
                    null,
                    2
                  )
                )
              }
              assert.ok(bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1)
              assert.equal(await panel.locator("h3").textContent(), bot.name)
              assert.equal(
                await panel.locator(".bot-profile-inline-label").textContent(),
                bot.title
              )
              assert.ok((await panel.textContent())?.includes(messages[2]))
              await panel.getByRole("button", { name: "关闭详情面板", exact: true }).focus()
              await page.keyboard.press("Enter")
              await panel.waitFor({ state: "detached" })
              assert.equal(
                await page.evaluate(
                  () => (window as unknown as { fixtureMutations: number }).fixtureMutations
                ),
                0
              )
              if (timezoneId === "UTC" && locale === "zh-CN")
                await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) })
              results.push({ timezoneId, locale, width, theme, geometry, panel: bounds })
            }
          }
          if (timezoneId === "UTC" && locale === "zh-CN") {
            const user = page.locator('[data-message="0"] .bot-message-bubble')
            const assistant = page.locator('[data-message="1"] .bot-message-bubble')
            const color = () =>
              user.evaluate((element) => getComputedStyle(element).backgroundColor)
            const listeners = () =>
              page.evaluate(() =>
                (window as unknown as { fixtureThemeListeners(): number[] }).fixtureThemeListeners()
              )
            const baselineListeners = await listeners()
            const setScene = async (kind: string, avatarColor: string, avatarHash?: string) => {
              await page.evaluate(
                ({ kind, avatarColor, avatarHash, id }) =>
                  (window as unknown as { fixtureScene(value: unknown): void }).fixtureScene({
                    kind,
                    bot: { id, avatarColor, avatarHash }
                  }),
                {
                  kind,
                  avatarColor,
                  avatarHash,
                  id: avatarColor === "blue" ? "22222222-2222-4222-8222-222222222222" : bot.id
                }
              )
              await page.waitForFunction(
                ({ kind, avatarColor }) => {
                  const element = document.querySelector(
                    "[data-transcript] .bot-transcript-content"
                  ) as HTMLElement
                  return (
                    element.dataset.tintKind === kind && element.dataset.tintColor === avatarColor
                  )
                },
                { kind, avatarColor }
              )
            }
            for (const theme of ["codex-light", "codex-dark"] as const) {
              await page.evaluate(
                (theme) =>
                  (window as unknown as { fixtureTheme(value: string): void }).fixtureTheme(theme),
                theme
              )
              await setScene("direct", "red")
              await page.waitForFunction(
                () =>
                  getComputedStyle(
                    document.querySelector('[data-message="0"] .bot-message-bubble')!
                  ).backgroundColor === "rgb(194, 29, 46)"
              )
              assert.notEqual(
                await assistant.evaluate((element) => getComputedStyle(element).backgroundColor),
                await color()
              )
              assert.notEqual(
                await page
                  .locator("[data-peer-control] .bot-message-bubble")
                  .evaluate((element) => getComputedStyle(element).backgroundColor),
                await color()
              )
              await setScene("direct", "blue")
              await page.waitForFunction(
                () =>
                  getComputedStyle(
                    document.querySelector('[data-message="0"] .bot-message-bubble')!
                  ).backgroundColor === "rgb(12, 100, 193)"
              )
              for (const scenario of [
                { kind: "group", color: "red" },
                { kind: "peer", color: "red" },
                { kind: "direct", color: "black" },
                { kind: "direct", color: "red", photo: "photo-hash" }
              ]) {
                await setScene(scenario.kind, scenario.color, scenario.photo)
                await page.waitForFunction(
                  () => !document.querySelector("[data-transcript] [data-user-bubble-tint]")
                )
                assert.notEqual(await color(), "rgb(194, 29, 46)")
              }
              for (const avatarColor of [
                "gray",
                "blue",
                "red",
                "orange",
                "yellow",
                "green",
                "cyan",
                "violet",
                "magenta",
                "brown"
              ]) {
                await setScene("direct", avatarColor)
                const contrast = await user.evaluate((element) => {
                  const style = getComputedStyle(element)
                  const [background, foreground] = [style.backgroundColor, style.color].map((rgb) =>
                    rgb
                      .match(/\d+(?:\.\d+)?/g)!
                      .slice(0, 3)
                      .map(Number)
                      .reduce((sum, channel, index) => {
                        const srgb = channel / 255
                        return (
                          sum +
                          [0.2126, 0.7152, 0.0722][index] *
                            (srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4)
                        )
                      }, 0)
                  )
                  return (
                    (Math.max(background, foreground) + 0.05) /
                    (Math.min(background, foreground) + 0.05)
                  )
                })
                assert.ok(
                  contrast >= 4.5,
                  `${theme}/${avatarColor}: visible normal-text contrast ${contrast}`
                )
              }
              await setScene("direct", "red")
              await page.waitForFunction(
                () => !!document.querySelector("[data-transcript] [data-user-bubble-tint]")
              )
              await page.screenshot({ path: resolve(output, `user-tint-${theme}.png`) })
            }
            for (let cycle = 0; cycle < 3; cycle++) {
              await page.evaluate(() =>
                (
                  window as unknown as { fixtureAppearance(value: boolean): void }
                ).fixtureAppearance(true)
              )
              const toggle = page.getByRole("switch", { name: "Bot 消息配色", exact: true })
              await toggle.waitFor()
              assert.equal(
                await page.locator('[data-appearance] button[aria-pressed="true"]').count(),
                1,
                "adding tint preference must preserve the configured theme selection"
              )
              assert.equal(
                await page
                  .getByRole("radio", { name: "深色", exact: true })
                  .getAttribute("aria-checked"),
                "true"
              )
              assert.match(
                await page.locator('[data-appearance] button[aria-pressed="true"]').innerText(),
                /Codex/
              )
              await toggle.click()
              await page.waitForFunction(
                () => !(window as unknown as { fixtureTintEnabled(): boolean }).fixtureTintEnabled()
              )
              assert.notEqual(await color(), "rgb(194, 29, 46)")
              await toggle.focus()
              await page.keyboard.press("Space")
              await page.waitForFunction(() =>
                (window as unknown as { fixtureTintEnabled(): boolean }).fixtureTintEnabled()
              )
              await page.getByRole("button", { name: "关闭外观", exact: true }).click()
              await page.locator("[data-appearance]").waitFor({ state: "detached" })
              assert.deepEqual(
                await listeners(),
                baselineListeners,
                "appearance remount must release all subscriptions"
              )
            }
            await page.emulateMedia({ forcedColors: "active" })
            assert.equal(
              await color(),
              await page.evaluate(() => {
                const sample = document.createElement("div")
                sample.style.background = "Canvas"
                document.body.append(sample)
                const value = getComputedStyle(sample).backgroundColor
                sample.remove()
                return value
              })
            )
            await page.emulateMedia({ forcedColors: "none" })
            await page.evaluate(() =>
              (window as unknown as { fixtureTint(value: boolean): void }).fixtureTint(false)
            )
            await page.reload()
            await page.addScriptTag({ content: bundle.outputFiles[0].text })
            await page.locator("[data-composer]").waitFor()
            assert.equal(
              await page.evaluate(() =>
                (window as unknown as { fixtureTintEnabled(): boolean }).fixtureTintEnabled()
              ),
              false
            )
            assert.notEqual(await color(), "rgb(194, 29, 46)")
            await page.evaluate(() =>
              (window as unknown as { fixtureTint(value: boolean): void }).fixtureTint(true)
            )
            await page.waitForFunction(
              () =>
                getComputedStyle(document.querySelector('[data-message="0"] .bot-message-bubble')!)
                  .backgroundColor === "rgb(194, 29, 46)"
            )
            results.push({
              kind: "direct-user-tint",
              themes: ["light", "dark"],
              switchPersistence: true,
              groupPeerPhotoBlackNeutral: true,
              forcedColors: true,
              listenerBaseline: baselineListeners
            })
          }
          await page.bringToFront()
          await page.evaluate(
            `window.themeMediaEvents=[];window.themeMedia=matchMedia('(prefers-color-scheme: dark)');window.themeMedia.addEventListener('change',event=>window.themeMediaEvents.push({matches:event.matches,visible:document.visibilityState}));`
          )
          await page.emulateMedia({ colorScheme: "dark" })
          await page.waitForFunction("window.themeMediaEvents.some(event=>event.matches)")
          await page.evaluate(() =>
            (window as unknown as { fixtureSystem(): void }).fixtureSystem()
          )
          assert.equal(
            await page.evaluate(() => document.documentElement.dataset.colorScheme),
            "dark"
          )
          await page.emulateMedia({ colorScheme: "light" })
          await page.waitForFunction("window.themeMediaEvents.some(event=>!event.matches)")
          try {
            await page.waitForFunction(
              () => document.documentElement.dataset.colorScheme === "light"
            )
          } catch (error) {
            console.error(
              "System theme state",
              await page.evaluate(() => ({
                scheme: document.documentElement.dataset.colorScheme,
                match: matchMedia("(prefers-color-scheme: dark)").matches,
                settings: localStorage.getItem("cmb:theme-settings"),
                resolved: (
                  window as unknown as { fixtureThemeValue(): string }
                ).fixtureThemeValue(),
                visibility: document.visibilityState
              }))
            )
            await page.screenshot({ path: resolve(output, "system-theme-failure.png") })
            throw error
          }
          await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" })
          await page.locator("[data-inspect]").focus()
          await page.keyboard.press("Enter")
          const reduced = page.locator(".bot-inspector-panel")
          await reduced.waitFor()
          assert.equal(
            await reduced.evaluate((element) => getComputedStyle(element).animationName),
            "none"
          )
          await reduced.getByRole("button", { name: "关闭详情面板", exact: true }).focus()
          await page.keyboard.press("Enter")
          await reduced.waitFor({ state: "detached" })
          await page.reload()
          await page.addScriptTag({ content: bundle.outputFiles[0].text })
          assert.equal(
            await page.evaluate(() => document.documentElement.dataset.colorScheme),
            "light"
          )
          assert.deepEqual(errors, [])
        } finally {
          await context.close()
        }
      }
    }
    await writeFile(
      resolve(output, "results.json"),
      JSON.stringify({ passed: results.length, results }, null, 2) + "\n"
    )
    console.log(`Bot presentation matrix: ${results.length} checks passed`)
  } finally {
    await browser.close()
    console.log("Bot presentation browser end", new Date().toISOString())
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
