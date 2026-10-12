/** Isolated real React/PDF.js/Chromium, using public synthetic PDF bytes only.
 * Does not attach to the user's App, browser, Host or private database. */
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, realpath, symlink, rm, mkdir } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { build } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { chromium, _electron } from "playwright"
import { pdfPreviewAssetsPlugin } from "../src/main/build/pdf-preview-assets"

function pdf(pages: number, label: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ]
  for (let number = 1; number <= pages; number++) {
    const width = number % 2 ? 595 : 842,
      height = number % 2 ? 842 : 595
    const content = `BT /F1 18 Tf 48 ${height - 92} Td (${label} page ${number}) Tj ET`
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + (number - 1) * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
    )
  }
  let result = "%PDF-1.4\n"
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(result))
    result += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(result)
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  result += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(result)
}

async function main() {
  const root = resolve(".")
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cmb-pdf-preview-")))
  const cases: string[] = []
  let server: ReturnType<typeof createServer> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined
  const engine = process.argv.includes("--electron") ? "electron" : "chrome"
  try {
    await symlink(
      join(root, "node_modules"),
      join(directory, "node_modules"),
      process.platform === "win32" ? "junction" : "dir"
    )
    await writeFile(join(directory, "a.pdf"), pdf(30, "SYNTHETIC PDF"))
    await writeFile(join(directory, "b.pdf"), pdf(1, "REPLACEMENT PDF"))
    await writeFile(
      join(directory, "index.html"),
      '<div id="root"></div><script type="module" src="/entry.tsx"></script>'
    )
    await writeFile(
      join(directory, "entry.tsx"),
      `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BotPdfPreview } from ${JSON.stringify(join(root, "src/renderer/src/components/bots/BotPdfPreview.tsx"))};
import ${JSON.stringify(join(root, "src/renderer/src/index.css"))};
function App() {
  const [source, setSource] = useState('/a.pdf'), [url, setUrl] = useState(null), [open, setOpen] = useState(true), [saved, setSaved] = useState(0);
  useEffect(() => { let disposed = false, owned; setUrl(null);
    const request = source === 'invalid' ? Promise.resolve(new Blob(['not a PDF'])) : fetch(source).then(r => r.blob());
    request.then(blob => { if (disposed) return; owned = URL.createObjectURL(blob); setUrl(owned) });
    return () => { disposed = true; if (owned) URL.revokeObjectURL(owned); };
  }, [source]);
  return <><button id="swap" onClick={() => setSource('/b.pdf')}>swap</button><button id="invalid" onClick={() => setSource('invalid')}>invalid</button><button id="close" onClick={() => setOpen(false)}>close</button><span id="saved">{saved}</span>
    <div style={{ height: 720, width: 900, display: 'flex' }}>{open && url && <BotPdfPreview sourceUrl={url} onDownload={() => setSaved(n => n+1)}/>}</div></>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
`
    )
    const distribution = join(directory, "dist")
    await build({
      configFile: false,
      root: directory,
      base: "./",
      plugins: [pdfPreviewAssetsPlugin(), react(), tailwindcss()],
      resolve: { alias: { "@": join(root, "src/renderer/src") } },
      build: { outDir: distribution, emptyOutDir: true },
      logLevel: "error"
    })
    server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture").pathname
      if (path === "/favicon.ico") {
        response.writeHead(204)
        response.end()
        return
      }
      const location = resolve(distribution, "." + (path === "/" ? "/index.html" : path))
      if (!location.startsWith(distribution + sep)) {
        response.writeHead(404)
        response.end()
        return
      }
      const bytes =
        path === "/a.pdf"
          ? Promise.resolve(pdf(30, "SYNTHETIC PDF"))
          : path === "/b.pdf"
            ? Promise.resolve(pdf(1, "REPLACEMENT PDF"))
            : readFile(location)
      void bytes
        .then((data) => {
          const mime = /\.m?js$/.test(path)
            ? "text/javascript"
            : path.endsWith(".css")
              ? "text/css"
              : path.endsWith(".pdf")
                ? "application/pdf"
                : path.endsWith(".wasm")
                  ? "application/wasm"
                  : path === "/"
                    ? "text/html"
                    : "application/octet-stream"
          response.setHeader("Content-Type", mime)
          response.end(data)
        })
        .catch(() => {
          response.writeHead(404)
          response.end()
        })
    })
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done))
    const address = server.address()
    assert(address && typeof address !== "string")
    if (engine === "electron") {
      // An isolated window owned only by this synthetic fixture. No application
      // main, preload, Host, profile or user database is loaded here.
      const main = join(directory, "fixture.cjs")
      await writeFile(
        main,
        `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(join(directory, "electron-profile"))});
app.commandLine.appendSwitch('force-device-scale-factor', '2');
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1100, height: 950, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.loadURL(${JSON.stringify(`http://127.0.0.1:${address.port}`)});
});
app.on('window-all-closed', () => app.quit());
`
      )
      electron = await _electron.launch({ args: [main] })
    } else {
      browser = await chromium.launch({
        channel: process.platform === "win32" ? "msedge" : "chrome",
        headless: true
      })
    }
    const page = electron
      ? await electron.firstWindow()
      : await browser!.newPage({
          viewport: { width: 1100, height: 950 },
          deviceScaleFactor: 2
        })
    const errors: string[] = []
    page.on("pageerror", (error) =>
      errors.push(error.message + " " + (error.stack?.slice(0, 1200) ?? ""))
    )
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text().slice(0, 1000))
    })
    await page.goto(`http://127.0.0.1:${address.port}`)
    const text = (label: string) => page.locator(".bot-pdf-text").getByText(label, { exact: true })
    try {
      await text("SYNTHETIC PDF page 1").waitFor({ timeout: 30_000 })
    } catch (error) {
      console.error(
        JSON.stringify({
          syntheticBody: await page.locator("body").innerText(),
          errors,
          workers: page.workers().length
        })
      )
      throw error
    }
    assert.equal(await page.getByLabel("共 30 页").textContent(), "/ 30")
    assert((await page.locator(".bot-pdf-page").count()) <= 5)
    assert((await page.locator("canvas").count()) <= 5)
    const measured = await text("SYNTHETIC PDF page 1").boundingBox()
    assert(
      measured && measured.height > 10 && measured.width > 80,
      "selectable text has real geometry"
    )
    cases.push("actual worker renders text with geometry; only the visible window owns canvases")

    await page.getByRole("textbox", { name: "页码", exact: true }).fill("12")
    await page.getByRole("textbox", { name: "页码", exact: true }).press("Enter")
    await text("SYNTHETIC PDF page 12").waitFor()
    await page.waitForFunction(
      () => (document.querySelector('input[aria-label="页码"]') as HTMLInputElement)?.value === "12"
    )
    cases.push("page jump and visible-page indicator agree, excluding overscan rows")

    const before = await page
      .locator('[aria-label="第 12 页"] canvas')
      .evaluate((canvas: HTMLCanvasElement) => canvas.width)
    await page.getByRole("button", { name: "放大", exact: true }).click()
    await page.waitForFunction((width) => {
      const canvas = document.querySelector(
        '[aria-label="第 12 页"] canvas'
      ) as HTMLCanvasElement | null
      return !!canvas && canvas.width > width
    }, before)
    assert(
      await page
        .locator("canvas")
        .evaluateAll((canvases) =>
          canvases.every(
            (canvas: HTMLCanvasElement) => canvas.width * canvas.height <= 4 * 1024 * 1024
          )
        )
    )
    const landscape = page.locator('[aria-label="第 12 页"]')
    const bounds = await landscape.evaluate((element) => {
      const row = element.parentElement!.getBoundingClientRect()
      const paper = element.getBoundingClientRect()
      return { rowWidth: row.width, paperWidth: paper.width, leftInset: paper.left - row.left }
    })
    assert(
      bounds.rowWidth >= bounds.paperWidth + 30 && bounds.leftInset >= 10,
      "mixed-size pages remain reachable at the left edge after zoom"
    )
    cases.push("zoom draws again within the per-page high-DPI pixel limit")

    await page.locator("#swap").click()
    await text("REPLACEMENT PDF page 1").waitFor()
    assert.equal(await text("SYNTHETIC PDF page 12").count(), 0)
    await assertEventually(() => page.workers().length === 1)
    cases.push("changing files releases the previous worker and removes old text")

    await page.locator("#invalid").click()
    await page.getByRole("alert").waitFor()
    await page.getByRole("button", { name: "保存原文件", exact: true }).click()
    assert.equal(await page.locator("#saved").textContent(), "1")
    await assertEventually(() => page.workers().length === 0)
    cases.push("invalid PDF terminates its worker and preserves the parent save callback")

    await page.locator("#close").click()
    assert.equal(await page.locator("canvas").count(), 0)
    assert.equal(await page.locator(".bot-pdf-text").count(), 0)
    assert.deepEqual(errors, [])
    cases.push("unmount leaves no canvas, text layer, worker or uncaught page error")
    const output = join(root, "output/bot-pdf-preview")
    await mkdir(output, { recursive: true })
    await writeFile(
      join(output, `result-${engine}.json`),
      JSON.stringify(
        { status: "passed", engine, cases, productionAppTouched: false, syntheticOnly: true },
        null,
        2
      ) + "\n"
    )
    console.log(JSON.stringify({ status: "passed", engine, cases }))
  } finally {
    await electron?.close()
    await browser?.close()
    if (server) await new Promise<void>((done) => server!.close(() => done()))
    await rm(directory, { recursive: true, force: true })
  }
}

async function assertEventually(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert(predicate())
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
