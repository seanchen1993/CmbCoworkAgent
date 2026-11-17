/** Real Electron verification: npx tsx tests/design-url-import-electron.spec.mts */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer, type Server } from "node:http"
import { once } from "node:events"
import { build } from "esbuild"
import { _electron as electron, type ElectronApplication } from "playwright"
import type { DesignImportRequest, DesignImportResult } from "../src/shared/design-url-import"

const root = process.cwd()
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "design-url-electron-"))
await fs.mkdir(path.join(temporary, "profile"))
await fs.mkdir(path.join(root, "node_modules/.cache"), { recursive: true })
const bundleDirectory = await fs.mkdtemp(
  path.join(root, "node_modules/.cache/design-url-electron-")
)
let businessRequests = 0
let application: ElectronApplication | undefined
const listen = async (server: Server) => {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
const assets = createServer(async (request, response) => {
  const url = request.url || ""
  if (url === "/frame-cross") {
    response.setHeader("content-type", "text/html; charset=utf-8")
    response.end(`<html><body><h2>CROSS_FRAME</h2><img src="/pixel.svg"><img id="frame-blob"><script>document.getElementById('frame-blob').src=URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'],{type:'image/svg+xml'}));</script></body></html>`)
  } else if (url === "/styles/main.css") {
    response.setHeader("content-type", "text/css")
    response.end(
      '@import "nested/colors.css";@font-face{font-family:CaptureFont;src:url(../font.woff2)}body{font-family:CaptureFont;background:rgb(240,245,250)}#content{background-image:url(../pixel.svg);padding:12px}'
    )
  } else if (url === "/styles/nested/colors.css") {
    response.setHeader("content-type", "text/css")
    response.end("#content{color:rgb(12,34,56)}")
  } else if (url === "/font.woff2") {
    response.setHeader("content-type", "font/woff2")
    response.end(
      await fs.readFile(
        path.join(root, "node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2")
      )
    )
  } else if (url === "/pixel.svg") {
    response.setHeader("content-type", "image/svg+xml")
    response.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#abc"/></svg>'
    )
  } else {
    response.statusCode = 404
    response.end("missing")
  }
})
const assetsOrigin = await listen(assets)
const website = createServer((request, response) => {
  const pathname = new URL(request.url || "/", "http://site.test").pathname
  response.setHeader("content-type", "text/html; charset=utf-8")
  if (pathname === "/interactive") {
    response.end(`<html><body><button id="toggle" aria-expanded="false">Dropdown</button><div id="menu" hidden>Options</div><script>
      document.getElementById('toggle').onclick=()=>{const menu=document.getElementById('menu');menu.hidden=!menu.hidden;document.getElementById('toggle').setAttribute('aria-expanded',String(!menu.hidden))};
      </script></body></html>`)
    return
  }
  if (pathname === "/frames") {
    response.end(`<html><head><title>FRAME_TREE</title></head><body>
      <iframe src="/same" onload="this.contentDocument.querySelector('h2').textContent='FIRST_INSTANCE'"></iframe>
      <iframe src="/same" onload="this.contentDocument.querySelector('h2').textContent='SECOND_INSTANCE'"></iframe>
      <iframe src="${assetsOrigin}/frame-cross"></iframe>
      <iframe src="/huge"></iframe>
      <iframe srcdoc="<html><body>SRCDOC_FRAME<iframe src='${origin}/nested'></iframe></body></html>"></iframe>
      </body></html>`)
    return
  }
  if (pathname === "/huge") { response.end("<html><body>" + "<span>超出节点预算</span>".repeat(30001) + "</body></html>"); return }
  if (pathname === "/same" || pathname === "/nested") {
    response.end(`<html><body><h2>${pathname === "/same" ? "SAME_FRAME" : "NESTED_FRAME"}</h2><img src="${assetsOrigin}/pixel.svg"></body></html>`)
    return
  }
  if (pathname === "/login") {
    response.setHeader("set-cookie", "auth=shared-profile; HttpOnly; Path=/; SameSite=Lax")
    response.end("<p>登录已完成</p>")
    return
  }
  if (pathname === "/business") {
    businessRequests++
    response.end("ok")
    return
  }
  if (pathname === "/slow") return // Cancellation must destroy the unfinished capture.
  if (pathname === "/private" && !request.headers.cookie?.includes("auth=shared-profile")) {
    response.end(
      '<h1>登录</h1><input type="password" value="must-not-export"><button>登录</button>'
    )
    return
  }
  if (pathname === "/session") {
    response.end(`<h1 id="session-state">${""}</h1><input id="value">
      <dialog id="open-dialog">当前弹窗</dialog><div id="open-popover" popover="manual">当前浮层</div>
      <dialog id="closed-dialog">未展开的弹窗</dialog><div id="closed-popover" popover>未展开的浮层</div><script>
      sessionStorage.setItem('private-state','CURRENT_TAB');
      document.getElementById('session-state').textContent=sessionStorage.getItem('private-state');
      document.getElementById('value').value='USER_EDITED';
      window.inMemoryToken='must-not-export';
      document.getElementById('open-dialog').showModal();
      document.getElementById('open-popover').showPopover();</script>`)
    return
  }
  response.end(`<!doctype html><html><head><title>动态测试页面</title>
    <link rel="stylesheet" href="${assetsOrigin}/styles/main.css"><style id="runtime-style"></style></head>
    <body><main id="content">loading</main><img id="blob-image"><canvas width="20" height="20"></canvas>
    <input id="edited"><select><option>A</option><option id="chosen">B</option></select><div id="shadow"></div>
    <a id="external" href="/business">链接</a><form action="/business"><button>提交</button></form>
    <script>
      fetch('/business');
      setTimeout(()=>{
        document.getElementById('content').textContent='SIGNED_IN_DYNAMIC';
        document.getElementById('edited').value='CURRENT_VALUE';
        document.getElementById('chosen').selected=true;
        document.getElementById('runtime-style').sheet.insertRule('#edited{border:3px solid rgb(10,20,30)}');
        document.getElementById('blob-image').src=URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>'],{type:'image/svg+xml'}));
        const context=document.querySelector('canvas').getContext('2d');context.fillStyle='blue';context.fillRect(0,0,20,20);
        const shadow=document.getElementById('shadow').attachShadow({mode:'open'});shadow.innerHTML='<style>span{color:rgb(100,50,20)}</style><span>SHADOW_CONTENT</span>';
        const sheet=new CSSStyleSheet();sheet.replaceSync('main{border-radius:7px}');document.adoptedStyleSheets=[sheet];
      },100);
    </script></body></html>`)
})
const origin = await listen(website)

try {
  const main = path.join(bundleDirectory, "main.cjs")
  await build({
    stdin: {
      resolveDir: root,
      contents: `
    import { app, BrowserWindow, session } from 'electron';
    import { DesignUrlImportService, validateCapturedArtifact } from './src/main/services/design/url-import-service';
    import { controlDesignInteractionRecording } from './src/main/services/design/interaction-recording';
    import { getBuiltinBrowserSession } from './src/main/browser/core/browser-profile-session';
    import { setGlobalBrowserService } from './src/main/browser/core/browser-service-registry';
    app.setPath('userData', process.env.DESIGN_URL_TEST_PROFILE);
    app.whenReady().then(() => {
      const current = new BrowserWindow({show:false,webPreferences:{session:getBuiltinBrowserSession(),backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
      current.loadURL('about:blank');
      setGlobalBrowserService({getWebContents:()=>current.webContents});
      globalThis.captureTest={service:new DesignUrlImportService(),validate:validateCapturedArtifact,record:controlDesignInteractionRecording,current,profile:getBuiltinBrowserSession(),defaultSession:session.defaultSession,progress:[]};
    });
  `
    },
    bundle: true,
    outfile: main,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron", "css-tree", "parse5"]
  })
  const executablePath =
    process.platform === "darwin"
      ? path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
      : path.join(
          root,
          "node_modules/electron/dist",
          process.platform === "win32" ? "electron.exe" : "electron"
        )
  const environment = { ...process.env, DESIGN_URL_TEST_PROFILE: path.join(temporary, "profile") }
  delete environment.ELECTRON_RUN_AS_NODE
  console.log("Starting Electron capture integration")
  application = await electron.launch({
    executablePath,
    args: [main],
    env: environment,
    timeout: 20_000
  })
  await application.evaluate(async () => {
    while (!(globalThis as any).captureTest) await new Promise((resolve) => setTimeout(resolve, 10))
  })
  const run = async (name: string, extra: Partial<DesignImportRequest> = {}) =>
    application!.evaluate(
      async (_electron, request) => {
        const test = (globalThis as any).captureTest
        return test.service.run(11, request, (event: unknown) => test.progress.push(event))
      },
      {
        requestId: name,
        source: "url",
        url: `${origin}/private?secret=not-in-manifest`,
        workspacePath: temporary,
        ...extra
      }
    ) as Promise<DesignImportResult>
  const finish = (requestId: string, keep = true) =>
    application!.evaluate(
      async (_electron, data) =>
        (globalThis as any).captureTest.service.finish(11, data.requestId, data.keep),
      { requestId, keep }
    )

  const validationDirectory = path.join(temporary, "validation")
  await fs.mkdir(validationDirectory)
  await fs.writeFile(path.join(validationDirectory, "empty.html"), "<html><body></body></html>")
  await fs.writeFile(path.join(validationDirectory, "valid.html"), "<html><body>FRAME_CONTENT</body></html>")
  await fs.writeFile(path.join(validationDirectory, "broken.html"), '<html><body><img src="missing.png"></body></html>')
  for (const [name, parentStyle, frameStyle, source, valid] of [
    ["hidden", "", "visibility:hidden", "empty.html", true],
    ["inherited-hidden", "visibility:hidden", "", "empty.html", true],
    ["collapsed", "", "visibility:collapse", "empty.html", true],
    ["display-none", "", "display:none", "empty.html", true],
    ["visible-empty", "", "", "empty.html", false],
    ["visible-override", "visibility:hidden", "visibility:visible", "empty.html", false],
    ["visible-content", "", "", "valid.html", true],
    ["visible-broken-image", "", "", "broken.html", false]
  ] as const) {
    const filePath = path.join(validationDirectory, `${name}.html`)
    await fs.writeFile(filePath, `<html><body><p>MAIN_CONTENT</p><div style="${parentStyle}"><iframe
      width="1" height="1" style="${frameStyle}" data-design-capture-frame="f_1" src="${source}"></iframe></div></body></html>`)
    const validate = () => application!.evaluate(async (_electron, file) =>
      (globalThis as any).captureTest.validate(file, new AbortController().signal), filePath)
    if (valid) await validate()
    else await assert.rejects(validate, /快照预览验证失败/)
  }
  console.log("PASS hidden helper frames do not fail validation; visible frames still require complete content")

  const login = await run("login-required")
  assert.equal(login.status, "needs_user_action")
  assert.ok(login.screenshotDataUrl)
  console.log("PASS login page requires user action")
  await application.evaluate(async (_electron, url) => {
    const test = (globalThis as any).captureTest
    await test.defaultSession.cookies.set({ url, name: "auth", value: "wrong-profile" })
    await test.current.webContents.loadURL(url + "/login")
  }, origin)
  const result = await run("authenticated")
  assert.equal(result.success, true, JSON.stringify(result))
  assert.match(result.html!, /SIGNED_IN_DYNAMIC/)
  assert.match(result.html!, /SHADOW_CONTENT/)
  assert.match(result.html!, /CURRENT_VALUE/)
  assert.match(result.html!, /<option id="chosen" selected/)
  assert.doesNotMatch(result.html!, /fetch\('|setTimeout\(|attachShadow\(/)
  const manifest = await fs.readFile(
    path.join(path.dirname(result.artifactPath!), "capture-manifest.json"),
    "utf8"
  )
  assert.doesNotMatch(manifest, /not-in-manifest|shared-profile|wrong-profile/)
  assert.ok((await fs.readdir(path.join(path.dirname(result.artifactPath!), "assets"))).length >= 5)
  await finish("authenticated")
  const requestsAfterCapture = businessRequests
  console.log(
    "PASS shared HttpOnly cookies, dynamic DOM, CSSOM, blob, canvas, shadow and recursive resources"
  )

  const before = await application.evaluate(() =>
    (globalThis as any).captureTest.current.webContents.getURL()
  )
  assert.equal(
    before,
    origin + "/login",
    "background capture must preserve the user's current page"
  )
  await application.evaluate(async (_electron, url) => {
    await (globalThis as any).captureTest.current.webContents.loadURL(url)
  }, origin + "/session")
  const current = await run("current-page", { source: "current-browser" })
  assert.equal(current.success, true, JSON.stringify(current))
  assert.match(current.html!, /CURRENT_TAB/)
  assert.match(current.html!, /USER_EDITED/)
  assert.doesNotMatch(current.html!, /inMemoryToken|must-not-export/)
  const capturedLayers = await application.evaluate(async ({ BrowserWindow }, filePath) => {
    const preview = new BrowserWindow({ show: false, webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true
    } })
    try {
      await preview.loadFile(filePath)
      return await preview.webContents.executeJavaScript(`({
        modal: document.getElementById('open-dialog').matches(':modal'),
        popover: document.getElementById('open-popover').matches(':popover-open'),
        closedDialog: document.getElementById('closed-dialog').open,
        closedPopover: document.getElementById('closed-popover').matches(':popover-open'),
        sourceScript: !!document.querySelector('script:not([data-design-capture-runtime])')
      })`)
    } finally {
      preview.destroy()
    }
  }, current.artifactPath!)
  assert.deepEqual(capturedLayers, {
    modal: true, popover: true, closedDialog: false, closedPopover: false, sourceScript: false
  })
  await finish("current-page", false)
  console.log("PASS current-page capture preserves tab storage, input state and open dialog/popover state")

  await application.evaluate(async (_electron, url) => {
    const test = (globalThis as any).captureTest
    await test.current.loadURL(url)
    await test.current.webContents.executeJavaScript(`(${test.record.toString()})("start")`)
  }, origin + "/interactive")
  const interactivePage = await application.firstWindow()
  await interactivePage.click("#toggle")
  await interactivePage.waitForTimeout(400)
  await interactivePage.click("#toggle")
  await interactivePage.waitForTimeout(400)
  const interactive = await run("recorded-clicks", { source: "current-browser" })
  assert.equal(interactive.success, true, JSON.stringify(interactive))
  assert.ok(interactive.warnings.some(warning => warning.code === "recorded_interactions"))
  const replayed = await application.evaluate(async ({ BrowserWindow }, file) => {
    const preview = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    try {
      await preview.loadFile(file)
      return await preview.webContents.executeJavaScript(`(() => {
        const button=document.getElementById('toggle'),menu=document.getElementById('menu');
        button.click(); const opened=!menu.hidden; button.click();
        return {opened,closed:menu.hidden,sourceHandlers:button.hasAttribute('onclick')};
      })()`)
    } finally { preview.destroy() }
  }, interactive.artifactPath!)
  assert.deepEqual(replayed, { opened: true, closed: true, sourceHandlers: false })
  await finish("recorded-clicks", false)
  console.log("PASS current-browser interaction recording survives capture, asset localization, validation and offline replay")

  const frameResult = await run("frame-tree", { url: origin + "/frames" })
  assert.equal(frameResult.success, true, JSON.stringify(frameResult))
  const frameDirectory = path.join(path.dirname(frameResult.artifactPath!), "frames")
  const frameFiles = await fs.readdir(frameDirectory)
  assert.equal(frameFiles.length, 6)
  assert.ok(frameResult.warnings.some(warning => warning.code === "frame_screenshot"))
  const allFrameHtml = (await Promise.all(frameFiles.map(file => fs.readFile(path.join(frameDirectory, file), "utf8")))).join("\n")
  for (const text of ["FIRST_INSTANCE", "SECOND_INSTANCE", "CROSS_FRAME", "SRCDOC_FRAME", "NESTED_FRAME"]) assert.ok(allFrameHtml.includes(text), text)
  assert.doesNotMatch(allFrameHtml, /createObjectURL|src="https?:/)
  await finish("frame-tree")
  console.log("PASS same URL instances, cross-origin, srcdoc, nested frame capture and per-frame blobs")

  const pending = run("cancel-test", { url: origin + "/slow" })
  await new Promise((resolve) => setTimeout(resolve, 250))
  const wrongOwner = await application.evaluate(() =>
    (globalThis as any).captureTest.service.cancel(22, "cancel-test")
  )
  assert.equal(wrongOwner, false)
  await application.evaluate(() =>
    (globalThis as any).captureTest.service.cancel(11, "cancel-test")
  )
  assert.equal((await pending).status, "cancelled")
  const navigation = run("navigation-test", { source: "current-browser" })
  await new Promise((resolve) => setTimeout(resolve, 150))
  await application.evaluate(
    async (_electron, url) => (globalThis as any).captureTest.current.webContents.loadURL(url),
    origin + "/login"
  )
  assert.equal((await navigation).status, "failed")
  console.log("PASS cancellation ownership and navigation races")

  website.closeAllConnections()
  assets.closeAllConnections()
  await new Promise<void>((resolve) => website.close(() => resolve()))
  await new Promise<void>((resolve) => assets.close(() => resolve()))
  const offlineFrames = path.join(temporary, "offline-frames")
  await fs.cp(path.dirname(frameResult.artifactPath!), offlineFrames, { recursive: true })
  const frameOffline = await application.evaluate(async ({ BrowserWindow }, filePath) => {
    const preview = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    try {
      await preview.loadFile(filePath)
      return await preview.webContents.executeJavaScript(`(() => {
        const read = doc => ({ text: doc.body.innerText, images: [...doc.images].every(img => img.complete && img.naturalWidth > 0), frames: [...doc.querySelectorAll('iframe')].map(frame => read(frame.contentDocument)) });
        return read(document);
      })()`)
    } finally { preview.destroy() }
  }, path.join(offlineFrames, "index.html"))
  const offlineText = JSON.stringify(frameOffline)
  for (const text of ["FIRST_INSTANCE", "SECOND_INSTANCE", "CROSS_FRAME", "SRCDOC_FRAME", "NESTED_FRAME"]) assert.ok(offlineText.includes(text), text)
  assert.doesNotMatch(offlineText, /"images":false/)
  console.log("PASS independent offline frame tree with complete images")
  const exported = path.join(temporary, "exported")
  await fs.cp(path.dirname(result.artifactPath!), exported, { recursive: true })
  const offline = await application.evaluate(
    async ({ BrowserWindow }, filePath) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
      })
      try {
        await window.loadFile(filePath)
        return await window.webContents.executeJavaScript(`(() => ({
        text:document.getElementById('content').textContent,
        color:getComputedStyle(document.getElementById('content')).color,
        radius:getComputedStyle(document.getElementById('content')).borderRadius,
        images:[...document.images].every(image=>image.complete&&image.naturalWidth>0),
        api:typeof window.api,
        scripts:[...document.scripts].map(script=>script.hasAttribute('data-design-capture-runtime'))
      }))()`)
      } finally {
        window.destroy()
      }
    },
    path.join(exported, "index.html")
  )
  assert.equal(offline.text, "SIGNED_IN_DYNAMIC")
  assert.equal(offline.color, "rgb(12, 34, 56)")
  assert.equal(offline.radius, "7px")
  assert.equal(offline.images, true)
  assert.equal(offline.api, "undefined")
  assert.deepEqual(offline.scripts, [true])
  assert.equal(businessRequests, requestsAfterCapture)
  console.log(
    "PASS independent offline export preserves appearance and never replays source business scripts"
  )
} finally {
  await application?.close()
  website.closeAllConnections()
  assets.closeAllConnections()
  website.close()
  assets.close()
  await fs.rm(temporary, { recursive: true, force: true })
  await fs.rm(bundleDirectory, { recursive: true, force: true })
}
