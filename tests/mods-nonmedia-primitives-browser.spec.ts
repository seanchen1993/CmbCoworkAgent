import assert from "node:assert/strict"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const artifacts = mkdtempSync(join(tmpdir(), "mods-nonmedia-primitives-"))
  try {
    await mount(
      page,
      `
      import {Element,FunctionPanes} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionPanes.tsx"))};
      import {FunctionClient} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionClient.tsx"))};
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {ClawResultsVisibility} from ${JSON.stringify(resolve("src/renderer/src/lib/claw-sidebar.ts"))};
      import {validateFunctionTree} from ${JSON.stringify(resolve("src/shared/mods/v2/ui.ts"))};
      let uuid=0;crypto.randomUUID??=()=>"00000000-0000-4000-8000-"+String(++uuid).padStart(12,'0');
      const press={plugin:'generic',handle:1};
      const tree={type:'Box',props:{key:'scope',flexDirection:'column',gap:1,width:'100%'},children:[
        {type:'Text',props:{hover:{color:'#cc0000'}},children:['Hover marker']},
        {type:'Text',props:{dir:'rtl'},children:['ABC שלום']},
        {type:'Text',props:{wrap:'truncate-middle',mono:true},children:['ROOT/😀é/very-long-directory/document-tail.json']},
        {type:'Box',props:{display:'none',hover:{display:'flex'}},children:[{type:'Text',props:{},children:['Revealed content']}]},
        {type:'Box',props:{key:'nested'},children:[{type:'Text',props:{hover:{color:'#0000cc'}},children:['Nested marker']}]},
        {type:'Button',props:{key:'styled',label:'Styled button',variant:'primary',role:'dismiss'},press,
          children:[{type:'Text',props:{bold:true},children:['Styled']},' button']},
        {type:'Input',props:{key:'notes',label:'Notes',rows:3},press:{plugin:'generic',handle:2}}
      ]};
      validateFunctionTree(tree);
      window.primitiveFixture={actions:[],measurements:[],clientActions:[],copies:[]};
      window.api.mods.clientAct=async(id,action)=>{window.primitiveFixture.clientActions.push(action)};
      const clientTree={type:'Input',props:{key:'client-notes',label:'Client notes',rows:3},press:{plugin:'generic',handle:3}};
      const pane={key:'generic:probe',id:'probe',plugin:'generic',title:'Measured pane',
        openRequestId:'native-open',generation:'00000000-0000-4000-8000-000000000000',rows:8,
        columns:20,backgroundColor:'#123456',closeOnEscape:false,
        tree:{type:'Text',props:{},children:['Measured content']}};
      window.api.mods.panes=async()=>[structuredClone(pane)];
      window.api.mods.onCardsChanged=()=>()=>{};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.paneAct=async(id,action)=>{window.primitiveFixture.measurements.push(action)};
      window.api.mods.scrollAck=async()=>{};
      useAppStore.getState().currentThreadId='a';useAppStore.getState().mainView='thread';
      host.render(<main style={{padding:24,font:'16px monospace'}}>
        <button id='host-action' onClick={()=>window.primitiveFixture.actions.push({kind:'host'})}>Host control</button>
        <section id='primitives' style={{width:240,contain:'layout paint',position:'relative'}}>
          <Element node={tree} busy={false} act={async(node,kind,value)=>window.primitiveFixture.actions.push({kind,key:node.props.key,value})}/>
        </section>
        <FunctionClient threadId='a' pane='generic:probe' node={{type:'Client',props:{key:'notes',module:'notes.ts'},client:{plugin:'generic'}}}
          snapshot={{id:'notes',generation:'client-generation',plugin:'generic',element:'notes',module:'notes.ts',tree:clientTree}}
          refresh={()=>{}} render={(tree,busy,act)=><Element node={tree} busy={busy} act={act}/>}/>
        <ModsChatScope.Provider value={{threadId:'a',enabled:true}}>
          <ClawResultsVisibility.Provider value={true}><FunctionPanes threadId='a'/></ClawResultsVisibility.Provider>
        </ModsChatScope.Provider>
      </main>);
    `,
      [browserWorkerPlugin()]
    )
    await page.addScriptTag({ content: "window.__name = value => value" })
    const notes = page.getByRole("textbox", { name: "Notes", exact: true })
    assert.equal(await notes.evaluate((node) => node.tagName), "TEXTAREA")
    assert.equal(await notes.getAttribute("rows"), "3")
    await notes.evaluate((node) => {
      node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        node,
        "中文"
      )
      node.dispatchEvent(new InputEvent("input", { bubbles: true, data: "文", isComposing: true }))
      node.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter", isComposing: true })
      )
    })
    assert.equal(await page.evaluate("window.primitiveFixture.actions.length"), 0)
    await notes.evaluate((node) =>
      node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文" }))
    )
    await page.waitForFunction(
      "window.primitiveFixture.actions.filter(a=>a.kind==='change').length===1"
    )
    await notes.fill("line one\nline two")
    await notes.press("Enter")
    await page.waitForFunction(
      "window.primitiveFixture.actions.some(a=>a.kind==='submit'&&a.value==='line one\\nline two')"
    )
    await page.getByRole("button", { name: "Styled button", exact: true }).click()
    assert.equal(await page.locator("[data-function-dismiss]").count(), 1)
    await page.getByText("Hover marker", { exact: true }).hover()
    assert.equal(
      await page
        .getByText("Hover marker", { exact: true })
        .evaluate((node) => getComputedStyle(node).color),
      "rgb(204, 0, 0)"
    )
    assert.equal(await page.getByText("Revealed content", { exact: true }).isVisible(), true)
    assert.notEqual(
      await page
        .getByText("Nested marker", { exact: true })
        .evaluate((node) => getComputedStyle(node).color),
      "rgb(0, 0, 204)"
    )
    await page.getByText("Nested marker", { exact: true }).hover()
    assert.equal(
      await page
        .getByText("Nested marker", { exact: true })
        .evaluate((node) => getComputedStyle(node).color),
      "rgb(0, 0, 204)"
    )
    assert.equal(
      await page
        .getByText("ABC שלום", { exact: true })
        .evaluate((node) => getComputedStyle(node).direction),
      "rtl"
    )
    const visible = page.locator("[data-function-text-visible]")
    await page.waitForFunction(
      "document.querySelector('[data-function-text-visible]')?.textContent?.includes('…')"
    )
    const first = (await visible.textContent())!
    assert(first.startsWith("ROOT/") && first.endsWith("tail.json"), first)
    assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(first))
    const original = "ROOT/😀é/very-long-directory/document-tail.json"
    assert((await page.locator("[data-function-text-truncate]").ariaSnapshot()).includes(original))
    await page.evaluate(() => {
      document.addEventListener("copy", (event) => {
        const copy = event as ClipboardEvent
        ;(
          window as unknown as { primitiveFixture: { copies: unknown[] } }
        ).primitiveFixture.copies.push({
          text: copy.clipboardData?.getData("text/plain"),
          prevented: event.defaultPrevented,
          trusted: event.isTrusted
        })
      })
    })
    for (const selector of ["[data-function-text-visible]", "[data-function-text-truncate]"]) {
      await page.evaluate((selector) => {
        const range = document.createRange()
        range.selectNodeContents(document.querySelector(selector)!)
        window.getSelection()!.removeAllRanges()
        window.getSelection()!.addRange(range)
      }, selector)
      await page.keyboard.press("Control+C")
      assert.deepEqual(await page.evaluate("window.primitiveFixture.copies.at(-1)"), {
        text: original,
        prevented: true,
        trusted: true
      })
    }
    await page.getByRole("textbox", { name: "Client notes", exact: true }).click()
    assert.equal(
      await page
        .getByRole("textbox", { name: "Client notes", exact: true })
        .evaluate((node) => document.activeElement === node),
      true
    )
    assert.equal(
      await page.evaluate(
        "window.primitiveFixture.clientActions.filter(a=>a.kind==='pointer'&&a.value.type==='down').length"
      ),
      0
    )
    await page.locator("#primitives").evaluate((node) => {
      ;(node as HTMLElement).style.width = "390px"
    })
    await page.waitForFunction(
      (length) =>
        (document.querySelector("[data-function-text-visible]")?.textContent?.length ?? 0) > length,
      first.length
    )
    await page.waitForFunction("window.primitiveFixture.measurements.some(a=>a.kind==='measure')")
    const measured = await page.evaluate(
      "window.primitiveFixture.measurements.filter(a=>a.kind==='measure').at(-1)"
    )
    assert(measured.value.bodyColumns >= 18 && measured.value.bodyColumns <= 21)
    assert.equal(measured.value.openRequestId, "native-open")
    assert.equal(
      await page
        .locator("[data-function-pane-body]")
        .evaluate((node) => getComputedStyle(node).backgroundColor),
      "rgb(18, 52, 86)"
    )
    await page.getByRole("button", { name: "Host control", exact: true }).click()
    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(artifacts, "primitives.png"), fullPage: true })
    writeFileSync(
      join(artifacts, "report.json"),
      JSON.stringify(
        {
          passed: true,
          errors,
          checks: [
            "rows/IME/submit",
            "styled button",
            "native scoped hover",
            "direction/middle truncate",
            "native Pane measurement/columns/background",
            "host control"
          ]
        },
        null,
        2
      )
    )
    console.log(`PASS nonmedia native primitives and Pane geometry; ${artifacts}`)
  } catch (error) {
    console.error("Browser diagnostics", errors, await page.locator("body").innerText())
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
