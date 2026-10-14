import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const renderer = resolve("src/renderer/src")
  const css = await compile(
    readFileSync(resolve(renderer, "index.css"), "utf8").replace(
      /^@import "@fontsource[^\n]+\n/gm,
      ""
    ),
    { base: renderer, onDependency: () => undefined }
  )
  const stylesheet = css.build(
    new Scanner({ sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }] }).scan()
  )
  const output = resolve("output/mods-pane-reveal-browser")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await mount(
      page,
      `
      import {FunctionPanes} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionPanes.tsx"))};
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      const rows={a:[],b:[]},paneListeners=new Set();let serial=0,renders=0;
      crypto.randomUUID??=()=>"pane-fixture-"+(++serial);
      useAppStore.getState().currentThreadId='a';useAppStore.getState().mainView='thread';
      const emitPane=id=>{for(const fn of paneListeners)fn({threadId:id})};
      const openPane=(id,focus)=>{const token='open-'+(++serial);rows[id]=[{key:'p:replay',id:'replay',plugin:'p',title:'Replay fixture',
        openRequestId:token,generation:'draw-'+serial,closeOnEscape:true,rows:4,
        ...(focus?{focusRequest:{id:'focus-'+serial,pending:true}}:{}),
        tree:{type:'Box',props:{},children:[{type:'Button',props:{key:'pane-action',label:'Pane action'},press:{plugin:'p',handle:1}}]}}];emitPane(id)};
      window.paneFixture={actions:[],acks:[],imperative:phase=>{rows.a[0].imperativeFocus={id:"hidden-focus",phase,pane:"p:replay",generation:rows.a[0].generation,plugin:"p",element:"pane-action"};emitPane("a")},refresh:()=>{if(rows.a[0])rows.a[0].generation='draw-refresh-'+(++serial);emitPane('a')},
        openFromComposer:()=>openPane('a',true),background:()=>openPane('b',true),
        otherView:()=>{useAppStore.getState().mainView='dashboard';openPane('a',true)},
        rendered:()=>renders};
      window.api.mods.panes=async id=>{renders++;return structuredClone(rows[id])};
      window.api.mods.onCardsChanged=fn=>{paneListeners.add(fn);return()=>paneListeners.delete(fn)};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.paneAct=async(id,action)=>{
        window.paneFixture.actions.push({id,...action});
        if(action.kind==='close'){rows[id]=[];emitPane(id);return {focused:false}};
        if(action.kind==='focus'&&action.value?.request){const row=rows[id][0];
          if(row?.focusRequest?.id===action.value.request)row.focusRequest.pending=false;
          return {focused:action.value.focused,target:{plugin:'p',element:'pane-action'}}};
        return {focused:false};
      };
      window.api.mods.focusAck=async(id,ack)=>{window.paneFixture.acks.push({id,...ack});delete rows[id][0].imperativeFocus};window.api.mods.scrollAck=async()=>{};
      function RevealFixture(){const flow=useChatFlow('a','a',true);const[enabled,setEnabled]=useState(true);window.paneFixture.scope=setEnabled;
        const visible=useAppStore(s=>s.rightModule==='claw'&&!s.rightPanelCollapsed);
        return <><button onClick={()=>openPane('a',true)}>Open focused pane</button>
          <button onClick={()=>openPane('a',false)}>Open unfocused pane</button>
          <textarea className='composer-textarea' aria-label='Composer'/>
          <div hidden={!visible} inert={!visible}><ClawSidebarHost threadId='a'/></div>
          <ClawSidebar threadId='a' flow={flow} disabled={false} onFollowUp={()=>{}}>
            <ModsChatScope.Provider value={{threadId:'a',enabled}}><FunctionPanes threadId='a'/></ModsChatScope.Provider>
          </ClawSidebar>
          <div hidden><ModsChatScope.Provider value={{threadId:'b',enabled:true}}><FunctionPanes threadId='b'/></ModsChatScope.Provider></div>
        </>}
      host.render(<RevealFixture/>);
    `,
      [browserWorkerPlugin()]
    )
    await page.addStyleTag({ content: stylesheet })
    await page.addScriptTag({ content: "window.__name = value => value" })
    const openFocused = page.getByRole("button", { name: "Open focused pane", exact: true })
    const pane = page.locator('[data-claw-sidebar-host="a"] [data-function-pane="replay"]')
    const paneAction = page.getByRole("button", { name: "Pane action", exact: true })
    await openFocused.click()
    await pane.waitFor({ state: "visible" })
    await page.waitForFunction("document.querySelector('[data-claw-results]')?.hidden === false")
    assert.equal(
      await page
        .getByRole("tab", { name: "运行过程", exact: true })
        .getAttribute("aria-pressed"),
      "true"
    )
    // Explicit button retains the existing no-focus-steal policy; tab navigation still reaches the pane.
    await openFocused.focus()
    let tabReached = false
    for (let index = 0; index < 20; index++) {
      await page.keyboard.press("Tab")
      if (await paneAction.evaluate((el) => document.activeElement === el)) {
        tabReached = true
        break
      }
    }
    assert(tabReached, "New pane must be keyboard reachable without another results-entry click")
    await page.getByRole("button", { name: "收起当前助手", exact: true }).click()
    await pane.waitFor({ state: "hidden" })
    const refreshCount = await page.evaluate("window.paneFixture.rendered()")
    await page.evaluate("window.paneFixture.refresh()")
    await page.waitForFunction(`window.paneFixture.rendered() > ${refreshCount}`)
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    assert.equal(
      await pane.isVisible(),
      false,
      "A new drawing generation must not reopen a collapsed pane"
    )
    await page.evaluate("window.paneFixture.scope(false)")
    await pane.waitFor({ state: "detached" })
    await page.evaluate("window.paneFixture.scope(true)")
    await pane.waitFor({ state: "attached" })
    assert.equal(
      await pane.isVisible(),
      false,
      "Scope remount must not replay an already consumed open"
    )
    for (const phase of ["probe", "apply"]) {
      await page.evaluate(`window.paneFixture.imperative(${JSON.stringify(phase)})`)
      await page.waitForFunction(
        `window.paneFixture.acks.some(ack => ack.phase === ${JSON.stringify(phase)} && ack.allowed === false)`,
        undefined,
        { timeout: 1500 }
      )
      assert.equal(
        await pane.isVisible(),
        false,
        "Hidden imperative focus must deny promptly without reopening"
      )
    }
    await page.getByRole("button", { name: "Open unfocused pane", exact: true }).click()
    await pane.waitFor({ state: "visible" })
    assert.equal(
      await page
        .getByRole("button", { name: "Open unfocused pane", exact: true })
        .evaluate((el) => document.activeElement === el),
      true
    )
    await page.getByRole("button", { name: "关闭 Replay fixture", exact: true }).click()
    await pane.waitFor({ state: "detached" })
    await openFocused.click()
    await pane.waitFor({ state: "visible" })
    await page.getByRole("button", { name: "收起当前助手", exact: true }).click()
    await page.getByRole("textbox", { name: "Composer", exact: true }).focus()
    await page.evaluate("window.paneFixture.openFromComposer()")
    await pane.waitFor({ state: "visible" })
    await page.waitForFunction(
      "document.activeElement?.getAttribute('data-function-control') === 'pane-action'"
    )
    await page.getByRole("button", { name: "收起当前助手", exact: true }).click()
    const backgroundCount = await page.evaluate("window.paneFixture.rendered()")
    await page.evaluate("window.paneFixture.background()")
    await page.waitForFunction(`window.paneFixture.rendered() > ${backgroundCount}`)
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    assert.equal(
      await pane.isVisible(),
      false,
      "Background thread must not reveal the foreground host"
    )
    const otherCount = await page.evaluate("window.paneFixture.rendered()")
    await page.evaluate("window.paneFixture.otherView()")
    await page.waitForFunction(`window.paneFixture.rendered() > ${otherCount}`)
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    assert.equal(
      await pane.isVisible(),
      false,
      "A retained thread must not reveal a different main view"
    )
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, "final.png"), fullPage: true })
    console.log(
      "Pane reveal: explicit opens, redraw/collapse, close/reopen, focus policy and thread/view scope passed"
    )
  } catch (error) {
    await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true }).catch(() => {})
    writeFileSync(
      resolve(output, "failure.json"),
      JSON.stringify(
        {
          error: String(error),
          errors,
          body: await page
            .locator("body")
            .innerText()
            .catch(() => ""),
          actions: await page.evaluate("window.paneFixture?.actions").catch(() => null)
        },
        null,
        2
      )
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
