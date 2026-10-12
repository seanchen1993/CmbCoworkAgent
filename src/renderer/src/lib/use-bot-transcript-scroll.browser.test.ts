import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"
import { chromium } from "playwright"
import { expect, it } from "vitest"

it.skipIf(process.env.CMB_BOT_BROWSER_TEST !== "1")(
  "follows actual content measurements and append growth, then respects wheel detach and return to bottom",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmb-transcript-scroll-"))
    const browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
      args: ["--disable-updater-scheduler"]
    })
    try {
      await build({
        stdin: {
          resolveDir: process.cwd(),
          loader: "tsx",
          contents: `
import React, {useCallback,useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useBotTranscriptScroll} from './src/renderer/src/lib/use-bot-transcript-scroll';
function Fixture(){
  const [parent,setParent]=useState(null),[rows,setRows]=useState(30),[width,setWidth]=useState(520);
  const following=useRef(true),frame=useRef(null),writes=useRef(0),detaches=useRef(0);
  const follow=useCallback(()=>{
    if(!parent||!following.current||frame.current!==null)return;
    frame.current=requestAnimationFrame(()=>{
      frame.current=null;
      if(following.current){parent.scrollTop=parent.scrollHeight;writes.current++;}
    });
  },[parent]);
  useEffect(()=>()=>{if(frame.current!==null)cancelAnimationFrame(frame.current);},[parent]);
  useBotTranscriptScroll({scrollParent:parent,viewId:'fixture',following,
    onReadPosition:()=>{},
    onUserDetach:()=>{detaches.current++;if(frame.current!==null){cancelAnimationFrame(frame.current);frame.current=null;}},
    onContentHeightChanged:follow});
  window.fixtureFollowing=()=>following.current;
  window.fixtureWrites=()=>writes.current;
  window.fixtureDetaches=()=>detaches.current;
  window.fixtureAppend=()=>setRows(value=>value+10);
  window.fixtureMeasure=()=>{parent.scrollTop-=90;setWidth(value=>value===520?280:520);};
  return <div><textarea aria-label="Composer"/><div id="viewport" ref={setParent} tabIndex={0}
    style={{width,height:320,overflowY:'auto',overflowAnchor:'none',border:'1px solid black'}}>
    <div className="bot-transcript-content">{Array.from({length:rows},(_,index)=><p key={index}
      style={{margin:0,padding:'9px 8px',lineHeight:'20px'}}>{index} Content with enough words to wrap after the viewport narrows during asynchronous transcript measurement.</p>)}</div>
  </div></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`
        },
        bundle: true,
        outfile: join(directory, "fixture.js"),
        platform: "browser",
        format: "iife",
        jsx: "automatic",
        define: { "process.env.NODE_ENV": '"development"' },
        logLevel: "silent"
      })
      await writeFile(
        join(directory, "index.html"),
        '<!doctype html><html><body><div id="root"></div><script src="fixture.js"></script></body></html>'
      )
      const page = await browser.newPage({ viewport: { width: 900, height: 650 } })
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(pathToFileURL(join(directory, "index.html")).href)
      const atBottom = () =>
        page.evaluate(() => {
          const node = document.getElementById("viewport")!
          return node.scrollHeight - node.scrollTop - node.clientHeight
        })
      const following = () =>
        page.evaluate(() =>
          (window as unknown as { fixtureFollowing(): boolean }).fixtureFollowing()
        )
      await expect.poll(atBottom).toBeLessThanOrEqual(1)
      await page.evaluate(() => (window as unknown as { fixtureAppend(): void }).fixtureAppend())
      await expect.poll(atBottom).toBeLessThanOrEqual(1)
      expect(await following()).toBe(true)
      await page.evaluate(() => (window as unknown as { fixtureMeasure(): void }).fixtureMeasure())
      await expect.poll(atBottom).toBeLessThanOrEqual(1)
      expect(await following()).toBe(true)
      const viewport = page.locator("#viewport")
      await viewport.hover()
      await page.mouse.wheel(0, -400)
      await expect.poll(following).toBe(false)
      const held = await viewport.evaluate((node) => node.scrollTop)
      const writes = await page.evaluate(() =>
        (window as unknown as { fixtureWrites(): number }).fixtureWrites()
      )
      await page.evaluate(() => (window as unknown as { fixtureAppend(): void }).fixtureAppend())
      await expect.poll(() => viewport.locator("p").count()).toBe(50)
      await page.waitForTimeout(100)
      expect(await following()).toBe(false)
      expect(await viewport.evaluate((node) => node.scrollTop)).toBeCloseTo(held, 0)
      expect(
        await page.evaluate(() =>
          (window as unknown as { fixtureWrites(): number }).fixtureWrites()
        )
      ).toBe(writes)
      await page.mouse.wheel(0, 100_000)
      await expect.poll(following).toBe(true)
      await expect.poll(atBottom).toBeLessThanOrEqual(1)
      await page.getByRole("textbox", { name: "Composer" }).focus()
      await page.keyboard.press("PageUp")
      await page.evaluate(() => (window as unknown as { fixtureAppend(): void }).fixtureAppend())
      await expect.poll(atBottom).toBeLessThanOrEqual(1)
      expect(await following()).toBe(true)
      expect(errors).toEqual([])
    } finally {
      await browser.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
  20_000
)
