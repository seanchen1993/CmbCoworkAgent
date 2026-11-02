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
    let pointerStart = 0
    const down = async () => {
      await page.mouse.up()
      const box = await page.getByRole("separator").boundingBox()
      assert(box)
      pointerStart = box.x + box.width / 2
      await page.mouse.move(pointerStart, box.y + Math.min(box.height / 2, 200))
      await page.mouse.down()
    }
    const move = (delta: number) =>
      page.evaluate((clientX) => {
        document
          .querySelector('[role="separator"]')
          ?.dispatchEvent(new PointerEvent("pointermove", { clientX, pointerId: 1, bubbles: true }))
      }, pointerStart + delta)
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
          await move(20)
          await settle()
          assert.equal((await snapshot()).value, fullscreen ? 48 : 480)
          // Keep the last update pending until release. Pointer capture and blur
          // must end the drag even without a compatibility mouseup event.
          await page.evaluate(
            ({ end, clientX }) => {
              const handle = document.querySelector('[role="separator"]')!
              handle.dispatchEvent(
                new PointerEvent("pointermove", { clientX, pointerId: 1, bubbles: true })
              )
              if (end === "blur") window.dispatchEvent(new Event("blur"))
              else
                handle.dispatchEvent(
                  new PointerEvent("pointerup", { clientX, pointerId: 1, bubbles: true })
                )
            },
            { end, clientX: pointerStart + 40 }
          )
          await settle()
          const first = await snapshot()
          assert.equal(first.value, fullscreen ? 46 : 460)
          if (explicitCleanup)
            assert.deepEqual([first.widthStart, first.percentStart], [null, null])
          await down()
          await move(10)
          await settle()
          const second = await snapshot()
          assert.equal(
            second.value,
            explicitCleanup ? (fullscreen ? 45 : 450) : fullscreen ? 49 : 490,
            explicitCleanup
              ? "next drag uses the preceding final width"
              : "legacy mouse-only cleanup leaves a stale pointer baseline"
          )
          await page.mouse.up()
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
      await move(20)
      await settle()
      await page.evaluate(() => (window as ResizeFixtureWindow).remove())
      await settle()
      const cancelled = await snapshot()
      assert.deepEqual([cancelled.widthStart, cancelled.percentStart], [null, null])
      await move(200)
      await settle()
      assert.deepEqual(await snapshot(), cancelled, "unmounted handle cannot update the panel")
    }
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "evidence.json"),
      JSON.stringify({ passed: true, evidence, errors }, null, 2)
    )
    console.log(
      "PASS real ResizeHandle: pointer capture and explicit end/cancel preserves consecutive pixel/percent drags, pending mouseup, blur and unmount"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
