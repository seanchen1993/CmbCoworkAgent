import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

interface ResizeFixtureWindow extends Window {
  mount(explicitCleanup: boolean, fullscreen: boolean): void
  snapshot(): { value: number; widthStart: number | null; percentStart: number | null }
  remove(): void
}

async function main() {
  const output = resolve("output/right-resize-lifecycle")
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
        import React,{useCallback,useEffect,useRef,useState} from 'react';
        import{createRoot}from'react-dom/client';
        import{ResizeHandle}from'./src/renderer/src/components/ui/resizable';
        const root=createRoot(document.getElementById('root'));let revision=0;
        function Fixture({explicitCleanup,fullscreen}){
          const[value,setValue]=useState(fullscreen?50:500);
          const widthStart=useRef(null),percentStart=useRef(null);
          const[shown,setShown]=useState(true);
          const finish=useCallback(()=>{widthStart.current=null;percentStart.current=null},[]);
          // Match App's earlier global listener and retained legacy split cleanup.
          useEffect(()=>{document.addEventListener('mouseup',finish);
            return()=>document.removeEventListener('mouseup',finish)},[finish]);
          const drag=useCallback(delta=>{
            if(fullscreen){if(percentStart.current===null)percentStart.current=value;
              setValue(percentStart.current-delta/10)}
            else{if(widthStart.current===null)widthStart.current=value;
              setValue(widthStart.current-delta)}
          },[value,fullscreen]);
          window.snapshot=()=>({value,widthStart:widthStart.current,percentStart:percentStart.current});
          window.remove=()=>setShown(false);
          return <div><output>{value}</output>{shown&&<ResizeHandle onDrag={drag}
            onDragEnd={explicitCleanup?finish:undefined}
            onDragCancel={explicitCleanup?finish:undefined}/>}</div>;
        }
        window.mount=(explicitCleanup,fullscreen)=>root.render(<Fixture key={++revision}
          explicitCleanup={explicitCleanup} fullscreen={fullscreen}/>);`
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
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const evidence: unknown[] = []
  try {
    await page.setContent("<div id='root'></div>")
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const settle = () =>
      page.evaluate(
        () => new Promise<void>((done) => requestAnimationFrame(() => setTimeout(done, 0)))
      )
    const down = () =>
      page.getByRole("separator").dispatchEvent("mousedown", { clientX: 100, button: 0 })
    const snapshot = () => page.evaluate(() => (window as ResizeFixtureWindow).snapshot())
    for (const fullscreen of [false, true]) {
      for (const explicitCleanup of [false, true]) {
        for (const end of ["mouseup", "blur"] as const) {
          await page.evaluate(
            ({ explicitCleanup, fullscreen }) =>
              (window as ResizeFixtureWindow).mount(explicitCleanup, fullscreen),
            { explicitCleanup, fullscreen }
          )
          await settle()
          await down()
          await page.evaluate(() =>
            document.dispatchEvent(new MouseEvent("mousemove", { clientX: 120 }))
          )
          await settle()
          assert.equal((await snapshot()).value, fullscreen ? 48 : 480)
          // Keep the last pointer update pending until release, after App's old
          // document listener has already run; blur has no document mouseup.
          await page.evaluate((end) => {
            document.dispatchEvent(new MouseEvent("mousemove", { clientX: 140 }))
            if (end === "blur") window.dispatchEvent(new Event("blur"))
            else document.dispatchEvent(new MouseEvent("mouseup"))
          }, end)
          await settle()
          const first = await snapshot()
          assert.equal(first.value, fullscreen ? 46 : 460)
          if (explicitCleanup)
            assert.deepEqual([first.widthStart, first.percentStart], [null, null])
          await down()
          await page.evaluate(() => {
            document.dispatchEvent(new MouseEvent("mousemove", { clientX: 110 }))
          })
          await settle()
          const second = await snapshot()
          assert.equal(
            second.value,
            explicitCleanup ? (fullscreen ? 45 : 450) : fullscreen ? 49 : 490,
            explicitCleanup
              ? "next drag uses the preceding final width"
              : "old App lifecycle reproduces stale baseline"
          )
          await page.evaluate(() => document.dispatchEvent(new MouseEvent("mouseup")))
          await settle()
          assert.equal(
            (await snapshot()).value,
            second.value,
            "release retains the last physically rendered frame"
          )
          if (explicitCleanup)
            assert.deepEqual(
              [(await snapshot()).widthStart, (await snapshot()).percentStart],
              [null, null]
            )
          if (explicitCleanup)
            assert.equal(
              fullscreen ? second.percentStart : second.widthStart,
              fullscreen ? 46 : 460
            )
          evidence.push({ fullscreen, explicitCleanup, end, first, second })
        }
      }
      await page.evaluate(
        (fullscreen) => (window as ResizeFixtureWindow).mount(true, fullscreen),
        fullscreen
      )
      await settle()
      await down()
      await page.evaluate(() =>
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: 120 }))
      )
      await settle()
      await page.evaluate(() => (window as ResizeFixtureWindow).remove())
      await settle()
      const cancelled = await snapshot()
      assert.deepEqual([cancelled.widthStart, cancelled.percentStart], [null, null])
      await page.evaluate(() =>
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: 300 }))
      )
      await settle()
      assert.deepEqual(await snapshot(), cancelled, "unmounted handle cannot update the panel")
    }
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "evidence.json"),
      JSON.stringify({ passed: true, evidence, errors }, null, 2)
    )
    console.log(
      "PASS real ResizeHandle: old stale baseline reproduced; explicit end/cancel preserves consecutive pixel/percent drags, pending mouseup, blur and unmount"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
