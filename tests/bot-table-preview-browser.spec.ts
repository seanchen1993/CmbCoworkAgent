import { viteUrlAssetsFixture } from "./fixtures/vite-url-assets"
/** Real file service, disposable document process and React file preview. */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import * as XLSX from "xlsx"
import { BotStore } from "../src/main/bots/store"
import { BotArtifacts } from "../src/main/bots/artifacts"
import { BotDocumentReader } from "../src/main/bots/document-reader"
import type { BotFilePreviewRequest } from "../src/shared/bot-file-preview"

async function main() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-table-ui-"))
  const renderer = resolve("src/renderer/src")
  const output = resolve("output/bot-table-preview")
  await mkdir(output, { recursive: true })
  const store = new BotStore(join(directory, "state.sqlite"))
  const files = new BotArtifacts(
    join(directory, "objects"),
    store,
    new BotDocumentReader({
      entry: resolve("src/main/bots/document-worker-entry.ts"),
      execArgv: ["--import", "tsx"]
    })
  )
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const errors: string[] = []
  try {
    const { conversationId } = store.createBot({ nonce: "table-bot", name: "表格验证" })
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["名称", "状态"],
        ['<img src=x onerror="window.UNSAFE=1">', "=1+1"]
      ]),
      "总览"
    )
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(
        Array.from({ length: 53 }, (_, row) =>
          Array.from({ length: 23 }, (_, column) => `${row}:${column}`)
        )
      ),
      "运行明细"
    )
    await files.publish(
      {
        id: "table",
        conversationId,
        runId: null,
        name: "研发验收报告.xlsx",
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      },
      XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })
    )
    const highlight = await build({
      entryPoints: [join(renderer, "components/tabs/code-highlight-worker.ts")],
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      logLevel: "silent"
    })
    const bundle = await build({
      stdin: {
        contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{BotFilePreview}from'./src/renderer/src/components/bots/BotFilePreview';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';import{Toaster}from'sonner';import './src/renderer/src/components/bots/bot-workspace.css';
        window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');
        window.api={bots:{filePreview:window.fixtureRead,cancelFilePreview:window.fixtureCancel}};
        function Fixture(){const[open,setOpen]=useState(false);return <><button onClick={()=>setOpen(true)}>预览表格</button>{open&&<BotFilePreview id="table" conversationId=${JSON.stringify(conversationId)} close={()=>setOpen(false)}/>}<Toaster/></>}
        createRoot(document.getElementById('root')).render(<Fixture/>);`,
        resolveDir: process.cwd(),
        loader: "tsx"
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      outfile: join(directory, "preview.js"),
      jsx: "automatic",
      alias: { "@": renderer },
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
      plugins: [
        viteUrlAssetsFixture(),
        {
          name: "highlight-worker",
          setup(builder) {
            builder.onResolve({ filter: /code-highlight-worker\?worker$/ }, () => ({
              path: "highlight",
              namespace: "worker"
            }))
            builder.onLoad({ filter: /.*/, namespace: "worker" }, () => ({
              loader: "js",
              contents: `export default class extends Worker {constructor(options){const url=URL.createObjectURL(new Blob([${JSON.stringify(highlight.outputFiles[0].text)}],{type:'text/javascript'}));super(url,options);URL.revokeObjectURL(url);}}`
            }))
          }
        }
      ]
    })
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
    const context = await browser.newContext({
      viewport: { width: 1280, height: 880 },
      permissions: ["clipboard-read", "clipboard-write"]
    })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    page.on("pageerror", (error) => errors.push(error.message))
    let fail = false
    await page.exposeFunction("fixtureRead", (input: BotFilePreviewRequest) => {
      if (fail) {
        fail = false
        throw new Error("夹具：本次读取中断")
      }
      return files.previews.read(input)
    })
    await page.exposeFunction(
      "fixtureCancel",
      (input: { conversationId: string; requestId: string }) => files.previews.cancel(input)
    )
    await page.route("http://127.0.0.1:39179/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<html><body style="margin:0"><div id="root"></div></body></html>'
      })
    )
    await page.goto("http://127.0.0.1:39179/")
    await page.addStyleTag({ content: css.build(scanner.scan()) })
    for (const asset of bundle.outputFiles)
      if (asset.path.endsWith(".css")) await page.addStyleTag({ content: asset.text })
      else if (asset.path.endsWith(".js")) await page.addScriptTag({ content: asset.text })
    await page.getByRole("button", { name: "预览表格", exact: true }).click()
    await page.getByRole("button", { name: "单元格 A2", exact: true }).click()
    assert.equal(
      await page.getByLabel("所选单元格内容").textContent(),
      '<img src=x onerror="window.UNSAFE=1">'
    )
    assert.equal(await page.getByRole("dialog").locator("img").count(), 0)
    await page.getByRole("combobox", { name: "选择工作表" }).click()
    await page.getByRole("option", { name: "运行明细", exact: true }).click()
    const first = page.getByRole("button", { name: "单元格 A1", exact: true })
    await first.waitFor()
    assert.equal(await page.locator("[data-cell]").count(), 1000)
    assert.equal(await page.locator('[data-cell][tabindex="0"]').count(), 1)
    await first.focus()
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("ArrowDown")
    assert.equal(await page.getByLabel("所选单元格内容").textContent(), "1:1")
    await page.getByRole("button", { name: "复制单元格", exact: true }).click()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "1:1")
    await page.screenshot({ path: join(output, "table-light.png"), animations: "disabled" })
    fail = true
    await page.getByRole("button", { name: "下一页行", exact: true }).click()
    await page.getByRole("alert").getByText("夹具：本次读取中断").waitFor()
    assert.equal(await page.locator("[data-cell]").count(), 0)
    await page.getByRole("button", { name: "重新加载", exact: true }).click()
    await page.getByRole("button", { name: "单元格 A51", exact: true }).waitFor()
    await page.getByRole("button", { name: "后面的列", exact: true }).click()
    await page.getByRole("button", { name: "单元格 U51", exact: true }).waitFor()
    assert.equal(await page.locator("[data-cell]").count(), 9)
    assert.equal(
      await page.getByRole("button", { name: "下一页行", exact: true }).isDisabled(),
      true
    )
    await page.getByRole("button", { name: "复制本页表格", exact: true }).click()
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      "50:20\t50:21\t50:22\n51:20\t51:21\t51:22\n52:20\t52:21\t52:22"
    )
    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(value: string): void }).fixtureTheme("codex-dark")
    )
    await page.setViewportSize({ width: 640, height: 620 })
    await page.waitForFunction(() => {
      const box = document.querySelector('[role="dialog"]')?.getBoundingClientRect()
      return box && box.y >= 0 && box.bottom <= innerHeight
    })
    await page.screenshot({ path: join(output, "table-dark-narrow.png"), animations: "disabled" })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true
    )
    await page.getByRole("combobox", { name: "选择工作表" }).click()
    await page.getByRole("option", { name: "总览", exact: true }).click()
    await page.getByRole("button", { name: "单元格 A1", exact: true }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "上一页行", exact: true }).isDisabled(),
      true
    )
    await page.keyboard.press("Escape")
    await page.getByRole("dialog").waitFor({ state: "hidden" })
    assert.deepEqual(errors, [])
    console.log(
      "PASS real table preview: worker, sheet/row/column navigation, keyboard, clipboard, failed-read retry, bounded DOM and narrow themes"
    )
  } finally {
    await browser.close()
    await files.close()
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
