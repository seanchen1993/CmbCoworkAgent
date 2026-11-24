/** A composer update must not rewrite the scroll viewport's global stylesheet. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const bundle = await build({
    stdin: {
      resolveDir: resolve("."),
      loader: "tsx",
      contents: `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ScrollArea} from './src/renderer/src/components/ui/scroll-area';
function Fixture() {
  const [draft, setDraft] = useState('');
  const [rows, setRows] = useState(20);
  return <><input aria-label="draft" value={draft} onChange={e=>setDraft(e.target.value)}/>
    <button onClick={()=>setRows(n=>n+10)}>append</button>
    <ScrollArea type="always" orientation="both" style={{height:150,width:300}}>
      <div style={{width:600}}>{Array.from({length:rows},(_,i)=><div key={i} style={{height:30}}>row {i}</div>)}</div>
    </ScrollArea><output>{draft.length}</output></>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/entry.js" ? "text/javascript" : "text/html")
    res.end(
      req.url === "/entry.js"
        ? bundle.outputFiles[0].text
        : '<meta charset="utf-8"><style>[data-radix-scroll-area-viewport]{height:100%;width:100%}[data-scroll-area-scrollbar]{width:8px;height:8px}</style><div id="root"></div><script type="module" src="/entry.js"></script>'
    )
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const browser = await chromium.launch({
    ...(existsSync(chromium.executablePath())
      ? {}
      : { channel: process.platform === "win32" ? "msedge" : "chrome" }),
    headless: true
  })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.getByRole("textbox", { name: "draft" }).waitFor()
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    )
    await page.evaluate(() => {
      const style = [...document.querySelectorAll("style")].find((e) =>
        e.textContent?.includes("-webkit-overflow-scrolling:touch")
      )!
      if (!style) throw new Error("Missing production viewport style")
      ;(window as any).styleWrites = 0
      new MutationObserver((records) => {
        ;(window as any).styleWrites += records.length
      }).observe(style, { childList: true, characterData: true, subtree: true })
    })
    await page.getByRole("textbox", { name: "draft" }).pressSequentially("x".repeat(100))
    assert.equal(await page.locator("output").textContent(), "100")
    assert.equal(
      await page.evaluate(() => (window as any).styleWrites),
      0,
      "unchanged viewport CSS must not be replaced on every draft edit"
    )
    const viewport = page.locator("[data-radix-scroll-area-viewport]")
    const before = await viewport.evaluate((e) => e.scrollHeight)
    await page.getByRole("button", { name: "append" }).click()
    await page.waitForFunction(
      (height) =>
        document.querySelector("[data-radix-scroll-area-viewport]")!.scrollHeight > height,
      before
    )
    await viewport.hover()
    await page.mouse.wheel(90, 180)
    await page.waitForFunction(() => {
      const e = document.querySelector("[data-radix-scroll-area-viewport]")!
      return e.scrollTop > 0 && e.scrollLeft > 0
    })
    assert.equal(await page.evaluate(() => (window as any).styleWrites), 0)
    assert.deepEqual(errors, [])
    console.log(
      "PASS: draft updates retain viewport stylesheet; appended content and both scroll axes work"
    )
  } finally {
    await browser.close()
    await new Promise<void>((done) => server.close(() => done()))
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
