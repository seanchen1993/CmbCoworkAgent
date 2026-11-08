import assert from "node:assert/strict"
import { build } from "esbuild"
import type { Browser } from "playwright"

/** Real size measurements reproduce App/native compensation competing for the same row. */
export async function verifyExternalAnchorOwnership(browser: Browser): Promise<unknown[]> {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React,{useRef,useState,useLayoutEffect}from'react';
      import{createRoot}from'react-dom/client';import{Virtuoso}from'react-virtuoso';
      import{acquireChatExternalScrollAnchor}from'./src/renderer/src/components/chat/chat-external-scroll-anchor';
      window.writes=[];
      const nativeBy=Element.prototype.scrollBy;
      Element.prototype.scrollBy=function(...args){
        if(this.hasAttribute('data-virtuoso-scroller'))window.writes.push(args[0].top);
        return nativeBy.apply(this,args);
      };
      function Fixture(){
        const handle=useRef(null),root=useRef(null),[phase,setPhase]=useState(0);
        window.phase=phase;
        useLayoutEffect(()=>{
          const release=window.leased?acquireChatExternalScrollAnchor(handle.current):()=>{};
          window.release=release;window.grow=()=>setPhase(4);
          let frame,attempt=0,stable=0,finished=false;
          const tick=()=>{
            const viewport=root.current.querySelector('[data-virtuoso-scroller]');
            const target=viewport?.querySelector('[data-row="120"]');
            if(viewport&&!finished){
              if(target){
                handle.current.cancelScrollToIndex();
                const delta=target.getBoundingClientRect().top-viewport.getBoundingClientRect().top-28;
                if(Math.abs(delta)>1)viewport.scrollTop+=delta;
                stable=Math.abs(delta)<=1&&window.phase===3?stable+1:0;
                if(stable>=4){finished=true;window.finished=true;}
              }else if(attempt%12===0)handle.current.scrollToIndex({index:120,align:'start',behavior:'auto'});
              attempt++;
            }
            frame=requestAnimationFrame(tick);
          };
          frame=requestAnimationFrame(tick);
          const timers=[80,180,300].map((delay,i)=>setTimeout(()=>setPhase(i+1),delay));
          return()=>{release();cancelAnimationFrame(frame);timers.forEach(clearTimeout)};
        },[]);
        return <div ref={root}><Virtuoso ref={handle} firstItemIndex={10000} totalCount={200}
          style={{height:600,width:700}} increaseViewportBy={{top:600,bottom:900}}
          initialTopMostItemIndex={{index:120,align:'start',offset:-28}} followOutput={false}
          skipAnimationFrameInResizeObserver itemContent={abs=>{
            const index=abs-10000;
            const height=phase===0?(index===119?344:80):phase===1?(index%2?367:344):
              phase===2?(index%2?467:344):(index%2?331:467)+(phase===4?100:0);
            return <div data-row={index} style={{height}}>Message {index}</div>;
          }}/></div>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);
    ` },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const evidence: unknown[] = []
  for (const leased of [false, true]) {
    const page = await browser.newPage()
    try {
      await page.setContent('<div id="root"></div>')
      await page.evaluate(value => { (window as unknown as { leased: boolean }).leased = value }, leased)
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      await page.waitForFunction("window.finished", undefined, { timeout: 5000 })
      const result = await page.evaluate(`({writes:window.writes.slice(),
        offset:document.querySelector('[data-row="120"]').getBoundingClientRect().top-
          document.querySelector('[data-virtuoso-scroller]').getBoundingClientRect().top})`) as {
          writes: number[], offset: number
        }
      assert(Math.abs(result.offset - 28) <= 2, "App owner preserves the saved row offset")
      if (!leased) assert(result.writes.length > 0, "Control reproduces the competing native writer")
      else {
        assert.deepEqual(result.writes, [], "External ownership removes the extra native size writer")
        await page.evaluate("window.release()")
        await page.waitForTimeout(150)
        assert.equal(await page.evaluate("window.writes.length"), 0,
          "Release cannot replay size deltas already handled by the App")
        await page.evaluate("document.querySelector('[data-virtuoso-scroller]').scrollTop-=40")
        await page.evaluate("new Promise(resolve=>requestAnimationFrame(resolve))")
        await page.evaluate("window.grow()")
        await page.waitForFunction("window.writes.length>0", undefined, { timeout: 3000 })
      }
      evidence.push({ leased, ...result })
    } finally { await page.close() }
  }
  return evidence
}
