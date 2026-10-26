import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/mods-packaged-focus-browser")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(15000)
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await mount(
      page,
      `
      import {FunctionPanes} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionPanes.tsx"))};
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {ClawResultsVisibility} from ${JSON.stringify(resolve("src/renderer/src/lib/claw-sidebar.ts"))};
      useAppStore.getState().currentThreadId='a';useAppStore.getState().mainView='thread';
      let rows=[],serial=0,gate,release,ackGate,releaseAck,waiting=false,entered='',focusCount=0,changes=[];
      let intent=0;crypto.randomUUID??=()=>'fixture-intent-'+(++intent);
      const paneListeners=new Set(),configs=new Set();
      const emitPane=()=>{for(const fn of paneListeners)fn({threadId:'a'})};
      const tree=()=>({type:'Box',props:{},children:[
        {type:'Text',props:{},children:['focus-events:'+focusCount+' entered:'+entered]},
        ...['First','Second'].map((name,index)=>({type:'Input',props:{key:name,label:name+' focus field'},press:{plugin:'p',handle:index+1}}))
      ]});
      window.focusFixture={
        start(holdAck=false){entered='';focusCount=0;changes=[];waiting=false;
          ackGate=holdAck?new Promise(done=>releaseAck=done):Promise.resolve();
          gate=new Promise(done=>release=done);serial++;
          rows=[{key:'p:focus-'+serial,id:'focus',plugin:'p',title:'Focus E2E',generation:'initial-'+serial,
            openRequestId:'open-'+serial,rows:4,focusRequest:{id:'focus-'+serial,pending:true},tree:tree()}];emitPane()},
        waiting:()=>waiting,changes:()=>changes,
        release(){waiting=false;release()},ack(){releaseAck()},
        removeTarget(){rows[0].tree.children=rows[0].tree.children.filter(node=>node.props?.key!=='First')},
        close(){rows=[];emitPane()},
        revoke(){for(const fn of configs)fn()},
        redraw(){rows[0].generation='redraw-'+serial;rows[0].tree=tree();emitPane()}
      };
      window.api.mods.panes=async()=>{if(waiting)await gate;return structuredClone(rows)};
      window.api.mods.onCardsChanged=fn=>{paneListeners.add(fn);return()=>paneListeners.delete(fn)};
      window.api.mods.onConfigurationChanged=fn=>{configs.add(fn);return()=>configs.delete(fn)};
      window.api.mods.paneAct=async(id,action)=>{
        const row=rows[0];
        if(!row||action.pane!==row.key||action.generation!==row.generation)throw Error('MODS_UI_STALE_ACTION');
        if(action.kind==='focus'&&action.value?.request){
          assertFocus=action.value.focused;
          if(!assertFocus)throw Error('FIXTURE_FOCUS_NOT_ADMITTED');
          focusCount++;row.focusRequest.pending=false;row.generation='committed-'+serial;row.tree=tree();
          waiting=true;emitPane();await ackGate;return {focused:true,target:{plugin:'p',element:'First'}};
        }
        if(action.kind==='change'){changes.push({generation:action.generation,value:action.value});
          entered=action.value;row.generation='input-'+serial;row.tree=tree();emitPane()}
        return {focused:false};
      };
      let assertFocus=false;
      function Fixture(){const[thread,setThread]=useState('a');window.focusFixture.thread=setThread;
        return <><textarea className='composer-textarea' aria-label='Composer'/><button>Other focus</button>
          <ClawResultsVisibility.Provider value={true}>
            <ModsChatScope.Provider value={{threadId:thread,enabled:true}}><FunctionPanes threadId={thread}/></ModsChatScope.Provider>
          </ClawResultsVisibility.Provider></>}
      host.render(<Fixture/>);
    `,
      [browserWorkerPlugin()]
    )
    await page.addScriptTag({ content: "window.__name = value => value" })
    const first = page.getByRole("textbox", { name: "First focus field", exact: true })
    const second = page.getByRole("textbox", { name: "Second focus field", exact: true })
    const start = async (holdAck = false) => {
      await page.getByRole("textbox", { name: "Composer", exact: true }).focus()
      await page.evaluate(`window.focusFixture.start(${holdAck})`)
      await page.waitForFunction("window.focusFixture.waiting()")
      await first.waitFor()
    }
    await start()
    // The host has invalidated G1 but its G2 snapshot is held at the actual IPC boundary.
    assert.equal(await first.evaluate((node) => node === document.activeElement), false)
    assert.equal(await second.getAttribute("readonly"), "")
    await page.evaluate("window.focusFixture.release()")
    await page.waitForFunction(
      "document.activeElement?.getAttribute('data-function-control') === 'First'"
    )
    // Same immediate fill as the packaged gate: no extra redraw wait or retry.
    await second.fill("packaged focus persists")
    await page
      .getByText("focus-events:1 entered:packaged focus persists", { exact: true })
      .waitFor()
    assert.equal(await second.inputValue(), "packaged focus persists")
    assert(await second.evaluate((node) => node === document.activeElement))
    assert.deepEqual(await page.evaluate("window.focusFixture.changes()"), [
      { generation: "committed-1", value: "packaged focus persists" }
    ])
    await page.evaluate("window.focusFixture.redraw()")
    await page.waitForFunction(
      "document.querySelector('[data-function-pane]')?.getAttribute('data-function-pane-generation') === 'redraw-1'"
    )
    assert(await second.evaluate((node) => node === document.activeElement))
    assert.equal(await second.inputValue(), "packaged focus persists")
    assert.equal(await page.getByRole("alert").count(), 0)
    console.log(
      "PASS committed focus drawing accepts immediate input once and preserves second-field focus on redraw"
    )
    await start(true)
    await page.evaluate("window.focusFixture.release()")
    await page.getByText("focus-events:1 entered:", { exact: true }).waitFor()
    assert.equal(await first.evaluate((node) => node === document.activeElement), false)
    assert.equal(await second.getAttribute("readonly"), "")
    await page.evaluate("window.focusFixture.ack()")
    await page.waitForFunction(
      "document.activeElement?.getAttribute('data-function-control') === 'First'"
    )
    await second.fill("snapshot arrived before ACK")
    await page
      .getByText("focus-events:1 entered:snapshot arrived before ACK", { exact: true })
      .waitFor()
    assert(await second.evaluate((node) => node === document.activeElement))
    console.log("PASS snapshot-before-ACK ordering retains barrier until both are committed")
    for (const change of ["focus", "key", "revoke", "target", "close", "thread"]) {
      await start()
      if (change === "focus") await page.getByRole("button", { name: "Other focus" }).focus()
      if (change === "key") await page.keyboard.press("ArrowRight")
      if (change === "revoke") await page.evaluate("window.focusFixture.revoke()")
      if (change === "target") await page.evaluate("window.focusFixture.removeTarget()")
      if (change === "close") await page.evaluate("window.focusFixture.close()")
      if (change === "thread") await page.evaluate("window.focusFixture.thread('b')")
      await page.evaluate("window.focusFixture.release()")
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
      )
      assert.equal(
        await page.evaluate(
          "document.activeElement?.getAttribute('data-function-control') === 'First'"
        ),
        false,
        change
      )
      assert.deepEqual(await page.evaluate("window.focusFixture.changes()"), [], change)
      console.log(`PASS waiting focus does not survive ${change} change`)
    }
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          passed: true,
          scope:
            "Real FunctionPanes React component and browser events; controlled IPC generation/ACK barrier, not packaged Guest execution",
          checks: 8,
          errors
        },
        null,
        2
      )
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
