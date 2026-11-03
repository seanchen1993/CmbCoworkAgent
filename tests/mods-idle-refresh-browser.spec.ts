/** Production React: bounded extension work while typing and changing conversations. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
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
      import {PlatformWorkspace} from ${JSON.stringify(resolve("src/renderer/src/components/platform/PlatformWorkspace.tsx"))};
      import {FunctionPanes} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionPanes.tsx"))};
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      const cards=new Set(),platform=new Set(),config=new Set();
      let lists=0,behaviors=0,reads=0,active=0,maximum=0,prepares=0,discoveries=0;
      const wait=ms=>new Promise(done=>setTimeout(done,ms));
      window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
      window.api.mods.onPlatformChanged=fn=>{platform.add(fn);return()=>platform.delete(fn)};
      window.api.mods.onConfigurationChanged=fn=>{config.add(fn);return()=>config.delete(fn)};
      window.api.mods.panes=async()=>{reads++;maximum=Math.max(maximum,++active);try{await wait(15);return []}finally{active--}};
      window.api.mods.platformSurfaceList=async(_thread,options)=>{lists++;if(!options?.residentOnly)discoveries++;return{revision:0,entries:[],errors:[],canPrepare:true}};
      window.api.mods.platformBehaviorList=async()=>{behaviors++;return{revision:0,bindings:[],active:[],errors:[]}};
      window.api.mods.platformSurfacePrepare=async()=>{prepares++};
      function Fixture(){const[id,setId]=useState('idle');return <><textarea aria-label='Chat draft' defaultValue='keep'/>
        <button onClick={()=>setId(value=>value==='idle'?'other':'idle')}>Switch conversation</button>
        <ModsChatScope.Provider value={{threadId:id,enabled:true,ready:true}}>
          <FunctionPanes threadId={id} revealInSidebar={false}/>
        </ModsChatScope.Provider><PlatformWorkspace key={id} threadId={id} active/>
      </>}
      host.render(<Fixture/>);
      window.refreshProbe={stats:()=>({lists,behaviors,reads,active,maximum,prepares,discoveries}),
        reset:()=>{lists=behaviors=reads=maximum=discoveries=0},
        burst:async(scope,spaced=false)=>{for(let n=0;n<40;n++){
          for(const fn of cards)fn({threadId:'idle',scope});if(spaced)await wait(1)}await wait(120)},
        platform:async()=>{for(const fn of platform)fn({threadId:'idle'});await wait(80)}};
    `, [browserWorkerPlugin()])
    await page.getByLabel("Chat draft").waitFor()
    await page.waitForFunction("window.refreshProbe.stats().lists>0 && window.refreshProbe.stats().active===0")
    assert.equal(await page.evaluate("window.refreshProbe.stats().discoveries"), 0)
    const extraButton = await page.getByRole("button", { name: "查找可用插件界面", exact: true }).count()
    await page.evaluate("window.refreshProbe.reset()")
    await page.evaluate("window.refreshProbe.burst('feedback')")
    const feedback = await page.evaluate("window.refreshProbe.stats()")
    await page.evaluate("window.refreshProbe.reset()")
    await page.evaluate("window.refreshProbe.burst('panes',true)")
    const panes = await page.evaluate("window.refreshProbe.stats()")
    await page.evaluate("window.refreshProbe.reset()")
    await page.evaluate("window.refreshProbe.platform()")
    const configuration = await page.evaluate("window.refreshProbe.stats()")
    await page.getByLabel("Chat draft").fill("typing remains available")
    const switchTimes: number[] = []
    for (let index = 0; index < 8; index++) {
      const start = performance.now()
      await page.getByRole("button", { name: "Switch conversation", exact: true }).click()
      await page.waitForFunction("window.refreshProbe.stats().active===0")
      switchTimes.push(performance.now() - start)
    }
    assert.equal(await page.getByLabel("Chat draft").inputValue(), "typing remains available")
    const output = resolve("output/mods-idle-refresh-browser")
    mkdirSync(output, { recursive: true })
    const report = { extraButton, feedback, panes, configuration, switchTimes, errors }
    writeFileSync(resolve(output, "report.json"), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    assert.equal(extraButton, 0, "Cold sources alone must not add a global discovery button")
    assert.equal(feedback.reads, 0, "Feedback updates must not redraw every plugin pane")
    assert.equal(panes.lists, 0, "Pane drawing updates must not rescan the extension directory")
    assert.equal(panes.behaviors, 0)
    assert.equal(panes.maximum, 1, "Only one pane snapshot may be in flight")
    assert(panes.reads < 20, "A burst must coalesce instead of queueing all 40 snapshots")
    assert.equal(configuration.lists, 1, "Real platform changes still refresh discovery")
    assert.equal(configuration.prepares, 0, "Reading a catalogue must never activate sources")
    assert.equal(configuration.discoveries, 0, "Chat refresh must not inspect installed source files")
    assert.deepEqual(errors, [])
    console.log("PASS idle extension traffic stays bounded across typing and conversation changes")
  } finally { await browser.close() }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
