import assert from "node:assert/strict"
import { createServer } from "node:http"
import { build } from "esbuild"
import { chromium } from "playwright"

const root = process.cwd()
const app = await build({
  stdin: {
    contents: `
export * from './src/renderer/src/lib/design-preview-preparation';
export * from './src/renderer/src/lib/design-html-srcdoc';
export * from './src/renderer/src/lib/design-preview-resources';
`,
    resolveDir: root,
    loader: "ts"
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm"
})
const worker = await build({
  entryPoints: ["src/renderer/src/lib/design-preview-worker.ts"],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm"
})
const server = createServer((req, res) => {
  res.setHeader(
    "content-type",
    req.url?.endsWith(".js") || req.url?.endsWith(".ts") ? "text/javascript" : "text/html"
  )
  res.end(
    req.url === "/app.js"
      ? app.outputFiles[0].contents
      : req.url === "/design-preview-worker.ts"
        ? worker.outputFiles[0].contents
        : '<!doctype html><input id="composer"><div id="preview"></div>'
  )
})
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined
})
try {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
  const result = await page.evaluate(async () => {
    const modulePath = "/app.js"
    const m = await import(modulePath)
    const svg =
      "data:image/svg+xml;base64," +
      btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/><!--' +
          "x".repeat(64000) +
          "--></svg>"
      )
    const text: Record<string, string> = {
      "/capture/frames/f_1.html":
        '<html><head><link rel="stylesheet" href="../assets/theme.css"></head><body><h2>子页面</h2><img src="../assets/shared.svg"><iframe data-design-capture-frame="f_2" src="../frames/f_2.html"></iframe></body></html>',
      "/capture/frames/f_2.html":
        '<html><body><p>嵌套页面</p><img src="../assets/shared.svg"></body></html>',
      "/capture/assets/theme.css": "h2{color:rgb(12,34,56);background-image:url(shared.svg)}"
    }
    const reads: string[] = []
    ;(window as unknown as { api: unknown }).api = {
      file: {
        readText: async (path: string) => {
          reads.push(path)
          return { success: path in text, content: text[path] }
        },
        readDataUrl: async (path: string) => {
          reads.push(path)
          return { success: true, dataUrl: svg }
        }
      }
    }
    const business =
      'const printHtml="<html><head><style>:root{--fake:#ffffff}</style></head><body>打印</body></html>"; function contact(c){return `<p>${c.task}</p>`;} window.fixtureReady=true;'
    const source =
      "<!doctype html><html><head><style>h1{color:#123456}</style></head><body><h1>财富管理</h1>" +
      '<img src="assets/shared.svg">'.repeat(100) +
      '<iframe data-design-capture-frame="f_1" src="frames/f_1.html"></iframe><script>' +
      business +
      "</script></body></html>"
    const first = m.prepareDesignPreview(source, "/capture/index.html")
    const duplicate = m.prepareDesignPreview(source, "/capture/index.html")
    const reused = first === duplicate
    const html = await first
    const frame = document.createElement("iframe")
    frame.style.cssText = "width:800px;height:600px"
    document.getElementById("preview")!.append(frame)
    await new Promise<void>((done) => {
      frame.onload = () => done()
      frame.srcdoc = html
    })
    m.commitPreparedDesignPreview(html)
    const doc = frame.contentDocument!
    const child = doc.querySelector("iframe")!.contentDocument!
    const nested = child.querySelector("iframe")!.contentDocument!
    const oldBlob = doc.images[0].src
    const snapshot = {
      reused,
      body: doc.body.innerText,
      ready: (frame.contentWindow as unknown as { fixtureReady?: boolean }).fixtureReady,
      imageUrls: new Set([...doc.images, ...child.images, ...nested.images].map((img) => img.src))
        .size,
      images: [...doc.images, ...child.images, ...nested.images].every(
        (img) => img.complete && img.naturalWidth > 0
      ),
      childText: child.body.innerText,
      nestedText: nested.body.innerText,
      color: getComputedStyle(child.querySelector("h2")!).color,
      reads: reads.filter((path) => path.endsWith("shared.svg")).length,
      bytes: new TextEncoder().encode(html).byteLength,
      canonicalUnchanged: !source.includes("blob:")
    }
    const second = await m.prepareDesignPreview(
      source.replace("财富管理", "第二版"),
      "/capture/index.html"
    )
    // A delayed acknowledgement from the old page must not revoke the prepared replacement.
    m.commitPreparedDesignPreview(html)
    const nextBlob = new DOMParser().parseFromString(second, "text/html").images[0].src
    const replacementSurvivesOldAck = (await fetch(nextBlob)).ok
    const oldBeforeSwap = (await fetch(oldBlob)).ok
    await new Promise<void>((done) => {
      frame.onload = () => done()
      frame.srcdoc = second
    })
    m.commitPreparedDesignPreview(second)
    let revoked = false
    try {
      await fetch(oldBlob)
    } catch {
      revoked = true
    }
    const huge =
      "<html><body>" +
      Array.from({ length: 20000 }, (_, i) => `<div>第${i}项：${"页面内容".repeat(25)}</div>`).join(
        ""
      ) +
      "</body></html>"
    let ticks = 0
    const timer = setInterval(() => ticks++, 5)
    const started = performance.now()
    const large = await m.prepareDesignPreview(huge)
    clearInterval(timer)
    const milliseconds = Math.round(performance.now() - started)
    const canceled = m.prepareDesignPreview(huge + "old").then(
      () => false,
      () => true
    )
    await m.prepareDesignPreview("<p>new</p>")
    const cancellation = await canceled
    m.disposePreparedDesignPreviews()
    return {
      ...snapshot,
      replacementSurvivesOldAck,
      oldBeforeSwap,
      revoked,
      milliseconds,
      ticks,
      nodes: (large.match(/data-design-node=/g) ?? []).length,
      cancellation
    }
  })
  assert.equal(result.reused, true)
  assert.equal(result.ready, true)
  assert.doesNotMatch(result.body, /function contact|c\.task|打印/)
  assert.equal(result.imageUrls, 1)
  assert.equal(result.images, true)
  assert.equal(result.reads, 1)
  assert.equal(result.color, "rgb(12, 34, 56)")
  assert.match(result.childText, /子页面/)
  assert.match(result.nestedText, /嵌套页面/)
  assert(result.bytes < 100000, `preview must not duplicate the image bytes: ${result.bytes}`)
  assert.equal(result.canonicalUnchanged, true)
  assert.equal(result.replacementSurvivesOldAck, true)
  assert.equal(result.oldBeforeSwap, true)
  assert.equal(result.revoked, true)
  assert.equal(result.nodes, 20000)
  assert(result.ticks > 0, "the UI event loop must respond during worker preparation")
  assert.equal(result.cancellation, true)
  assert.deepEqual(errors, [])
  console.log(
    "PASS structural injection, Worker reuse/cancellation, frame previews, Blob deduplication and lifecycle",
    JSON.stringify(result)
  )
} finally {
  await browser.close()
  await new Promise<void>((done) => server.close(() => done()))
}
