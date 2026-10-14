/** A protected prefix must paint while later stream input is still arriving. */
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
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    const fixture = `
      import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      {const events=new Set(),unmounted=[],clicks=[],seen=[];let mountRelease,reads=[],mounts=0;
      new MutationObserver(()=>seen.push(document.body.textContent)).observe(document.body,{subtree:true,childList:true,characterData:true});
      window.api.mods.onCardsChanged=fn=>{events.add(fn);return()=>events.delete(fn)};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.siteMountOutcome=async()=>{const owner='owner-'+(++mounts);await new Promise(done=>mountRelease=done);return {state:'mounted',owner}};
      window.api.mods.siteUnmount=async(thread,owner)=>unmounted.push(owner);
      window.api.mods.siteRender=async(thread,owner,input)=>{await new Promise(done=>reads.push({done,input}));return {key:'engine:'+owner,id:owner,plugin:'engine',generation:'generation',title:'Protected',rows:12,closeOnEscape:false,tree:{type:'engine',ref:0},nativeContent:{component:'AssistantMessage',entries:[{ref:0,props:{...input,text:input.text.replace('RAW','SAFE')}}],nativeUnchanged:false}}};
      function Fixture(){const [text,setText]=useState('RAW_FIRST');
        window.first={seen:()=>seen,nextInput:()=>reads[0].input.text,redraw:()=>{for(const fn of events)fn({threadId:'first',scope:'site-redraw:owner-'+mounts})},set:setText,mounts:()=>mounts,releaseMount:()=>mountRelease(),reads:()=>reads.length,releaseRead:()=>reads.shift().done(),unmounted:()=>unmounted,clicks:()=>clicks,source:()=>{for(const fn of events)fn({threadId:'first',scope:'source-replaced:10'})}};
        return <ModsChatScope.Provider value={{threadId:'first',enabled:true,ready:true}}><FunctionSite threadId='first' component='AssistantMessage' facts={{text,isFirstOfReply:true}} renderNative={safe=><button onClick={()=>clicks.push(text)}>{safe.text}</button>}/></ModsChatScope.Provider>}
      host.render(<Fixture/>)}
    `
    await mount(page, fixture, [browserWorkerPlugin()])
    await page.waitForFunction("window.first?.mounts()===1")
    await page.evaluate("window.first.set('RAW_FIRST + second')")
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
    await page.evaluate("window.first.releaseMount()")
    await page.waitForFunction("window.first.reads()===1", undefined, { timeout: 3000 })
    await page.evaluate("window.first.set('RAW_FIRST + second + third')")
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
    await page.evaluate("window.first.releaseRead()")
    await page.getByRole("button", { name: "SAFE_FIRST", exact: true }).waitFor({ timeout: 3000 })
    assert.equal(await page.getByText(/RAW_FIRST/).count(), 0)
    assert.equal(await page.locator('[data-function-site="AssistantMessage"] [inert]').count(), 1)
    await page.getByRole("button", { name: "SAFE_FIRST", exact: true }).dispatchEvent("click")
    assert.deepEqual(await page.evaluate("window.first.clicks()"), [])
    assert.deepEqual(await page.evaluate("window.first.unmounted()"), [])
    await page.waitForFunction("window.first.reads()===1")
    const superseded = String(await page.evaluate("window.first.nextInput()")).replace(
      "RAW",
      "SAFE"
    )
    await page.evaluate("window.first.set('RAW_FIRST + second + third + fourth')")
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
    await page.evaluate("window.first.redraw();window.first.releaseRead()")
    await page.waitForFunction("window.first.reads()===1")
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
    assert.equal(await page.getByRole("button", { name: "SAFE_FIRST", exact: true }).count(), 1)
    assert.equal(await page.getByRole("button", { name: superseded, exact: true }).count(), 0)
    assert.equal(
      await page.evaluate(
        (value) =>
          Reflect.get(window, "first")
            .seen()
            .some((text: string) => text.includes(value)),
        superseded
      ),
      false
    )
    console.log(
      "PASS SDK redraw during append rejects the superseded protected read and preserves only the committed inert frame"
    )
    await page.evaluate("window.first.source()")
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
    assert.equal(await page.getByRole("button", { name: "SAFE_FIRST", exact: true }).count(), 0)
    assert.deepEqual(errors, [])
    console.log(
      "PASS inflight first mount/read publishes only a protected inert prefix before stream end; source replacement revokes it"
    )
    for (const replacement of ["replacement", "aba", "source"] as const) {
      await mount(page, fixture, [browserWorkerPlugin()])
      await page.waitForFunction("window.first?.mounts()===1")
      await page.evaluate("window.first.releaseMount()")
      await page.waitForFunction("window.first.reads()===1")
      if (replacement === "source") await page.evaluate("window.first.source()")
      else {
        await page.evaluate("window.first.set('UNRELATED')")
        await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
        if (replacement === "aba") await page.evaluate("window.first.set('RAW_FIRST + later')")
      }
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
      await page.evaluate("window.first.releaseRead()")
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
      assert.equal(await page.getByRole("button", { name: "SAFE_FIRST", exact: true }).count(), 0)
      assert.equal(await page.getByText(/RAW_FIRST|UNRELATED/).count(), 0)
    }
    console.log(
      "PASS replacement, intervening non-prefix ABA and source change reject the late first drawing"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
