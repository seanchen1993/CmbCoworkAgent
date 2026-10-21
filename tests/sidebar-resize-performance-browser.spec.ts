import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

interface ResizeWindow extends Window {
  mount(mode: "baseline" | "preview"): void
  unmount(): void
  renders: number
  commits: number[]
}

async function main() {
  const output = resolve("output/sidebar-resize-performance")
  mkdirSync(output, { recursive: true })
  const source = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React,{useState,useRef} from 'react';import{createRoot}from'react-dom/client';
      import{ResizeHandle}from'./src/renderer/src/components/ui/resizable';
      import{useSidebarResizePreview}from'./src/renderer/src/lib/sidebar-resize-preview';
      const root=createRoot(document.getElementById('root'));let revision=0;
      function Fixture({mode}){
        const[width,setWidth]=useState(240);const start=useRef(width);window.renders++;
        const resize=useSidebarResizePreview(width,value=>{window.commits.push(value);setWidth(value)},180,480);
        return <><div style={{display:'flex'}}><aside aria-label='sidebar' style={{flexShrink:0,width:'var(--app-sidebar-width,'+width+'px)'}}>
          {Array.from({length:600},(_,i)=><p key={i}>会话 {i} · 真实 React 侧栏内容</p>)}</aside>
          <ResizeHandle onDrag={mode==='baseline'?delta=>setWidth(Math.min(480,Math.max(180,start.current+delta))):resize.preview}
          onDragEnd={mode==='baseline'?undefined:resize.finish} onDragCancel={resize.cancel}/>
          <main style={{flex:1}}>业务内容区域 {width}</main></div></>;
      }
      window.mount=mode=>{window.renders=0;window.commits=[];root.render(<Fixture key={++revision} mode={mode}/>)};
      window.unmount=()=>root.render(null);
      window.mount('baseline');`
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic"
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.route("http://localhost/sidebar-resize", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<style>body{margin:0}aside p{margin:0;height:24px}</style><div id='root'></div>"
      })
    )
    await page.goto("http://localhost/sidebar-resize")
    await page.addScriptTag({ content: source.outputFiles[0].text })
    const settle = () =>
      page.evaluate(
        () => new Promise<void>((done) => requestAnimationFrame(() => setTimeout(done, 0)))
      )
    const down = async () => {
      await page.getByRole("separator").dispatchEvent("mousedown", { clientX: 240, button: 0 })
    }
    const move = (x: number) =>
      page.evaluate((x) => document.dispatchEvent(new MouseEvent("mousemove", { clientX: x })), x)
    const up = () => page.evaluate(() => document.dispatchEvent(new MouseEvent("mouseup")))
    const width = () =>
      page.getByLabel("sidebar").evaluate((element) => element.getBoundingClientRect().width)
    await page.getByRole("separator").waitFor()
    const measurements: unknown[] = []
    for (const mode of ["baseline", "preview"] as const) {
      await page.evaluate((mode) => (window as ResizeWindow).mount(mode), mode)
      await settle()
      const before = await page.evaluate(() => (window as ResizeWindow).renders)
      await down()
      const started = Date.now()
      for (let step = 1; step <= 24; step++) {
        await move(240 + step * 4)
        await settle()
        assert.equal(await width(), 240 + step * 4, "width updates during the gesture")
      }
      const during = await page.evaluate(() => (window as ResizeWindow).renders)
      await up()
      await settle()
      const after = await page.evaluate(() => (window as ResizeWindow).renders)
      if (mode === "baseline")
        assert(during - before >= 20, "baseline must exercise React per frame")
      else {
        assert.equal(during - before, 0, "preview never rerenders the App during pointer frames")
        assert.equal(after - during, 1, "release commits one final React state")
        assert.deepEqual(await page.evaluate(() => (window as ResizeWindow).commits), [336])
      }
      measurements.push({
        mode,
        pointerFrames: 24,
        renderDuring: during - before,
        renderOnRelease: after - during,
        elapsedMs: Date.now() - started,
        finalWidth: await width()
      })
    }
    // Each new gesture starts from the committed width; bounds remain unchanged.
    await down()
    await move(2000)
    await settle()
    assert.equal(await width(), 480)
    await up()
    await settle()
    await down()
    await move(-1000)
    await settle()
    assert.equal(await width(), 180)
    await up()
    await settle()
    // Blur flushes a pending last pointer frame and restores pre-existing body styles.
    await page.evaluate(() => {
      document.body.style.cursor = "crosshair"
      document.body.style.userSelect = "text"
    })
    await down()
    await move(270)
    await page.evaluate(() => window.dispatchEvent(new Event("blur")))
    await settle()
    assert.equal(await width(), 210)
    assert.deepEqual(
      await page.evaluate(() => [document.body.style.cursor, document.body.style.userSelect]),
      ["crosshair", "text"]
    )
    // Removing a handle mid-gesture cancels pending work and leaves no global listeners.
    await down()
    await move(310)
    await page.evaluate(() => (window as ResizeWindow).unmount())
    await settle()
    const committed = await page.evaluate(() => (window as ResizeWindow).commits.slice())
    await move(900)
    await up()
    await settle()
    assert.deepEqual(await page.evaluate(() => (window as ResizeWindow).commits), committed)
    assert.equal(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--app-sidebar-resize-duration")
      ),
      ""
    )
    assert.equal(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--app-sidebar-width")
      ),
      ""
    )
    // Existing consumers with only onDrag still receive a pending final frame.
    await page.evaluate(() => (window as ResizeWindow).mount("baseline"))
    await settle()
    await down()
    await page.evaluate(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 280 }))
      document.dispatchEvent(new MouseEvent("mouseup"))
    })
    await settle()
    assert.equal(await width(), 280)
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "evidence.json"),
      JSON.stringify(
        {
          passed: true,
          measurements,
          checks: [
            "live width each frame",
            "one final commit",
            "min/max",
            "next gesture",
            "blur pending flush",
            "unmount cleanup",
            "original onDrag-only release flush"
          ],
          errors
        },
        null,
        2
      )
    )
    console.log(
      "PASS sidebar resize: 24 live frames, baseline >=20 App renders, preview 0 and release 1; bounds/blur/unmount preserved"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
