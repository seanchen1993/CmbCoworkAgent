/** Production sites with long forms; controlled IPC makes pending redraws observable. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync } from "node:fs"
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
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await mount(
      page,
      `
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      const cards=new Set(), owners=new Map();let dockSequence=0, held=false, releases=[];window.dockReads=0;
      window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.siteRead=undefined;
      window.api.mods.siteMountOutcome=async(thread,component)=>{
        const owner='owner-'+(++dockSequence);owners.set(owner,component);return {state:'mounted',owner}
      };
      window.api.mods.siteUnmount=async(thread,owner)=>{owners.delete(owner)};
      window.api.mods.siteRender=async(thread,owner,props)=>{
        const component=owners.get(owner);window.dockReads++;if(held)await new Promise(r=>releases.push(r));
        return {key:'engine:'+owner,id:owner,plugin:'engine',title:component,generation:'g'+dockSequence,
          rows:12,closeOnEscape:false,nativeFallback:false,
          nativeContent:{component,entries:[{ref:0,props}]},
          tree:{type:'Box',props:{flexDirection:'column'},children:[
            ...Array.from({length:5},(_,i)=>({type:'Input',props:{key:'field'+i,label:component+' Field '+i,value:''},press:{plugin:'test',handle:i+1}})),
            {type:'Text',props:{},children:[Array.from({length:80},(_,i)=>component+' report '+i).join('\\n')]}]}}
      };
      window.api.mods.siteAct=async(thread,owner,action)=>{
        for(const fn of cards)fn({threadId:thread,scope:'site-redraw:'+owner})
      };
      window.dock={hold:()=>{held=true},release:()=>{held=false;releases.splice(0).forEach(r=>r())},
        revoke:()=>{held=true;for(const fn of cards)fn({threadId:'a',scope:'source-retiring:1'})}};
      host.render(<ModsChatScope.Provider value={{threadId:'a',enabled:true}}>
        <main style={{height:'100vh',display:'flex',flexDirection:'column',overflow:'hidden'}}>
          <FunctionSite threadId='a' component='ChatHeader' facts={{isWorking:false}}/>
          <div data-transcript style={{flex:'1 1 0',minHeight:0,overflow:'auto'}}><div style={{height:3000}}>Transcript</div></div>
          <FunctionSite threadId='a' component='AbovePrompt' facts={{isWorking:false}}/>
          <textarea aria-label='Chat composer' style={{height:70,flexShrink:0}}/>
        </main>
      </ModsChatScope.Provider>);
    `,
      [browserWorkerPlugin()]
    )
    await page.waitForTimeout(500)
    if ((await page.getByLabel("AbovePrompt Field 0").count()) === 0)
      console.log("INITIAL", await page.locator("body").innerText(), errors)
    for (const component of ["AbovePrompt", "ChatHeader"]) {
      const site = page.locator(`[data-function-site=${component}]`)
      await site.getByLabel(`${component} Field 0`).waitFor()
      await page.evaluate("window.dock.hold()")
      await site.evaluate((node) => {
        node.scrollTop = 200
      })
      await page.waitForTimeout(100)
      assert.equal(
        await site.getByLabel(`${component} Field 0`).count(),
        1,
        `${component} must retain its protected form during a scroll read`
      )
      assert((await site.evaluate((node) => node.scrollTop)) >= 190, "scroll must not reset")
      await page.evaluate("window.dock.release()")
      await page.waitForTimeout(100)
      const before = await site.boundingBox()
      assert(before && before.height <= Math.min(288, 800 / 3), "Both docks reserve transcript space")
      if (component === "ChatHeader") assert(before.height > 144, "Expanded top forms have usable height")
      await page.locator("[data-transcript]").evaluate((node) => {
        node.scrollTop = 2500
      })
      assert.deepEqual(await site.boundingBox(), before, "transcript scrolling must not move dock")
      await site.evaluate((node) => {
        node.scrollTop = node.scrollHeight
      })
      await page.waitForTimeout(150)
      assert(
        await site.evaluate((node) => node.scrollTop > 200),
        "last report rows must be reachable"
      )
      console.log(`PASS ${component}: retained form, independent scrolling, stable dock`)
    }
    // During a delayed protected read, continuous resize must keep the old forms inert.
    await page.evaluate("window.dock.hold()")
    const readsBefore = await page.evaluate("window.dockReads") as number
    for (let step = 0; step < 12; step++) {
      await page.setViewportSize({ width: 700 + (step % 3) * 120, height: 620 + (step % 2) * 100 })
      await page.waitForTimeout(35)
      for (const component of ["AbovePrompt", "ChatHeader"]) {
        const input = page.getByLabel(`${component} Field 0`)
        assert.equal(await input.count(), 1, "Resize must retain verified dock content")
        assert(await input.evaluate(node => Boolean(node.closest("[inert]"))),
          "Old geometry grants no interaction while a fresh read waits")
      }
    }
    await page.waitForTimeout(5100)
    assert.equal(await page.getByText("内容加载较慢，请稍候…", { exact: true }).count(), 0)
    assert((await page.evaluate("window.dockReads") as number) - readsBefore <= 2,
      "Resize burst coalesces behind the one in-flight read per dock")
    await page.evaluate("window.dock.release()")
    await page.waitForFunction(() => [...document.querySelectorAll("input")].every(node =>
      !node.closest("[inert]")))
    console.log("PASS resize burst: retained inert forms, coalesced reads, current controls restored")
    mkdirSync("output/mods-docked-sites", { recursive: true })
    await page.screenshot({ path: "output/mods-docked-sites/long-form.png" })
    await page.evaluate("window.dock.revoke()")
    await page.setViewportSize({ width: 1100, height: 900 })
    await page.waitForTimeout(100)
    assert.equal(
      await page.getByLabel("AbovePrompt Field 0").count(),
      0,
      "source retirement must still remove the old protected drawing"
    )
    assert.deepEqual(errors, [])
    console.log("PASS source retirement still removes docked content")
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
