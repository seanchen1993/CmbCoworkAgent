/** Real React mount and browser events with controlled IPC replies; no main service claim. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

type FixtureOptions = {
  scenario?: "message" | "ask" | "mode"
  first?: "hold" | "fail" | "inactive" | "safe"
  ready?: boolean
  holdMount?: boolean
  transparent?: boolean
}

async function fixture(page: Page, options: FixtureOptions = {}) {
  await mount(
    page,
    `
    import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
    import {FunctionMessageText} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionMessageText.tsx"))};
    import {UserInputRequestDialog} from ${JSON.stringify(resolve("src/renderer/src/components/chat/UserInputRequestDialog.tsx"))};
    import {AgentModeSwitcher} from ${JSON.stringify(resolve("src/renderer/src/components/chat/AgentModeSwitcher.tsx"))};
    {
    crypto.randomUUID??=()=> 'native-fixture-'+Math.random().toString(16).slice(2);
    const settings=${JSON.stringify(options)},calls=[],answers=[],changes=[],rows=new Map();
    const cards=new Set(),configuration=new Set(),reads=[],mounts=[],history=[];
    let sequence=0,first=settings.first||'safe',holdMount=Boolean(settings.holdMount);
    let failNext='',holdRead=false,revision=1,modeLayout='inline',badMetadata='';
    const rootNode=document.getElementById('root');
    const record=value=>{if(typeof value==='string'&&value.includes('RAW_SECRET'))history.push(value)};
    const observer=new MutationObserver(records=>{
      record(rootNode.textContent);
      for(const mutation of records){
        record(mutation.oldValue);
        if(mutation.type==='characterData')record(mutation.target.data);
        if(mutation.type==='attributes')record(mutation.target.getAttribute(mutation.attributeName));
        for(const node of mutation.addedNodes){record(node.textContent);if(node.nodeType===1)for(const attribute of node.attributes)record(attribute.value)}
      }
    });
    observer.observe(rootNode,{subtree:true,childList:true,characterData:true,characterDataOldValue:true,attributes:true,attributeOldValue:true});
    const draw=(row,input)=>{
      let props=structuredClone(input);
      if(row.component==='UserMessage')props.text='Safe message '+revision;
      if(row.component==='AskUserQuestion')props.questions=props.questions.map(question=>({...question,
        header:'Safe header',question:'Safe question '+row.requestId+' '+revision,
        options:question.options.map(option=>({...option,description:'Safe description'}))}));
      if(row.component==='SessionMode')props.modes=['Safe '+input.modes.join(' ')];
      const engine={type:'engine',ref:0};
      const tree=row.component==='SessionMode'?
        {type:'Box',props:{gap:1},children:modeLayout==='inline'?
          [{type:'Text',props:{},children:['Protected wrapper ']},engine]:
          [{type:'Button',props:{key:'outside',label:'Plugin standalone control'},press:{plugin:'fixture-plugin',handle:1}},engine]}:
        {type:'Box',props:{},children:[engine]};
      return {key:'engine:'+row.owner,id:row.owner,plugin:'engine',title:row.component,
        generation:'generation-'+revision,rows:12,closeOnEscape:false,nativeFallback:false,
        tree:settings.transparent?{type:'fragment',children:[{type:'fragment',children:tree.children}]}:tree,
        nativeContent:{component:row.component,entries:[{ref:0,props}],nativeUnchanged:false,
          ...(row.requestId?{requestId:row.requestId}:{})}};
    };
    window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
    window.api.mods.onConfigurationChanged=fn=>{configuration.add(fn);return()=>configuration.delete(fn)};
    window.api.mods.feedback=async()=>[];
    window.api.mods.siteMountOutcome=async(threadId,component,messageId,requestId)=>{
      calls.push(['mount',component,requestId||null]);
      if(first==='inactive')return {state:'inactive',reason:'no-protection-or-functions'};
      const owner='owner-'+(++sequence),row={owner,component,requestId};rows.set(owner,row);
      if(holdMount)await new Promise(resolve=>mounts.push(resolve));
      return {state:'mounted',owner};
    };
    window.api.mods.siteRender=async(threadId,owner,input)=>{
      const row=rows.get(owner);if(!row)throw Error('MODS_UI_SITE_CLOSED');
      calls.push(['render',row.component,row.requestId||null,owner]);
      const candidate=structuredClone(draw(row,input));
      if(badMetadata==='missing')delete candidate.nativeContent;
      if(badMetadata==='component')candidate.nativeContent.component='AssistantMessage';
      if(badMetadata==='fragment')candidate.tree={type:'fragment',children:[candidate.tree],props:{}};
      badMetadata='';
      if(first==='fail'){first='safe';throw Error('first publication refused')}
      if(failNext){const error=failNext;failNext='';
        if(error==='MODS_UI_SITE_CLOSED')rows.delete(owner);
        throw Error(error)}
      if(first==='hold'||holdRead){first='safe';holdRead=false;await new Promise((resolve,reject)=>reads.push({resolve,reject,candidate}))}
      return candidate;
    };
    window.api.mods.siteUnmount=async(threadId,owner)=>{calls.push(['unmount',owner]);rows.delete(owner)};
    window.api.mods.siteAct=async(threadId,owner,action)=>{calls.push(['act',owner,action]);return {}};
    function Fixture(){
      const [ready,setReady]=useState(settings.ready!==false),[visible,setVisible]=useState(true),
        [text,setText]=useState('RAW_SECRET_MESSAGE_ONE'),[requestId,setRequestId]=useState('R1'),
        [mode,setMode]=useState('normal'),[locked,setLocked]=useState(false);
      const renderText=text=><span data-original-native-text>{text}</span>;
      window.nativeFixture={calls,answers,changes,history,
        ready:setReady,visible:setVisible,text:setText,request:setRequestId,locked:setLocked,
        liveOwners:()=>[...rows.keys()],
        releaseRead:()=>{for(const read of reads.splice(0))read.resolve()},
        rejectRead:()=>{for(const read of reads.splice(0))read.reject(Error('publication refused'))},
        releaseMount:()=>{holdMount=false;for(const resolve of mounts.splice(0))resolve()},
        holdMount:()=>holdMount=true,
        holdNext:()=>{holdRead=true;revision++},
        failNext:error=>failNext=error,
        malformNext:kind=>badMetadata=kind,
        refresh:component=>{for(const row of rows.values())if(row.component===component)for(const fn of cards)fn({threadId:'thread',scope:'site:'+row.owner})},
        interactiveMode:()=>{modeLayout='interactive';revision++;for(const row of rows.values())if(row.component==='SessionMode')for(const fn of cards)fn({threadId:'thread',scope:'site:'+row.owner})},
        counts:()=>({reads:reads.length,mounts:mounts.length}),
        unmount:()=>host.render(null)};
      const request={requestId,threadId:'thread',createdAt:new Date().toISOString(),questions:[{
        id:'same_choice',header:'Raw header',question:'RAW_SECRET_QUESTION',options:[
          {label:'Keep',description:'RAW_SECRET_DESCRIPTION'},
          {label:'Change',description:'RAW_SECRET_DESCRIPTION'}]}]};
      return <ModsChatScope.Provider value={{threadId:'thread',enabled:true,ready}}>
        <main style={{padding:24,width:700}}>
          <textarea aria-label='Ordinary composer'/>
          {visible&&(settings.scenario==='ask'?
            <UserInputRequestDialog request={request} onSubmit={answer=>answers.push(answer)}/>:
            settings.scenario==='mode'?
              <AgentModeSwitcher threadId='thread' mode={mode} locked={locked} lockedReason={locked?'Real task is running':undefined}
                onChange={value=>{changes.push(value);setMode(value)}}/>:
              <FunctionMessageText threadId='thread' messageId='original-message' role='user'
                text={text} isExpanded={true} isFirstOfReply={true} fallback={renderText(text)} renderText={renderText}/>)}
        </main>
      </ModsChatScope.Provider>;
    }
    host.render(<Fixture/>);
    }
  `,
    [browserWorkerPlugin()]
  )
}

const settled = (page: Page) =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  )
async function noRaw(page: Page) {
  await settled(page)
  assert.equal(
    await page.locator("#root").evaluate((node) => node.textContent!.includes("RAW_SECRET")),
    false
  )
  assert.deepEqual(await page.evaluate("window.nativeFixture.history"), [])
}
async function dispose(page: Page) {
  await page.evaluate(
    "window.nativeFixture.unmount();window.nativeFixture.releaseRead();window.nativeFixture.releaseMount()"
  )
  await page.waitForFunction("window.nativeFixture.liveOwners().length===0")
}

async function main() {
  mkdirSync(resolve("output"), { recursive: true })
  const output = mkdtempSync(resolve("output/mods-native-engine-browser-"))
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
  const errors: string[] = [],
    checks: string[] = []
  let failure = ""
  page.on("pageerror", (error) => errors.push(error.message))
  const pass = (label: string) => {
    checks.push(label)
    console.log("PASS " + label)
  }
  try {
    await fixture(page, { first: "hold" })
    await page.waitForFunction("window.nativeFixture.counts().reads===1")
    await noRaw(page)
    assert.equal(await page.locator("[data-original-native-text]").count(), 0)
    await page.getByRole("textbox", { name: "Ordinary composer" }).fill("Normal draft")
    assert.equal(
      await page.getByRole("textbox", { name: "Ordinary composer" }).inputValue(),
      "Normal draft"
    )
    await page.screenshot({ path: resolve(output, "first-publication-waiting.png") })
    await page.evaluate("window.nativeFixture.releaseRead()")
    await page.getByText("Safe message 1", { exact: true }).waitFor()
    await noRaw(page)
    pass("real first mount waits for a safe publication without putting raw fallback into DOM")
    await dispose(page)

    await fixture(page, { first: "fail" })
    await page.getByRole("alert").waitFor()
    await noRaw(page)
    assert.equal(await page.locator("[data-original-native-text]").count(), 0)
    await page.screenshot({ path: resolve(output, "first-publication-failed.png") })
    pass("first publication failure keeps a safe empty frame and cannot restore raw fallback")
    await dispose(page)

    await fixture(page)
    await page.getByText("Safe message 1", { exact: true }).waitFor()
    await page.evaluate(
      "window.nativeFixture.failNext('update publication refused');window.nativeFixture.refresh('UserMessage')"
    )
    await page.getByRole("alert").waitFor()
    assert(await page.getByText("Safe message 1", { exact: true }).isVisible())
    await noRaw(page)
    await page.screenshot({ path: resolve(output, "update-failed-safe-frame-retained.png") })
    pass("recoverable update failure retains the actual previous safe frame")
    for (const kind of ["missing", "component", "fragment"]) {
      const before = await page.evaluate(
        "window.nativeFixture.calls.filter(row=>row[0]==='render').length"
      )
      await page.evaluate((kind) => {
        const control = (
          window as unknown as {
            nativeFixture: {
              malformNext(kind: string): void
              refresh(component: string): void
            }
          }
        ).nativeFixture
        control.malformNext(kind)
        control.refresh("UserMessage")
      }, kind)
      await page.waitForFunction(
        (before) =>
          (
            window as unknown as {
              nativeFixture: {
                calls: unknown[][]
              }
            }
          ).nativeFixture.calls.filter((row) => row[0] === "render").length > before,
        before
      )
      await settled(page)
      assert(await page.getByText("Safe message 1", { exact: true }).isVisible())
      await noRaw(page)
      pass(kind === "fragment"
        ? "malformed Fragment metadata is rejected before replacing the actual previous safe frame"
        : "a " + kind + " native metadata update is rejected before replacing the old safe frame")
    }
    await page.evaluate(
      "window.nativeFixture.holdNext();window.nativeFixture.text('RAW_SECRET_MESSAGE_TWO')"
    )
    await page.waitForFunction("window.nativeFixture.counts().reads===1")
    await settled(page)
    assert.equal(await page.getByText("Safe message 1", { exact: true }).count(), 0)
    await noRaw(page)
    await page.evaluate("window.nativeFixture.releaseRead()")
    await page.getByText("Safe message 2", { exact: true }).waitFor()
    await noRaw(page)
    pass(
      "actual input changes hide the old frame until the new input gets its own safe publication"
    )
    await dispose(page)

    await fixture(page, { first: "hold", ready: false })
    await page.locator('[data-function-site="UserMessage"][aria-busy="true"]').waitFor({
      state: "attached"
    })
    await settled(page)
    assert.equal(await page.evaluate("window.nativeFixture.calls.length"), 0)
    await noRaw(page)
    await page.evaluate("window.nativeFixture.ready(true)")
    await page.waitForFunction("window.nativeFixture.counts().reads===1")
    await noRaw(page)
    await page.evaluate("window.nativeFixture.releaseRead()")
    await page.getByText("Safe message 1", { exact: true }).waitFor()
    pass("unknown global readiness does not guess inactive or expose original text")
    await dispose(page)

    await fixture(page, { holdMount: true })
    await page.waitForFunction("window.nativeFixture.counts().mounts===1")
    await page.evaluate("window.nativeFixture.visible(false)")
    await settled(page)
    await page.evaluate("window.nativeFixture.releaseMount()")
    await page.waitForFunction("window.nativeFixture.liveOwners().length===0")
    assert.equal(
      await page.evaluate("window.nativeFixture.calls.filter(row=>row[0]==='render').length"),
      0
    )
    await noRaw(page)
    pass("a late mounted owner is released after its actual React surface unmounts")
    await dispose(page)

    await fixture(page)
    await page.getByText("Safe message 1", { exact: true }).waitFor()
    const firstOwner = await page.evaluate("window.nativeFixture.liveOwners()[0]")
    await page.evaluate(
      "window.nativeFixture.holdNext();window.nativeFixture.failNext('MODS_UI_SITE_CLOSED');window.nativeFixture.refresh('UserMessage')"
    )
    await page.waitForFunction("window.nativeFixture.counts().reads===1")
    await noRaw(page)
    assert.equal(await page.getByText("Safe message 1", { exact: true }).count(), 0)
    assert.equal(
      await page.evaluate("window.nativeFixture.calls.filter(row=>row[0]==='mount').length"),
      2
    )
    const nextOwners = await page.evaluate("window.nativeFixture.liveOwners()")
    assert.equal(nextOwners.length, 1)
    assert.notEqual(nextOwners[0], firstOwner)
    await page.evaluate("window.nativeFixture.releaseRead()")
    await page.getByText("Safe message 2", { exact: true }).waitFor()
    await noRaw(page)
    assert.equal(
      await page.evaluate("window.nativeFixture.calls.filter(row=>row[0]==='mount').length"),
      2
    )
    pass("a closed owner triggers exactly one real remount and waits for the new safe frame")
    await dispose(page)

    await fixture(page)
    await page.getByText("Safe message 1", { exact: true }).waitFor()
    await page.evaluate(
      "window.nativeFixture.failNext('MODS_SCOPE_CHANGED');window.nativeFixture.refresh('UserMessage')"
    )
    await page.getByText("界面或提问已更新，请使用当前内容。", { exact: true }).waitFor()
    await page.waitForFunction("window.nativeFixture.liveOwners().length===0")
    assert.equal(await page.getByText("Safe message 1", { exact: true }).count(), 0)
    await noRaw(page)
    pass(
      "scope retirement clears the former safe frame instead of treating it as a recoverable update"
    )
    await dispose(page)

    await fixture(page, { first: "inactive" })
    await page.getByText("RAW_SECRET_MESSAGE_ONE", { exact: true }).waitFor()
    assert.equal(
      await page.evaluate("window.nativeFixture.calls.filter(row=>row[0]==='render').length"),
      0
    )
    pass("only an explicit host inactive outcome returns the ordinary original renderer")
    await dispose(page)

    await fixture(page, { scenario: "ask", transparent: true })
    await page.getByText("Safe question R1 1", { exact: true }).waitFor()
    assert.equal(
      await page
        .locator('[data-function-site="AskUserQuestion"]')
        .getAttribute("data-function-request-id"),
      "R1"
    )
    assert.equal(await page.getByRole("radiogroup").count(), 1)
    await noRaw(page)
    await page.evaluate(
      "window.nativeFixture.holdNext();window.nativeFixture.refresh('AskUserQuestion')"
    )
    await page.waitForFunction("window.nativeFixture.counts().reads===1")
    await page.evaluate("window.nativeFixture.request('R2')")
    await page.getByText("Safe question R2 2", { exact: true }).waitFor()
    assert.equal(
      await page
        .locator('[data-function-site="AskUserQuestion"]')
        .getAttribute("data-function-request-id"),
      "R2"
    )
    await page.evaluate("window.nativeFixture.releaseRead()")
    await settled(page)
    assert.equal(await page.getByText("Safe question R1 2", { exact: true }).count(), 0)
    assert.equal(await page.getByRole("radiogroup").count(), 1)
    await page.getByRole("radio", { name: /Keep/ }).click()
    await page.getByRole("button", { name: "提交", exact: true }).click()
    assert.deepEqual(
      await page.evaluate(
        "window.nativeFixture.answers.map(answer=>[answer.requestId,answer.answers.same_choice.label])"
      ),
      [["R2", "Keep"]]
    )
    assert(
      await page.evaluate(
        "window.nativeFixture.calls.some(row=>row[0]==='mount'&&row[2]==='R1')&&window.nativeFixture.calls.some(row=>row[0]==='mount'&&row[2]==='R2')"
      )
    )
    await noRaw(page)
    await page.screenshot({ path: resolve(output, "actual-r2-native-controls.png") })
    pass(
      "real nested Fragment R1/R2 remount keeps unique controls, rejects late R1 and answers only R2"
    )
    await dispose(page)

    await fixture(page, { scenario: "mode", transparent: true })
    const trigger = () => page.getByRole("button", { name: /^执行模式：/ })
    await page.getByText("Safe Solo", { exact: true }).waitFor()
    assert.equal(await trigger().count(), 1)
    assert.equal(await page.locator("button button").count(), 0)
    await trigger().focus()
    await page.keyboard.press("Enter")
    const slider = page.getByRole("slider", { name: "执行模式", exact: true })
    await slider.waitFor()
    await slider.focus()
    await page.keyboard.press("ArrowRight")
    await page.waitForFunction("window.nativeFixture.changes.includes('multi')")
    await page.keyboard.press("Escape")
    await page.getByText("Safe Multi", { exact: true }).waitFor()
    assert.equal(await trigger().getAttribute("aria-expanded"), "false")
    assert(await trigger().evaluate((node) => document.activeElement === node))
    await page.evaluate("window.nativeFixture.interactiveMode()")
    await page.getByRole("button", { name: "Plugin standalone control", exact: true }).waitFor()
    assert.equal(await trigger().count(), 1)
    assert.equal(await page.locator("button button").count(), 0)
    await trigger().focus()
    await page.keyboard.press("Enter")
    await slider.waitFor()
    await page.keyboard.press("Escape")
    await page.evaluate("window.nativeFixture.locked(true)")
    await trigger().focus()
    await page.keyboard.press("Enter")
    assert(await page.getByText("Real task is running", { exact: true }).last().isVisible())
    assert(await slider.isDisabled())
    await page.keyboard.press("Escape")
    await page.screenshot({ path: resolve(output, "one-original-mode-trigger.png") })
    pass(
      "nested Fragment inline and interactive mode layouts retain one original keyboard trigger and locked reason"
    )
    await dispose(page)
    assert.deepEqual(errors, [])
  } catch (error) {
    failure = error instanceof Error ? (error.stack ?? error.message) : String(error)
    throw error
  } finally {
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          scope: "real React/browser lifecycle with fixture IPC, not actual main pending service",
          checks,
          errors,
          failure,
          complete: !failure && errors.length === 0
        },
        null,
        2
      )
    )
    console.log("Native browser evidence: " + output)
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
