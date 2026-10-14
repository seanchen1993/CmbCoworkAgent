/** Data-only events must not blank every protected message; authority events still revoke. */
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
      import {ModsChatScope,useModsChatState} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      {const cards=new Set(),config=new Set();let hold=false,releases=[],seq=0,reads=0;
      window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
      window.api.mods.onConfigurationChanged=fn=>{config.add(fn);return()=>config.delete(fn)};
      window.api.mods.chatDisplayCapability=async()=>{reads++;if(hold)await new Promise(done=>releases.push(done));return true};
      window.api.mods.siteMountOutcome=async()=>({state:'mounted',owner:'owner-'+(++seq)});
      window.api.mods.siteUnmount=async()=>{};
      window.api.mods.siteRender=async(t,owner,input)=>{if(hold)await new Promise(done=>releases.push(done));return {key:owner,id:owner,plugin:'engine',generation:owner,title:'Message',rows:1,closeOnEscape:false,tree:{type:'engine',ref:0},nativeContent:{component:'AssistantMessage',entries:[{ref:0,props:input}],nativeUnchanged:false}}};
      window.trace={reads:()=>reads,hold:()=>hold=true,release:()=>{hold=false;for(const done of releases.splice(0))done()},cards:scope=>{for(const fn of cards)fn({threadId:'a',scope})},config:payload=>{for(const fn of config)fn(payload)}};
      function Fixture(){const state=useModsChatState('a','workspace');return <ModsChatScope.Provider value={{threadId:'a',...state}}><div data-message-list>{[1,2,3].map(n=><FunctionSite key={n} threadId="a" component="AssistantMessage" facts={{text:'HISTORY_'+n,isFirstOfReply:true}} fallback={null} renderNative={input=><p>{input.text}</p>}/>)}</div></ModsChatScope.Provider>}
      host.render(<Fixture/>);}
    `,
      [browserWorkerPlugin()]
    )
    await page.getByText("HISTORY_3", { exact: true }).waitFor()
    const results: number[] = []
    for (const kind of ["cards", "schema", "panes", "feedback", "records"]) {
      await page.evaluate(
        `window.trace.hold();window.trace.${kind === "schema" ? "config({scope:'schema'})" : `cards('${kind}')`}`
      )
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done()))
          )
      )
      results.push(await page.locator("[data-message-list] p").count())
      await page.evaluate("window.trace.release()")
      await page.getByText("HISTORY_3", { exact: true }).waitFor()
    }
    assert.deepEqual(
      results,
      [3, 3, 3, 3, 3],
      "Card data and schema refresh must keep all protected history mounted"
    )
    for (const payload of ["undefined", "{scope:'unknown'}"]) {
      await page.evaluate(`window.trace.hold();window.trace.config(${payload})`)
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done()))
          )
      )
      assert.equal(
        await page.locator("[data-message-list] p").count(),
        0,
        "Unknown or authority changes must revoke every old drawing"
      )
      await page.evaluate("window.trace.release()")
      await page.getByText("HISTORY_3", { exact: true }).waitFor()
    }
    console.log(
      "PASS data-only notifications preserve all history; unknown and authority events still revoke"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
