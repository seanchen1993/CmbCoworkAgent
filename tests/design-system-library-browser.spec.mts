import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { fileURLToPath } from "node:url"
import { buildSync } from "esbuild"
import { chromium } from "playwright"
import { DesignSystemLibrary } from "../src/main/services/design/system-library"
import {
  extractDesignStyleSnapshot,
  buildDesignSystemMarkdown
} from "../src/main/services/design/system-style-snapshot"

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "design-system-ui-"))
const library = new DesignSystemLibrary(path.join(temporary, "library"))
const builtin = {
  id: "builtin-sample",
  name: "内置示例",
  description: "内置规范",
  ownership: "builtin" as const,
  path: "/builtin/DESIGN.md"
}
const builtinContent = "# 内置示例\n\n正文 14px，按钮圆角 8px。"
const bundle = buildSync({
  entryPoints: [
    fileURLToPath(new URL("./support/design-system-library-fixture.tsx", import.meta.url))
  ],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  tsconfig: "tsconfig.web.json",
  define: { "process.env.NODE_ENV": '"development"', "import.meta.env": "{}" }
}).outputFiles[0].contents
const cssRoot = path.resolve("out/renderer/assets")
const css = fs.existsSync(cssRoot)
  ? fs
      .readdirSync(cssRoot)
      .filter((name) => name.endsWith(".css"))
      .map((name) => fs.readFileSync(path.join(cssRoot, name), "utf8"))
      .join("\n")
  : ""
const server = http.createServer((request, response) => {
  if (request.url === "/app.js") {
    response.setHeader("content-type", "text/javascript")
    response.end(bundle)
  } else if (request.url === "/style.css") {
    response.setHeader("content-type", "text/css")
    response.end(css)
  } else
    response.end(
      '<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'
    )
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const executablePath =
  process.env.CHROMIUM_EXECUTABLE_PATH ||
  (fs.existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : undefined)
const browser = await chromium.launch({ headless: true, executablePath })
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } })
  page.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on("pageerror", (error) => {
    errors.push(error.message)
    console.error("Renderer error:", error.message)
  })
  await page.exposeFunction("systemList", () => [builtin, ...library.list()])
  await page.exposeFunction("systemRead", (id: string) => {
    if (id === builtin.id) return { success: true, system: builtin, content: builtinContent }
    const result = library.read(id)
    return { success: true, system: result.info, content: result.content }
  })
  await page.exposeFunction("systemSave", (draft: Parameters<typeof library.save>[0]) => ({
    success: true,
    system: library.save(draft)
  }))
  // tsx preserves function names through a helper; serialized callbacks need it in the page.
  await page.addInitScript("window.__name = (target) => target")
  await page.addInitScript(() => {
    const host = window as any
    host.api = {
      requirements: { getToken: async () => ({ success: false, error: "测试环境未连接需求服务" }) },
      design: {
        listSystems: () => host.systemList(),
        readSystem: (id: string) => host.systemRead(id),
        saveSystem: (draft: unknown) => host.systemSave(draft),
        listTemplates: async () => [],
        listImportedTemplates: async () => [],
        selectSystemFile: async () => ({
          success: true,
          draft: { name: "替换稿名称", content: "# 更新稿\n\n按钮圆角 12px。", source: "file" }
        }),
        exportSystem: async (content: string) => {
          host.exportedMarkdown = content
          return { success: true }
        },
        onSystemExtractionProgress: () => () => {},
        cancelSystemExtraction: async () => true,
        openImportBrowser: async () => ({ success: true }),
        extractSystem: (request: unknown) =>
          new Promise((resolve) => {
            host.lastExtractionRequest = request
            host.finishExtraction = () =>
              resolve(
                host.extractionFailure || {
                  success: true,
                  draft: { name: "网页规范", content: "# 网页规范\n\n字体 16px", source: "web" }
                }
              )
          })
      }
    }
  })
  const address = server.address() as import("node:net").AddressInfo
  await page.goto(`http://127.0.0.1:${address.port}`)
  await page.getByRole("button", { name: "选择设计系统", exact: true }).click()
  await page.getByRole("button", { name: "复制到我的并编辑", exact: true }).click()
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("我的品牌规范")
  await page.getByRole("button", { name: "保存到我的", exact: true }).click()
  await page.getByRole("button", { name: "用于本次设计", exact: true }).waitFor()
  assert.equal(
    await page.getByTestId("selected-system").textContent(),
    "none",
    "Save alone must not apply a system"
  )
  const first = library.list().find((item) => item.isLatest)!
  await page.getByRole("button", { name: "用于本次设计", exact: true }).click()
  assert.equal(await page.getByTestId("selected-system").textContent(), first.id)
  await page.getByRole("button", { name: "更换设计系统", exact: true }).click()
  await page.getByRole("button", { name: "上传新版本", exact: true }).click()
  await page
    .getByRole("textbox", { name: "design.md 内容", exact: true })
    .filter({ hasText: /更新稿/ })
    .waitFor()
  assert.equal(
    await page.getByRole("textbox", { name: "名称", exact: true }).inputValue(),
    "我的品牌规范",
    "Replacing Markdown must retain the system identity and name"
  )
  await page.getByRole("button", { name: "下载 design.md", exact: true }).click()
  assert.match(await page.evaluate(() => (window as any).exportedMarkdown), /更新稿/)
  await page.getByRole("button", { name: "保存新版本", exact: true }).click()
  await page.getByText("我的 · v2", { exact: true }).first().waitFor()
  assert.equal(library.read(first.id).content, builtinContent)
  assert.equal(await page.getByTestId("selected-system").textContent(), first.id)
  await page.getByRole("button", { name: "关闭", exact: true }).first().click()
  await page.getByRole("button", { name: "查看本次规范", exact: true }).click()
  await page.getByRole("dialog").getByText("我的 · v1", { exact: true }).waitFor()
  assert.equal(await page.getByRole("button", { name: "编辑", exact: true }).count(), 0)
  await page.getByRole("button", { name: "关闭", exact: true }).first().click()
  await page.getByRole("button", { name: "更换设计系统", exact: true }).click()
  await page.getByRole("button", { name: "上传 design.md", exact: true }).click()
  await page.locator('input[type="file"]').setInputFiles({
    name: "design.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 文件规范\n\n来自上传文件")
  })
  await page.getByRole("button", { name: "重新上传修改稿", exact: true }).click()
  await page.getByRole("button", { name: "保存并用于本次设计", exact: true }).click()
  await page.getByRole("button", { name: "更换设计系统", exact: true }).waitFor()
  assert.equal(library.list().filter((item) => item.isLatest).length, 2)
  await page.getByRole("button", { name: "更换设计系统", exact: true }).click()
  await page.getByRole("button", { name: "从网页提取", exact: true }).click()
  await page.getByRole("textbox", { name: "页面链接", exact: true }).fill("https://example.com")
  await page.getByRole("button", { name: "开始提取", exact: true }).click()
  await page.getByRole("button", { name: "取消提取", exact: true }).click()
  await page.evaluate(() => (window as any).finishExtraction())
  assert.equal(
    await page.getByRole("textbox", { name: "名称", exact: true }).count(),
    0,
    "Late extraction cannot reopen the editor"
  )
  await page.getByRole("button", { name: "开始提取", exact: true }).click()
  await page.evaluate(() => (window as any).finishExtraction())
  await page.getByRole("textbox", { name: "名称", exact: true }).waitFor()
  const screenshotDirectory = process.env.DESIGN_SYSTEM_QA_DIR || temporary
  fs.mkdirSync(screenshotDirectory, { recursive: true })
  await page.screenshot({
    path: path.join(screenshotDirectory, "library-editor.png"),
    fullPage: true
  })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await page.locator('[role="dialog"]').evaluate((el) => el.scrollWidth > el.clientWidth),
    false,
    "Dialog should fit narrow widths"
  )
  await page.getByRole("button", { name: "取消", exact: true }).click()
  await page.getByRole("button", { name: "返回设计历史", exact: true }).click()
  await page.getByRole("button", { name: "设计系统库", exact: true }).click()
  await page.getByRole("tab", { name: /我的/ }).click()
  assert.equal(await page.getByRole("button", { name: "用于本次设计", exact: true }).count(), 0)
  await page.getByRole("button", { name: "从网页提取", exact: true }).click()
  await page.getByRole("button", { name: "内置浏览器当前页", exact: true }).click()
  await page.getByRole("button", { name: "确认浏览器页面", exact: true }).click()
  await page.getByRole("button", { name: "确认页面并提取规范", exact: true }).click()
  assert.equal(
    await page.evaluate(() => (window as any).lastExtractionRequest.source),
    "current-browser"
  )
  await page.evaluate(() => {
    const host = window as any
    host.extractionFailure = { success: false, needsUserAction: true, error: "请完成登录" }
    host.finishExtraction()
  })
  await page.getByRole("alert").filter({ hasText: "请完成登录" }).waitFor()
  await page.evaluate(() => {
    ;(window as any).extractionFailure = null
  })
  await page.getByRole("button", { name: "确认页面并提取规范", exact: true }).click()
  await page.evaluate(() => (window as any).finishExtraction())
  await page.getByRole("textbox", { name: "名称", exact: true }).waitFor()
  assert.equal(await page.getByTestId("browser-confirmation").count(), 0)
  assert.deepEqual(errors, [])

  // Run the actual computed-style extractor against a real rendered page.
  const stylesPage = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  await stylesPage.setContent(
    '<style>body{background:rgb(245,246,247);color:rgb(20,30,40);font:16px/24px sans-serif}button{padding:12px 24px;border-radius:10px;background:rgb(40,80,160);color:white}</style><h1>工作台</h1><button>保存</button><input type="password" value="secret-password">'
  )
  await stylesPage.evaluate("window.__name = (target) => target")
  const snapshot = await stylesPage.evaluate(extractDesignStyleSnapshot)
  assert.equal(snapshot.elements.button!.borderRadius, "10px")
  const markdown = buildDesignSystemMarkdown("工作台", "https://example.com", snapshot)
  assert.match(markdown, /rgb\(40, 80, 160\)/)
  assert.match(markdown, /12px 24px/)
  assert.doesNotMatch(markdown, /secret-password/)
  const restored = new DesignSystemLibrary(library.storageDir)
  assert.equal(restored.read(first.id).content, builtinContent)
  console.log(
    `PASS design system UI, immutable persistence and computed-style extraction${process.env.DESIGN_SYSTEM_QA_DIR ? `; screenshots: ${screenshotDirectory}` : ""}`
  )
} finally {
  await browser.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(temporary, { recursive: true, force: true })
}
