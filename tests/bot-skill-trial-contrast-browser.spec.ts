import { viteUrlAssetsFixture } from "./fixtures/vite-url-assets"
/** Real trial and attachment cards, bubble CSS and persona colors; no App transport/model. */
import assert from "node:assert/strict"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"

async function main() {
  const root = process.cwd(),
    renderer = resolve(root, "src/renderer/src"),
    output = resolve(root, "output/skill-trial-contrast")
  await mkdir(output, { recursive: true })
  const trial = {
    id: "trial-color",
    skillId: "skill-color",
    name: "按月份和区域生成工单月报",
    version: 1,
    inputs: "打开本次指定网页，生成 2026-10 西区的工单月报，返回实际结果和页面截图。",
    criteria: "核对新一期数据、项目名称、每项数量与总数；截图必须来自本次结果页面。"
  }
  const attachment = {
    id: "uploaded-records",
    conversationId: "conversation",
    sequence: 1,
    sender: "user",
    botId: null,
    text: "核对附件",
    runId: null,
    replyTo: null,
    createdAt: 123,
    attachments: ["csv"],
    attachmentFiles: [
      {
        id: "csv",
        conversationId: "conversation",
        runId: null,
        name: "project-records.csv",
        mime: "text/csv",
        size: 279,
        sha256: "a".repeat(64),
        createdAt: 123,
        origin: "upload"
      }
    ]
  }
  const instructions =
    "执行本次保存的技能版本。保留任务输入与验收条件；未完成时说明实际卡点，不自行标记通过。"
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
      contents: `import React from'react';import{createRoot}from'react-dom/client';
        import{BotSkillTrialMessage}from'./src/renderer/src/components/bots/BotSkillTrialMessage';
        import{BotMessageAttachments}from'./src/renderer/src/components/bots/BotMessageAttachments';
        import{botUserBubbleTint}from'./src/renderer/src/lib/use-bot-user-bubble-tint';
        import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';
        import'./src/renderer/src/components/bots/bot-workspace.css';
        const settings=document.documentElement.dataset;
        applyThemePreference(settings.fixtureTheme);
        const tint=botUserBubbleTint('direct',{id:'trial-bot',avatarColor:settings.fixtureColor},settings.fixtureColor!=='neutral');
        createRoot(document.getElementById('root')).render(<main className="bot-workspace min-h-screen bg-background p-10 text-foreground"><div className="bot-transcript-content" data-user-bubble-tint={!!tint||undefined} style={tint}><article className="bot-message" data-sender="user"><div className="bot-message-bubble"><BotSkillTrialMessage trial={${JSON.stringify(trial)}} text={${JSON.stringify(instructions)}}/><BotMessageAttachments message={${JSON.stringify(attachment)}} openImage={()=>{}} openFile={()=>{window.fixtureOpened=true;}} saveFile={(id,artifact)=>{window.fixtureSaves=[...(window.fixtureSaves||[]),{id,artifact}];}}/></div></article></div></main>);`
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    outfile: resolve(output, "fixture.js"),
    jsx: "automatic",
    alias: { "@": renderer },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.DEV": "false",
      __APP_VERSION__: '"contrast-test"'
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
          // This Bot attachment fixture never opens a standard conversation.
          builder.onResolve({ filter: /^@\/lib\/thread-context$/ }, () => ({
            path: "unused-standard-thread",
            namespace: "contrast"
          }))
          builder.onLoad({ filter: /.*/, namespace: "contrast" }, () => ({
            loader: "js",
            contents:
              "export const useThreadStateSelector=(_id,selector)=>selector({workspacePath:null,workspaceFiles:[]});"
          }))
        }
      }
    ]
  })
  const style =
    css.build(scanner.scan()) +
    (bundle.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "")
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const results = []
  try {
    for (const theme of ["light", "dark"] as const) {
      for (const color of ["orange", "cyan", "blue", "neutral"]) {
        const context = await browser.newContext({
          viewport: { width: 900, height: 720 },
          colorScheme: theme,
          reducedMotion: "reduce"
        })
        try {
          const page = await context.newPage(),
            errors: string[] = []
          page.on("pageerror", (error) => errors.push(error.message))
          page.setDefaultTimeout(5000)
          await page.route("**/*", (route) =>
            route.request().url() === "http://127.0.0.1/trial"
              ? route.fulfill({
                  contentType: "text/html",
                  body: `<html lang="zh-CN" data-fixture-theme="codex-${theme}" data-fixture-color="${color}"><head><style>${style}</style></head><body><div id="root"></div></body></html>`
                })
              : route.abort()
          )
          await page.goto("http://127.0.0.1/trial")
          await page.addScriptTag({
            content: bundle.outputFiles.find((f) => f.path.endsWith(".js"))!.text
          })
          const card = page.getByRole("region", { name: "技能试跑", exact: true })
          await card.getByRole("heading", { name: `试跑 · ${trial.name}`, exact: true }).waitFor()
          assert.equal(await card.getByText(instructions, { exact: true }).isVisible(), false)
          const summary = card.locator("summary")
          await summary.focus()
          await page.keyboard.press("Enter")
          await card.getByText(instructions, { exact: true }).waitFor()
          await summary.hover()
          const measureContrast = (element: HTMLElement) => {
            const bubble = element.closest(".bot-message-bubble")!
            const canvas = document.createElement("canvas")
            canvas.width = canvas.height = 1
            const context = canvas.getContext("2d", { willReadFrequently: true })!
            const values = []
            for (const node of element.querySelectorAll("h3,span,dt,dd,summary,p")) {
              if (!node.textContent?.trim()) continue
              // Composite each text node's own paint layers, including its card and hover fill.
              const layers = []
              for (let current: Element | null = node; current; current = current.parentElement)
                layers.push(getComputedStyle(current).backgroundColor)
              context.fillStyle = "Canvas"
              context.fillRect(0, 0, 1, 1)
              for (const layer of layers.reverse()) {
                context.fillStyle = layer
                context.fillRect(0, 0, 1, 1)
              }
              const background = [...context.getImageData(0, 0, 1, 1).data]
              if (background[3] !== 255) throw new Error("Non-opaque screen")
              const style = getComputedStyle(node)
              context.clearRect(0, 0, 1, 1)
              context.fillStyle = style.color
              context.fillRect(0, 0, 1, 1)
              const foreground = [...context.getImageData(0, 0, 1, 1).data]
              let opacity = foreground[3] / 255
              for (
                let current: Element | null = node;
                current && current !== bubble;
                current = current.parentElement
              )
                opacity *= Number(getComputedStyle(current).opacity)
              let fg = 0,
                bg = 0
              for (let i = 0; i < 3; i++) {
                const text = (foreground[i] * opacity + background[i] * (1 - opacity)) / 255
                const fill = background[i] / 255
                const weight = [0.2126, 0.7152, 0.0722][i]
                fg += weight * (text <= 0.04045 ? text / 12.92 : ((text + 0.055) / 1.055) ** 2.4)
                bg += weight * (fill <= 0.04045 ? fill / 12.92 : ((fill + 0.055) / 1.055) ** 2.4)
              }
              values.push({
                text: node.textContent,
                color: style.color,
                ratio: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
              })
            }
            return { overflow: element.scrollWidth - element.clientWidth, values }
          }
          const contrast = await card.evaluate(measureContrast)
          const files = page.getByLabel("消息附件", { exact: true })
          await files.getByRole("button", { name: "查看附件 project-records.csv" }).waitFor()
          const attachmentContrast = await files.evaluate(measureContrast)
          const fileButton = files.getByRole("button", { name: "查看附件 project-records.csv" })
          await fileButton.hover()
          const attachmentHoverContrast = await files.evaluate(measureContrast)
          const saveButton = files.getByRole("button", {
            name: "保存 project-records.csv",
            exact: true
          })
          await saveButton.click()
          assert.equal(
            await page.evaluate(() =>
              Boolean((window as unknown as { fixtureOpened?: boolean }).fixtureOpened)
            ),
            false,
            "Saving must not open the preview"
          )
          await saveButton.focus()
          await page.keyboard.press("Enter")
          assert.deepEqual(
            await page.evaluate(
              () => (window as unknown as { fixtureSaves?: unknown[] }).fixtureSaves
            ),
            Array.from({ length: 2 }, () => ({
              id: "csv",
              artifact: attachment.attachmentFiles[0]
            })),
            "Mouse and keyboard saving must retain the original scoped file identity"
          )
          assert.equal(await files.locator("button button").count(), 0)
          await fileButton.focus()
          await page.keyboard.press("Enter")
          assert.equal(
            await page.evaluate(() =>
              Boolean((window as unknown as { fixtureOpened?: boolean }).fixtureOpened)
            ),
            true
          )
          await page.screenshot({
            path: resolve(output, `${theme}-${color}.png`),
            animations: "disabled"
          })
          await summary.focus()
          await page.keyboard.press("Space")
          assert.equal(await card.getByText(instructions, { exact: true }).isVisible(), false)
          assert.equal(
            await summary.evaluate((element) => element === document.activeElement),
            true
          )
          assert.deepEqual(errors, [])
          assert.ok(contrast.overflow <= 1)
          assert.ok(attachmentContrast.overflow <= 1)
          results.push({
            theme,
            color,
            contrast,
            attachmentContrast,
            attachmentHoverContrast,
            detailsKeyboardToggle: true,
            attachmentKeyboardOpen: true,
            attachmentMouseAndKeyboardSave: true,
            errors
          })
        } finally {
          await context.close()
        }
      }
    }
  } finally {
    await browser.close()
  }
  await writeFile(
    resolve(output, "result.safe.json"),
    JSON.stringify(
      {
        boundary:
          "Real React/component/tint/CSS in Chrome; synthetic content; no model/App acceptance",
        results
      },
      null,
      2
    ) + "\n"
  )
  const failures = results.flatMap((result) =>
    [
      ...result.contrast.values,
      ...result.attachmentContrast.values,
      ...result.attachmentHoverContrast.values
    ]
      .filter((value) => value.ratio < 4.5)
      .map((value) => ({ theme: result.theme, color: result.color, ...value }))
  )
  assert.deepEqual(
    failures,
    [],
    "All trial and attachment text, including hovered controls, needs 4.5:1 contrast"
  )
  console.log(JSON.stringify({ passed: results.length, output }))
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
