/** Real React navigation against the real main-process manager with a deterministic model. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { DatabaseSync } from "node:sqlite"
import { basename, dirname, resolve } from "node:path"
import { build, transformSync } from "esbuild"
import { readFileSync } from "node:fs"
import { prepareEditableSource } from "../src/main/services/design/direct-edit"
import { chromium } from "playwright"
import { NativeSqliteAdapter } from "../src/main/db/native-sqlite-adapter"
import { DesignSessionStore } from "../src/main/services/design/session-store"
import { DesignRunManager } from "../src/main/services/design/run-manager"
import { inspectDesignDocument } from "../src/shared/design-progressive"
import { executeDesignPatch } from "../src/main/services/design/patch-executor"
import {
  designPatchStyleProbe,
  inspectDesignPatchStyles
} from "../src/main/services/design/artifact-validator"
import {
  createDesignState,
  type DesignRunEvent,
  type DesignRunRequest,
  type DesignSessionChange
} from "../src/shared/managed-design-session"

const bundle = await build({
  stdin: {
    contents: `
    import React, { useEffect, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { DesignView } from './src/renderer/src/components/design/DesignView';
    import { BrowserPageConfirmationBar } from './src/renderer/src/components/browser/BrowserPageConfirmationBar';
    import { useBrowserViewLifecycle } from './src/renderer/src/components/browser/useBrowserViewLifecycle';
    import { onOpenResourcePanelOverlay, onCloseResourcePanelOverlay } from './src/renderer/src/lib/resource-panel-overlay-events';
    import { applyThemePreference } from './src/renderer/src/lib/theme-preference';
    import { DEFAULT_THEME_ID } from './src/renderer/src/lib/theme-registry';
    window.applyDesignTestTheme = (dark) => applyThemePreference(dark ? 'codex-dark' : DEFAULT_THEME_ID);
    function Fixture() {
      const [show, setShow] = useState(true);
      const [browserOpen, setBrowserOpen] = useState(false);
      useEffect(() => onOpenResourcePanelOverlay(({mode}) => { if(mode==='browser') setBrowserOpen(true); }), []);
      useEffect(() => onCloseResourcePanelOverlay((mode) => { if(!mode||mode==='browser') setBrowserOpen(false); }), []);
      useBrowserViewLifecycle({currentThreadId:null,harnessSessionThreadId:null,mainView:'design',
        rightPanelCollapsed:true,isAgentFocusActive:false,overlayModule:browserOpen?'browser':null,onRequestBrowserPanel:()=>{}});
      return <><button id="toggle-mode" onClick={() => setShow(!show)}>切换模式</button>
        {browserOpen && <BrowserPageConfirmationBar loading={false} url="https://example.com/design"/>}
        <div style={{height:'900px'}}>{show ? <DesignView/> : <div>其他模式</div>}</div></>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `,
    resolveDir: process.cwd(),
    loader: "tsx"
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  alias: { "@": resolve("src/renderer/src") },
  define: {
    "import.meta.env": '{"VITE_LEANSTAR_REQUIREMENTS_MOCK":"true"}',
    "process.env.NODE_ENV": '"test"'
  },
  plugins: [
    {
      name: "fixture-app-store",
      setup(builder) {
        builder.onLoad({ filter: /\/lib\/store\.ts$/ }, () => ({
          contents: `const state={loadModels:async()=>{},loadProviders:async()=>{}}; export function useAppStore(select){return select?select(state):state;}`,
          loader: "js"
        }))
      }
    }
  ]
})
const reactRuntime = await build({ stdin: { contents: `import * as React from 'react'; import {createRoot} from 'react-dom/client'; window.React=React; window.ReactDOM={createRoot};`, resolveDir: process.cwd() }, bundle: true, write: false, platform: "browser", format: "iife" })
const vueRuntime = process.env.DESIGN_VUE_RUNTIME ? readFileSync(process.env.DESIGN_VUE_RUNTIME, "utf8") : null
const uiStyles = process.env.DESIGN_UI_STYLES
const server = createServer((_request, response) => {
  if (uiStyles && _request.url === "/ui.css") {
    response.setHeader("Content-Type", "text/css")
    response.end(readFileSync(uiStyles))
    return
  }
  if (uiStyles && /\.(woff2?|ttf)$/.test(_request.url ?? "")) {
    response.end(readFileSync(resolve(dirname(uiStyles), basename(_request.url!))))
    return
  }
  if (_request.url === "/react.js" || _request.url === "/babel.js" || _request.url === "/vue.js") {
    response.setHeader("Content-Type", "text/javascript")
    response.end(_request.url === "/react.js" ? reactRuntime.outputFiles[0].contents : _request.url === "/vue.js" ? vueRuntime ?? "" :
      `document.addEventListener('DOMContentLoaded',async()=>{for(const source of document.querySelectorAll('script[type="text/babel"]')){const text=await window.parent.compileDesignJsx(source.textContent);const script=document.createElement('script');script.dataset.designHostRuntime='test-compiler';script.textContent=text;document.body.append(script)}});`)
    return
  }
  response.setHeader(
    "Content-Type",
    _request.url === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8"
  )
  response.end(
    _request.url === "/app.js"
      ? bundle.outputFiles[0].contents
      : `${uiStyles ? '<link rel="stylesheet" href="/ui.css">' : ''}<div id="root"></div><script src="/app.js"></script>`
  )
})
await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", resolveReady))
const address = server.address() as { port: number }
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined
})
const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
const emitters: Array<(event: DesignRunEvent) => void> = []
const completions: Array<() => void> = []
const requests: DesignRunRequest[] = []
let aborted = 0
let deliver: (change: DesignSessionChange) => void = () => undefined
const subscriptions = new Set<string>()
const manager = new DesignRunManager(new DesignSessionStore(db), {
  execute: (_request, _id, emit) => {
    requests.push(_request)
    emitters.push(emit)
    return new Promise<void>((done) => completions.push(done))
  },
  abort: () => {
    aborted++
  },
  finalize: (event) => ({ ...event, artifactPath: "/workspace/design.html" }),
  publish: (change) =>
    deliver(subscriptions.has(change.id) ? change : { ...change, snapshot: undefined })
})
manager.create({
  id: "ds_browser",
  meta: { id: "ds_browser", title: "浏览器回归", createdAt: 1, updatedAt: 1 },
  state: {
    ...createDesignState(),
    selectedModelId: "custom:test",
    designLink: "https://legacy-design-reference.example.com/private"
  },
  workspacePath: "/workspace"
})
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors: string[] = []
  page.setDefaultTimeout(10000)
  page.on("console", (message) => {
    if (message.type() === "error") console.log("BROWSER", message.text())
  })
  page.on("pageerror", (error) => { errors.push(error.message); console.log("PAGE ERROR", error.stack) })
  await page.exposeFunction("designRpc", (method: string, ...args: unknown[]) => {
    const id = String(args[0])
    if (method === "list") return manager.list()
    if (method === "migrate") return manager.migrate(args[0] as never)
    if (method === "open") {
      subscriptions.add(id)
      return manager.get(id)
    }
    if (method === "close") {
      subscriptions.delete(id)
      return
    }
    if (method === "patch") return manager.patch(id, args[1] as never, args[2] as never)
    if (method === "inspectEditable") return manager.inspectEditable(id)
    if (method === "edit") return manager.edit(id, args[1] as never)
    if (method === "tweak") return manager.tweak(id, args[1] as never)
    if (method === "patchHistory")
      return manager.patchHistory(id, args[1] as "undo" | "redo", Number(args[2]))
    if (method === "previewVisible")
      return manager.previewVisible(id, String(args[1]), Number(args[2]))
    if (method === "start") return manager.start(args[0] as never)
    if (method === "setWorkspace") return manager.setWorkspace(id, String(args[1]))
    if (method === "stop") return manager.stop(id)
    if (method === "retry") return manager.retry(id, String(args[1]))
    if (method === "markRead") return manager.markRead(id, Number(args[1]))
    if (method === "delete") return manager.remove(id)
    if (method === "create") return manager.create(args[0] as never)
    throw new Error(`Unknown RPC ${method}`)
  })
  await page.exposeFunction("compileDesignJsx", (source: string) => transformSync(source, { loader: "jsx", jsx: "transform" }).code)
  deliver = (change) => {
    void page
      .evaluate(
        (payload) => (window as unknown as { deliver: (event: unknown) => void }).deliver(payload),
        change
      )
      .catch(() => undefined)
  }
  await page.addInitScript(() => {
    // Electron's preload belongs to the host, not sandboxed template thumbnails.
    if (window !== window.top) return
    if (!localStorage.getItem("design_browser_seeded")) {
      localStorage.setItem("design_last_session", "ds_browser")
      localStorage.setItem("design_browser_seeded", "1")
    }
    ;(window as unknown as { businessRuns: number }).businessRuns = 0
    window.addEventListener("message", (event) => {
      if (event.data?.type === "test-business-run")
        (window as unknown as { businessRuns: number }).businessRuns++
    })
    const listeners = new Set<(event: unknown) => void>()
    const importListeners = new Set<(event: unknown) => void>()
    const importFixture = { mode: "success", requests: [] as Array<{ requestId: string; source: string }>,
      pending: null as null | ((value: unknown) => void), opened: false, hiddenCount: 0 }
    ;(window as unknown as { importFixture: typeof importFixture }).importFixture = importFixture
    const templatePackage = { id: "fixture-template", name: "import.html", entryPath: "index.html", rootDir: "/workspace/template", html: "<h1>HTML 导入页面</h1>", files: ["index.html", "detail.html"], pages: ["index.html", "detail.html"], warnings: [], previewUrl: "about:blank", framework: "html", sourceKind: "html", importedAt: "2026-10-29", totalBytes: 25 }
    const templateFixture = { mode: "success", sources: [] as string[], pending: null as null | ((value: unknown) => void), templatePackage }
    ;(window as any).templateFixture = templateFixture
    ;(window as unknown as { deliver: (event: unknown) => void }).deliver = (event) => {
      for (const callback of listeners) callback(event)
    }
    const rpc = (method: string, ...args: unknown[]) =>
      (window as unknown as { designRpc: (...args: unknown[]) => Promise<unknown> }).designRpc(
        method,
        ...args
      )
    const sessions = Object.fromEntries(
      [
        "list",
        "inspectEditable",
        "edit",
        "tweak",
        "patchHistory",
        "previewVisible",
        "migrate",
        "open",
        "close",
        "patch",
        "start",
        "stop",
        "retry",
        "delete",
        "markRead",
        "create",
        "setWorkspace"
      ].map((method) => [method, (...args: unknown[]) => rpc(method, ...args)])
    )
    sessions.onChange = (callback: (event: unknown) => void) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }
    ;(window as unknown as { api: unknown }).api = {
      browser: {
        onPanelRequest: () => () => {},
        setBounds: async (_bounds: unknown, visible: boolean) => { if (!visible) importFixture.hiddenCount++ },
        disposeAllForRendererUnload: () => {}
      },
      design: {
        sessions,
        listImportedTemplates: async () => [],
        importTemplate: async (source: string) => {
          templateFixture.sources.push(source)
          if (templateFixture.mode === "error") return { error: "模板导入失败" }
          if (templateFixture.mode === "delayed") return new Promise((resolve) => { templateFixture.pending = resolve })
          return { template: templatePackage }
        },
        readTemplate: async ({ entryPath }: { entryPath: string }) => ({ template: { ...templatePackage, entryPath } }),
        listSystems: async () => [
          {
            id: "neutral-modern",
            name: "Neutral Modern",
            path: "/systems/neutral",
            category: "Core"
          },
          { id: "wealth", name: "财富管理", path: "/systems/wealth", category: "Core" }
        ],
        listTemplates: async () =>
          Array.from({ length: 5 }, (_, i) => ({
            name: `模板 ${i + 1}`,
            description: `模板说明 ${i + 1}`,
            path: `/templates/${i + 1}`,
            previewPath: `/templates/${i + 1}.html`,
            previewHtml: `<h1>模板内容 ${i + 1}</h1>`
          })),
        storeHtml: async () => ({ ok: true }),
        getArtifactPackageInfo: async () => ({ success: true, filePath: "/workspace/design.html", relatedFileCount: 0 }),
        saveArtifact: async (id: string) => ({ success: true, filePath: `/workspace/${id}.html` }),
        saveArtifactFile: async (filePath: string) => importFixture.mode === "save-fail"
          ? { success: false, error: "磁盘写入失败" } : { success: true, filePath },
        cancelUrlImport: async (requestId: string) => {
          importFixture.pending?.({ success: false, requestId, status: "cancelled", warnings: [] })
          importFixture.pending = null
          return true
        },
        finishUrlImport: async () => true,
        onUrlImportProgress: (callback: (event: unknown) => void) => {
          importListeners.add(callback)
          return () => importListeners.delete(callback)
        },
        openImportBrowser: async () => {
          importFixture.opened = true
          return importFixture.mode === "open-fail" ? { success: false, error: "打开失败测试" } : { success: true }
        },
        importFromUrl: async (request: { requestId: string; source: string }) => {
          importFixture.requests.push(request)
          if (importFixture.mode === "login") return { success: false, requestId: request.requestId,
            status: "needs_user_action", warnings: [], finalUrl: "https://example.com/design", error: "请先完成登录" }
          if (importFixture.mode === "waiting") {
            for (const callback of importListeners) callback({ requestId: request.requestId, stage: "waiting_render", message: "等待测试页面渲染" })
            return new Promise((resolve) => { importFixture.pending = resolve })
          }
          return {
          success: true,
          requestId: request.requestId,
          status: "completed",
          warnings: [],
          artifactPath: "/workspace/capture/index.html",
          finalUrl: "https://example.com/design",
          title: "链接导入",
          html: "<h1>链接页面</h1>"
          }
        },
        importPrototypeZip: async () => ({
          success: true,
          title: "原型导入",
          html: "<h1>原型页面</h1>",
          imageCount: 2
        }),
        syncContextFiles: async () => ({ success: true })
      },
      skills: { list: async () => [], listPlugins: async () => [], getDisabled: async () => [] },
      models: {
        list: async () => [{ id: "custom:test", name: "Test", model: "test", available: true }]
      },
      workspace: { get: async () => "/workspace", select: async () => "/workspace/selected" },
      file: {
        parseSelected: async () => ({
          success: true,
          attachment: {
            filename: "requirement.md",
            filePath: "/workspace/requirement.md",
            content: "需求附件内容",
            mimeType: "text/markdown",
            size: 20,
            truncated: false
          }
        }),
        selectCode: async () => ({ canceled: false, filePaths: ["/workspace/import.html"] }),
        selectPrototypeZip: async () => ({
          canceled: false,
          filePaths: ["/workspace/prototype.zip"]
        }),
        select: async () => ({
          canceled: false,
          files: [
            {
              filename: "requirement.md",
              filePath: "/workspace/requirement.md",
              grant: "test-grant",
              content: "需求附件内容",
              mimeType: "text/markdown",
              size: 20,
              truncated: false
            }
          ]
        }),
        readText: async (path: string) =>
          path.endsWith(".css")
            ? { success: true, content: "h1{color:rgb(12,34,56)}" }
            : {
                success: true,
                filename: "import.html",
                content:
                  '<html><head><link rel="stylesheet" href="./import.css"></head><body><h1>HTML 导入页面</h1></body></html>'
              },
        readDataUrl: async () => ({ success: false })
      }
    }
  })
  await page.goto(`http://127.0.0.1:${address.port}`)
  const input = page.locator("textarea").first()
  await input.waitFor()
  const workspace = page.getByTestId("design-workspace")
  const conversation = page.getByRole("region", { name: "设计对话", exact: true })
  const canvas = page.getByRole("region", { name: "设计页面", exact: true })
  const divider = page.getByRole("separator", { name: "调整对话与页面宽度", exact: true })
  assert.equal(await workspace.getAttribute("data-layout"), "conversation")
  assert.equal(await canvas.count(), 0, "an empty session has no blank preview pane")
  assert.equal(await divider.count(), 0)
  const composerBox = await input.boundingBox()
  assert.ok(composerBox && composerBox.width >= 700, "the initial composer fills a wide centered conversation")
  assert.ok(Math.abs(composerBox.x + composerBox.width / 2 - 720) < 20, "the composer is centered")
  if (process.env.DESIGN_WORKSPACE_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.DESIGN_WORKSPACE_SCREENSHOTS}-welcome.png`, animations: "disabled" })
    await page.setViewportSize({ width: 700, height: 900 })
    await page.evaluate(() => (window as any).applyDesignTestTheme(true))
    assert.equal(await conversation.evaluate(element => element.scrollWidth <= element.clientWidth), true)
    await page.screenshot({ path: `${process.env.DESIGN_WORKSPACE_SCREENSHOTS}-welcome-dark.png`, animations: "disabled" })
    await page.evaluate(() => (window as any).applyDesignTestTheme(false))
    await page.setViewportSize({ width: 1440, height: 1000 })
  }
  const startActions = page.getByRole("group", { name: "设计开始方式", exact: true })
  assert.equal(await startActions.getByRole("button").count(), 4, "the template picker sits beside the three context actions")
  for (const label of ["选择模板", "通过链接还原页面", "上传 HTML 文件", "关联代码"]) {
    assert.equal(await startActions.getByRole("button", { name: label, exact: false }).count(), 1)
  }
  assert.equal(await page.getByRole("button", { name: "上传截图", exact: true }).count(), 0,
    "screenshot upload has no duplicate standalone button")
  await page.getByRole("button", { name: "更多上传选项", exact: true }).click()
  const attachmentMenu = page.getByRole("menu")
  assert.equal(await attachmentMenu.getByRole("menuitem").count(), 2)
  assert.equal(await attachmentMenu.getByRole("menuitem", { name: "关联页面模板", exact: true }).count(), 0,
    "the welcome template shortcut has no duplicate entry in More")
  for (const label of ["上传截图", "上传原型图压缩包"]) {
    await attachmentMenu.getByRole("menuitem", { name: label, exact: true }).waitFor()
  }
  assert.equal(await attachmentMenu.getByRole("menuitem", { name: "通过链接关联设计图", exact: true }).count(), 0)
  assert.equal(await page.getByText("legacy-design-reference.example.com", { exact: true }).count(), 0,
    "legacy reference links have no visible entry or context pill")
  await page.keyboard.press("Escape")
  await attachmentMenu.waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "更多上传选项")
  assert.equal(await page.getByRole("button", { name: "更多上传选项", exact: true }).evaluate(element => element === document.activeElement), true)
  await page.getByRole("button", { name: "更多上传选项", exact: true }).click()
  const screenshotChooser = page.waitForEvent("filechooser")
  await page.getByRole("menuitem", { name: "上传截图", exact: true }).click()
  await (await screenshotChooser).setFiles([])
  console.log("PASS compact context actions and attachment menu screenshot/keyboard flows without URL-only references")

  const openTemplatePicker = async () => {
    await startActions.getByRole("button", { name: "选择模板", exact: true }).click()
    await page.getByRole("dialog", { name: "关联页面模板", exact: true }).waitFor()
  }
  const templateDialog = page.getByRole("dialog", { name: "关联页面模板", exact: true })
  await openTemplatePicker()
  await templateDialog.getByRole("button", { name: "选择模板 2模板预览", exact: true }).click()
  if (process.env.DESIGN_TEMPLATE_UI_SCREENSHOTS) {
    await templateDialog.screenshot({ path: `${process.env.DESIGN_TEMPLATE_UI_SCREENSHOTS}-picker.png`, animations: "disabled" })
    await page.setViewportSize({ width: 390, height: 844 })
    const lightBackground = await templateDialog.evaluate(element => getComputedStyle(element).backgroundColor)
    await page.evaluate(() => (window as any).applyDesignTestTheme(true))
    assert.notEqual(await templateDialog.evaluate(element => getComputedStyle(element).backgroundColor), lightBackground)
    assert.equal(await templateDialog.evaluate(element => element.scrollWidth <= element.clientWidth), true,
      "the template picker fits a narrow window")
    await templateDialog.screenshot({ path: `${process.env.DESIGN_TEMPLATE_UI_SCREENSHOTS}-narrow.png`, animations: "disabled" })
    await page.evaluate(() => (window as any).applyDesignTestTheme(false))
    await page.setViewportSize({ width: 1440, height: 1000 })
  }
  await templateDialog.getByRole("button", { name: "取消", exact: true }).click()
  assert.equal(manager.get("ds_browser").state.creationSelection, undefined, "cancel leaves the original selection untouched")
  await openTemplatePicker()
  await templateDialog.getByRole("button", { name: "选择模板 1模板预览", exact: true }).click()
  await templateDialog.getByRole("button", { name: "关联此模板", exact: true }).click()
  await page.getByRole("button", { name: "更换页面模板：模板 1", exact: true }).waitFor()
  await startActions.getByRole("button", { name: "更换模板", exact: true }).waitFor()
  if (process.env.DESIGN_TEMPLATE_UI_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.DESIGN_TEMPLATE_UI_SCREENSHOTS}-composer.png`, animations: "disabled" })
  }
  await page.reload()
  await page.getByRole("button", { name: "更换页面模板：模板 1", exact: true }).click()
  assert.equal(await templateDialog.getByRole("button", { pressed: true }).filter({ hasText: "模板 1" }).count(), 1)
  await templateDialog.getByRole("button", { name: "选择模板 2模板预览", exact: true }).click()
  await templateDialog.getByRole("button", { name: "取消", exact: true }).click()
  await page.getByRole("button", { name: "更换页面模板：模板 1", exact: true }).waitFor()
  await page.getByRole("button", { name: "更多上传选项", exact: true }).click()
  assert.equal(await page.getByRole("menuitem", { name: "关联页面模板", exact: true }).count(), 0, "bound templates have one entry in the composer")
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "移除页面模板", exact: true }).click()
  await page.getByRole("group", { name: "页面模板", exact: true }).waitFor({ state: "detached" })

  // Upload errors and results arriving after cancellation cannot change the session.
  await openTemplatePicker()
  await templateDialog.getByRole("button", { name: "上传模板", exact: true }).click()
  await page.evaluate(() => { (window as any).templateFixture.mode = "error" })
  await templateDialog.getByRole("button", { name: "选择 HTML / ZIP", exact: true }).click()
  await templateDialog.getByText("模板导入失败", { exact: true }).waitFor()
  assert.equal(await templateDialog.getByRole("button", { name: "关联此模板", exact: true }).isDisabled(), true)
  await page.evaluate(() => { (window as any).templateFixture.mode = "delayed" })
  await templateDialog.getByRole("button", { name: "选择 HTML / ZIP", exact: true }).click()
  await page.waitForFunction(() => Boolean((window as any).templateFixture.pending))
  await templateDialog.getByRole("button", { name: "取消", exact: true }).click()
  await page.evaluate(() => {
    const fixture = (window as any).templateFixture
    fixture.pending({ template: fixture.templatePackage }); fixture.mode = "success"
  })
  assert.equal(await page.getByRole("group", { name: "页面模板", exact: true }).count(), 0)
  await openTemplatePicker()
  await templateDialog.getByRole("button", { name: "上传模板", exact: true }).click()
  await templateDialog.getByRole("button", { name: "选择文件夹", exact: true }).click()
  await templateDialog.getByLabel("模板页面入口", { exact: true }).selectOption("detail.html")
  await templateDialog.getByRole("button", { name: "关联此模板", exact: true }).click()
  await page.getByRole("button", { name: "更换页面模板：import.html", exact: true }).click()
  await templateDialog.getByLabel("模板页面入口", { exact: true }).waitFor()
  assert.equal(await templateDialog.getByLabel("模板页面入口", { exact: true }).inputValue(), "detail.html")
  await templateDialog.getByRole("button", { name: "选择模板", exact: true }).click()
  await templateDialog.getByRole("button", { name: "选择模板 2模板预览", exact: true }).click()
  await templateDialog.getByRole("button", { name: "关联此模板", exact: true }).click()
  await page.getByRole("button", { name: "更换页面模板：模板 2", exact: true }).waitFor()
  assert.equal(requests.length, 0, "associating a template does not start a model run")
  console.log("PASS first-generation composer template association, cancellation, persistence, removal and package entry selection")
  await input.fill("直接生成一个测试页面")
  await page.getByRole("button", { name: "▶ 发送", exact: true }).click()
  await page
    .getByRole("button", { name: "■ 停止", exact: true })
    .waitFor()
    .catch(async (error) => {
      console.log("BODY", (await page.locator("body").innerText()).slice(-1800))
      console.log("STATE", JSON.stringify(manager.get("ds_browser")).slice(0, 1200))
      throw error
    })
  await page.getByRole("button", { name: "更多上传选项", exact: true }).click()
  for (const label of ["通过链接还原页面", "上传 HTML 文件", "关联代码"]) {
    assert.equal(await page.getByRole("menuitem", { name: label, exact: true }).count(), 1,
      "context actions stay available after the welcome actions disappear")
  }
  for (const label of ["通过链接还原页面", "上传 HTML 文件", "上传原型图压缩包"]) {
    assert.equal(await page.getByRole("menuitem", { name: label, exact: true }).getAttribute("aria-disabled"), "true",
      "imports cannot replace a design while it is generating")
  }
  await page.keyboard.press("Escape")
  await new Promise<void>((done) => setTimeout(done, 200))
  assert.equal(emitters.length, 1)
  assert.doesNotMatch(requests[0].prompt, /legacy-design-reference\.example\.com|Design reference URL/,
    "legacy URL-only references are no longer sent to the model")
  assert.match(requests[0].prompt, /模板内容 2/, "the confirmed template is included in the first generation")
  assert.equal(await page.getByRole("button", { name: "更换页面模板：模板 2", exact: true }).isDisabled(), true)
  const waiting = page.getByTestId("design-generation-waiting")
  await waiting.waitFor()
  assert.equal(await workspace.getAttribute("data-layout"), "split", "generation immediately opens both panes")
  await canvas.getByTestId("design-generation-waiting").waitFor()
  await divider.waitFor()
  assert.equal(await conversation.getByTestId("design-generation-waiting").count(), 0,
    "the conversation is reserved for model execution and messages")
  emitters[0]({ type: "execution", event: { kind: "assistant_text", content: "模型正在规划页面结构", timestamp: Date.now() } })
  await conversation.getByText("模型正在规划页面结构", { exact: true }).waitFor()
  assert.equal(await canvas.getByText("模型正在规划页面结构", { exact: true }).count(), 0)
  await waiting.getByRole("heading", { name: "先看结构，再调细节" }).waitFor()
  emitters[0]({ type: "metrics", metrics: { firstModelChunkAt: Date.now() } })
  await waiting.getByRole("status").filter({ hasText: "正在生成首个页面框架" }).waitFor()
  await waiting.getByRole("button", { name: "下一张灵感卡片", exact: true }).click()
  await waiting.getByRole("heading", { name: "把修改说到具体位置" }).waitFor()
  await waiting.getByRole("button", { name: "上一张灵感卡片", exact: true }).click()
  if (process.env.DESIGN_WAITING_SCREENSHOT) {
    await page.screenshot({ path: process.env.DESIGN_WAITING_SCREENSHOT, fullPage: true, animations: "disabled" })
  }
  const declaration = {
    defaults: { primary: "#123456", radius: 12, label: "开始" },
    schema: {
      primary: { type: "color", label: "主色" },
      radius: { type: "number", label: "圆角", min: 0, max: 32 },
      label: { type: "text", label: "文案", maxLength: 20 }
    },
    bindings: {
      primary: [{ type: "css-var", name: "--primary" }],
      radius: [{ type: "css-var", name: "--radius", unit: "px" }],
      label: [{ type: "text", selector: "#cta-label" }]
    }
  }
  const makeHtml = (first: boolean, complete = false) =>
    `<!doctype html><html><head><style>h1{color:var(--primary)}button{border-radius:var(--radius)}</style><script type="application/design-tweaks+json">${JSON.stringify(declaration)}</script></head><body ${complete ? "" : 'data-design-build="building"'}><section data-design-section="main" ${first ? "data-design-pending" : ""}><h1>${first ? "布局占位" : "后台完成的设计"}</h1><button><span id="cta-label">开始</span></button></section><section data-design-section="tail" ${complete ? "" : "data-design-pending"}><p id="preserved">${complete ? "尾部内容完成" : "保留节点"}</p></section><script>window.parent.postMessage({type:'test-business-run'},'*')</script></body></html>`
  const runId = manager.get("ds_browser").activeRunId!
  const preview = (revision: number, html: string) =>
    emitters[0]({
      type: "preview",
      preview: {
        runId,
        revision,
        html,
        draftPath: "/workspace/draft.html",
        phase: "sections",
        status: "building",
        ...inspectDesignDocument(html),
        tweaks: null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    })
  preview(1, makeHtml(true))
  await page.frameLocator("iframe").getByText("布局占位", { exact: true }).waitFor()
  assert.equal(await waiting.count(), 0, "the first framework immediately replaces the waiting card")
  await canvas.waitFor()
  await divider.waitFor()
  assert.equal(await workspace.getAttribute("data-layout"), "split")
  const widthBeforeDrag = (await conversation.boundingBox())!.width
  await page.locator("iframe").evaluate((frame) => { (window as any).resizePreviewFrame = frame })
  const dragDivider = async (delta: number) => {
    const box = (await divider.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(200, box.height / 2))
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + delta, box.y + Math.min(200, box.height / 2), { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction(() => !document.querySelector('[data-testid="design-resize-shield"]'))
  }
  await dragDivider(180)
  assert.ok(Math.abs((await conversation.boundingBox())!.width - widthBeforeDrag - 180) <= 2,
    "dragging right gives the conversation more room")
  await dragDivider(-90)
  const resizedWidth = (await conversation.boundingBox())!.width
  assert.ok(Math.abs(resizedWidth - widthBeforeDrag - 90) <= 2, "dragging left gives the page more room")
  assert.equal(await page.evaluate(() => localStorage.getItem("design_conversation_width_v1")), String(resizedWidth))
  await divider.press("Home")
  assert.equal((await conversation.boundingBox())!.width, 320, "the conversation cannot be dragged out of view")
  await divider.press("End")
  assert.ok((await canvas.boundingBox())!.width >= 359, "the canvas keeps its minimum width")
  await divider.press("Enter")
  assert.equal((await conversation.boundingBox())!.width, 420)
  await divider.press("ArrowRight")
  assert.equal((await conversation.boundingBox())!.width, 444)
  await divider.dblclick()
  assert.equal((await conversation.boundingBox())!.width, 420, "double-click restores the default split")
  await divider.press("ArrowRight")
  const capturedDivider = (await divider.boundingBox())!
  await page.mouse.move(capturedDivider.x + 3, capturedDivider.y + 120)
  await page.mouse.down()
  await page.setViewportSize({ width: 700, height: 900 })
  await divider.waitFor({ state: "detached" })
  await page.getByTestId("design-resize-shield").waitFor({ state: "detached" })
  await page.mouse.up()
  assert.equal(await workspace.getAttribute("data-stacked"), "true", "narrow windows stack both panes without horizontal overflow")
  assert.equal(await page.evaluate(() => document.body.style.cursor), "", "window resize releases the drag cursor")
  await page.setViewportSize({ width: 1440, height: 1000 })
  await divider.waitFor()
  assert.equal(await page.getByTestId("design-resize-shield").count(), 0)
  assert.equal(await page.locator("iframe").evaluate(frame => frame === (window as any).resizePreviewFrame), true,
    "resizing does not recreate the live preview")
  console.log("PASS wide initial conversation, generation-triggered split, pointer/keyboard resizing and drag cleanup")
  if (process.env.DESIGN_WORKSPACE_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.DESIGN_WORKSPACE_SCREENSHOTS}-split.png`, animations: "disabled" })
  }
  await page.locator("iframe").evaluate((frame) => {
    const w = (frame as HTMLIFrameElement).contentWindow as Window & {
      kept?: Element | null
      identity?: string
    }
    w.kept = w.document.getElementById("preserved")
    w.identity = "same-context"
  })
  preview(2, makeHtml(false))
  await page.frameLocator("iframe").getByText("后台完成的设计", { exact: true }).waitFor()
  assert.equal(
    await page.locator("iframe").evaluate((frame) => {
      const w = (frame as HTMLIFrameElement).contentWindow as Window & {
        kept?: Element
        identity?: string
      }
      return w.identity === "same-context" && w.kept === w.document.getElementById("preserved")
    }),
    true,
    "section update keeps the iframe and unaffected nodes"
  )
  assert.equal(
    await page.evaluate(() => (window as unknown as { businessRuns: number }).businessRuns),
    0,
    "draft business scripts must remain inert"
  )
  await page.getByTitle("开启微调").click()
  await page.getByLabel("主色", { exact: true }).fill("#00aa00")
  await page.getByLabel("主色", { exact: true }).blur()
  await page.waitForFunction(async () => {
    const snapshot = await (
      window as unknown as { designRpc: (...args: unknown[]) => Promise<any> }
    ).designRpc("open", "ds_browser")
    return snapshot.state.draftPreview?.tweaks?.overrides?.primary === "#00aa00"
  })
  await page.locator("iframe").evaluate((frame) => {
    const w = (frame as HTMLIFrameElement).contentWindow as Window & { droppedPatch?: boolean }
    w.addEventListener(
      "message",
      (event) => {
        if (event.data?.type === "__design_preview_update" && !w.droppedPatch) {
          w.droppedPatch = true
          event.stopImmediatePropagation()
        }
      },
      true
    )
  })
  preview(3, makeHtml(false, true))
  await page.frameLocator("iframe").getByText("尾部内容完成", { exact: true }).waitFor()
  assert.equal(
    await page
      .locator("iframe")
      .evaluate(
        (frame) =>
          (frame as HTMLIFrameElement).contentWindow &&
          ((frame as HTMLIFrameElement).contentWindow as Window & { identity?: string })
            .identity === "same-context"
      ),
    true,
    "missing ACK recovers through a full snapshot without a document reload"
  )
  await page.waitForFunction(
    () =>
      document
        .querySelector("iframe")
        ?.contentDocument?.documentElement.style.getPropertyValue("--primary") === "#00aa00"
  )
  assert.equal(manager.get("ds_browser").state.draftPreview!.tweaks!.overrides.primary, "#00aa00")
  emitters[0]({ type: "token", token: "离开前的消息。" })
  await page.getByText("离开前的消息。", { exact: true }).waitFor()
  await page.getByTitle("返回历史记录").click()
  await page.getByText("My Designs", { exact: true }).waitFor()
  emitters[0]({ type: "token", token: "离开期间新增的消息。" })
  await new Promise<void>((done) => setTimeout(done, 150))
  assert.equal(aborted, 0)
  await page.getByTitle("直接生成一个测试页面", { exact: true }).click()
  await page.getByText("离开前的消息。离开期间新增的消息。", { exact: true }).waitFor()
  assert.equal(await page.getByRole("button", { name: "■ 停止", exact: true }).count(), 1)
  await page.locator("#toggle-mode").click()
  emitters[0]({
    type: "execution",
    event: {
      kind: "validation",
      content: "后台验证已完成",
      status: "success",
      timestamp: Date.now()
    }
  })
  emitters[0]({
    type: "done",
    html: makeHtml(false, true)
  })
  completions[0]()
  await page.locator("#toggle-mode").click()
  await page.getByText("✓ 设计已生成", { exact: true }).waitFor()
  assert.equal((await conversation.boundingBox())!.width, 444, "reopening remembers the conversation width")
  await page.getByText("后台验证已完成", { exact: true }).waitFor()
  await page.frameLocator("iframe").first().getByText("后台完成的设计", { exact: true }).waitFor()
  await page.waitForFunction(
    () => (window as unknown as { businessRuns: number }).businessRuns === 1
  )
  const finalIdentity = await page
    .locator("iframe")
    .evaluate(
      (frame) =>
        (frame as HTMLIFrameElement).contentDocument!.documentElement.dataset.designPreviewInstance
    )
  await page.getByRole("button", { name: "预览", exact: true }).click()
  await page.getByLabel("主色", { exact: true }).fill("#aa0000")
  await page.getByLabel("主色", { exact: true }).blur()
  await page.waitForFunction(async () => {
    const snapshot = await (
      window as unknown as { designRpc: (...args: unknown[]) => Promise<any> }
    ).designRpc("open", "ds_browser")
    return snapshot.state.tweaks?.overrides?.primary === "#aa0000"
  })
  assert.equal(
    await page
      .locator("iframe")
      .evaluate(
        (frame) =>
          (frame as HTMLIFrameElement).contentDocument!.documentElement.dataset
            .designPreviewInstance
      ),
    finalIdentity,
    "Tweaks never reloads the final iframe"
  )
  assert.equal(
    await page.evaluate(() => (window as unknown as { businessRuns: number }).businessRuns),
    1,
    "business scripts execute only once at finalization"
  )
  assert.equal(aborted, 0)
  assert.equal(emitters.length, 1, "reopening must not rerun the model")
  await page.locator("iframe").evaluate((frame) => {
    const win = (frame as HTMLIFrameElement).contentWindow as Window & {
      savedHeading?: Element
      clicks?: number
    }
    win.savedHeading = win.document.querySelector("h1")!
    win.document.querySelector("button")!.addEventListener("click", () => {
      win.clicks = (win.clicks || 0) + 1
    })
  })
  await input.fill("把主标题文案改成局部更新成功")
  await page.getByRole("button", { name: "▶ 发送", exact: true }).click()
  await page.getByRole("button", { name: "■ 停止", exact: true }).waitFor()
  assert.equal(requests[1].kind, "patch", "chat edits route to the bounded executor")
  assert.doesNotMatch(requests[1].prompt, /模板内容 2|创建设计时选择的参考资料/, "iterations never reapply the initial template HTML")
  assert.equal(await page.getByRole("group", { name: "页面模板", exact: true }).count(), 0)
  await page.getByRole("button", { name: "更多上传选项", exact: true }).click()
  assert.equal(await page.getByRole("menuitem", { name: "关联页面模板", exact: true }).count(), 0, "generated pages cannot rebind their initial template")
  await page.keyboard.press("Escape")
  assert.equal(await waiting.count(), 0, "edits keep the previous design visible")
  assert.equal(
    requests[1].currentHtml,
    undefined,
    "the renderer does not send the full page for patches"
  )
  const beforePatch = manager.get("ds_browser")
  const result = await executeDesignPatch({
    html: beforePatch.state.html,
    artifactRevision: beforePatch.state.artifactRevision ?? 0,
    instruction: requests[1].prompt,
    request: requests[1].patch!,
    tweaks: beforePatch.state.tweaks ?? null,
    signal: new AbortController().signal,
    status: (patchStatus) => emitters[1]({ type: "patch_status", patchStatus }),
    validate: async () => [],
    complete: async (messages) => {
      const context = JSON.parse(messages[1].content)
      assert.ok(
        !messages[1].content.includes("test-business-run"),
        "source scripts stay out of model context"
      )
      if (!context.targets.length)
        return {
          content: JSON.stringify({ action: "target", targetIds: [context.directory[0].targetId] })
        }
      const heading = context.directory.find((n: { tag: string }) => n.tag === "h1")
      return {
        content: JSON.stringify({
          protocol: "design-patch/1",
          contextId: context.contextId,
          baseArtifactRevision: context.baseArtifactRevision,
          summary: "主标题已局部更新",
          operations: [
            {
              op: "set_text",
              targetId: heading.targetId,
              expectedHash: heading.hash,
              text: "局部更新成功"
            }
          ]
        })
      }
    }
  })
  const candidate = result.candidate
  emitters[1]({
    type: "done",
    html: candidate.html,
    tweaks: candidate.tweaks,
    artifactPath: "/workspace/design.html",
    patchResult: {
      patch: candidate.patch,
      baseSourceHash: candidate.baseSourceHash,
      baseTweakRevision: candidate.baseTweakRevision,
      tweakReads: candidate.tweakReads,
      tweakUpdates: candidate.tweakUpdates
    }
  })
  completions[1]()
  await page.frameLocator("iframe").getByText("局部更新成功", { exact: true }).waitFor()
  assert.equal(
    await page.locator("iframe").evaluate((frame) => {
      const win = (frame as HTMLIFrameElement).contentWindow as Window & { savedHeading?: Element }
      return win.savedHeading === win.document.querySelector("h1")
    }),
    true,
    "live patches preserve node identity"
  )
  assert.equal(
    await page
      .locator("iframe")
      .evaluate(
        (frame) =>
          (frame as HTMLIFrameElement).contentDocument!.documentElement.dataset
            .designPreviewInstance
      ),
    finalIdentity
  )
  await page.getByRole("button", { name: "预览", exact: true }).click()
  await page.frameLocator("iframe").locator("button").click()
  assert.equal(
    await page
      .locator("iframe")
      .evaluate(
        (frame) =>
          ((frame as HTMLIFrameElement).contentWindow as Window & { clicks: number }).clicks
      ),
    1,
    "direct event listeners survive live patches"
  )
  await page.getByTitle("撤销局部修改").click()
  await page.frameLocator("iframe").getByText("后台完成的设计", { exact: true }).waitFor()
  await page.getByTitle("重做局部修改").click()
  await page.frameLocator("iframe").getByText("局部更新成功", { exact: true }).waitFor()
  assert.equal(
    await page.evaluate(() => (window as unknown as { businessRuns: number }).businessRuns),
    1,
    "patch, undo and redo do not reexecute business scripts"
  )
  await page.getByRole("button", { name: "注释", exact: true }).click()
  await page.frameLocator("iframe").getByText("局部更新成功", { exact: true }).click()
  await page.getByPlaceholder("输入批注内容… (Shift+Enter 换行)").fill("只修改这个标题的颜色")
  await page.getByRole("button", { name: "发送 →", exact: true }).click()
  await page.getByRole("button", { name: "■ 停止", exact: true }).waitFor()
  assert.equal(requests[2].kind, "patch")
  assert.ok(requests[2].patch!.targets[0].nodeId, "comments carry a stable source identity")
  assert.equal(
    requests[2].patch!.targets[0].artifactRevision,
    manager.get("ds_browser").state.artifactRevision
  )
  emitters[2]({ type: "error", error: "模拟模型失败" })
  completions[2]()
  await page.getByText(/模拟模型失败/).waitFor()
  assert.equal(
    manager.get("ds_browser").state.html,
    candidate.html,
    "failed local edits retain the committed page"
  )
  const styleIssues = await page.locator("iframe").evaluate((frame, probeSource) => {
    const win = (frame as HTMLIFrameElement).contentWindow!
    const heading = win.document.querySelector<HTMLElement>("h1")!
    const probe = win.eval(`(${probeSource})`)
    const check = { targetId: heading.dataset.designNode, property: "color", value: "#aa0000" }
    const initial = probe([check])
    const style = win.document.createElement("style")
    style.textContent = "h1{color:blue!important}"
    win.document.head.appendChild(style)
    const overridden = probe([check])
    style.remove()
    return { initial, overridden }
  }, designPatchStyleProbe.toString())
  assert.deepEqual(
    styleIssues.initial,
    [],
    "computed style validation accepts the effective parameter color"
  )
  assert.equal(
    styleIssues.overridden.length,
    1,
    "computed style validation catches !important overriding the requested value"
  )
  const statePage = await browser.newPage()
  try {
    await statePage.setContent(
      '<style>button{color:black}button:hover{color:red}[data-design-node="n_state"]:hover{color:blue}</style><button id="state" data-design-node="n_state">state</button>'
    )
    const cdp = await statePage.context().newCDPSession(statePage)
    let attached = false
    const driver = {
      executeJavaScript: (code: string) => statePage.evaluate(code),
      debugger: {
        isAttached: () => attached,
        attach: () => {
          attached = true
        },
        detach: () => {
          attached = false
        },
        sendCommand: (method: string, params?: object) => cdp.send(method as never, params as never)
      }
    }
    const checks = [{ targetId: "n_state", property: "color", value: "blue", state: "hover" }]
    assert.deepEqual(
      await inspectDesignPatchStyles(driver, checks, 1440),
      [],
      "hover state is validated in Chromium"
    )
    await statePage.addStyleTag({ content: "#state:hover{color:red!important}" })
    assert.equal(
      (await inspectDesignPatchStyles(driver, checks, 1440)).length,
      1,
      "hover specificity conflicts are detected"
    )
    await cdp.detach()
  } finally {
    await statePage.close()
  }
  const recoveryRevision = (manager.get("ds_browser").state.artifactRevision ?? 0) + 1
  await page.evaluate((revision) => {
    let dropped = false
    window.addEventListener(
      "message",
      (event) => {
        if (
          !dropped &&
          event.data?.type === "__design_live_applied" &&
          event.data.revision === revision
        ) {
          dropped = true
          event.stopImmediatePropagation()
        }
      },
      true
    )
  }, recoveryRevision)
  await page.getByTitle("撤销局部修改").click()
  await page.waitForFunction(
    (instance) =>
      document.querySelector("iframe")?.contentDocument?.documentElement?.dataset
        .designPreviewInstance !== instance,
    finalIdentity
  )
  await page.frameLocator("iframe").getByText("后台完成的设计", { exact: true }).waitFor()
  assert.equal(
    emitters.length,
    3,
    "a lost local ACK recovers from the committed snapshot without invoking the model"
  )
  // The creation screen must use the same durable sessions and import pipeline as the editor.
  await page.getByTitle("返回历史记录").click()
  const originalCount = manager.list().length
  await page.getByRole("button", { name: "新建设计" }).first().click()
  await page.getByRole("heading", { name: "新建设计", exact: true }).waitFor().catch(async (error) => {
    console.log("CREATION BODY", (await page.locator("body").innerText()).slice(-1800)); throw error
  })
  assert.equal(await page.getByText("选择新建设计方式").count(), 0, "new designs use a full page")
  await page.getByLabel("设计系统", { exact: true }).selectOption("wealth")
  await page.getByRole("button", { name: "切换目录", exact: true }).click()
  await page.getByText("/workspace/selected", { exact: true }).waitFor()
  await page.getByRole("button", { name: "下一页模板" }).click()
  await page.getByRole("button", { name: "选择模板 5模板预览", exact: true }).click()
  await page.getByRole("button", { name: "上一页模板" }).click()
  await page.getByRole("button", { name: "通过链接还原", exact: false }).click()
  await page.getByPlaceholder("https://example.com/page").fill("invalid-url")
  assert.equal(await page.getByRole("button", { name: "在内置浏览器中打开", exact: true }).isDisabled(), true)
  await page.getByRole("button", { name: "×", exact: true }).click()
  assert.equal(
    await page.getByText("模板：模板 5", { exact: false }).count(),
    1,
    "cancelled imports retain selections"
  )
  await page.getByRole("button", { name: "上传需求文件", exact: true }).click()
  await page.getByRole("button", { name: "选择文件", exact: true }).click().catch(async error => {
    console.log("REQUIREMENT FILE BODY", (await page.locator("body").innerText()).slice(-2500))
    throw error
  })
  await page.getByRole("button", { name: "进入设计", exact: false }).click()
  await page.locator("textarea").first().waitFor()
  const createdId = await page.evaluate(() => localStorage.getItem("design_last_session"))
  assert.ok(createdId)
  assert.equal(manager.list().length, originalCount + 1)
  assert.equal(manager.get(createdId).workspacePath, "/workspace/selected")
  assert.equal(manager.get(createdId).state.selectedDesignSystemId, "wealth")
  assert.equal(manager.get(createdId).state.creationSelection?.template.name, "模板 5")
  assert.equal(manager.get(createdId).state.attachedFiles?.[0].content, "需求附件内容")
  const originalRequirement = manager.get(createdId).state.creationSelection!.requirement
  await page.getByRole("button", { name: "更换页面模板：模板 5", exact: true }).click()
  await templateDialog.getByRole("button", { name: "上一页模板", exact: true }).click()
  await templateDialog.getByRole("button", { name: "选择模板 3模板预览", exact: true }).click()
  await templateDialog.getByRole("button", { name: "关联此模板", exact: true }).click()
  await page.getByRole("button", { name: "更换页面模板：模板 3", exact: true }).waitFor()
  await page.reload()
  await page.getByRole("button", { name: "更换页面模板：模板 3", exact: true }).waitFor()
  const reassociated = manager.get(createdId)
  assert.equal(reassociated.workspacePath, "/workspace/selected")
  assert.equal(reassociated.state.selectedDesignSystemId, "wealth")
  assert.deepEqual(reassociated.state.creationSelection!.requirement, originalRequirement,
    "changing a template preserves the requirement association")
  assert.equal(reassociated.state.attachedFiles?.[0].content, "需求附件内容")
  await page.locator("textarea").first().fill("直接生成一个模板测试页面")
  await page.getByRole("button", { name: "▶ 发送", exact: true }).click()
  await page.getByRole("button", { name: "■ 停止", exact: true }).waitFor()
  const creationRequest = requests.at(-1)!
  assert.match(creationRequest.prompt, /模板内容 3/)
  assert.doesNotMatch(creationRequest.prompt, /模板内容 5/)
  assert.match(creationRequest.prompt, /需求附件内容/)
  assert.equal(
    creationRequest.cleanUserMsg,
    "直接生成一个模板测试页面",
    "reference HTML stays out of chat"
  )
  emitters.at(-1)!({ type: "error", error: "测试结束" })
  completions.at(-1)!()
  await page.getByText(/测试结束/).waitFor()
  await page.getByRole("button", { name: "更换页面模板：模板 3", exact: true }).click()
  await templateDialog.getByRole("button", { name: "选择模板 4模板预览", exact: true }).click()
  await templateDialog.getByRole("button", { name: "关联此模板", exact: true }).click()
  await page.getByRole("button", { name: "更换页面模板：模板 4", exact: true }).waitFor()
  assert.equal(await page.getByRole("button", { name: "🔄 重试", exact: true }).count(), 0,
    "changing the initial template clears stale retry prompts")
  await page.locator("textarea").first().fill("直接生成更新后的模板页面")
  await page.getByRole("button", { name: "▶ 发送", exact: true }).click()
  await page.getByRole("button", { name: "■ 停止", exact: true }).waitFor()
  assert.match(requests.at(-1)!.prompt, /模板内容 4/)
  assert.doesNotMatch(requests.at(-1)!.prompt, /模板内容 3|模板内容 5/)
  emitters.at(-1)!({ type: "error", error: "模板切换测试结束" })
  completions.at(-1)!()
  await page.getByText("模板切换测试结束", { exact: false }).waitFor()
  console.log("PASS editor template changes preserve workspace/requirements/design system and invalidate stale retries")

  // Opening a URL requires a separate confirmation of the live browser page before capture.
  await page.getByTitle("返回历史记录").click()
  await page.getByRole("button", { name: "新建设计" }).first().click()
  await page.getByRole("button", { name: "通过链接还原", exact: false }).click()
  await page.getByPlaceholder("https://example.com/page").fill("https://example.com/private")
  await page.evaluate(() => { (window as any).importFixture.mode = "waiting" })
  const beforeCancelledImport = manager.list().length
  const requestCountBeforeOpen = await page.evaluate(() => (window as any).importFixture.requests.length)
  await page.getByRole("button", { name: "在内置浏览器中打开", exact: true }).click()
  await page.getByRole("dialog", { name: "通过链接还原页面" }).waitFor({ state: "detached" })
  assert.equal(await page.evaluate(() => (window as any).importFixture.requests.length), requestCountBeforeOpen,
    "opening the browser must never start a background capture")
  await page.getByRole("button", { name: "确认页面并还原", exact: true }).click()
  await page.getByText("等待测试页面渲染", { exact: true }).waitFor()
  await page.getByRole("button", { name: "取消还原", exact: true }).click()
  await page.waitForFunction(() => !(window as any).importFixture.pending)
  assert.equal(manager.list().length, beforeCancelledImport, "cancelled capture creates no design")
  await page.getByRole("button", { name: "通过链接还原", exact: false }).click()
  await page.getByPlaceholder("https://example.com/page").fill("https://example.com/private")
  await page.evaluate(() => { (window as any).importFixture.mode = "save-fail" })
  await page.getByRole("button", { name: "在内置浏览器中打开", exact: true }).click()
  await page.getByRole("button", { name: "确认页面并还原", exact: true }).click()
  await page.getByRole("alert").filter({ hasText: "磁盘写入失败" }).waitFor()
  assert.equal(manager.list().length, beforeCancelledImport, "failed persistence creates no empty design")
  await page.getByRole("region", { name: "确认页面并还原" }).getByRole("button", { name: "取消", exact: true }).click()
  // Editing the URL while the browser is open hides its native view using the modal marker.
  await page.getByRole("button", { name: "通过链接还原", exact: false }).click()
  await page.getByPlaceholder("https://example.com/page").fill("https://example.com/private")
  await page.evaluate(() => { (window as any).importFixture.mode = "open-fail" })
  await page.getByRole("button", { name: "在内置浏览器中打开", exact: true }).click()
  await page.getByRole("alert").filter({ hasText: "打开失败测试" }).waitFor()
  assert.equal(await page.getByRole("button", { name: "确认页面并还原", exact: true }).isEnabled(), true,
    "the user can correct navigation in the browser after an initial open error")
  const hiddenBeforeEdit = await page.evaluate(() => (window as any).importFixture.hiddenCount)
  await page.getByRole("button", { name: "修改链接", exact: true }).click()
  await page.waitForFunction((previous) => (window as any).importFixture.hiddenCount > previous, hiddenBeforeEdit)
  assert.equal(await page.getByRole("dialog", { name: "通过链接还原页面" }).getAttribute("data-cmb-modal-dialog"), "true")
  await page.getByRole("button", { name: "×", exact: true }).click()
  await page.getByRole("button", { name: "通过链接还原", exact: false }).click()
  await page.getByPlaceholder("https://example.com/page").fill("https://example.com/private")
  await page.evaluate(() => { (window as any).importFixture.mode = "login" })
  await page.getByRole("button", { name: "在内置浏览器中打开", exact: true }).click()
  await page.getByRole("button", { name: "确认页面并还原", exact: true }).click()
  await page.getByRole("alert").filter({ hasText: "请先完成登录" }).waitFor()
  assert.equal(await page.getByRole("dialog", { name: "通过链接还原页面" }).count(), 0)
  assert.equal(await page.evaluate(() => (window as any).importFixture.opened), true)
  await page.evaluate(() => { (window as any).importFixture.mode = "success" })
  await page.getByRole("button", { name: "确认页面并还原", exact: true }).click()
  await page.frameLocator('iframe[title="Design Preview"]').getByText("链接页面", { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => (window as any).importFixture.requests.at(-1).source), "current-browser")
  assert.equal(await page.evaluate(() => (window as any).importFixture.requests.every((request: any) => request.source === "current-browser")), true)
  assert.equal(await page.getByRole("button", { name: "确认页面并还原", exact: true }).count(), 0,
    "successful capture closes the browser confirmation surface")
  console.log("PASS URL import progress, cancellation and login/current-page recovery")

  for (const entry of [
    { button: "导入 HTML", heading: "HTML 导入页面", kind: "import_html" },
    { button: "原型压缩包", heading: "原型页面", kind: "prototype_zip" },
    { button: "通过链接还原", heading: "链接页面", kind: "import_url" }
  ]) {
    await page.getByTitle("返回历史记录").click()
    await page.getByRole("button", { name: "新建设计" }).first().click()
    await page.getByLabel("设计系统", { exact: true }).selectOption("wealth")
    await page.getByRole("button", { name: entry.button, exact: false }).click()
    if (entry.kind === "import_url") {
      await page.getByPlaceholder("https://example.com/page").fill("https://example.com/design")
      await page.getByRole("button", { name: "在内置浏览器中打开", exact: true }).click()
      await page.getByRole("button", { name: "确认页面并还原", exact: true }).click()
    }
    await page.frameLocator('iframe[title="Design Preview"]').getByText(entry.heading, { exact: true }).waitFor()
    const id = (await page.evaluate(() => localStorage.getItem("design_last_session")))!
    await page.waitForFunction(async (sessionId) => {
      const snapshot = await (
        window as unknown as { designRpc: (...args: unknown[]) => Promise<any> }
      ).designRpc("open", sessionId)
      return Boolean(snapshot.state.artifactPath)
    }, id)
    assert.equal(manager.get(id).meta.kind, entry.kind)
    assert.equal(manager.get(id).state.tweaksOn, true)
    assert.equal(manager.get(id).state.selectedDesignSystemId, "wealth")
    if (entry.kind === "import_html") {
      assert.equal(
        await page
          .frameLocator("iframe")
          .locator("h1")
          .evaluate((element) => getComputedStyle(element).color),
        "rgb(12, 34, 56)",
        "local CSS survives imports"
      )
    }
  }
  await page.getByTitle("返回历史记录").click()
  await page.getByRole("button", { name: "新建设计" }).first().click()
  await page.getByRole("button", { name: "返回设计历史", exact: true }).click()
  await page.getByText("My Designs", { exact: true }).waitFor()
  await page.reload()
  await page.getByRole("heading", { name: "新建设计", exact: true }).waitFor().catch(async (error) => {
    console.log("RELOAD BODY", (await page.locator("body").innerText()).slice(-1800));
    console.log("LAST", await page.evaluate(() => localStorage.getItem("design_last_session"))); throw error
  })
  await page.getByRole("button", { name: "上传模板", exact: true }).click()
  await page.getByRole("button", { name: "选择 HTML / ZIP", exact: true }).click()
  await page.getByRole("combobox").filter({ hasText: "请选择命名空间" }).click()
  await page
    .getByRole("option", { name: /Mock 开发组 A/ })
    .first()
    .click()
  await page.getByRole("combobox").filter({ hasText: "请选择需求特性" }).click()
  await page.getByRole("option", { name: /Mock 需求 A-1/ }).click()
  await page.getByRole("button", { name: "进入设计", exact: false }).click()
  await page.locator("textarea").first().waitFor()
  const uploadId = (await page.evaluate(() => localStorage.getItem("design_last_session")))!
  const uploadSelection = manager.get(uploadId).state.creationSelection!
  assert.equal(uploadSelection.template.mode, "upload")
  assert.match(uploadSelection.template.html!, /HTML 导入页面/)
  assert.equal(uploadSelection.requirement.namespaceId, "ns-wplus")
  assert.equal(uploadSelection.requirement.requirement?.code, "P2603-2406")
  await page.getByTitle("返回历史记录").click()
  await page.getByRole("button", { name: "新建设计" }).first().click()
  await page.getByRole("button", { name: "不选模板", exact: true }).click()
  await page.getByRole("button", { name: "不绑定需求", exact: true }).click()
  await page.getByRole("button", { name: "进入设计", exact: false }).click()
  await page.locator("textarea").first().waitFor()
  const blankId = (await page.evaluate(() => localStorage.getItem("design_last_session")))!
  assert.equal(manager.get(blankId).state.creationSelection?.template.html, null)
  assert.equal(manager.get(blankId).state.creationSelection?.requirement.requirement, null)
  assert.equal(manager.get(blankId).state.attachedFiles, null)

  // User gestures run through the real DesignView, IPC-style client and durable manager.
  const directRunsBefore = requests.length
  const openDirectFixture = async (id: string, html: string) => {
    manager.create({ id, meta: { id, title: id, createdAt: 1, updatedAt: 1 }, workspacePath: "/workspace",
      state: { ...createDesignState(), html, artifactPath: "/workspace/design.html", activeMode: "edit", generationState: "done" } })
    await page.evaluate((value) => localStorage.setItem("design_last_session", value), id)
    await page.reload()
    await page.frameLocator("iframe").locator('[data-design-host-runtime="editor"]').waitFor({ state: "attached" })
  }
  const editText = async (selector: string, text: string) => {
    const frame = page.frameLocator("iframe")
    await frame.locator(selector).dblclick()
    const editor = frame.getByRole("textbox", { name: "编辑文字" })
    await editor.fill(text)
    await editor.dispatchEvent("compositionstart")
    await editor.dispatchEvent("keydown", { key: "Enter", isComposing: true })
    assert.equal(await editor.count(), 1, "IME confirmation does not submit prematurely")
    await editor.dispatchEvent("compositionend")
    await editor.press("Enter")
    await frame.locator(selector).filter({ hasText: text }).waitFor().catch(async (error) => {
      const id = await page.evaluate(() => localStorage.getItem("design_last_session"))
      console.log("EDIT FAILED", id, id ? manager.get(id).state.html.slice(-2200) : "")
      console.log("EDIT DOM", await frame.locator("body").innerText())
      console.log("EDIT STATUS", (await page.locator("body").innerText()).slice(-900))
      throw error
    })
    await frame.getByRole("textbox", { name: "编辑文字" }).waitFor({ state: "detached" })
  }
  await openDirectFixture("ds_useredit", '<!doctype html><html><head><style>article{padding:20px;margin:10px}button{padding:12px}</style></head><body><h1>原始标题</h1><button id="icon-action"><svg width="10" height="10"><path d="M0 0L10 10"/></svg>保存</button><article id="remove-card"><span>内部文字</span></article><article id="keep-card">保留卡片</article><script>document.getElementById("icon-action").addEventListener("click",()=>window.clicks=(window.clicks||0)+1)</script></body></html>')
  const directFrame = page.frameLocator("iframe")
  const staticInstance = await directFrame.locator("html").getAttribute("data-design-preview-instance")
  await editText("h1", "中文直接编辑")
  assert.equal(await directFrame.locator("html").getAttribute("data-design-preview-instance"), staticInstance, "direct text keeps the iframe")
  await editText("#icon-action", "提交申请")
  assert.equal(await directFrame.locator("#icon-action svg").count(), 1)
  assert.match(manager.get("ds_useredit").state.html, /提交申请/)
  await directFrame.locator("#remove-card span").click()
  await directFrame.getByRole("button", { name: "article", exact: true }).click()
  await directFrame.getByRole("button", { name: "删除", exact: true }).click()
  await directFrame.locator("#remove-card").waitFor({ state: "detached" })
  assert.equal(await directFrame.locator("#keep-card").count(), 1)
  await page.getByTitle("撤销局部修改").click()
  await directFrame.locator("#remove-card").waitFor()
  await page.getByTitle("重做局部修改").click()
  await directFrame.locator("#remove-card").waitFor({ state: "detached" })
  await directFrame.locator("#keep-card").click()
  await page.keyboard.press("Delete")
  await directFrame.locator("#keep-card").waitFor({ state: "detached" })
  await page.getByTitle("撤销局部修改").click()
  await directFrame.locator("#keep-card").waitFor()
  await directFrame.locator("h1").dblclick()
  const cancelledText = directFrame.getByRole("textbox", { name: "编辑文字" })
  await cancelledText.fill("这段取消")
  await cancelledText.press("Backspace")
  assert.equal(await directFrame.locator("h1").count(), 1, "Backspace inside text does not delete the element")
  if (process.env.DESIGN_EDIT_SCREENSHOT) await page.screenshot({ path: process.env.DESIGN_EDIT_SCREENSHOT, fullPage: true })
  await cancelledText.press("Escape")
  assert.equal(await directFrame.locator("h1").textContent(), "中文直接编辑")
  await page.getByRole("button", { name: "预览", exact: true }).click()
  await directFrame.locator("#icon-action").click()
  assert.equal(await directFrame.locator("html").evaluate(() => (window as Window & { clicks?: number }).clicks), 1)
  await page.getByRole("button", { name: "编辑", exact: true }).click()
  await directFrame.locator("h1").dblclick()
  await directFrame.getByRole("textbox", { name: "编辑文字" }).fill("离开页面仍保存")
  await page.locator("#toggle-mode").click()
  await page.waitForFunction(async () => {
    const snapshot = await (window as unknown as { designRpc: (...args: unknown[]) => Promise<any> }).designRpc("open", "ds_useredit")
    return snapshot.state.html.includes("离开页面仍保存")
  })
  await page.locator("#toggle-mode").click()
  await directFrame.locator("h1").filter({ hasText: "离开页面仍保存" }).waitFor()
  await page.reload()
  await directFrame.locator("h1").filter({ hasText: "离开页面仍保存" }).waitFor()
  assert.equal(await directFrame.locator("#remove-card").count(), 0)
  const savedDirect = manager.get("ds_useredit").state.html
  assert.ok(!savedDirect.includes('data-design-host-runtime="editor"'))
  assert.ok(!savedDirect.includes("<textarea"))
  await page.getByTitle("导出设计", { exact: true }).click()
  await page.getByLabel("导出格式", { exact: true }).selectOption("html")
  const downloaded = page.waitForEvent("download")
  await page.getByRole("button", { name: "导出 HTML", exact: true }).click()
  const exported = readFileSync((await (await downloaded).path())!, "utf8")
  assert.match(exported, /离开页面仍保存/)
  assert.match(exported, /提交申请/)
  assert.ok(!exported.includes('id="remove-card"'))
  assert.ok(!exported.includes('data-design-host-runtime="editor"'))

  const base = `http://127.0.0.1:${address.port}`
  await openDirectFixture("ds_reactedit", `<!doctype html><html><head><script src="${base}/react.js"></script><script defer src="${base}/babel.js"></script></head><body><div id="root"></div><script type="text/babel">function App(){const [n,setN]=React.useState(0);return <main><h1>React原文</h1><button onClick={()=>setN(n+1)}>重新渲染 {n}</button><section>React可删除区</section></main>};ReactDOM.createRoot(document.getElementById('root')).render(<App/>);</script></body></html>`)
  await editText("h1", "React新文案")
  await page.getByRole("button", { name: "预览", exact: true }).click()
  await page.frameLocator("iframe").getByRole("button", { name: "重新渲染 0" }).click()
  await page.frameLocator("iframe").getByRole("button", { name: "重新渲染 1" }).waitFor()
  assert.equal(await page.frameLocator("iframe").locator("h1").textContent(), "React新文案")
  await page.getByRole("button", { name: "编辑", exact: true }).click()
  await page.frameLocator("iframe").locator("section").click()
  await page.frameLocator("iframe").getByRole("button", { name: "删除", exact: true }).click()
  await page.frameLocator("iframe").locator("section").waitFor({ state: "detached" })
  await page.reload()
  await page.frameLocator("iframe").locator("h1").filter({ hasText: "React新文案" }).waitFor()
  assert.equal(await page.frameLocator("iframe").locator("section").count(), 0)

  const recordData = { data: { records: { a: { title: "甲记录" }, b: { title: "乙记录" } } }, bindings: {
    "a-title": { kind: "text", path: "/records/a/title" }, "b-title": { kind: "text", path: "/records/b/title" },
    "a-row": { kind: "record", path: "/records/a" }, "b-row": { kind: "record", path: "/records/b" }
  } }
  await openDirectFixture("ds_recordedit", prepareEditableSource(`<!doctype html><html><head><script type="application/design-edit+json">${JSON.stringify(recordData)}</script><script src="${base}/react.js"></script><script defer src="${base}/babel.js"></script><style>article{padding:15px}</style></head><body><div id="root"></div><script type="text/babel">function App(){const [n,setN]=React.useState(0);return <main><button onClick={()=>setN(n+1)}>刷新记录 {n}</button>{Object.entries(window.designData.data.records).map(([key,record])=><article key={key} data-design-bind={key+'-row'}><h2 data-design-bind={key+'-title'}>{record.title}</h2></article>)}</main>};ReactDOM.createRoot(document.getElementById('root')).render(<App/>);</script></body></html>`))
  await editText('[data-design-bind="a-title"]', "只修改甲记录")
  assert.equal(await page.frameLocator("iframe").locator('[data-design-bind="b-title"]').textContent(), "乙记录")
  await page.frameLocator("iframe").locator('[data-design-bind="a-row"]').click({ position: { x: 2, y: 2 } })
  await page.frameLocator("iframe").getByRole("button", { name: "删除", exact: true }).click()
  await page.frameLocator("iframe").locator('[data-design-bind="a-row"]').waitFor({ state: "detached" })
  await page.getByRole("button", { name: "预览", exact: true }).click()
  await page.frameLocator("iframe").getByRole("button", { name: "刷新记录 0" }).click()
  await page.frameLocator("iframe").getByRole("button", { name: "刷新记录 1" }).waitFor()
  assert.equal(await page.frameLocator("iframe").locator("article").count(), 1)
  assert.equal(await page.frameLocator("iframe").locator('[data-design-bind="b-title"]').textContent(), "乙记录")
  await page.reload()
  await page.frameLocator("iframe").locator('[data-design-bind="b-title"]').waitFor()
  assert.equal(await page.frameLocator("iframe").locator("article").count(), 1)

  if (vueRuntime) {
    await openDirectFixture("ds_vueedit", `<!doctype html><html><head><script src="${base}/vue.js"></script></head><body><div id="app"></div><script>Vue.createApp({data(){return {n:0}},template:${JSON.stringify('<main><h1>Vue原文</h1><button @click="n++">重新渲染 {{n}}</button><section>Vue可删除区</section></main>') }}).mount('#app')</script></body></html>`)
    await editText("h1", "Vue新文案")
    await page.getByRole("button", { name: "预览", exact: true }).click()
    await page.frameLocator("iframe").getByRole("button", { name: "重新渲染 0" }).click()
    await page.frameLocator("iframe").getByRole("button", { name: "重新渲染 1" }).waitFor()
    assert.equal(await page.frameLocator("iframe").locator("h1").textContent(), "Vue新文案")
    await page.getByRole("button", { name: "编辑", exact: true }).click()
    await page.frameLocator("iframe").locator("section").click()
    await page.frameLocator("iframe").getByRole("button", { name: "删除", exact: true }).click()
    await page.frameLocator("iframe").locator("section").waitFor({ state: "detached" })
    await page.reload()
    await page.frameLocator("iframe").locator("h1").filter({ hasText: "Vue新文案" }).waitFor()
    assert.equal(await page.frameLocator("iframe").locator("section").count(), 0)
    console.log("PASS: real Vue source editing survives reactive updates and reopen")
  }
  assert.equal(requests.length, directRunsBefore, "direct edits never invoke the model")
  console.log("PASS: direct double-click/IME text, icon retention, nested selection/deletion, history, persistence and real React rerender")

  // Both the explicit Continue action and a follow-up must use the latest unfinished page.
  manager.create({
    id: "ds_resume_draft",
    meta: { id: "ds_resume_draft", title: "接续草稿", createdAt: 1, updatedAt: 1 },
    state: { ...createDesignState(), selectedModelId: "custom:test", creationSelection: {
      method: "prompt", workspacePath: "/workspace", designSystemId: null,
      template: { mode: "select", name: "恢复测试模板", html: "<h1>不应重建的初始模板</h1>", path: null },
      requirement: { mode: "none", namespaceId: null, pathName: null, requirement: null, implementationDetails: [], path: null }
    } },
    workspacePath: "/workspace"
  })
  await page.evaluate(() => localStorage.setItem("design_last_session", "ds_resume_draft"))
  await page.reload()
  await page.locator("textarea").first().fill("直接生成一个接续测试页面")
  await page.getByRole("button", { name: "▶ 发送", exact: true }).click()
  await page.getByRole("button", { name: "■ 停止", exact: true }).waitFor()
  const firstResumeEmitter = emitters.at(-1)!
  const firstResumeFinish = completions.at(-1)!
  const partialResumeHtml = makeHtml(false).replace("后台完成的设计", "已经完成的欢迎区")
    .replace("保留节点", "待生成统计区")
  const emitResumePreview = (revision: number, html: string) => {
    const runId = manager.get("ds_resume_draft").activeRunId!
    emitters.at(-1)!({ type: "preview", preview: {
      runId, revision, html, draftPath: "/workspace/resume-draft.html", phase: "sections", status: "building",
      ...inspectDesignDocument(html), tweaks: null, createdAt: Date.now(), updatedAt: Date.now()
    } })
  }
  emitResumePreview(5, partialResumeHtml)
  await page.frameLocator("iframe").getByRole("heading", { name: "已经完成的欢迎区", exact: true }).waitFor()
  await page.getByRole("button", { name: "■ 停止", exact: true }).click()
  await page.getByRole("button", { name: "继续生成", exact: true }).waitFor()
  firstResumeFinish()
  await page.reload()
  await page.frameLocator("iframe").getByRole("heading", { name: "已经完成的欢迎区", exact: true }).waitFor()
  await page.getByRole("button", { name: "继续生成", exact: true }).click()
  await page.getByRole("button", { name: "■ 停止", exact: true }).waitFor()
  const resumedDraftRequest = requests.at(-1)!
  assert.equal(resumedDraftRequest.resumeFromDraft, true)
  assert.equal(resumedDraftRequest.isIteration, true)
  assert.match(resumedDraftRequest.currentHtml!, /已经完成的欢迎区|待生成统计区/)
  assert.doesNotMatch(resumedDraftRequest.prompt, /不应重建的初始模板|创建设计时选择的参考资料/)
  await page.frameLocator("iframe").getByRole("heading", { name: "已经完成的欢迎区", exact: true }).waitFor()
  assert.equal(await waiting.count(), 0, "continuing keeps the draft on screen without returning to the waiting card")
  firstResumeEmitter({ type: "done", html: makeHtml(false, true) })
  assert.equal(manager.get("ds_resume_draft").state.html, "", "late completion of the stopped run cannot replace the resumed draft")
  const latestResumeHtml = partialResumeHtml.replace("待生成统计区", "统计区已经写到一半")
  const secondResumeFinish = completions.at(-1)!
  emitResumePreview(1, latestResumeHtml)
  await page.frameLocator("iframe").getByText("统计区已经写到一半", { exact: true }).waitFor()
  await page.getByRole("button", { name: "■ 停止", exact: true }).click()
  await page.getByRole("button", { name: "继续生成", exact: true }).waitFor()
  secondResumeFinish()
  await page.locator("textarea").first().fill("继续，把统计区补完")
  await page.getByRole("button", { name: "▶ 发送", exact: true }).click()
  await page.getByRole("button", { name: "■ 停止", exact: true }).waitFor()
  assert.equal(requests.at(-1)!.kind, "agent")
  assert.equal(requests.at(-1)!.resumeFromDraft, true)
  assert.match(requests.at(-1)!.currentHtml!, /统计区已经写到一半/)
  assert.match(requests.at(-1)!.prompt, /继续，把统计区补完/)
  assert.doesNotMatch(requests.at(-1)!.prompt, /不应重建的初始模板|创建设计时选择的参考资料/)
  assert.equal(requests.at(-1)!.resumeGoal, "直接生成一个接续测试页面")
  assert.equal(requests.at(-1)!.prompt.match(/\[接续未完成的设计\]/g)?.length, 1)
  const resumedFinalHtml = makeHtml(false, true).replace("后台完成的设计", "已经完成的欢迎区")
    .replace("尾部内容完成", "统计区接续完成")
  emitters.at(-1)!({ type: "done", html: resumedFinalHtml })
  completions.at(-1)!()
  await page.frameLocator("iframe").getByText("统计区接续完成", { exact: true }).waitFor()
  assert.match(manager.get("ds_resume_draft").state.html, /已经完成的欢迎区/)
  assert.equal(manager.get("ds_resume_draft").state.draftPreview, null)
  console.log("PASS: stopped drafts resume after reload through Continue and follow-ups, retaining completed content and latest progress")

  manager.create({
    id: "ds_stream_questions",
    meta: { id: "ds_stream_questions", title: "逐题刷新", createdAt: 1, updatedAt: 1 },
    state: { ...createDesignState(), selectedModelId: "custom:test", selectedDesignSystemId: "neutral-modern" },
    workspacePath: "/workspace"
  })
  await page.evaluate(() => localStorage.setItem("design_last_session", "ds_stream_questions"))
  await page.reload()
  await page.locator("textarea").first().waitFor()
  manager.start({ requestId: "stream-questions", designSessionId: "ds_stream_questions", kind: "questions", prompt: "创建销售看板" })
  await page.getByText("正在生成问题...", { exact: true }).waitFor()
  assert.equal(await waiting.count(), 0, "questions remain visible without the waiting card")
  const questionEmit = emitters.at(-1)!
  const questionFinish = completions.at(-1)!
  const nameQuestion = { id: "product_name", type: "text", label: "看板名称" }
  const scopeQuestion = { id: "scope", type: "chips", label: "主要指标", options: ["收入", "客户"] }
  questionEmit({ type: "question", question: nameQuestion })
  await page.getByText("看板名称", { exact: true }).waitFor()
  await page.getByPlaceholder("输入你的回答...", { exact: true }).fill("华东销售中心")
  assert.equal(await page.getByRole("button", { name: "继续 →", exact: true }).isDisabled(), true)
  await page.waitForFunction(async () => {
    const snapshot = await (window as unknown as { designRpc: (method: string, id: string) => Promise<{ state: { answers: Record<string, string> } }> }).designRpc("open", "ds_stream_questions")
    return snapshot.state.answers.product_name === "华东销售中心"
  })
  // Reopening mid-stream must restore editable questions and their saved answers.
  await page.reload()
  await page.getByText("看板名称", { exact: true }).waitFor()
  assert.equal(await canvas.count(), 0, "requirement questions stay in the wide conversation")
  assert.equal(await page.getByPlaceholder("输入你的回答...", { exact: true }).inputValue(), "华东销售中心")
  questionEmit({ type: "question", question: scopeQuestion })
  await page.getByRole("button", { name: "收入", exact: true }).click()
  questionEmit({ type: "done", questions: [nameQuestion, scopeQuestion] })
  questionFinish()
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((el) => el.textContent?.includes("继续 →"))
    return button && !button.disabled
  })
  assert.equal(await page.getByPlaceholder("输入你的回答...", { exact: true }).inputValue(), "华东销售中心")
  await page.getByRole("button", { name: "继续 →", exact: true }).click()
  await page.getByRole("button", { name: "■ 停止", exact: true }).waitFor()
  assert.equal(requests.at(-1)!.kind, "agent")
  assert.match(requests.at(-1)!.prompt, /华东销售中心/)
  await waiting.waitFor()
  await canvas.getByTestId("design-generation-waiting").waitFor()
  assert.equal(await workspace.getAttribute("data-layout"), "split", "submitting answers opens the generation pane")
  await waiting.getByRole("button", { name: "停止生成", exact: true }).click()
  await waiting.waitFor({ state: "detached" })
  assert.equal(await workspace.getAttribute("data-layout"), "conversation", "stopping before any preview returns to the conversation")
  assert.equal(manager.get("ds_stream_questions").activeRunId, null)
  completions.at(-1)!()
  console.log("PASS: questions appear before completion, accept answers while streaming, and preserve them across refresh and submission")
  assert.deepEqual(errors, [])
  console.log(
    "PASS: progressive previews, bounded chat/comment patches, live node/listener preservation, durable undo/redo, background recovery, full-page creation, template/requirement persistence and URL/HTML/ZIP imports"
  )
} finally {
  await browser.close()
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done()))
  )
  db.close()
}
