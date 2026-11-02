/** Real hooks and FunctionPanes only; whole App routing is covered by the native driver. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

const output = resolve("output", `project-chat-workbench-browser-${randomUUID()}`)
const checks: string[] = []
const settle = async (page: import("playwright").Page) => {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  )
}

async function main() {
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await mount(
      page,
      `
      let bindingReads=0,runReads=0,activeReads=0,subscribers=0,finishBinding,finishRuns;
      window.scopeFixture={defer:false,update:null,state:null,reads:()=>({binding:bindingReads,runs:runReads,active:activeReads,subscribers}),
        pending:()=>Boolean(finishBinding&&finishRuns),finish:()=>{
          const stale=structuredClone(profileView);stale.active={id:'late-profile',name:'Late profile',flow:definition('a')};
          finishBinding(stale);finishRuns([{id:'late-run',threadId:'a',workspace:'a',status:'running',startedAt:1,
            flow:definition('a'),attempts:[],failureCounts:{},epoch:0}]);finishBinding=finishRuns=null;
        }};
      window.api.mods.clawView=async()=>{bindingReads++;return window.scopeFixture.defer
        ?new Promise(resolve=>finishBinding=resolve):structuredClone(profileView)};
      window.api.mods.flowRuns=async()=>{runReads++;return window.scopeFixture.defer
        ?new Promise(resolve=>finishRuns=resolve):[]};
      window.api.mods.flowActive=async()=>{activeReads++;return null};
      window.api.mods.onConfigurationChanged=()=>{subscribers++;return()=>subscribers--};
      function ScopeProbe(){const[enabled,setEnabled]=useState(false);const flow=useChatFlow('a','a',enabled);
        window.scopeFixture.update=setEnabled;window.scopeFixture.state={enabled,run:flow.run?.id??null,
          profile:flow.binding?.active?.id??null,error:flow.error};
        return <section aria-label='Actual flow hook'><p>{enabled?'enabled':'disabled'}</p></section>}
      host.render(<ScopeProbe/>);
    `
    )
    await page.getByRole("region", { name: "Actual flow hook" }).waitFor()
    await settle(page)
    assert.deepEqual(await page.evaluate("window.scopeFixture.reads()"), {
      binding: 0,
      runs: 0,
      active: 0,
      subscribers: 0
    })
    checks.push(
      "useChatFlow disabled makes no binding/history/active reads or configuration subscriptions"
    )
    await page.evaluate("window.scopeFixture.defer=true;window.scopeFixture.update(true)")
    await page.waitForFunction("window.scopeFixture.pending()")
    await page.evaluate("window.scopeFixture.update(false)")
    await page.waitForFunction(
      "window.scopeFixture.state.enabled===false&&window.scopeFixture.reads().subscribers===0"
    )
    await page.evaluate("window.scopeFixture.finish()")
    await settle(page)
    const state = (await page.evaluate("window.scopeFixture.state")) as {
      enabled: boolean
      run: string | null
      profile: string | null
    }
    assert.deepEqual(
      { enabled: state.enabled, run: state.run, profile: state.profile },
      { enabled: false, run: null, profile: null }
    )
    assert.equal(
      await page.evaluate(
        "window.fixture.calls.filter(c=>['start','clawStart','cancel','decide'].includes(c[0])).length"
      ),
      0
    )
    checks.push(
      "late ordinary binding/history replies cannot resurrect a disabled project hook or execute a task"
    )
    await page.screenshot({ path: resolve(output, "disabled-hook.png"), fullPage: true })

    await mount(
      page,
      `
      import {FunctionPanes} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionPanes.tsx"))};
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {useClawNotices,protectFlowTaskView} from ${JSON.stringify(resolve("src/renderer/src/lib/claw-sidebar.ts"))};
      let rows=[],paneListeners=new Set(),serial=0,releaseProtection;
      crypto.randomUUID??=()=>"project-pane-fixture-"+(++serial);
      window.paneScope={actions:[],notices:{},set:null,open:()=>{
        rows=[{key:'plugin:custom',id:'custom',plugin:'plugin',title:'Plugin custom panel',rows:4,
          generation:'draw-'+(++serial),openRequestId:'open-'+serial,
          tree:{type:'Box',props:{},children:[{type:'Button',props:{key:'custom-action',label:'Custom project action'},
            press:{plugin:'plugin',handle:1}}]}}];for(const fn of paneListeners)fn({threadId:'a'});
      },unprotect:()=>releaseProtection?.(),panel:()=>({module:useAppStore.getState().rightModule,collapsed:useAppStore.getState().rightPanelCollapsed})};
      window.api.mods.panes=async()=>structuredClone(rows);
      window.api.mods.onCardsChanged=fn=>{paneListeners.add(fn);return()=>paneListeners.delete(fn)};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.paneAct=async(id,action)=>{window.paneScope.actions.push({id,action});return{focused:false}};
      window.api.mods.focusAck=async()=>{};window.api.mods.scrollAck=async()=>{};
      function PaneProbe(){const[reveal,setReveal]=useState(false);window.paneScope.set=setReveal;
        const notices=useClawNotices('a');window.paneScope.notices=notices;
        useEffect(()=>{releaseProtection=protectFlowTaskView('a',true);return()=>releaseProtection()},[]);
        return <><div hidden><ClawSidebarHost threadId='a'/></div>
          <ModsChatScope.Provider value={{threadId:'a',enabled:true}}>
            <FunctionPanes threadId='a' revealInSidebar={reveal}/>
          </ModsChatScope.Provider></>}
      host.render(<PaneProbe/>);
    `,
      [browserWorkerPlugin()]
    )
    await settle(page)
    await page.evaluate("window.paneScope.open()")
    const action = page.getByRole("button", { name: "Custom project action", exact: true })
    await action.waitFor({ state: "visible" })
    await action.click()
    await page.waitForFunction("window.paneScope.actions.some(x=>x.action.kind==='press')")
    await settle(page)
    assert.deepEqual(await page.evaluate("window.paneScope.panel()"), {
      module: "work",
      collapsed: true
    })
    assert.deepEqual(await page.evaluate("window.paneScope.notices"), {})
    checks.push(
      "project custom panes still render and handle real actions without sidebar navigation or notices"
    )
    await page.screenshot({ path: resolve(output, "project-custom-pane.png"), fullPage: true })
    await page.evaluate("window.paneScope.set(true)")
    await settle(page)
    await page.waitForFunction("Object.keys(window.paneScope.notices).length>0")
    await page.evaluate("window.paneScope.unprotect();window.paneScope.open()")
    await page.waitForFunction(
      "window.paneScope.panel().module==='claw'&&window.paneScope.panel().collapsed===false"
    )
    checks.push(
      "ordinary default pane mode retains its original notices and automatic sidebar reveal"
    )
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          success: true,
          checks,
          scope:
            "Real useChatFlow and FunctionPanes with controlled IPC; not whole App/native/model acceptance",
          errors
        },
        null,
        2
      )
    )
    console.log(JSON.stringify({ output, checks: checks.length, success: true }))
  } catch (error) {
    await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true }).catch(() => {})
    writeFileSync(
      resolve(output, "failure.json"),
      JSON.stringify({ error: String(error), checks, errors,
        body: await page.locator("body").innerText().catch(() => "") }, null, 2)
    )
    throw error
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
