/** Real React navigation against the real main-process manager with a deterministic model. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { DatabaseSync } from "node:sqlite"
import { resolve } from "node:path"
import { build } from "esbuild"
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
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { DesignView } from './src/renderer/src/components/design/DesignView';
    function Fixture() {
      const [show, setShow] = useState(true);
      return <><button id="toggle-mode" onClick={() => setShow(!show)}>切换模式</button>
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
  define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"test"' },
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
const server = createServer((_request, response) => {
  response.setHeader(
    "Content-Type",
    _request.url === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8"
  )
  response.end(
    _request.url === "/app.js"
      ? bundle.outputFiles[0].contents
      : '<div id="root"></div><script src="/app.js"></script>'
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
  state: { ...createDesignState(), selectedModelId: "custom:test" },
  workspacePath: "/workspace"
})
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors: string[] = []
  page.setDefaultTimeout(10000)
  page.on("console", (message) => {
    if (message.type() === "error") console.log("BROWSER", message.text())
  })
  page.on("pageerror", (error) => errors.push(error.message))
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
  deliver = (change) => {
    void page
      .evaluate(
        (payload) => (window as unknown as { deliver: (event: unknown) => void }).deliver(payload),
        change
      )
      .catch(() => undefined)
  }
  await page.addInitScript(() => {
    localStorage.setItem("design_last_session", "ds_browser")
    ;(window as unknown as { businessRuns: number }).businessRuns = 0
    window.addEventListener("message", (event) => {
      if (event.data?.type === "test-business-run")
        (window as unknown as { businessRuns: number }).businessRuns++
    })
    const listeners = new Set<(event: unknown) => void>()
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
      design: {
        sessions,
        listSystems: async () => [],
        listTemplates: async () => [],
        storeHtml: async () => ({ ok: true })
      },
      skills: { list: async () => [], listPlugins: async () => [], getDisabled: async () => [] },
      models: {
        list: async () => [{ id: "custom:test", name: "Test", model: "test", available: true }]
      },
      workspace: { get: async () => "/workspace" },
      file: {
        readText: async () => ({ success: false }),
        readDataUrl: async () => ({ success: false })
      }
    }
  })
  await page.goto(`http://127.0.0.1:${address.port}`)
  const input = page.locator("textarea").first()
  await input.waitFor()
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
  await new Promise<void>((done) => setTimeout(done, 200))
  assert.equal(emitters.length, 1)
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
      document.querySelector("iframe")?.contentDocument?.documentElement.dataset
        .designPreviewInstance !== instance,
    finalIdentity
  )
  await page.frameLocator("iframe").getByText("后台完成的设计", { exact: true }).waitFor()
  assert.equal(
    emitters.length,
    3,
    "a lost local ACK recovers from the committed snapshot without invoking the model"
  )
  assert.deepEqual(errors, [])
  console.log(
    "PASS: progressive previews, bounded chat/comment patches, live node/listener preservation, durable undo/redo and background recovery"
  )
} finally {
  await browser.close()
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done()))
  )
  db.close()
}
