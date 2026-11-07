/** Real viewport resize delivery with the existing follow/detach/restore controller. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import {observeChatViewportResize} from './src/renderer/src/components/chat/chat-viewport-resize';
        import {createChatScrollState,transitionChatScroll,shouldFollowChatOutput}
          from './src/shared/chat-scroll-controller';
        const viewport=document.getElementById('viewport'),header=document.getElementById('header');
        let state=createChatScrollState('a'),dispose=()=>{},frame=null,notifications=0,writes=0;
        const event=e=>{state=transitionChatScroll(state,e).state};
        event({type:'DATA_READY',messageCount:2});event({type:'BOTTOM_CONFIRMED'});
        const resized=()=>{
          notifications++;
          if(!shouldFollowChatOutput(state))return;
          const generation=state.generation;
          event({type:'CONTENT_GROWN'});
          if(frame!==null)cancelAnimationFrame(frame);
          frame=requestAnimationFrame(()=>{
            frame=null;
            if(state.generation!==generation||!shouldFollowChatOutput(state))return;
            viewport.scrollTop=viewport.scrollHeight-viewport.clientHeight;writes++;
            event({type:'BOTTOM_CONFIRMED'});
          });
        };
        viewport.addEventListener('wheel',e=>{
          if(e.deltaY<0)event({type:'USER_DETACH',source:'user-input'});
        },{passive:true});
        window.fixture={
          attach:()=>{dispose=observeChatViewportResize(viewport,resized)},
          dispose:()=>{dispose();if(frame!==null)cancelAnimationFrame(frame);frame=null},
          header:h=>{header.style.height=h+'px'},
          bottom:()=>{event({type:'RETURN_TO_BOTTOM'});viewport.scrollTop=viewport.scrollHeight;event({type:'BOTTOM_CONFIRMED'})},
          restore:()=>event({type:'RESTORE_BEGIN'}),
          snapshot:()=>{
            const marker=document.getElementById('marker').getBoundingClientRect(),box=viewport.getBoundingClientRect();
            return {notifications,writes,mode:state.mode,scrollTop:viewport.scrollTop,
              gap:viewport.scrollHeight-viewport.clientHeight-viewport.scrollTop,
              visible:marker.top>=box.top&&marker.bottom<=box.bottom};
          }
        };`
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
  const page = await browser.newPage()
  const call = (script: string) => page.evaluate(script)
  const snapshot = () => call("window.fixture.snapshot()") as Promise<{
    notifications: number; writes: number; mode: string; scrollTop: number; gap: number; visible: boolean
  }>
  const settle = () => page.evaluate(async () => {
    for (let index = 0; index < 5; index++) {
      await new Promise<void>(done => requestAnimationFrame(() => done()))
    }
  })
  try {
    await page.setContent(`<style>
      body{margin:0}#shell{height:700px;width:600px;display:flex;flex-direction:column}
      #header{height:0;flex-shrink:0}#viewport{flex:1;min-height:0;overflow:auto;overflow-anchor:none}
      #content{height:1600px;display:flex;flex-direction:column;justify-content:flex-end}
      #marker{height:20px}#composer{height:100px;flex-shrink:0}
      </style><div id="shell"><div id="header"></div><div id="viewport">
      <div id="content"><div id="marker">Final answer</div></div></div><textarea id="composer"></textarea></div>`)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await call("window.fixture.bottom();window.fixture.header(272)")
    await settle()
    assert.equal((await snapshot()).visible, false, "Unobserved header resize reproduces the lost tail")
    await call("window.fixture.header(0);window.fixture.bottom()")
    await settle()
    await call("window.fixture.attach()")
    await settle()
    assert.equal((await snapshot()).notifications, 0, "Initial observer delivery must not reposition")
    await call("window.fixture.header(272)")
    await settle()
    const following = await snapshot()
    assert.equal(following.visible, true)
    assert.equal(following.gap, 0)
    assert.equal(following.writes, 1, "One resize uses one follow correction")

    await page.mouse.move(300, 400)
    await page.mouse.wheel(0, -350)
    await settle()
    const detached = await snapshot()
    assert.equal(detached.mode, "detached")
    await call("window.fixture.header(200)")
    await settle()
    assert.equal((await snapshot()).scrollTop, detached.scrollTop)
    assert.equal((await snapshot()).writes, detached.writes)
    await call("window.fixture.restore();window.fixture.header(272)")
    await settle()
    assert.equal((await snapshot()).mode, "restoring")
    assert.equal((await snapshot()).writes, detached.writes)

    await call("window.fixture.dispose()")
    const disposed = await snapshot()
    await call("window.fixture.header(100)")
    await settle()
    assert.equal((await snapshot()).notifications, disposed.notifications)
    console.log("PASS viewport resize preserves following, detached/restoring ownership and cleanup")
  } finally {
    await browser.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
