/** A detached reader must not flash when sibling row height changes cancel out. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main(): Promise<void> {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import {installChatDetachedLayoutAnchor,notifyChatDetachedAnchorOwnerReleased} from
          './src/renderer/src/components/chat/chat-detached-layout-anchor';
        const viewport=document.querySelector('#viewport'),root=document.querySelector('#content');
        const reading=document.querySelector('#reading');
        const offset=()=>reading.getBoundingClientRect().top-viewport.getBoundingClientRect().top;
        const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
        const NativeResizeObserver=window.ResizeObserver,observations=new Set();
        window.ResizeObserver=class extends NativeResizeObserver {
          observe(node,options){observations.add(node);super.observe(node,options)}
          unobserve(node){observations.delete(node);super.unobserve(node)}
          disconnect(){observations.clear();super.disconnect()}
        };
        let lease=1,owners=0;
        viewport.scrollTop=310;
        const dispose=installChatDetachedLayoutAnchor({root,viewport,readLease:()=>lease,
          acquireScrollAnchor:()=>{owners++;return()=>owners--}});
        window.fixture={async run(){
          for(let i=0;i<4;i++)await frame();
          const before=offset(), samples=[];
          document.querySelector('#above').style.height='365px';
          document.querySelector('#below').style.height='935px';
          for(let i=0;i<6;i++) { await frame(); samples.push(offset()); }
          return {before,samples,top:viewport.scrollTop};
        },async ownership(){
          const initial=owners;
          viewport.dispatchEvent(new WheelEvent('wheel',{deltaY:-40}));
          const wheel=owners;
          viewport.scrollTop-=40;
          const userTop=viewport.scrollTop;
          await new Promise(resolve=>setTimeout(resolve,150));await frame();
          const afterWheel=owners,afterTop=viewport.scrollTop;
          const bar=document.createElement('div');bar.dataset.scrollAreaScrollbar='';
          viewport.parentElement.append(bar);
          bar.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:7}));
          const pointer=owners;
          window.dispatchEvent(new Event('blur'));await frame();
          const blur=owners;bar.remove();
          viewport.scrollTop=0;await frame();await frame();
          const head=owners;
          viewport.scrollTop=userTop;await frame();await frame();
          return {initial,wheel,afterWheel,userTop,afterTop,pointer,blur,head};
        },async lifecycle(){
          const observedRows=()=>[...observations].filter(node=>node.matches('[data-chat-message-row]')).length;
          const initial=observedRows();
          let stale=0;
          for(let i=0;i<8;i++){
            const old=document.querySelector('#below');
            old.replaceWith(old.cloneNode(true));
            await frame();
            if(observations.has(old))stale++;
          }
          const recycled=observedRows();
          lease=null;root.classList.add('following');await frame();
          const following=observedRows();
          lease=2;notifyChatDetachedAnchorOwnerReleased(viewport);await frame();
          const reacquired=observedRows();
          dispose();const remaining=observations.size,before=viewport.scrollTop;
          document.querySelector('#above').style.height='400px';
          for(let i=0;i<4;i++)await frame();
          return {initial,stale,recycled,following,reacquired,remaining,before,after:viewport.scrollTop};
        },dispose};`
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser"
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent(`<div id="viewport" style="height:200px;overflow:auto;overflow-anchor:none">
      <div id="content"><div id="above" data-chat-message-row data-chat-message-id="above"
        style="height:300px">Older answer</div>
        <div id="reading" data-chat-message-row data-chat-message-id="reading"
          style="height:100px">Readable history</div>
        <div id="below" data-chat-message-row data-chat-message-id="below"
          style="height:1000px">Streaming answer</div></div></div>`)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const result = (await page.evaluate("window.fixture.run()")) as {
      before: number
      samples: number[]
      top: number
    }
    console.log(JSON.stringify(result))
    assert.deepEqual(errors, [])
    assert(
      result.samples.every((offset) => Math.abs(offset - result.before) <= 2),
      "Balanced row resize must preserve the detached reading position in each frame"
    )
    const ownership = await page.evaluate("window.fixture.ownership()") as {
      initial: number, wheel: number, afterWheel: number, userTop: number, afterTop: number,
      pointer: number, blur: number, head: number
    }
    assert.deepEqual([ownership.initial, ownership.wheel, ownership.afterWheel,
      ownership.pointer, ownership.blur, ownership.head], [1, 0, 1, 0, 1, 0])
    assert.equal(ownership.afterTop, ownership.userTop, "User scrolling must not be pulled back")
    const lifecycle = (await page.evaluate("window.fixture.lifecycle()")) as {
      initial: number
      stale: number
      recycled: number
      following: number
      reacquired: number
      remaining: number
      before: number
      after: number
    }
    assert.equal(lifecycle.initial, 3)
    assert.equal(lifecycle.stale, 0, "Virtual recycling must unobserve removed rows")
    assert.equal(lifecycle.recycled, 3, "Observation count must stay bounded by mounted rows")
    assert.equal(lifecycle.following, 0, "Following must release detached row observations")
    assert.equal(lifecycle.reacquired, 3)
    assert.equal(lifecycle.remaining, 0)
    assert.equal(lifecycle.after, lifecycle.before, "Cleanup must cancel subsequent correction")
    assert.deepEqual(errors, [])
    console.log(
      "PASS balanced resize and bounded observation lifecycle " + JSON.stringify(lifecycle)
    )
  } finally {
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
