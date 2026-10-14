/** Real MessageBubble and tool detail continuity with controlled safe IPC receipts. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

const output = resolve(
  "output/sparks-remediation-20261010/message-recovery/tool-disclosure",
  "regression-" + Date.now()
)
async function fixture(page: Page, standalone = false) {
  await mount(
    page,
    `
    import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
    import {FunctionToolGroup} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionToolGroup.tsx"))};
    import {MessageBubble} from ${JSON.stringify(resolve("src/renderer/src/components/chat/MessageBubble.tsx"))};
    import {getWorkerToolUiKey} from ${JSON.stringify(resolve("src/renderer/src/lib/worker-tool-result-key.ts"))};
    import {ToolCallRenderer} from ${JSON.stringify(resolve("src/renderer/src/components/chat/ToolCallRenderer.tsx"))};
    {
    const cards=new Set(),configuration=new Set(),calls=[],owners=new Map();
    let next=0,revision=1,groupFailure='',remaining=0,groupDelay=0;
    window.electron={process:{platform:'win32'}};window.api.mods.cards=async()=>[];
    const baseTool={id:'exact-tool-id',name:'diagnostic_tool',args:{query:'RAW_PROTECTED_ARGUMENT'}};
    window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
    window.api.mods.onConfigurationChanged=fn=>{configuration.add(fn);return()=>configuration.delete(fn)};
    window.api.mods.siteMountOutcome=async(thread,component)=>{const owner='owner-'+(++next);owners.set(owner,{thread,component});calls.push(['mount',thread,component,owner]);return {state:'mounted',owner}};
    window.api.mods.siteUnmount=async(thread,owner)=>{calls.push(['unmount',thread,owner]);owners.delete(owner)};
    window.api.mods.siteRender=async(thread,owner,props)=>{const row=owners.get(owner);if(!row)throw Error('MODS_UI_SITE_CLOSED');calls.push(['render',thread,row.component,owner]);if(row.component==='ToolGroup'&&groupDelay)await new Promise(r=>setTimeout(r,groupDelay));if(row.component==='ToolGroup'&&remaining>0){remaining--;throw Error(groupFailure)};
      const safeOutput='HOST_SAFE_RESULT_'+thread+'_'+revision+' '+ 'x'.repeat(160)+' END_DETAIL';
      let safe=structuredClone(props);if(row.component==='ToolGroup')safe.calls=safe.calls.map(call=>({...call,input:{query:'HOST_SAFE_ARGUMENT'},output:safeOutput}));else {if('input' in safe)safe.input={query:'HOST_SAFE_ARGUMENT'};if('output' in safe)safe.output=safeOutput}
      return {key:'engine:'+owner,id:owner,plugin:'engine',title:row.component,generation:'g-'+revision,rows:12,closeOnEscape:false,tree:{type:'engine',ref:0},nativeContent:{component:row.component,entries:[{ref:0,props:safe}],nativeUnchanged:false}}};
    window.api.mods.siteAct=async()=>{calls.push(['act']);throw Error('UNEXPECTED_ACT')};
    function Fixture(){const [thread,setThread]=useState('A'),[outer,setOuter]=useState(false),[toolId,setToolId]=useState('exact-tool-id'),[messageId,setMessageId]=useState('actual-message');const tool={...baseTool,id:toolId};
      window.disclosure={calls,owners,outer:()=>outer,thread:setThread,tool:setToolId,message:setMessageId,emit:(code='',count=0)=>{revision++;groupFailure=code;remaining=count;groupDelay=80;for(const fn of cards)fn({threadId:thread})},unmount:()=>host.render(null)};
      const message={id:messageId,role:'assistant',content:'',tool_calls:[tool],created_at:new Date(1)};
      const toolResults=new Map([[getWorkerToolUiKey(message.id,tool.id,0),{content:'RAW_PROTECTED_RESULT'}]]);
      if(${standalone})return <ModsChatScope.Provider value={{threadId:thread,enabled:false,ready:true}}><ToolCallRenderer threadId={thread} toolCall={tool} result='STANDALONE_RESULT' status='completed' isStreaming={false}/></ModsChatScope.Provider>;
      return <ModsChatScope.Provider value={{threadId:thread,enabled:true,ready:true}}><MessageBubble message={message} threadId={thread} isStreaming={false} isLoading={false} showAssistantMeta={false} toolResults={toolResults}/></ModsChatScope.Provider>
    }
    host.render(<Fixture/>);
    }
  `,
    [
      browserWorkerPlugin(),
      {
        name: "actual-image-assets",
        setup(builder) {
          builder.initialOptions.loader = { ...builder.initialOptions.loader, ".png": "dataurl" }
        }
      }
    ]
  )
}
async function main() {
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = [],
    results: unknown[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  try {
    for (const failure of ["", "MODS_DEVELOPMENT_APPLYING"]) {
      await fixture(page)
      const outer = page.locator(
        '[data-function-site="ToolGroup"] > .contents > [data-function-request-id="exact-tool-id"]'
      )
      await outer.locator(":scope > div > button").first().click()
      await page
        .getByText(/HOST_SAFE_RESULT_A_1/)
        .first()
        .waitFor()
      const afterOuterOnly = {
        toolId: await outer.getAttribute("data-function-request-id"),
        summaryVisible: await page
          .getByText(/HOST_SAFE_RESULT_A_1/)
          .first()
          .isVisible(),
        rawResultLabel: await page.getByText("RAW RESULT", { exact: true }).count()
      }
      const row = outer.locator(':scope > div > [data-function-request-id="exact-tool-id"]')
      await row.locator(":scope > button").click()
      await row.locator('[data-function-site="ToolResult"] pre').waitFor()
      assert(
        (await row.locator('[data-function-site="ToolResult"] pre').textContent())?.includes(
          "END_DETAIL"
        )
      )
      assert.equal(await page.getByText("RAW_PROTECTED_RESULT", { exact: true }).count(), 0)
      const before = await page.evaluate(
        'window.disclosure.calls.filter(c=>c[0]==="render"&&c[2]==="ToolResult").length'
      )
      await page.evaluate(
        ({ failure }) => Reflect.get(window, "disclosure").emit(failure, failure ? 1 : 0),
        { failure }
      )
      await outer.waitFor()
      await page.waitForTimeout(600)
      const result = {
        failure,
        afterOuterOnly,
        outerExpanded: (await row.count()) === 1,
        rowCount: await row.count(),
        newSummaryVisible: await page
          .getByText(/HOST_SAFE_RESULT_A_2/)
          .first()
          .isVisible(),
        fullDetailVisible: await page.getByText(/END_DETAIL/).count(),
        rawResultLabel: await page.getByText("RAW RESULT", { exact: true }).count(),
        toolResultReadsBefore: before,
        toolResultReadsAfter: await page.evaluate(
          'window.disclosure.calls.filter(c=>c[0]==="render"&&c[2]==="ToolResult").length'
        ),
        calls: await page.evaluate("window.disclosure.calls")
      }
      assert.equal(result.outerExpanded, true)
      assert.equal(result.newSummaryVisible, true)
      assert.equal(result.fullDetailVisible, 1)
      assert.equal(result.rawResultLabel, 1)
      assert.equal(await row.locator(":scope > button").getAttribute("aria-expanded"), "true")
      assert.equal(
        await outer.locator(":scope > div > button").first().getAttribute("aria-expanded"),
        "true"
      )
      results.push(result)
      await row.locator(":scope > button").click()
      await page.evaluate("window.disclosure.emit()")
      await page.waitForTimeout(600)
      assert.equal(await row.locator(":scope > button").getAttribute("aria-expanded"), "false")
      assert.equal(await page.getByText("RAW RESULT", { exact: true }).count(), 0)
      await outer.locator(":scope > div > button").first().click()
      await outer.locator(":scope > div > button").first().click()
      assert.equal(await row.locator(":scope > button").getAttribute("aria-expanded"), "false")
      await row.locator(":scope > button").click()
      await row.locator('[data-function-site="ToolResult"] pre').waitFor()
      await outer.locator(":scope > div > button").first().click()
      await outer.locator(":scope > div > button").first().click()
      assert.equal(await row.locator(":scope > button").getAttribute("aria-expanded"), "true")
      await row.locator('[data-function-site="ToolResult"] pre').waitFor()
      writeFileSync(
        resolve(output, failure ? "after-transient-dom.html" : "after-refresh-dom.html"),
        await outer.evaluate((node) => node.outerHTML)
      )
      await page.screenshot({
        path: resolve(output, failure ? "after-transient.png" : "after-refresh.png")
      })
      await page.evaluate('window.disclosure.emit("MODS_SCOPE_CHANGED",999)')
      await page.getByRole("alert").waitFor()
      assert.equal(await page.getByText(/HOST_SAFE_RESULT_A_|RAW_PROTECTED_RESULT/).count(), 0)
      await page.evaluate('window.disclosure.thread("B")')
      await page.getByRole("alert").waitFor()
      assert.equal(await page.getByText(/HOST_SAFE_RESULT_A_|RAW_PROTECTED_RESULT/).count(), 0)
      await page.evaluate("window.disclosure.unmount()")
    }
    await fixture(page)
    let outer = page.locator(
      '[data-function-site="ToolGroup"] > .contents > [data-function-request-id="exact-tool-id"]'
    )
    await outer.locator(":scope > div > button").first().click()
    let inner = outer.locator(":scope > div > [data-function-request-id]")
    await inner.locator(":scope > button").click()
    await inner.locator('[data-function-site="ToolResult"] pre').waitFor()
    await page.evaluate('window.disclosure.tool("other-tool-id")')
    outer = page.locator(
      '[data-function-site="ToolGroup"] > .contents > [data-function-request-id="other-tool-id"]'
    )
    await outer.locator(":scope > div > button").first().click()
    inner = outer.locator(":scope > div > [data-function-request-id]")
    assert.equal(await inner.locator(":scope > button").getAttribute("aria-expanded"), "false")
    await inner.locator(":scope > button").click()
    await inner.locator('[data-function-site="ToolResult"] pre').waitFor()
    await page.evaluate('window.disclosure.thread("B")')
    await page
      .getByText(/HOST_SAFE_RESULT_B_1/)
      .first()
      .waitFor()
    assert.equal(await inner.locator(":scope > button").getAttribute("aria-expanded"), "false")
    assert.equal(await page.getByText("RAW RESULT", { exact: true }).count(), 0)
    await inner.locator(":scope > button").click()
    await inner.locator('[data-function-site="ToolResult"] pre').waitFor()
    await page.evaluate('window.disclosure.message("other-message")')
    await outer.locator(":scope > div > button").first().click()
    assert.equal(await inner.locator(":scope > button").getAttribute("aria-expanded"), "false")
    await page.evaluate("window.disclosure.unmount()")
    await fixture(page, true)
    const independent = page.locator('[data-function-request-id="exact-tool-id"] > button')
    assert.equal(await independent.getAttribute("aria-expanded"), "false")
    await independent.click()
    await page.getByText("RAW RESULT", { exact: true }).waitFor()
    assert.equal(await independent.getAttribute("aria-expanded"), "true")
    await independent.click()
    assert.equal(await independent.getAttribute("aria-expanded"), "false")
    assert.equal(await page.getByText("RAW RESULT", { exact: true }).count(), 0)
    results.push({
      identityIsolation: "tool/thread/message",
      uncontrolled: "open and close",
      controlledFalse: "retained",
      outerReopen: "retained"
    })
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "result.json"),
      JSON.stringify({ results, errors, scopeProtected: true }, null, 2)
    )
    console.log(JSON.stringify({ results, errors, output }))
  } finally {
    await browser.close()
  }
}
void main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
