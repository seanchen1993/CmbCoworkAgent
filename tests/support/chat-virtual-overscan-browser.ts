import assert from "node:assert/strict"
import { build } from "esbuild"
import type { Browser } from "playwright"
import { CHAT_VIRTUAL_OVERSCAN } from
  "../../src/renderer/src/components/chat/chat-virtual-overscan"

/** Real wheel/layout with simulated asynchronous body authorization, not mount counts.
 * Mixed-size initialization uses the actual ChatMessageVirtualList history suite: cancelling
 * a raw initial index before size discovery does not implement the platform restore lifecycle.
 * The withdrawn dynamic range's ResizeObserver lifecycle is no longer production behavior.
 */
export async function verifyVirtualOverscan(browser: Browser): Promise<unknown[]> {
  assert.deepEqual(CHAT_VIRTUAL_OVERSCAN, { top: 1200, bottom: 1200 })
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React,{useRef,useState,useLayoutEffect}from'react';
      import{createRoot}from'react-dom/client';
      import{Virtuoso}from'react-virtuoso';
      import{CHAT_VIRTUAL_OVERSCAN}from'./src/renderer/src/components/chat/chat-virtual-overscan';
      const config=window.config;
      function Row({index}){
        const[ready,setReady]=useState(false);
        useLayoutEffect(()=>{const timer=setTimeout(()=>setReady(true),80);return()=>clearTimeout(timer)},[]);
        const height=config.rowHeight||[40,100,240,80][index%4];
        return <div data-row={index} style={{height,position:'relative'}}>{ready?
          <div data-body style={config.sparse?{position:'absolute',bottom:0}:undefined}>
            Authorized body {index}</div>:<div data-pending/>}</div>;
      }
      function Fixture(){
        const handle=useRef(null),[viewport,setViewport]=useState(null);
        const range=CHAT_VIRTUAL_OVERSCAN;
        window.range=range;
        useLayoutEffect(()=>{
          if(!viewport)return;
          let frame,stopped=false;
          window.samples=[];window.maxMounted=0;
          const onScroll=()=>{const list=viewport.querySelector('[data-testid="virtuoso-item-list"]');
            if(!stopped&&viewport.scrollTop>0&&list?.style.visibility==='hidden'){
              stopped=true;handle.current.cancelScrollToIndex();}}
          const onWheel=()=>{handle.current.cancelScrollToIndex();window.wheelAt=performance.now()};
          viewport.addEventListener('scroll',onScroll);viewport.addEventListener('wheel',onWheel);
          const tick=()=>{
            const area=viewport.getBoundingClientRect();
            const list=viewport.querySelector('[data-testid="virtuoso-item-list"]');
            const visible=list&&getComputedStyle(list).visibility!=='hidden';
            const count=[...viewport.querySelectorAll('[data-body]')].filter(body=>{
              const r=body.getBoundingClientRect();return visible&&r.bottom>area.top&&r.top<area.bottom}).length;
            const mounted=viewport.querySelectorAll('[data-row]').length;
            window.maxMounted=Math.max(window.maxMounted,mounted);
            if(count&&!window.firstReady)window.firstReady={at:performance.now(),top:viewport.scrollTop};
            if(window.wheelAt)window.samples.push({top:viewport.scrollTop,count,mounted});
            frame=requestAnimationFrame(tick);
          };frame=requestAnimationFrame(tick);
          return()=>{cancelAnimationFrame(frame);viewport.removeEventListener('scroll',onScroll);viewport.removeEventListener('wheel',onWheel)};
        },[viewport]);
        return <Virtuoso ref={handle} scrollerRef={setViewport} totalCount={400}
          style={{height:config.height,width:600}} initialTopMostItemIndex={{index:200,align:'start'}}
          increaseViewportBy={config.baseline?{top:600,bottom:900}:range}
          itemContent={index=><Row index={index}/>}/>;
      }
      window.startedAt=performance.now();
      createRoot(document.getElementById('root')).render(<Fixture/>);
    ` }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const results: unknown[] = []
  for (const config of [
    { baseline: true, height: 600, rowHeight: 400, sparse: true },
    { baseline: false, height: 600, rowHeight: 400, sparse: true },
    { baseline: false, height: 600, rowHeight: 40 },
    { baseline: false, height: 300, rowHeight: 40 },
    { baseline: false, height: 600, rowHeight: 100 }
  ]) {
    const page = await browser.newPage({ viewport: { width: 800, height: 800 } })
    try {
      await page.setContent('<div id="root"></div>')
      await page.evaluate(value => { (window as unknown as { config: unknown }).config = value }, config)
      await page.mouse.move(300, 250)
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      await page.waitForFunction("window.firstReady")
      // No expansion/read/settling wait is allowed between first body readiness and real input.
      await page.mouse.wheel(0, -1050)
      await page.waitForTimeout(220)
      const result = await page.evaluate(`({range:window.range,ready:window.firstReady,
        readyMs:window.firstReady.at-window.startedAt,maxMounted:window.maxMounted,samples:window.samples})`) as {
          readyMs: number,
          range: { top: number, bottom: number }, ready: { top: number }, maxMounted: number,
          samples: { top: number, count: number }[]
        }
      const moved = result.samples.filter(sample => sample.top <= result.ready.top - 1000)
      assert(moved.length > 0, "Real wheel must traverse the requested 1050px")
      const blank = moved.filter(sample => sample.count === 0).length
      if (config.baseline) assert(blank > 0, "600/900 control reproduces entering unread cold rows")
      else assert.equal(result.samples.filter(sample => sample.count === 0).length, 0,
        "First-ready real wheel must keep authorized body visible throughout the sampled gesture")
      const policy = config.baseline ? { top: 600, bottom: 900 } : result.range
      const budget = Math.ceil((config.height + policy.top + policy.bottom) / (config.rowHeight || 40)) + 4
      assert(result.maxMounted <= budget, `Mounted rows ${result.maxMounted} exceed pixel budget ${budget}`)
      assert(result.maxMounted < 100, "Short/pending rows must not mount the 400-row transcript")
      if (!config.baseline && config.rowHeight === 40 && config.height === 600) {
        await page.evaluate("document.querySelector('[data-virtuoso-scroller]').style.height='300px'")
        await page.waitForTimeout(40)
        assert.deepEqual(await page.evaluate("window.range"), { top: 1200, bottom: 1200 })
        await page.evaluate("document.querySelector('[data-virtuoso-scroller]').style.height='720px'")
        await page.waitForTimeout(40)
        const count = await page.locator('[data-row]').count()
        assert(count <= Math.ceil((720 + 2400) / 40) + 4)
        await page.evaluate("document.querySelector('[data-virtuoso-scroller]').style.height='300px'")
        await page.waitForTimeout(40)
        assert.deepEqual(await page.evaluate("window.range"), { top: 1200, bottom: 1200 },
          "Resizing cannot change the fixed prepared range")
      }
      results.push({ config, blank, maxMounted: result.maxMounted, budget, range: policy,
        readyMs: result.readyMs })
    } finally { await page.close() }
  }
  return results
}
