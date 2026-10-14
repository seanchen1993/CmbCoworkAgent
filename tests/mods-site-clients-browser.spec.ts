/** Actual production React and native answer controls with a controllable IPC fixture. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/mods-site-clients-browser")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
  const errors: string[] = [],
    checks: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const pass = (label: string) => {
    checks.push(label)
    console.log("PASS " + label)
  }
  try {
    await mount(
      page,
      `
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      import {UserInputRequestDialog} from ${JSON.stringify(resolve("src/renderer/src/components/chat/UserInputRequestDialog.tsx"))};
      crypto.randomUUID??=()=> 'site-fixture-'+Math.random().toString(16).slice(2);
      let hidden=false;Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
      const cards=new Set(),config=new Set(),rows=new Map(),siteCalls=[],answers=[];
      let siteSequence=0,holdPress=false,finishPress,holdRead=false,finishRead,rejectPress=false,quietPress=false;
      const text=children=>({type:'Text',props:{},children:[children]});
      const draw=row=>({key:'engine:'+row.owner,id:row.owner,plugin:'engine',title:row.component,
        generation:'generation-'+row.revision,rows:12,closeOnEscape:false,nativeFallback:false,
        nativeContent:{component:row.component,entries:[{ref:0,props:row.props??{}}],...(row.requestId?{requestId:row.requestId}:{})},
        tree:row.component==='AskUserQuestion'?{type:'Box',props:{flexDirection:'column'},children:[{type:'Client',props:{key:'counter',module:'surface.tsx'},client:{plugin:'actual-plugin'}},{type:'engine',ref:0}]}:{type:'Client',props:{key:'counter',module:'surface.tsx'},client:{plugin:'actual-plugin'}},
        clients:[{id:row.owner,generation:'generation-'+row.revision,plugin:'actual-plugin',element:'counter',module:'surface.tsx',tree:{type:'Box',props:{},children:[
          text(row.component+' count:'+row.count),{type:'Button',props:{key:'increment',label:'Increment '+row.component},press:{plugin:'actual-plugin',handle:1}}]}}]});
      window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
      window.api.mods.onConfigurationChanged=fn=>{config.add(fn);return()=>config.delete(fn)};
      window.api.mods.feedback=async()=>[];
      window.api.mods.siteMount=async(thread,component,messageId,requestId)=>{const owner='owner-'+(++siteSequence);rows.set(owner,{owner,component,requestId,count:0,revision:1});siteCalls.push(['mount',component,owner]);return owner};
      window.api.mods.siteMountOutcome=async(...args)=>({state:'mounted',owner:await window.api.mods.siteMount(...args)});
      window.api.mods.siteRender=async(thread,owner,props)=>{const row=rows.get(owner);if(!row)throw Error('MODS_UI_SITE_CLOSED');siteCalls.push(['render',row.component,owner]);row.props=structuredClone(props);const value=structuredClone(draw(row));if(holdRead){holdRead=false;await new Promise(r=>finishRead=r)}return value};
      window.api.mods.siteUnmount=async(thread,owner)=>{siteCalls.push(['unmount',owner]);rows.delete(owner)};
      window.api.mods.clientAct=async(thread,action)=>{siteCalls.push(['act',structuredClone(action)]);const row=rows.get(action.instance);if(!row||action.pane!=='engine:'+row.owner||action.generation!=='generation-'+row.revision)throw Error('stale');if(action.kind==='press'){row.count++;if(!quietPress)for(const fn of cards)fn({threadId:thread,scope:'site:'+row.owner});if(holdPress){holdPress=false;await new Promise(r=>finishPress=r);if(rejectPress){rejectPress=false;throw Error('old generation retired')}}}};
      function Fixture(){
        const [ask,setAsk]=useState(false),[text,setText]=useState('Original message'),[visible,setVisible]=useState(true);
        window.siteFixture={calls:siteCalls,answers,ask:setAsk,visible:setVisible,text:setText,
          hidden:value=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'))},
          emit:scope=>{for(const fn of cards)fn({threadId:'a',scope})},
          owner:component=>[...rows.values()].find(r=>r.component===component)?.owner,
          refresh:component=>{const row=[...rows.values()].find(r=>r.component===component);row.count++;for(const fn of cards)fn({threadId:'a',scope:'site:'+row.owner})},
          redraw:component=>{const row=[...rows.values()].find(r=>r.component===component);row.revision++;for(const fn of cards)fn({threadId:'a',scope:'site:'+row.owner})},
          holdPress:(reject=false,quiet=false)=>{holdPress=true;rejectPress=reject;quietPress=quiet},finishPress:()=>finishPress?.(),holdRead:()=>holdRead=true,finishRead:()=>finishRead?.(),
          reset:()=>{for(const fn of config)fn()},unmount:()=>host.render(null)};
        return <ModsChatScope.Provider value={{threadId:'a',enabled:true}}>
          <main style={{width:700,padding:24}}><h1>Ordinary conversation</h1>
          {visible&&<FunctionSite threadId='a' component='AbovePrompt' facts={{isWorking:false}}/>}
          <textarea aria-label='Ordinary composer'/>
          <FunctionSite threadId='a' component='AssistantMessage' facts={{text,isFirstOfReply:true}}/>
          </main><UserInputRequestDialog request={ask?{requestId:'native-question',threadId:'a',createdAt:new Date().toISOString(),questions:[{id:'choice',header:'Plan',question:'Original native question?',options:[{label:'Careful',description:'Original description'},{label:'Fast',description:'Other description'}]}]}:null} onSubmit={answer=>answers.push(answer)}/>
        </ModsChatScope.Provider>
      }
      host.render(<Fixture/>);
    `,
      [browserWorkerPlugin()]
    )
    await page.getByText("AbovePrompt count:0", { exact: true }).waitFor()
    await page.getByText("AssistantMessage count:0", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Increment AbovePrompt", exact: true }).click()
    await page.getByText("AbovePrompt count:1", { exact: true }).waitFor()
    assert(await page.getByText("AssistantMessage count:0", { exact: true }).isVisible())
    pass(
      "actual Client controls run at AbovePrompt and message positions with independent identities"
    )
    await page.evaluate("window.siteFixture.holdRead();window.siteFixture.text('Original message appended')")
    await page.waitForTimeout(100)
    const retainedClient = page.getByRole("button", { name: "Increment AssistantMessage", exact: true })
    assert.equal(await retainedClient.getAttribute("aria-disabled"), "true")
    const beforeRetainedAct = await page.evaluate("window.siteFixture.calls.filter(c=>c[0]==='act').length")
    await retainedClient.dispatchEvent("click")
    assert.equal(await page.evaluate("window.siteFixture.calls.filter(c=>c[0]==='act').length"), beforeRetainedAct)
    await page.evaluate("window.siteFixture.finishRead()")
    await page.waitForFunction("!document.querySelector('[data-function-site=AssistantMessage] [inert]')")
    await page.evaluate("window.siteFixture.text('Original message')")
    await page.getByText("AssistantMessage count:0", { exact: true }).waitFor()
    pass("retained append Client controls remain visible but disabled until their current protected read")
    const count = () => page.evaluate("window.siteFixture.calls.filter(c=>c[0]==='render').length")
    const baseline = await count()
    await page.evaluate("for(let i=0;i<30;i++)window.siteFixture.emit('site:unrelated')")
    await page.waitForTimeout(100)
    assert.equal(await count(), baseline)
    pass("unrelated site frames cause zero queries in mounted production owners")
    const composerBeforeRefresh = await page.getByRole("textbox", { name: "Ordinary composer" }).boundingBox()
    await page.evaluate("window.siteFixture.holdRead();window.siteFixture.emit('site:'+window.siteFixture.owner('AbovePrompt'))")
    await page.waitForTimeout(500)
    assert(await page.getByText("AbovePrompt count:1", { exact: true }).isVisible())
    assert.equal(await page.getByRole("status").count(), 0)
    assert.deepEqual(await page.getByRole("textbox", { name: "Ordinary composer" }).boundingBox(), composerBeforeRefresh)
    await page.evaluate("window.siteFixture.finishRead()")
    await page.waitForTimeout(100)
    pass("a slow non-revoking site refresh preserves content and composer geometry without blocking status")
    const visibilityBaseline = await page.evaluate("window.siteFixture.calls.length")
    await page.evaluate(`const buttons=[...document.querySelectorAll('button')];document.querySelector('[data-function-client]').dispatchEvent(new PointerEvent('pointermove',{bubbles:true,buttons:1,clientX:10,clientY:10}));window.siteFixture.hidden(true);buttons.forEach(button=>button.click())`)
    await page.waitForTimeout(450)
    assert(await page.getByText("AbovePrompt count:1", { exact: true }).isVisible())
    assert.equal(await page.evaluate("window.siteFixture.calls.length"), visibilityBaseline)
    await page.evaluate("window.siteFixture.hidden(false)")
    await page.waitForTimeout(450)
    assert.equal(await page.evaluate("window.siteFixture.calls.length"), visibilityBaseline)
    pass("hidden cached Client controls cannot act; idle restore preserves frames without IPC")
    const revokedActs = await page.evaluate("window.siteFixture.calls.filter(c=>c[0]==='act').length")
    await page.evaluate(`const buttons=[...document.querySelectorAll('button')];window.siteFixture.emit();buttons.forEach(button=>button.click())`)
    await page.getByText("AbovePrompt count:1", { exact: true }).waitFor()
    await page.waitForTimeout(100)
    // Redraw resize events are allowed, but cached press handlers cannot execute.
    assert.equal(await page.evaluate("window.siteFixture.calls.filter(c=>c[0]==='act'&&c[1].kind==='press').length"), 1)
    assert((await page.evaluate("window.siteFixture.calls.filter(c=>c[0]==='act').length")) >= revokedActs)
    pass("synchronous real revocation rejects cached Client presses before React removes the tree")
    await page.evaluate("window.siteFixture.holdPress()")
    await page.getByRole("button", { name: "Increment AbovePrompt", exact: true }).click()
    await page.getByText("AbovePrompt count:2", { exact: true }).waitFor()
    assert(
      await page.getByRole("button", { name: "Increment AbovePrompt", exact: true }).isDisabled()
    )
    await page.evaluate(
      "window.siteFixture.refresh('AbovePrompt');window.siteFixture.finishPress()"
    )
    await page.getByText("AbovePrompt count:3", { exact: true }).waitFor()
    await page.waitForFunction(
      "!document.querySelector('[data-function-site=AbovePrompt] button').disabled"
    )
    pass("local frame refresh preserves actual pending controls until their own reply completes")
    await page.evaluate("window.siteFixture.redraw('AbovePrompt')")
    await page.waitForTimeout(80)
    await page.getByRole("button", { name: "Increment AbovePrompt", exact: true }).click()
    await page.getByText("AbovePrompt count:4", { exact: true }).waitFor()
    pass(
      "same-instance parent redraw installs a fresh generation callback and keeps the next click usable"
    )
    await page.evaluate("window.siteFixture.holdPress(true)")
    await page.getByRole("button", { name: "Increment AbovePrompt", exact: true }).click()
    await page.getByText("AbovePrompt count:5", { exact: true }).waitFor()
    await page.evaluate("window.siteFixture.redraw('AbovePrompt')")
    await page.waitForTimeout(80)
    await page.evaluate("window.siteFixture.finishPress()")
    await page.waitForTimeout(80)
    assert.equal(
      await page.getByText("组件已更新或停止，请在当前画面重试。", { exact: true }).count(),
      0
    )
    assert(
      !(await page.getByRole("button", { name: "Increment AbovePrompt", exact: true }).isDisabled())
    )
    pass(
      "late old-generation rejection cannot write an error into the retained new drawing and returns only its pending token"
    )
    await page.evaluate("window.siteFixture.holdPress()")
    await page.getByRole("button", { name: "Increment AbovePrompt", exact: true }).click()
    await page.getByText("AbovePrompt count:6", { exact: true }).waitFor()
    await page.waitForTimeout(150)
    await page.evaluate("window.siteFixture.hidden(true)")
    const hiddenCompletionReads = await count()
    await page.evaluate("window.siteFixture.finishPress()")
    await page.waitForTimeout(400)
    assert.equal(await count(), hiddenCompletionReads)
    await page.evaluate("window.siteFixture.hidden(false)")
    await page.waitForTimeout(400)
    assert.equal(await count(), hiddenCompletionReads + 1)
    assert(await page.getByText("AbovePrompt count:6", { exact: true }).isVisible())
    pass("a hidden Client action completion defers its read until visible without clearing the frame")
    await page.evaluate("window.siteFixture.holdPress(false,true)")
    await page.getByRole("button", { name: "Increment AbovePrompt", exact: true }).click()
    await page.evaluate("window.siteFixture.hidden(true);window.siteFixture.finishPress()")
    const quietCompletionReads = await count()
    await page.waitForTimeout(200)
    assert.equal(await count(), quietCompletionReads)
    await page.evaluate("window.siteFixture.hidden(false)")
    await page.getByText("AbovePrompt count:7", { exact: true }).waitFor()
    await page.waitForTimeout(150)
    assert.equal(await count(), quietCompletionReads + 1)
    pass("a hidden action without notifications refreshes exactly once on restore without replay")
    const hiddenResizeBefore = await page.evaluate("window.siteFixture.calls.filter(c=>c[0]==='act'&&c[1].kind==='resize').length")
    await page.evaluate("window.siteFixture.hidden(true);document.querySelector('[data-function-site=AbovePrompt] [data-function-client]').style.width='300px'")
    await page.waitForTimeout(150)
    assert.equal(await page.evaluate("window.siteFixture.calls.filter(c=>c[0]==='act'&&c[1].kind==='resize').length"), hiddenResizeBefore)
    await page.evaluate("window.siteFixture.hidden(false)")
    await page.waitForFunction("window.siteFixture.calls.some(c=>c[0]==='act'&&c[1].kind==='resize'&&c[1].value.columns===37)")
    await page.evaluate("document.querySelector('[data-function-site=AbovePrompt] [data-function-client]').style.width=''")
    pass("hidden resize sends no action and delivers changed dimensions once visible")
    await page.getByRole("textbox", { name: "Ordinary composer" }).fill("Usual chat remains usable")
    assert.equal(
      await page.getByRole("textbox", { name: "Ordinary composer" }).inputValue(),
      "Usual chat remains usable"
    )
    pass("ordinary composer remains editable beside the actual site Client")
    await page.evaluate("window.siteFixture.ask(true)")
    await page.getByText("AskUserQuestion count:0", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Increment AskUserQuestion", exact: true }).click()
    await page.getByText("AskUserQuestion count:1", { exact: true }).waitFor()
    assert.equal(await page.evaluate("window.siteFixture.answers.length"), 0)
    const positions = await page.evaluate(() => [
      document.querySelector('[data-function-site="AskUserQuestion"] [data-function-client]')!.getBoundingClientRect()
        .bottom,
      [...document.querySelectorAll("button")]
        .find((node) => node.textContent?.includes("Careful"))!
        .getBoundingClientRect().top
    ])
    assert(positions[0] <= positions[1])
    assert(await page.getByText("Original native question?", { exact: true }).isVisible())
    await page.getByRole("button", { name: /Careful/ }).click()
    await page.screenshot({ path: resolve(output, "native-question-with-client.png") })
    pass(
      "actual original answer controls remain below the Client, and Client presses never submit an answer"
    )
    await page.evaluate("window.siteFixture.ask(false);window.siteFixture.visible(false)")
    await page.waitForFunction("!document.querySelector('[data-function-site=AbovePrompt]')")
    await page.waitForTimeout(80)
    assert(await page.evaluate("window.siteFixture.calls.some(c=>c[0]==='unmount')"))
    pass("actual component unmount releases its private native slot")
    assert.deepEqual(errors, [])
    writeFileSync(resolve(output, "report.json"), JSON.stringify({ checks, errors }, null, 2))
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
