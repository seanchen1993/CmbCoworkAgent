/** Real tool renderers and inert-history behavior with controlled native IPC receipts. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/tool-display-projection-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  const errors: string[] = [],
    checks: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const pass = (name: string) => {
    checks.push(name)
    console.log("PASS " + name)
  }
  try {
    await mount(
      page,
      `
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {FunctionSitePresentationCache} from ${JSON.stringify(resolve("src/renderer/src/lib/function-site-presentation.ts"))};
      import {FunctionToolGroup} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionToolGroup.tsx"))};
      import {ModCommandJobs} from ${JSON.stringify(resolve("src/renderer/src/components/chat/ModCommandJobs.tsx"))};
      import {ToolCallRenderer} from ${JSON.stringify(resolve("src/renderer/src/components/chat/ToolCallRenderer.tsx"))};
      import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      import {validateFunctionDisplaySnapshotData} from ${JSON.stringify(resolve("src/shared/mods/v2/display-snapshot.ts"))};
      {const cards=new Set(),owners=new Map(),requests=[],approvals=[];
      const cache=new FunctionSitePresentationCache(()=>true);
      let held=false,releaseRead,expands=0,sequence=0,hostHeld=false,releaseHost,hostClicks=0;
      const hostBody='PROTECTED HOST MESSAGE '.repeat(600);
      const jobs=[{id:'native-job',threadId:'a',workspace:'a',command:'native-command',state:'failed',createdAt:1,
        result:{text:'PRIVATE_JOB_OUTPUT'},error:'PRIVATE_JOB_ERROR'}];
      const data=(component,props)=>({component,tree:{type:'engine',ref:0},nativeContent:{component,
        nativeUnchanged:false,entries:[{ref:0,props}]}});
      const safeInput=input=>input&&typeof input==='object'&&('action'in input||'handle'in input)?input:{command:'SAFE COMMAND'};
      const safe=(component,props)=>component==='CommandOutput'?{...props,text:'SAFE '+(props.isErrored?'ERROR':'OUTPUT')}:
        component==='ToolGroup'?{...props,calls:props.calls.map(c=>({...c,input:safeInput(c.input),output:'SAFE RESULT'}))}:
        {...props,...(component==='ToolUse'?{input:safeInput(props.input)}:{}),...(props.output===undefined?{}:{output:'SAFE RESULT'})};
      const pane=(owner,component,props)=>({key:'engine:'+owner,id:owner,plugin:'engine',generation:'g-'+owner,
        title:component,rows:12,closeOnEscape:false,...data(component,props)});
      window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.jobs=async()=>structuredClone(jobs);
      window.api.mods.onJobsChanged=()=>()=>{};
      window.api.mods.siteAct=async()=>{throw Error('PASSIVE_MUST_NOT_ACT')};
      window.api.mods.siteUnmount=async(_thread,owner)=>{owners.delete(owner)};
      window.api.mods.siteRead=async(thread,component,props,id)=>{
        const receipt={thread,component,id,props:structuredClone(props)};requests.push(receipt);
        if(component==='AssistantMessage'){
          if(hostHeld)await new Promise(done=>releaseHost=done);
          return {state:'projected',snapshot:{scopeId:'actual-fixture-scope',key:'host-message-key',
            version:'v-'+(++sequence),expiresAt:Date.now()+120000,
            data:{component,hostMessage:{text:hostBody,isFirstOfReply:true}}}};
        }
        const checked=safe(component,structuredClone(props));
        const value=data(component,checked);
        let passive=Boolean(id);try{validateFunctionDisplaySnapshotData(value)}catch{passive=false}
        receipt.outcome=passive?'projected':'mounted';
        if(component==='ToolGroup'&&held)await new Promise(done=>releaseRead=done);
        if(passive)return {state:'projected',snapshot:{scopeId:'actual-fixture-scope',key:JSON.stringify([component,id]),
          version:'v-'+(++sequence),expiresAt:Date.now()+120000,data:value}};
        const owner='actual-owner-'+(++sequence);owners.set(owner,{component,props:checked});
        return {state:'mounted',owner,snapshot:pane(owner,component,checked)};
      };
      window.api.mods.siteRender=async(_thread,owner,props)=>{const item=owners.get(owner);if(!item)throw Error('MODS_UI_SITE_CLOSED');
        return pane(owner,item.component,safe(item.component,props))};
      function Fixture(){
        const [blocked,setBlocked]=useState(true),[visible,setVisible]=useState(true),[expanded,setExpanded]=useState(false),
          [id,setId]=useState('native-tool'),[danger,setDanger]=useState(false),[hostVisible,setHostVisible]=useState(true);
        const tool={id,name:'execute',args:danger?{action:'native-business-action',handle:'native-business-handle'}:{command:'PRIVATE COMMAND'}};
        const call={tool_use_id:id,tool:'execute',input:tool.args,output:'PRIVATE RESULT',isRunning:false,isErrored:false,isInterrupted:false};
        window.toolProjection={requests,approvals,blocked:setBlocked,visible:setVisible,id:setId,danger:setDanger,
          hold:()=>held=true,release:()=>{held=false;releaseRead?.()},held:()=>Boolean(releaseRead),expands:()=>expands,
          hostVisible:setHostVisible,holdHost:()=>hostHeld=true,releaseHost:()=>{hostHeld=false;releaseHost?.()},
          hostClicks:()=>hostClicks,hostBody,hostCacheReady:()=>[...cache.entries.values()].some(e=>e.presentation.hostMessage)};
        return <ModsChatScope.Provider value={{threadId:'a',enabled:true,ready:true,presentationCache:cache}}>
          <ModCommandJobs threadId='a'/>
          {hostVisible&&<FunctionSite threadId='a' component='AssistantMessage' presentationId='host-history-row'
            facts={{text:'PRIVATE HOST MESSAGE '.repeat(600),isFirstOfReply:true}}
            renderNative={props=><div><p data-host-body>{props.text}</p>
              <button onClick={()=>hostClicks++}>Host native copy</button></div>}/>}
          {visible&&<FunctionToolGroup threadId='a' calls={[call]} blocked={blocked} isActive={false}>
            {(modExpanded,safeCalls)=>blocked?<ToolCallRenderer threadId='a' toolCall={tool} needsApproval status='awaiting_approval'
              onApprovalDecision={decision=>approvals.push({decision,id:tool.id,command:tool.args.command})}/>:
              <div><button onClick={()=>{expands++;setExpanded(v=>!v)}}>Native expand</button>
              <p data-safe-group>{safeCalls?.[0]?.input?.command??'NO PROTECTED INPUT'}</p>
              {expanded&&<p>Native expanded</p>}
              <ToolCallRenderer threadId='a' toolCall={tool} result='PRIVATE RESULT' status='completed'
                presentation={safeCalls?.[0]?{input:safeCalls[0].input,output:safeCalls[0].output}:undefined}
                initialExpanded={modExpanded}/></div>}
          </FunctionToolGroup>}
        </ModsChatScope.Provider>
      }
      host.render(<Fixture/>);}
    `,
      [browserWorkerPlugin()]
    )
    await page.getByRole("button", { name: "运行", exact: true }).waitFor()
    assert.equal(
      await page.evaluate(
        "window.toolProjection.requests.filter(r=>r.component==='ToolGroup').length"
      ),
      0
    )
    await page.getByRole("button", { name: "运行", exact: true }).click()
    assert.deepEqual(await page.evaluate("window.toolProjection.approvals"), [
      { decision: "approve", id: "native-tool", command: "PRIVATE COMMAND" }
    ])
    pass(
      "blocked tools keep the original approval control and actual tool target without a Mods request"
    )

    await page.waitForFunction(
      "window.toolProjection.requests.filter(r=>r.component==='CommandOutput').length===2"
    )
    const ids = (await page.evaluate(
      "window.toolProjection.requests.filter(r=>r.component==='CommandOutput').map(r=>r.id)"
    )) as string[]
    assert.equal(new Set(ids).size, 2)
    assert.deepEqual(
      ids.map((id) => JSON.parse(id)).sort(),
      [
        ["CommandOutput", "native-job", "error"],
        ["CommandOutput", "native-job", "output"]
      ].sort()
    )
    assert(!JSON.stringify(ids).includes("PRIVATE"))
    assert(!JSON.stringify(ids).includes("native-command"))
    assert.equal(
      await page.evaluate(
        "window.toolProjection.requests.filter(r=>r.component==='CommandOutput').every(r=>r.props.args==='***')"
      ),
      true
    )
    pass(
      "one durable command job has independent output/error row identities without command arguments or body in its identity"
    )

    await page.evaluate("window.toolProjection.blocked(false)")
    await page
      .locator('[data-function-site="ToolGroup"] > [data-function-site-projected]')
      .waitFor()
    await page.getByText("SAFE COMMAND", { exact: true }).first().waitFor()
    await page.getByRole("button", { name: "Native expand", exact: true }).click()
    await page.getByText("Native expanded", { exact: true }).waitFor()
    assert.equal(await page.evaluate("window.toolProjection.expands()"), 1)
    assert.equal(await page.getByRole("button", { name: "运行", exact: true }).count(), 0)
    assert.equal(await page.evaluate("window.toolProjection.approvals.length"), 1)
    pass(
      "passive protected ToolGroup retains native disclosure interaction and never manufactures an approval"
    )

    await page.waitForFunction(
      "window.toolProjection.requests.some(r=>r.component==='ToolUse')&&window.toolProjection.requests.some(r=>r.component==='ToolResult')"
    )
    assert.equal(
      await page.evaluate(
        "window.toolProjection.requests.filter(r=>['ToolUse','ToolResult'].includes(r.component)).every(r=>r.id&&JSON.parse(r.id)[1]==='native-tool')"
      ),
      true
    )
    pass("ToolUse and ToolResult details carry native tool IDs on separate display channels")

    await page.evaluate("window.toolProjection.visible(false)")
    await page.locator('[data-function-site="ToolGroup"]').waitFor({ state: "detached" })
    await page.evaluate("window.toolProjection.hold();window.toolProjection.visible(true)")
    const cached = page.locator(
      '[data-function-site="ToolGroup"] > [data-function-site-cached][inert]'
    )
    await cached.waitFor()
    const before = await page.evaluate("window.toolProjection.expands()")
    await cached.getByRole("button", { name: "Native expand", exact: true }).dispatchEvent("click")
    assert.equal(await page.evaluate("window.toolProjection.expands()"), before)
    assert.equal(await page.evaluate("window.toolProjection.approvals.length"), 1)
    await page.evaluate("window.toolProjection.release()")
    await page
      .locator('[data-function-site="ToolGroup"] > [data-function-site-projected]')
      .waitFor()
    await page.getByRole("button", { name: "Native expand", exact: true }).click()
    assert.equal(await page.evaluate("window.toolProjection.expands()"), Number(before) + 1)
    pass(
      "inert remount presentation cannot activate native controls until the fresh host read completes"
    )

    await page.evaluate("window.toolProjection.id('x'.repeat(2049))")
    await page.waitForFunction(
      "window.toolProjection.requests.some(r=>r.component==='ToolGroup'&&!r.id)"
    )
    await page.waitForFunction(
      "document.querySelector('[data-function-site=ToolGroup][data-function-plugin=engine]')"
    )
    pass(
      "an oversized native group identity uses the real owned path rather than sending an invalid cache ID"
    )

    await page.evaluate(
      "window.toolProjection.id('native-tool');window.toolProjection.danger(true)"
    )
    await page.waitForFunction(
      "window.toolProjection.requests.some(r=>r.component==='ToolGroup'&&r.id&&r.props.calls[0].input.action&&r.outcome==='mounted')"
    )
    await page.waitForFunction(
      "document.querySelector('[data-function-site=ToolGroup][data-function-plugin=engine]')"
    )
    assert.equal(await page.evaluate("window.toolProjection.approvals.length"), 1)
    pass(
      "active-shaped business payload uses the owned path under the unchanged passive-data codec"
    )

    await page
      .locator('[data-function-site="AssistantMessage"] > [data-function-site-projected]')
      .waitFor()
    await page.evaluate("window.toolProjection.hostVisible(false)")
    await page.locator('[data-function-site="AssistantMessage"]').waitFor({ state: "detached" })
    await page.waitForFunction("window.toolProjection.hostCacheReady()")
    await page.evaluate("window.toolProjection.holdHost();window.toolProjection.hostVisible(true)")
    const cachedHost = page.locator(
      '[data-function-site="AssistantMessage"] > [data-function-site-cached][inert]'
    )
    await cachedHost.waitFor()
    assert.equal(
      await cachedHost.locator("[data-host-body]").textContent(),
      await page.evaluate("window.toolProjection.hostBody")
    )
    assert(!(await cachedHost.textContent())?.includes("PRIVATE HOST MESSAGE"))
    await cachedHost
      .getByRole("button", { name: "Host native copy", exact: true })
      .dispatchEvent("click")
    assert.equal(await page.evaluate("window.toolProjection.hostClicks()"), 0)
    await page.evaluate("window.toolProjection.releaseHost()")
    await page
      .locator('[data-function-site="AssistantMessage"] > [data-function-site-projected]')
      .waitFor()
    await page.getByRole("button", { name: "Host native copy", exact: true }).click()
    assert.equal(await page.evaluate("window.toolProjection.hostClicks()"), 1)
    pass(
      "protected host message remains visible on cached remount without a fake engine frame or a live cached control"
    )

    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(output, "tool-display.png"), fullPage: true })
    writeFileSync(
      join(output, "validation.json"),
      JSON.stringify(
        {
          passed: true,
          checks,
          errors,
          requestCount: await page.evaluate("window.toolProjection.requests.length")
        },
        null,
        2
      )
    )
  } catch (error) {
    await page.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {})
    writeFileSync(
      join(output, "validation.json"),
      JSON.stringify({ passed: false, checks, errors, error: String(error) }, null, 2)
    )
    throw error
  } finally {
    await browser.close()
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
