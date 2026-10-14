/** Real protected Spinner/ToolGroup surfaces and committed native renderer continuity. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await mount(page, `
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      import {FunctionToolGroup} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionToolGroup.tsx"))};
      {const cards=new Set(),owners=new Map(),calls=[];const staleSeen=[];new MutationObserver(records=>{if(document.body.textContent.includes('REDRAW 1')||records.some(r=>r.oldValue?.includes('REDRAW 1')||[...r.addedNodes].some(n=>n.textContent?.includes('REDRAW 1'))))staleSeen.push(true)}).observe(document.body,{subtree:true,childList:true,characterData:true,characterDataOldValue:true});let sequence=0,held=false,releases=[],redrawVersion=0,expireAbove=false,staleAbove=false;
      window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.siteMountOutcome=async(thread,component)=>{const owner='owner-'+(++sequence);owners.set(owner,component);return {state:'mounted',owner}};
      window.api.mods.siteUnmount=async(thread,owner)=>{owners.delete(owner)};
      window.api.mods.siteRender=async(thread,owner,input)=>{const component=owners.get(owner),safe=structuredClone(input),version=redrawVersion;calls.push(component);if(held)await new Promise(done=>releases.push(done));if(component==='AbovePrompt'&&staleAbove){staleAbove=false;throw Error('MODS_UI_DRAWING_STALE')}if(component==='AbovePrompt'&&expireAbove){expireAbove=false;throw Error('MODS_RUNTIME_INSTANCE_EXPIRED')}
        if(component==='ToolGroup')safe.calls=safe.calls.map(call=>({...call,input:{query:'SAFE INPUT'},...(call.output===undefined?{}:{output:'SAFE OUTPUT'})}));
        return {key:'engine:'+owner,id:owner,plugin:'engine',generation:'g-'+calls.length,title:component,rows:12,closeOnEscape:false,tree:component==='AbovePrompt'?{type:'Box',props:{},children:[{type:'Text',props:{},children:['REDRAW '+version]},{type:'engine',ref:0}]}:{type:'engine',ref:0},nativeContent:{component,entries:[{ref:0,props:safe}],nativeUnchanged:false}}};
      function Fixture(){const [running,setRunning]=useState(true),[output,setOutput]=useState(false),[error,setError]=useState(false),[blocked,setBlocked]=useState(false),[id,setId]=useState('tool-1'),[expanded,setExpanded]=useState(false),[word,setWord]=useState('Thinking'),[label,setLabel]=useState('OLD_RENDERER_STATE'),[working,setWorking]=useState(false);
        window.progress={stale:()=>staleAbove=true,staleSeen:()=>staleSeen.length,strong:()=>{const owner=[...owners].find(([,c])=>c==='AbovePrompt')[0];for(const fn of cards)fn({threadId:'a',scope:'site-invalidated:'+owner})},working:setWorking,expire:()=>expireAbove=true,releaseAndHold:()=>{for(const done of releases.splice(0))done()},clicks:()=>calls.filter(c=>c==='native-click').length,redraw:()=>{redrawVersion++;const owner=[...owners].find(([,c])=>c==='AbovePrompt')[0];for(const fn of cards)fn({threadId:'a',scope:'site-redraw:'+owner})},held:()=>releases.length,hold:()=>held=true,release:()=>{held=false;for(const done of releases.splice(0))done()},advance:()=>{setRunning(false);setOutput(true);setLabel('NEW_RAW_STATE')},error:setError,blocked:setBlocked,id:setId,word:setWord,emit:()=>{for(const fn of cards)fn({threadId:'a'})}};
        Object.assign(window.progress,{mounts:()=>sequence,source:generation=>{for(const fn of cards)fn({threadId:'a',scope:'source-replaced:'+generation})},redrawAll:()=>{for(const owner of owners.keys())for(const fn of cards)fn({threadId:'a',scope:'site-redraw:'+owner})}});
        const tool={tool_use_id:id,tool:'read_file',input:{query:'RAW INPUT'},isRunning:running,isErrored:error,isInterrupted:false,...(output?{output:'RAW OUTPUT'}:{})};
        return <ModsChatScope.Provider value={{threadId:'a',enabled:true,ready:true}}>
          <FunctionSite threadId='a' component='AbovePrompt' facts={{isWorking:working}} renderNative={()=><button onClick={()=>calls.push('native-click')}>Above native</button>}/>
          <FunctionSite threadId='a' component='AssistantMessage' facts={{text:'HISTORY',isFirstOfReply:true}} renderNative={safe=><button onClick={()=>calls.push('native-click')}>{safe.text}</button>}/>
          <FunctionSite threadId='a' component='Spinner' facts={{word,message:null,suffix:'',mode:running?'tool-use':'responding'}} renderNative={safe=><p>{safe.word}</p>}/>
          <FunctionToolGroup threadId='a' calls={[tool]} blocked={blocked} isActive={running}>
            {(groupExpanded,safeCalls)=>blocked?<button>Host approval</button>:<div><button onClick={()=>setExpanded(v=>!v)}>Expand</button><p>{label}</p><p>{safeCalls?.[0]?.isRunning?'SAFE RUNNING':'SAFE COMPLETE'}</p>{expanded&&<p>EXPANDED {String(safeCalls?.[0]?.output??'NO RESULT')}</p>}</div>}
          </FunctionToolGroup>
        </ModsChatScope.Provider>}
      host.render(<Fixture/>)}
    `, [browserWorkerPlugin()])
    await page.getByText("REDRAW 0", { exact: true }).waitFor()
    const oldButton = await page.getByRole("button", { name: "Above native" }).elementHandle()
    await page.evaluate("window.progress.hold();window.progress.redraw()")
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate("window.progress.held()"), 1)
    assert.equal(await page.getByText("REDRAW 0", { exact: true }).count(), 1)
    assert.equal(await page.locator('[data-function-site="AbovePrompt"] [inert]').count(), 1)
    await oldButton!.dispatchEvent("click")
    assert.equal(await page.evaluate("window.progress.clicks()"), 0)
    await page.evaluate("window.progress.redraw();window.progress.release()")
    await page.getByText("REDRAW 2", { exact: true }).waitFor()
    assert.equal(await page.getByText("REDRAW 1", { exact: true }).count(), 0)
    assert.equal(await page.evaluate("window.progress.staleSeen()"), 0)
    await page.getByRole("button", { name: "Above native" }).click()
    assert.equal(await page.evaluate("window.progress.clicks()"), 1)
    console.log("PASS SDK redraw preserves read-only protected presentation, coalesces revisions and never publishes a stale read")
    await page.evaluate("window.progress.hold();window.progress.redraw();window.progress.strong()")
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())))
    assert.equal(await page.getByText("REDRAW 2", { exact: true }).count(), 0)
    await page.evaluate("window.progress.release()")
    await page.getByText("REDRAW 3", { exact: true }).waitFor()
    console.log("PASS strong invalidation during a pure redraw immediately removes its retained presentation")
    await page.evaluate("window.progress.hold();window.progress.redraw();window.progress.working(true)")
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())))
    assert.equal(await page.getByText("REDRAW 3", { exact: true }).count(), 1)
    await page.evaluate("window.progress.working(false)")
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())))
    assert.equal(await page.getByText("REDRAW 3", { exact: true }).count(), 0)
    await oldButton!.dispatchEvent("click")
    assert.equal(await page.evaluate("window.progress.clicks()"), 1)
    await page.evaluate("window.progress.release()")
    await page.getByText("REDRAW 4", { exact: true }).waitFor()
    console.log("PASS input ABA cannot revive a redraw-qualified frame or its cached native callbacks")
    await page.evaluate("window.progress.hold();window.progress.expire();window.progress.redraw()")
    await page.waitForFunction("window.progress.held()===1")
    await page.evaluate("window.progress.releaseAndHold()")
    await page.waitForFunction("window.progress.held()===1")
    assert.equal(await page.getByText("REDRAW 4", { exact: true }).count(), 1)
    assert.equal(await page.locator('[data-function-site="AbovePrompt"] [inert]').count(), 1)
    await page.evaluate("window.progress.release()")
    await page.getByText("REDRAW 5", { exact: true }).waitFor()
    console.log("PASS fresh-call runtime expiry preserves only the explicitly pending read-only redraw frame")
    await page.getByText("SAFE RUNNING", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Expand", exact: true }).click()
    await page.getByText("EXPANDED NO RESULT", { exact: true }).waitFor()
    await page.evaluate("window.progress.hold();window.progress.advance();window.progress.word('Responding')")
    await page.waitForFunction("window.progress.held()===2")
    assert.deepEqual({ spinner: await page.getByText("Thinking", { exact: true }).count(),
      tool: await page.getByText("SAFE RUNNING", { exact: true }).count(),
      expanded: await page.getByText("EXPANDED NO RESULT", { exact: true }).count() },
    { spinner: 1, tool: 1, expanded: 1 })
    assert.equal(await page.getByText("NEW_RAW_STATE", { exact: true }).count(), 0)
    assert.equal(await page.getByText(/RAW OUTPUT|RAW INPUT/).count(), 0)
    await page.getByRole("button", { name: "Expand", exact: true }).dispatchEvent("click")
    assert.equal(await page.getByText("EXPANDED NO RESULT", { exact: true }).count(), 1)
    console.log("PASS protected tool progress retains the last committed expanded renderer and blocks new raw closures")
    await page.evaluate("window.progress.release()")
    await page.getByText("SAFE COMPLETE", { exact: true }).waitFor()
    await page.getByText("EXPANDED SAFE OUTPUT", { exact: true }).waitFor()
    await page.getByText("Responding", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Expand", exact: true }).click()
    assert.equal(await page.getByText("EXPANDED SAFE OUTPUT", { exact: true }).count(), 0)
    console.log("PASS fresh protected results resume the latest native renderer and ordinary expansion controls")
    for (const change of ["window.progress.error(true)", "window.progress.id('tool-2')", "window.progress.emit()"]){
      await page.evaluate("window.progress.hold();"+change)
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())))
      assert.equal(await page.getByText("SAFE COMPLETE", { exact: true }).count(), 0)
      await page.evaluate("window.progress.release()")
      await page.getByText("SAFE COMPLETE", { exact: true }).waitFor()
    }
    console.log("PASS errors, tool identity changes and strong invalidation immediately remove old protected rows")
    await page.evaluate("window.progress.hold();window.progress.blocked(true)")
    await page.getByRole("button", { name: "Host approval", exact: true }).waitFor()
    assert.equal(await page.getByText("SAFE COMPLETE", { exact: true }).count(), 0)
    assert.equal(await page.locator('[data-function-site="ToolGroup"]').count(), 0)
    console.log("PASS pending approval removes the plugin surface and remains host-owned")
    await page.evaluate("window.progress.release()")
    await page.getByText("REDRAW 5", { exact: true }).waitFor()
    await page.evaluate("window.progress.hold();window.progress.working(true)")
    await page.waitForFunction("window.progress.held()===1")
    await page.evaluate("window.progress.redraw()")
    await page.waitForTimeout(100)
    assert.equal(await page.getByText("REDRAW 5", { exact: true }).count(), 1)
    assert.equal(await page.locator('[data-function-site="AbovePrompt"] [inert]').count(), 1)
    const actionsBeforeReverse = await page.evaluate("window.progress.clicks()")
    await page.getByRole("button", { name: "Above native" }).dispatchEvent("click")
    assert.equal(await page.evaluate("window.progress.clicks()"), actionsBeforeReverse)
    await page.evaluate("window.progress.redraw();window.progress.stale();window.progress.releaseAndHold()")
    await page.waitForFunction("window.progress.held()===1")
    assert.equal(await page.getByText("REDRAW 5", { exact: true }).count(), 1)
    await page.evaluate("window.progress.release()")
    await page.getByText("REDRAW 7", { exact: true }).waitFor()
    console.log("PASS working before repeated redraw retains its committed progress frame even when the superseded read becomes STALE")
    for (let round = 0; round < 3; round++) {
      const before = await page.evaluate("window.progress.clicks()")
      await page.evaluate("window.progress.hold();window.progress.redrawAll()")
      await page.waitForFunction("window.progress.held()>=3")
      assert.equal(await page.getByRole("button", { name: "HISTORY", exact: true }).count(), 1)
      assert.equal(await page.locator('[data-function-site="AssistantMessage"] [inert]').count(), 1)
      await page.getByRole("button", { name: "HISTORY", exact: true }).dispatchEvent("click")
      assert.equal(await page.evaluate("window.progress.clicks()"), before)
      await page.evaluate("window.progress.release()")
      await page.waitForFunction(() => !document.querySelector('[data-function-site="AssistantMessage"] [inert]'))
      await page.getByRole("button", { name: "HISTORY", exact: true }).click()
      assert.equal(await page.evaluate("window.progress.clicks()"), Number(before) + 1)
    }
    console.log("PASS repeated broad SDK redraw keeps protected history visible and blocks every stale native action")
    const oldMounts = Number(await page.evaluate("window.progress.mounts()"))
    await page.evaluate("window.progress.hold();window.progress.source(20)")
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())))
    assert.equal(await page.getByRole("button", { name: "HISTORY", exact: true }).count(), 0)
    await page.waitForFunction(`window.progress.mounts()>${oldMounts}`)
    await page.evaluate("window.progress.release()")
    await page.getByRole("button", { name: "HISTORY", exact: true }).waitFor()
    const newMounts = await page.evaluate("window.progress.mounts()")
    await page.evaluate("window.progress.source(20);window.progress.source(19)")
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate("window.progress.mounts()"), newMounts)
    console.log("PASS committed source replacement clears immediately and directly remounts once; duplicates cannot reset retries")
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
