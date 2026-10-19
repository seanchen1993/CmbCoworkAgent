/** Real message wrappers, capability scope and DOM; no retained drawing can execute an action. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await mount(
      page,
      `
      import {ModsChatScope,useModsChatState} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {FunctionMessageText} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionMessageText.tsx"))};
      {const cards=new Set(),configs=new Set(),owners=new Map(),calls=[],clicks=[];
      let sequence=0,held=false,releases=[];
      window.api.mods.chatDisplayCapability=async()=>true;
      window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
      window.api.mods.onConfigurationChanged=fn=>{configs.add(fn);return()=>configs.delete(fn)};
      window.api.mods.siteMountOutcome=async(thread,component)=>{const owner='owner-'+(++sequence);owners.set(owner,component);calls.push(['mount',owner]);return {state:'mounted',owner}};
      window.api.mods.siteUnmount=async(thread,owner)=>{owners.delete(owner);calls.push(['unmount',owner])};
      window.api.mods.siteRender=async(thread,owner,input)=>{const copy=structuredClone(input),component=owners.get(owner);calls.push(['render',owner]);if(held)await new Promise(done=>releases.push(done));return {key:'engine:'+owner,id:owner,plugin:'test',generation:'generation-'+sequence,title:'Protected',rows:12,closeOnEscape:false,
        tree:{type:'Box',props:{},children:[{type:'engine',ref:0},{type:'Button',props:{key:'action',label:'Plugin action'},press:{plugin:'test',handle:71}}]},
        nativeContent:{component,entries:[{ref:0,props:{...copy,text:copy.text.replace('RAW','SAFE')}}]}}};
      window.api.mods.siteAct=async()=>{clicks.push('plugin');return {}};
      function Fixture(){const state=useModsChatState('thread','C:/workspace'),[visible,setVisible]=useState(true),[text,setText]=useState('RAW original'),[cache,setCache]=useState(false),[width,setWidth]=useState(700),[stream,setStream]=useState(null);
        window.remount={calls,clicks,show:setVisible,text:setText,stream:setStream,cache:setCache,width:setWidth,held:()=>releases.length,
          hold:()=>held=true,release:()=>{held=false;releases.splice(0).forEach(done=>done())},
          emit:scope=>{for(const fn of cards)fn({threadId:'thread',scope})},config:scope=>{for(const fn of configs)fn(scope?{scope}:undefined)}};
        return <ModsChatScope.Provider value={{threadId:'thread',...state,presentationCache:cache?state.presentationCache:null}}><div style={{width}}>{visible&&<FunctionMessageText threadId='thread' messageId='message-1' role='assistant' text={text} isExpanded isFirstOfReply fallback={<p>{text}</p>}
          renderText={safe=><div style={{height:240}}><p>{safe}</p><button onClick={()=>clicks.push('native')}>Native action</button><a href='#native' onClick={e=>{e.preventDefault();clicks.push('link')}}>Native link</a></div>}/>}</div>
          {stream&&<FunctionMessageText threadId='thread' messageId='message-1' presentationId='stream-block' role='assistant' text={stream} isExpanded isFirstOfReply renderText={safe=><p>{safe}</p>}/>}</ModsChatScope.Provider>}
      host.render(<Fixture/>)}
    `,
      [browserWorkerPlugin()]
    )
    const call = async (code: string) => page.evaluate(code)
    const settle = async () =>
      page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done()))
          )
      )
    const visible = () => page.getByText("SAFE original", { exact: true }).waitFor()
    const hide = async () => {
      await call("window.remount.show(false)")
      await page.locator('[data-function-site="AssistantMessage"]').waitFor({ state: "detached" })
    }
    const remountHeld = async () => {
      await call("window.remount.hold();window.remount.show(true)")
      await page.waitForFunction("window.remount.held()===1")
    }
    await visible().catch(async (error) => {
      console.error({
        errors,
        body: await page.locator("body").innerText(),
        calls: await call("window.remount?.calls")
      })
      throw error
    })
    await hide()
    await remountHeld()
    assert.equal(await page.locator("[data-function-site-pending]").count(), 1)
    assert.equal(await page.getByText("SAFE original", { exact: true }).count(), 0)
    console.log(
      "REPRODUCED cold virtual remount hides the previously protected message until IPC returns"
    )
    await call("window.remount.release()")
    await visible()
    await call("window.remount.cache(true)")
    await page.waitForFunction("window.remount.calls.filter(row=>row[0]==='render').length>=3")
    await visible()
    await settle()
    await call("window.remount.stream('RAW streaming')")
    await page.getByText("SAFE streaming", { exact: true }).waitFor()
    await call("window.remount.stream('RAW streaming more')")
    await page.getByText("SAFE streaming more", { exact: true }).waitFor()
    await call("window.remount.stream(null)")
    await page.getByText("SAFE streaming more", { exact: true }).waitFor({ state: "detached" })
    await settle()
    const originalHeight = await page
      .locator('[data-function-site="AssistantMessage"]')
      .evaluate((node) => {
        const range = document.createRange()
        range.selectNodeContents(node)
        return range.getBoundingClientRect().height
      })
    await hide()
    await remountHeld()
    await page.locator("[data-function-site-cached]").waitFor()
    assert.equal(await page.getByText("SAFE original", { exact: true }).count(), 1)
    assert.equal(await page.locator("[data-function-site-pending]").count(), 0)
    assert.equal(await page.getByText(/RAW/).count(), 0)
    const cached = page.locator("[data-function-site-cached]")
    const cachedHeight = await cached.evaluate((node) => node.getBoundingClientRect().height)
    assert(Math.abs(cachedHeight - originalHeight) < 1, `${cachedHeight} vs ${originalHeight}`)
    for (const name of ["Native action", "Plugin action"])
      await cached.getByRole("button", { name }).dispatchEvent("click")
    await cached.getByRole("link", { name: "Native link" }).dispatchEvent("click")
    assert.deepEqual(await call("window.remount.clicks"), [])
    assert.equal(await cached.locator("[data-function-handle]").count(), 0)
    await call("window.remount.width(350)")
    await page.waitForFunction(
      "document.querySelector('[data-function-site-cached]').style.minHeight===''"
    )
    assert.equal(await page.getByText("SAFE original", { exact: true }).count(), 1)
    await call("window.remount.width(700)")
    await call("window.remount.release()")
    await cached.waitFor({ state: "detached" })
    await visible()
    await page.getByRole("button", { name: "Native action" }).click()
    assert.deepEqual(await call("window.remount.clicks"), ["native"])
    console.log(
      "PASS unrelated streaming preserves history remount text and height while stripping and blocking old interactions"
    )
    await call("window.remount.hold();window.remount.text('RAW replacement')")
    await page.waitForFunction("window.remount.held()===1")
    await call("window.remount.text('RAW original')")
    await settle()
    assert.equal(await page.locator("[data-function-site-cached]").count(), 0)
    assert.equal(await page.getByText("SAFE original", { exact: true }).count(), 0)
    await call("window.remount.release()")
    await visible()
    console.log("PASS intervening replacement and A-B-A facts never revive an earlier cached body")
    await page.clock.install()
    await hide()
    await remountHeld()
    await page.locator("[data-function-site-cached]").waitFor()
    await page.clock.fastForward(120001)
    assert.equal(await page.locator("[data-function-site-cached]").count(), 0)
    assert.equal(await page.getByText("SAFE original", { exact: true }).count(), 0)
    assert.equal(await page.locator("[data-function-site-pending]").count(), 1)
    await call("window.remount.release()")
    await visible()
    await page.clock.resume()
    console.log(
      "PASS pane width changes discard old height constraints and stalled reads expire cached data"
    )
    for (const event of [
      "site-presentations:AssistantMessage",
      "source-retiring:2",
      "source-replaced:3",
      undefined
    ]) {
      await hide()
      await call(`window.remount.emit(${JSON.stringify(event)})`)
      await remountHeld()
      assert.equal(await page.locator("[data-function-site-cached]").count(), 0)
      assert.equal(await page.getByText("SAFE original", { exact: true }).count(), 0)
      await call("window.remount.release()")
      await visible()
      await settle()
    }
    await hide()
    await call("window.remount.config()")
    await remountHeld()
    assert.equal(await page.locator("[data-function-site-cached]").count(), 0)
    await call("window.remount.release()")
    await visible()
    await hide()
    await call("window.remount.text('RAW replacement')")
    await remountHeld()
    assert.equal(await page.locator("[data-function-site-cached]").count(), 0)
    assert.equal(await page.getByText(/RAW|SAFE original/).count(), 0)
    await call("window.remount.release()")
    await page.getByText("SAFE replacement", { exact: true }).waitFor()
    console.log(
      "PASS offscreen invalidation, source retirement/replacement, global/config changes and exact facts reject cached text"
    )
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
