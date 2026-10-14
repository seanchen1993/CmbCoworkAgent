import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

const bundle = await build({
  stdin: {
    contents: `import Highlight from "./src/renderer/src/components/tabs/code-highlight-worker?worker";
      window.highlightWorker = new Highlight({name:"real-highlight-smoke"});`,
    resolveDir: resolve(".")
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  plugins: [browserWorkerPlugin()]
})
const browser = await chromium.launch({
  ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }),
  headless: true
})
try {
  const page = await browser.newPage()
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const result = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const worker = window.highlightWorker
        const timer = setTimeout(() => {
          worker.terminate()
          reject(Error("worker timeout"))
        }, 15000)
        worker.onerror = (event) => {
          clearTimeout(timer)
          worker.terminate()
          reject(Error(event.message))
        }
        worker.onmessage = ({ data }) => {
          clearTimeout(timer)
          worker.terminate()
          resolve(data)
        }
        worker.postMessage({
          type: "highlight",
          requestId: 7,
          content: "const answer = 42",
          language: "typescript"
        })
      })
  )
  assert.equal(result.requestId, 7)
  assert.equal(result.ok, true)
  assert.match(result.html, /shiki/)
  assert.match(result.html, /answer/)
  console.log("PASS real bundled Shiki worker: Blob Worker roundtrip and termination")
} finally {
  await browser.close()
}
