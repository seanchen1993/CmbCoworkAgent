/** Real history surfaces recover after trial retirement without publishing an old read. */
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
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      {const cards=new Set(), owners=new Map();let sequence=0,held=false,retiring=false,releases=[];
      window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.siteRead=undefined;
      window.api.mods.siteMountOutcome=async(thread,component)=>{
        if(retiring)throw Error('MODS_DEVELOPMENT_APPLYING');
        const owner='history-'+(++sequence);owners.set(owner,component);return {state:'mounted',owner}
      };
      window.api.mods.siteUnmount=async(thread,owner)=>{owners.delete(owner)};
      window.api.mods.siteRender=async(thread,owner,props)=>{
        const component=owners.get(owner),safe={...props};if(component==='UserMessage')safe.origin={kind:'unclassified'};
        if(held)await new Promise(resolve=>releases.push(resolve));
        if(!owners.has(owner))throw Error('MODS_UI_SITE_CLOSED');
        return {key:'engine:'+owner,id:owner,plugin:'engine',generation:'g-'+sequence,
          title:component,rows:12,closeOnEscape:false,tree:{type:'engine',ref:0},
          nativeContent:{component,entries:[{ref:0,props:safe}],nativeUnchanged:false}}
      };
      const emit=scope=>{for(const fn of cards)fn({threadId:'a',scope})};
      window.historyTrial={pending:()=>releases.length,refresh:()=>{held=true;emit(undefined)},
        stop:generation=>{retiring=true;emit('source-retiring:'+generation)},
        finish:()=>{retiring=false;held=false;for(const resolve of releases.splice(0))resolve();emit(undefined)}};
      host.render(<ModsChatScope.Provider value={{threadId:'a',enabled:true,ready:true}}>
        <FunctionSite threadId='a' component='UserMessage' messageId='user-1'
          facts={{text:'My original question',isExpanded:false}} renderNative={safe=><p>{safe.text}</p>}/>
        <FunctionSite threadId='a' component='AssistantMessage'
          facts={{text:'My original reply',isFirstOfReply:true}} renderNative={safe=><p>{safe.text}</p>}/>
      </ModsChatScope.Provider>);}
    `,
      [browserWorkerPlugin()]
    )
    for (let generation = 1; generation <= 3; generation++) {
      await page.getByText("My original question", { exact: true }).waitFor()
      await page.getByText("My original reply", { exact: true }).waitFor()
      await page.evaluate("window.historyTrial.refresh()")
      await page.waitForFunction("window.historyTrial.pending()===2")
      await page.evaluate(
        (value) =>
          (
            window as unknown as {
              historyTrial: { stop(generation: number): void }
            }
          ).historyTrial.stop(value),
        generation
      )
      await page.waitForFunction(() => !document.body.textContent?.includes("My original question"))
      assert.equal(await page.getByText("My original reply", { exact: true }).count(), 0)
      await page.evaluate("window.historyTrial.finish()")
      await page.getByText("My original question", { exact: true }).waitFor()
      await page.getByText("My original reply", { exact: true }).waitFor()
      assert.equal(await page.getByRole("alert").count(), 0)
      assert.equal(await page.locator('[data-function-site][aria-busy="true"]').count(), 0)
    }
    assert.deepEqual(errors, [])
    console.log(
      "PASS three trial-stop cycles revoke old reads and restore both native history surfaces"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
