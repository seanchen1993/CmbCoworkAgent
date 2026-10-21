/** First paint exercises the real scope, queue and sites without exposing unverified text. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { build as buildCss } from "vite"
import tailwindcss from "@tailwindcss/vite"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  // Compile the application's actual utilities; handwritten fixture CSS would miss this bug.
  const cssBuild = await buildCss({
    configFile: false,
    plugins: [tailwindcss()],
    build: { write: false, rollupOptions: { input: resolve("src/renderer/src/index.css") } }
  })
  const bundles = Array.isArray(cssBuild) ? cssBuild : [cssBuild]
  const css = bundles.flatMap(bundle => "output" in bundle ? bundle.output : [])
    .filter(asset => asset.type === "asset" && asset.fileName.endsWith(".css"))
    .map(asset => asset.type === "asset"
      ? typeof asset.source === "string" ? asset.source : Buffer.from(asset.source).toString("utf8")
      : "").join("\n")
  assert(css.length > 0, "The real application stylesheet must be compiled")
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await mount(page, `
      import {ModsChatScope,useModsChatState} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      {const configs=new Set(),calls=[],owners=new Map(),pending=[];
      let capability=true,holdCapability=false,finishCapability,failed=false,seq=0;
      window.api.mods.chatDisplayCapability=async(thread,workspace)=>{
        calls.push(['capability',thread,workspace]);if(failed)throw Error('unavailable');
        if(holdCapability)return new Promise(r=>finishCapability=r);return capability};
      window.api.mods.onConfigurationChanged=fn=>{configs.add(fn);return()=>configs.delete(fn)};
      window.api.mods.onCardsChanged=()=>()=>{};
      window.api.mods.siteMountOutcome=async(thread,component)=>{const owner='first-'+(++seq);
        calls.push(['mount',owner]);owners.set(owner,component);return {state:'mounted',owner}};
      window.api.mods.siteRender=async(thread,owner,props)=>{calls.push(['render',owner,owners.get(owner)]);
        await new Promise(r=>pending.push(r));return {key:owner,id:owner,plugin:'engine',
        generation:owner,title:'message',rows:2,closeOnEscape:false,
        tree:{type:'Text',props:{},children:['SAFE '+props.index]},
        nativeContent:{component:owners.get(owner),entries:[{ref:0,props}]}}};
      window.api.mods.siteUnmount=async(thread,owner)=>{calls.push(['unmount',owner]);owners.delete(owner)};
      function Fixture(){const state=useModsChatState('first','C:/first'),[optional,setOptional]=useState(false),[withMessage,setWithMessage]=useState(false);
        window.first.showOptional=()=>setOptional(true);
        window.first.showMessage=()=>setWithMessage(true);
        return <ModsChatScope.Provider value={{threadId:'first',...state}}>
        {optional?<>{['AbovePrompt','PromptHint','SessionMode','Spinner'].map(component=><FunctionSite
          key={component} threadId='first' component={component} facts={{}}/>)}
          {withMessage&&<FunctionSite threadId='first' component='AssistantMessage' messageId='active-message'
            facts={{index:99}} fallback={<p>RAW 99</p>}/>}</>:
        <div className='mx-auto w-full max-w-3xl'>{Array.from({length:8},(_,index)=>{
          const site=<FunctionSite key={index} threadId='first'
          component={index===0?'UserMessage':'AssistantMessage'} messageId={'message-'+index} facts={{index}}
          className={index===0?'contents':undefined}
          fallback={<button onClick={()=>calls.push(['native'])}>RAW {index}</button>}/>;
          // Match MessageBubble's user shrink-to-fit hierarchy, including its padded content box.
          return index===0?<div key={index} data-user-message-geometry className='group flex justify-end overflow-hidden py-4'>
            <div className='flex min-w-0 max-w-[80%] flex-col items-end gap-1'>
              <div data-user-bubble className='min-w-0 max-w-full overflow-hidden rounded-lg p-3 bg-primary/10'>
                <div className='relative min-w-0 max-w-full overflow-hidden'>{site}</div>
              </div>
            </div>
          </div>:site
        })}</div>}</ModsChatScope.Provider>}
      window.first={calls,held:()=>pending.length,release:()=>pending.splice(0).forEach(r=>r()),
        configure:(enabled,hold=false)=>{capability=enabled;holdCapability=hold;for(const fn of configs)fn()},
        reject:()=>{failed=true;for(const fn of configs)fn()},repair:()=>failed=false,
        resolve:enabled=>finishCapability(enabled)};host.render(<Fixture/>)}
    `, [browserWorkerPlugin()])
    await page.addStyleTag({ content: css })
    await page.waitForFunction("window.first.held()===4")
    assert.equal(await page.locator("[data-function-site-pending]").count(), 8)
    assert.equal(await page.getByText(/RAW /).count(), 0)
    for (const width of [1280, 374, 180]) {
      await page.setViewportSize({ width, height: 900 })
      const geometry = await page.locator("[data-user-message-geometry]").evaluate(row => {
        const bubble = row.querySelector("[data-user-bubble]") as HTMLElement
        const pending = row.querySelector("[data-function-site-pending]") as HTMLElement
        const firstBar = pending.querySelector('[aria-hidden="true"] > div') as HTMLElement
        const r = row.getBoundingClientRect(), b = bubble.getBoundingClientRect()
        const p = pending.getBoundingClientRect(), bar = firstBar.getBoundingClientRect()
        return { display: getComputedStyle(row).display, rowWidth: r.width,
          bubbleWidth: b.width, pendingWidth: p.width, barWidth: bar.width, pendingHeight: p.height,
          rowLeft: r.left, rowRight: r.right, bubbleLeft: b.left, bubbleRight: b.right,
          pendingLeft: p.left, pendingRight: p.right, scrollWidth: bubble.scrollWidth,
          clientWidth: bubble.clientWidth, viewport: innerWidth }
      })
      assert.equal(geometry.display, "flex", "Application Tailwind layout must be active")
      assert(geometry.pendingWidth >= (width >= 374 ? 144 : 48),
        `UserMessage pending must not collapse inside its shrink-to-fit bubble: ${JSON.stringify(geometry)}`)
      assert(geometry.pendingWidth <= 176 && geometry.pendingHeight > 0)
      assert(geometry.barWidth > 0 && geometry.barWidth <= geometry.pendingWidth)
      assert(geometry.bubbleWidth <= geometry.rowWidth * 0.8 + 1)
      assert(geometry.pendingLeft >= geometry.bubbleLeft && geometry.pendingRight <= geometry.bubbleRight + 1)
      assert(geometry.bubbleLeft >= geometry.rowLeft && geometry.bubbleRight <= geometry.rowRight + 1)
      assert(geometry.rowLeft >= 0 && geometry.rowRight <= geometry.viewport + 1)
      assert(geometry.scrollWidth <= geometry.clientWidth + 1, "Narrow user bubble must not overflow")
    }
    await page.setViewportSize({ width: 1280, height: 900 })
    console.log("PASS actual application CSS keeps user skeleton nonzero in shrink-to-fit desktop and narrow bubbles")
    const firstCalls = await page.evaluate("window.first.calls.filter(c=>c[0]==='mount'||c[0]==='render')") as string[][]
    assert.equal(firstCalls.filter(call => call[0] === "mount").length, 4)
    assert.equal(firstCalls.filter(call => call[0] === "render").length, 4)
    for (const [, owner] of firstCalls.filter(call => call[0] === "mount")) {
      assert(firstCalls.findIndex(call => call[0] === "render" && call[1] === owner) >
        firstCalls.findIndex(call => call[0] === "mount" && call[1] === owner))
    }
    await page.evaluate("window.first.release()")
    await page.getByText("SAFE 0", { exact: true }).waitFor()
    await page.waitForFunction("window.first.held()===4")
    assert.equal(await page.getByText("SAFE 0", { exact: true }).count(), 1)
    await page.evaluate("window.first.release()")
    await page.getByText("SAFE 7", { exact: true }).waitFor()
    for (let index = 0; index < 8; index++) {
      assert.equal(await page.getByText(`SAFE ${index}`, { exact: true }).count(), 1)
    }
    assert.equal(await page.getByText(/^SAFE \d+$/).count(), 8)
    assert.equal(await page.getByText(/RAW /).count(), 0)
    assert.equal(await page.locator("[data-function-site-pending]").count(), 0)
    console.log("PASS first four drawings complete before later mounts; all eight protected messages appear once")

    await page.evaluate("window.first.configure(false)")
    await page.getByRole("button", { name: "RAW 0", exact: true }).click()
    assert.equal(await page.evaluate("window.first.calls.filter(c=>c[0]==='native').length"), 1)
    await page.evaluate("const old=document.querySelector('[data-function-site] button');window.first.configure(true,true);old.click()")
    assert.equal(await page.evaluate("window.first.calls.filter(c=>c[0]==='native').length"), 1)
    assert.equal(await page.getByText(/RAW /).count(), 0)
    await page.evaluate("window.first.reject()")
    await page.getByRole("alert").first().waitFor()
    assert.equal(await page.getByText(/RAW /).count(), 0)
    await page.evaluate("window.first.resolve(false)")
    assert.equal(await page.getByText(/RAW /).count(), 0, "late inactive decision cannot replace current error")
    await page.evaluate("window.first.repair();window.first.configure(false)")
    await page.getByRole("button", { name: "RAW 7", exact: true }).waitFor()
    console.log("PASS inactive host decision renders native content directly; revocation, failure and late results remain guarded")
    // A revoked read retains its physical queue slot until it settles. Drain obsolete reads
    // before measuring the new decoration requests, rather than counting their old gates.
    await page.evaluate("window.first.release()")
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
    const beforeOptionalRenders = await page.evaluate(
      "window.first.calls.filter(call=>call[0]==='render').length"
    ) as number
    await page.evaluate("window.first.configure(true,true);window.first.showOptional()")
    await page.waitForFunction("document.querySelectorAll('[data-function-site]').length===4")
    assert.equal(await page.locator("[data-function-site-pending]").count(), 0)
    assert.equal(await page.getByRole("status").count(), 0)
    await page.evaluate("window.first.resolve(true)")
    await page.waitForFunction("window.first.held()===3")
    const decorationReads = await page.evaluate(
      `window.first.calls.filter(call=>call[0]==='render').slice(${beforeOptionalRenders}).map(call=>call[2])`
    ) as string[]
    assert.equal(decorationReads.length, 3, "Count actual new decoration reads, not revoked old gates")
    assert(decorationReads.every(component => ["AbovePrompt", "PromptHint", "SessionMode", "Spinner"].includes(component)))
    assert.equal(await page.locator("[data-function-site-pending]").count(), 0)
    assert.equal(await page.getByRole("status").count(), 0)
    console.log("PASS optional input decorations introduce no pending bars or loading text while capability and drawings load")
    await page.evaluate("window.first.showMessage()")
    await page.waitForFunction("window.first.held()===4")
    assert.equal(await page.evaluate("window.first.calls.filter(call=>call[0]==='render').at(-1)[2]"),
      "AssistantMessage", "The fourth physical request must belong to the new transcript message")
    assert.equal(await page.locator('[data-function-site="AssistantMessage"]').count(), 1)
    assert.equal(await page.locator("[data-function-site-pending]").count(), 1)
    assert.equal(await page.getByText("RAW 99", { exact: true }).count(), 0)
    await page.evaluate("window.first.release()")
    await page.getByText("SAFE 99", { exact: true }).waitFor()
    await page.waitForFunction("window.first.held()>0")
    await page.evaluate("window.first.release()")
    assert.equal(await page.locator("[data-function-site-pending]").count(), 0)
    console.log("PASS three stalled optional decorations leave the fourth real FunctionSite slot available for a protected message")
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
