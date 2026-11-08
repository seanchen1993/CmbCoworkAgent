/** Real Virtuoso: cancelling its initial LAST request must release the hidden probe. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { verifyExternalAnchorOwnership } from "./support/chat-external-anchor-browser"
import { verifySessionSaveAnchor } from "./support/chat-session-save-anchor-browser"
import { verifyVirtualOverscan } from "./support/chat-virtual-overscan-browser"
import { verifyNativeItemMeasurements } from "./support/chat-native-item-measurement-browser"

async function main() {
  const output = resolve("output/chat-virtual-initial-cancel")
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
        import React,{useRef,useCallback}from'react';
        import{createRoot}from'react-dom/client';
        import{Virtuoso}from'react-virtuoso';
        function Fixture(){
          const handle=useRef(null),parent=useRef(null),stopped=useRef(false);
          const onScroll=useCallback(()=>{
            const viewport=parent.current;
            const list=viewport?.querySelector('[data-testid="virtuoso-item-list"]');
            if(!stopped.current&&viewport?.scrollTop>0&&list?.style.visibility==='hidden'){
              stopped.current=true;
              window.initialCancel={top:viewport.scrollTop,visibility:list.style.visibility};
              handle.current.cancelScrollToIndex();
            }
          },[]);
          const onWheel=useCallback(()=>{handle.current.cancelScrollToIndex();window.wheelCancels++},[]);
          const scroller=useCallback(node=>{
            parent.current?.removeEventListener('scroll',onScroll);
            parent.current?.removeEventListener('wheel',onWheel);
            parent.current=node;
            node?.addEventListener('scroll',onScroll,{passive:true});
            node?.addEventListener('wheel',onWheel,{passive:true});
          },[]);
          window.wheelCancels??=0;
          window.initialFixture={jump:index=>handle.current.scrollToIndex({index,align:'start',behavior:'auto'})};
          return <Virtuoso ref={handle} scrollerRef={scroller} style={{height:400,width:600}}
            totalCount={200} initialTopMostItemIndex={{index:'LAST',align:'end'}}
            itemContent={index=><div data-row={index} style={{height:[90,310,120,550][index%4]}}>Message {index}</div>}/>;
        }
        createRoot(document.getElementById('root')).render(<Fixture/>);
      `
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: "window.__name=value=>value" })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.waitForFunction("Boolean(window.initialCancel)")
    const cancelled = await page.evaluate("window.initialCancel")
    assert.equal(
      cancelled.visibility,
      "hidden",
      "Cancel must interrupt the initial hidden transaction"
    )
    await page.waitForFunction(
      () => {
        const list = document.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')!
        const viewport = document.querySelector<HTMLElement>("[data-virtuoso-scroller]")!
        const bounds = viewport.getBoundingClientRect()
        return (
          getComputedStyle(list).visibility === "visible" &&
          [...list.querySelectorAll<HTMLElement>("[data-row]")].some((row) => {
            const rect = row.getBoundingClientRect()
            return rect.bottom > bounds.top && rect.top < bounds.bottom
          })
        )
      },
      null,
      { timeout: 3000 }
    )
    await page.evaluate("window.initialFixture.jump(30)")
    await page.waitForFunction(() => {
      const row = document.querySelector<HTMLElement>('[data-row="30"]')
      const viewport = document.querySelector<HTMLElement>("[data-virtuoso-scroller]")!
      return (
        row && Math.abs(row.getBoundingClientRect().top - viewport.getBoundingClientRect().top) <= 2
      )
    })
    // Start another index request, then let a real wheel take over inside its retry window.
    await page.locator("[data-virtuoso-scroller]").hover()
    await page.evaluate("window.initialFixture.jump(100)")
    await page.mouse.wheel(0, -650)
    await page.waitForFunction("window.wheelCancels>0")
    await page.waitForTimeout(200)
    const manualTop = await page
      .locator("[data-virtuoso-scroller]")
      .evaluate((node) => node.scrollTop)
    await page.waitForTimeout(200)
    const after = await page.locator("[data-virtuoso-scroller]").evaluate((node) => node.scrollTop)
    assert.equal(after, manualTop, "A cancelled index retry must not overwrite real wheel input")
    const wheelVisibleIndex = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>("[data-virtuoso-scroller]")!
      const top = viewport.getBoundingClientRect().top
      const row = [...viewport.querySelectorAll<HTMLElement>("[data-row]")].find(
        (node) => node.getBoundingClientRect().bottom > top
      )
      return Number(row?.dataset.row)
    })
    assert(wheelVisibleIndex < 100, "The real wheel must move away from the old index target")
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "evidence.json"),
      JSON.stringify({ cancelled, manualTop, after, wheelVisibleIndex, errors }, null, 2)
    )
    const sessionBundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: "tsx",
        contents: `
        import React,{useRef,useLayoutEffect}from'react';
        import{createRoot}from'react-dom/client';import{Virtuoso}from'react-virtuoso';
        import{resolveChatSessionInitialLocation}from'./src/renderer/src/components/chat/chat-session-initial-location';
        function Fixture(){
          const handle=useRef(null),root=useRef(null);
          const location=window.sessionSeeded?resolveChatSessionInitialLocation('one','detached',
            {threadId:'one',messageId:'saved',offsetFromViewportTop:28},new Map([['saved',133]])):undefined;
          useLayoutEffect(()=>{let frame,restored=false;window.sessionSamples=[];
            const sample=()=>{
              const viewport=root.current.querySelector('[data-virtuoso-scroller]');
              const list=viewport?.querySelector('[data-testid="virtuoso-item-list"]');
              if(viewport&&list){const bounds=viewport.getBoundingClientRect();
                const row=[...list.querySelectorAll('[data-row]')].find(row=>{
                  const box=row.getBoundingClientRect();return box.bottom>bounds.top&&box.top<bounds.bottom});
                if(row&&getComputedStyle(list).visibility==='visible')window.sessionSamples.push(Number(row.dataset.row));
                if(!window.sessionSeeded&&!restored&&list.children.length){restored=true;
                  handle.current.scrollToIndex({index:133,align:'start',offset:-28,behavior:'auto'})}
              }
              frame=requestAnimationFrame(sample);
            };frame=requestAnimationFrame(sample);return()=>cancelAnimationFrame(frame)},[]);
          return <div ref={root}><Virtuoso ref={handle} firstItemIndex={10000} totalCount={200}
            style={{height:400,width:600}} initialTopMostItemIndex={location}
            itemContent={index=><div data-row={index-10000} style={{height:[90,310,120,550][index%4]}}>Message {index}</div>}/></div>;
        }createRoot(document.getElementById('root')).render(<Fixture/>);
      `
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' }
    })
    const sessionEvidence: unknown[] = []
    for (const seeded of [false, true]) {
      await page.goto("about:blank")
      await page.setContent('<div id="root"></div>')
      await page.addScriptTag({ content: "window.__name=value=>value" })
      await page.evaluate((value) => {
        ;(window as unknown as { sessionSeeded: boolean }).sessionSeeded = value
      }, seeded)
      await page.addScriptTag({ content: sessionBundle.outputFiles[0].text })
      await page.waitForFunction("window.sessionSamples?.length>=3")
      const samples = (await page.evaluate("window.sessionSamples")) as number[]
      if (seeded)
        assert(
          samples.every((index) => index === 132),
          "The first visible text must belong to the restored window, not a head probe"
        )
      else
        assert.equal(samples[0], 0, "Control demonstrates the previous head-then-restore sequence")
      const offset = await page
        .locator('[data-row="133"]')
        .evaluate(
          (row) =>
            row.getBoundingClientRect().top -
            document.querySelector("[data-virtuoso-scroller]")!.getBoundingClientRect().top
        )
      assert(
        Math.abs(offset - 28) <= 2,
        "A relative initial index with firstItemIndex=10000 preserves the positive saved offset"
      )
      sessionEvidence.push({ seeded, samples, offset })
    }
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "session-seed-evidence.json"),
      JSON.stringify(sessionEvidence, null, 2)
    )
    writeFileSync(
      resolve(output, "external-anchor-evidence.json"),
      JSON.stringify(await verifyExternalAnchorOwnership(browser), null, 2)
    )
    await verifySessionSaveAnchor(browser)
    writeFileSync(
      resolve(output, "native-measurement-evidence.json"),
      JSON.stringify(await verifyNativeItemMeasurements(browser), null, 2)
    )
    writeFileSync(
      resolve(output, "overscan-evidence.json"),
      JSON.stringify(await verifyVirtualOverscan(browser), null, 2)
    )
    console.log(
      "PASS initial hidden LAST cancellation, subsequent index navigation and real wheel takeover"
    )
  } finally {
    writeFileSync(resolve(output, "final-dom.html"), await page.content())
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
