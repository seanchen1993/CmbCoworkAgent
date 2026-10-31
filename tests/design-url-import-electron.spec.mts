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
  if (url === "/styles/main.css") {
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
    response.end(`<h1 id="session-state">${""}</h1><input id="value"><script>
      sessionStorage.setItem('private-state','CURRENT_TAB');
      document.getElementById('session-state').textContent=sessionStorage.getItem('private-state');
      document.getElementById('value').value='USER_EDITED';
      window.inMemoryToken='must-not-export';</script>`)
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
    import { DesignUrlImportService } from './src/main/services/design/url-import-service';
    import { getBuiltinBrowserSession } from './src/main/browser/core/browser-profile-session';
    import { setGlobalBrowserService } from './src/main/browser/core/browser-service-registry';
    app.setPath('userData', process.env.DESIGN_URL_TEST_PROFILE);
    app.whenReady().then(() => {
      const current = new BrowserWindow({show:false,webPreferences:{session:getBuiltinBrowserSession(),backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
      current.loadURL('about:blank');
      setGlobalBrowserService({getWebContents:()=>current.webContents});
      globalThis.captureTest={service:new DesignUrlImportService(),current,profile:getBuiltinBrowserSession(),defaultSession:session.defaultSession,progress:[]};
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
  await finish("current-page", false)
  console.log("PASS current-page capture preserves tab storage and input state")

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

  await new Promise<void>((resolve) => website.close(() => resolve()))
  await new Promise<void>((resolve) => assets.close(() => resolve()))
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
