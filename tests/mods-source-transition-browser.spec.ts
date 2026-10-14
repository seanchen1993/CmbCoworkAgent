/** A replacement source must not wait on a revoked read's renderer continuation. */
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
  try {
    await mount(
      page,
      `
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      {const listeners=new Set(),reads=[],unmounted=[];let mounts=0,hold=false,release,active=0,maxActive=0,holdMount=false,releaseMount;
      window.api.mods.onCardsChanged=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.siteMountOutcome=async()=>{const owner='owner-'+(++mounts);if(holdMount){holdMount=false;await new Promise(done=>releaseMount=done)}return {state:'mounted',owner}};
      window.api.mods.siteUnmount=async(t,owner)=>{unmounted.push(owner)};
      window.api.mods.siteRender=async(t,owner,input)=>{active++;maxActive=Math.max(active,maxActive);reads.push(owner);try{if(hold&&owner==='owner-1')await new Promise(done=>release=done);return {key:owner,id:owner,plugin:'engine',generation:owner,title:'Message',rows:1,closeOnEscape:false,tree:{type:'engine',ref:0},nativeContent:{component:'AssistantMessage',entries:[{ref:0,props:{...input,text:owner}}],nativeUnchanged:false}}}finally{active--}};
      window.transition={holdMount:()=>holdMount=true,releaseMount:()=>releaseMount?.(),emit:scope=>{for(const fn of listeners)fn({threadId:'a',scope})},hold:()=>hold=true,release:()=>{hold=false;release?.()},status:()=>({mounts,reads,unmounted,active,maxActive})};
      host.render(<ModsChatScope.Provider value={{threadId:'a',enabled:true}}><FunctionSite threadId="a" component="AssistantMessage" facts={{text:'RAW',isFirstOfReply:true}} fallback={null} renderNative={input=><p>{input.text}</p>}/></ModsChatScope.Provider>);}
    `,
      [browserWorkerPlugin()]
    )
    await page.getByText("owner-1", { exact: true }).waitFor()
    await page.evaluate("window.transition.hold();window.transition.emit('site:owner-1')")
    await page.waitForFunction("window.transition.status().active===1")
    await page.evaluate("window.transition.emit('source-retiring:1')")
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
    assert.equal(
      await page.getByText("owner-1", { exact: true }).count(),
      0,
      "Revoked source must disappear immediately"
    )
    await page.evaluate("window.transition.emit('source-replaced:2')")
    await page.getByText("owner-2", { exact: true }).waitFor({ timeout: 1500 })
    await page.evaluate(
      "window.transition.emit('source-replaced:2');window.transition.emit('source-retiring:1')"
    )
    assert.equal(await page.getByText("owner-2", { exact: true }).count(), 1)
    await page.evaluate("window.transition.release()")
    await page.waitForFunction("window.transition.status().active===0")
    assert.equal(await page.getByText("owner-1", { exact: true }).count(), 0)
    assert.equal(await page.getByText("owner-2", { exact: true }).count(), 1)
    const status = (await page.evaluate("window.transition.status()")) as {
      mounts: number
      maxActive: number
      unmounted: string[]
    }
    assert.equal(status.mounts, 2)
    assert(status.maxActive <= 4)
    assert(status.unmounted.includes("owner-1"))
    await page.evaluate(
      "window.transition.holdMount();window.transition.emit('source-retiring:2');window.transition.emit('source-replaced:3')"
    )
    await page.waitForFunction("window.transition.status().mounts===3")
    await page.evaluate("window.transition.emit('source-replaced:4')")
    await page.getByText("owner-4", { exact: true }).waitFor({ timeout: 1500 })
    await page.evaluate(
      "window.transition.releaseMount();window.transition.emit('source-replaced:3');window.transition.emit('source-retiring:2')"
    )
    await page.waitForFunction("window.transition.status().unmounted.includes('owner-3')")
    assert.equal(await page.getByText("owner-4", { exact: true }).count(), 1)
    assert.equal(await page.getByText("owner-3", { exact: true }).count(), 0)
    assert.equal(await page.evaluate("window.transition.status().mounts"), 4)
    console.log(
      "PASS source retirement clears old authority; replacement bypasses obsolete continuation; late mount is released and out-of-order generations cannot revive"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
