/** Real overlay/listeners/drawer/Markdown/preview. Unrelated RightPanel work tabs are a slot spy. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Plugin } from "esbuild"
import { chromium, type Page } from "playwright"
import { mount } from "./mods-flow-browser.spec"

const file = (path: string) => JSON.stringify(resolve("src/renderer/src", path))
const panelSlot: Plugin = {
  name: "unrelated-right-panel-tabs-slot-spy",
  setup(builder) {
    builder.onLoad({ filter: /[\\/]components[\\/]panels[\\/]RightPanel\.tsx$/ }, () => ({
      loader: "tsx",
      contents: `import {ProtectedFunctionPreview} from ${file("components/panels/ProtectedFunctionPreview.tsx")};
        export function RightPanel(props){
          const request=props.protectedFunctionPreviewRequest;
          return <section data-panel-slot-spy>
            {request&&<ProtectedFunctionPreview request={request} onClose={props.onProtectedFunctionPreviewClosed}/>}
            {props.resourcePreviewRequest&&<p data-old-preview-route>{props.resourcePreviewRequest.filePath}</p>}
          </section>
        }`
    }))
  }
}

async function fixture(page: Page, module = "claw", collapsed = false, focused = false) {
  await mount(page, `
    import {createPortal} from "react-dom";
    import {ResourcePanelOverlay} from ${file("components/panels/ResourcePanelOverlay.tsx")};
    import {FunctionMarkdown} from ${file("components/chat/FunctionMarkdown.tsx")};
    import {useClawSidebarHost} from ${file("lib/claw-sidebar.ts")};
    import {emitOpenResourcePreview} from ${file("lib/resource-preview-events.ts")};
    import {openResourcePanelOverlay} from ${file("lib/resource-panel-overlay-events.ts")};
    {
      const facts=[],invalidated=new Set();let ready=false,sourceMounts=0,sourceUnmounts=0;
      const address={kind:'pane',pane:'actual-live-pane',generation:'g1'};
      window.electron={process:{platform:'win32'}};
      window.api.browser={onPanelRequest:()=>()=>{},setBounds:async()=>{},disposeAllForRendererUnload:()=>{}};
      window.api.workspace={readFile:async()=>{facts.push(['FORBIDDEN_RAW_READ']);throw Error('No raw reader')}};
      window.api.mods.markdownLink=async(threadId,action)=>{
        facts.push(['link',threadId,structuredClone(action)]);
        return {state:'preview',preview:{receipt:'actual-native-receipt',title:'RAW_EVENT_TITLE',text:'RAW_EVENT_TEXT'}};
      };
      window.api.mods.markdownPreview=async(threadId,receipt)=>{
        facts.push(['snapshot',threadId,receipt]);
        return {receipt,title:'Native protected title',text:'SAFE_NATIVE_OVERLAY_SNAPSHOT'};
      };
      window.api.mods.markdownPreviewClose=async(threadId,receipt)=>facts.push(['close',threadId,receipt]);
      window.api.mods.onMarkdownPreviewInvalidated=fn=>{invalidated.add(fn);return()=>invalidated.delete(fn)};
      useAppStore.getState().setRightModule(${JSON.stringify(module)});
      useAppStore.getState().setRightPanelCollapsed(${JSON.stringify(collapsed)});
      function Source(){
        useEffect(()=>{sourceMounts++;return()=>sourceUnmounts++},[]);
        return <FunctionMarkdown props={{text:'[Workspace report](file:///C:/workspace/report.md)'}}
          context={{threadId:'thread',address,links:[{nodePath:[],nonce:'actual-native-nonce'}]}} nodePath={[]}/>;
      }
      function PortalSource(){const target=useClawSidebarHost('thread');return target?createPortal(<Source/>,target):null}
      function Fixture(){
        const [focus,setFocus]=useState(${JSON.stringify(focused)}),[thread,setThread]=useState('thread');
        window.overlayFixture={ready:()=>ready,facts,focus:setFocus,thread:setThread,
          manual:mode=>openResourcePanelOverlay(mode),
          source:()=>({mounts:sourceMounts,unmounts:sourceUnmounts}),
          old:()=>emitOpenResourcePreview({threadId:'thread',filePath:'C:/workspace/old.txt'}),
          invalidate:()=>{for(const fn of invalidated)fn({threadId:'thread',receipt:'actual-native-receipt'})}};
        useEffect(()=>{ready=true;return()=>{ready=false}},[]);
        return <main><ClawSidebarHost threadId='thread'/><PortalSource/>
          <ResourcePanelOverlay isAgentFocusActive={focus} renderedMainView='thread' renderedPanelThreadId={thread}/>
        </main>;
      }
      host.render(<Fixture/>);
    }
  `, [panelSlot])
  await page.waitForFunction("window.overlayFixture?.ready()&&window.overlayFixture.source().mounts===1")
}

async function main() {
  mkdirSync(resolve("output"), { recursive: true })
  const output = mkdtempSync(resolve("output/mods-protected-preview-overlay-browser-"))
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const checks: string[] = [], errors: string[] = []
  let failure = ""
  page.on("pageerror", (error) => errors.push(error.message))
  page.setDefaultTimeout(10000)
  const pass = (label: string) => { checks.push(label); console.log("PASS " + label) }
  try {
    await fixture(page)
    await page.getByRole("link", { name: "Workspace report", exact: true }).click()
    await page.getByText("SAFE_NATIVE_OVERLAY_SNAPSHOT", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate("window.overlayFixture.source()"), { mounts: 1, unmounts: 0 })
    assert.equal(await page.locator("[data-claw-sidebar-host]").count(), 1)
    assert.equal(await page.getByText("RAW_EVENT_TEXT", { exact: true }).count(), 0)
    assert.equal(await page.getByText("RAW_EVENT_TITLE", { exact: true }).count(), 0)
    await page.screenshot({ path: resolve(output, "claw-protected-preview.png"), fullPage: true })
    pass("expanded Claw has no standard RightPanel; real Markdown click reaches overlay/native snapshot while its original portal stays mounted")
    await page.evaluate("window.overlayFixture.invalidate()")
    await page.waitForFunction("!document.querySelector('[data-function-protected-preview-content]')")
    await page.waitForFunction("window.overlayFixture.facts.some(row=>row[0]==='close'&&row[2]==='actual-native-receipt')")
    await page.getByRole("dialog", { name: "文件预览", exact: true }).waitFor({ state: "detached" })
    assert.equal(await page.evaluate("window.overlayFixture.facts.some(row=>row[0]==='FORBIDDEN_RAW_READ')"), false)
    await page.getByRole("link", { name: "Workspace report", exact: true }).click()
    await page.getByText("SAFE_NATIVE_OVERLAY_SNAPSHOT", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate("window.overlayFixture.source()"), { mounts: 1, unmounts: 0 })
    pass("native invalidation closes its protected-only drawer, releases the receipt and leaves the original Claw link usable for another actual click")

    await fixture(page)
    await page.evaluate("window.overlayFixture.old()")
    await page.locator("[data-old-preview-route]").waitFor()
    assert.equal(await page.locator("[data-old-preview-route]").innerText(), "C:/workspace/old.txt")
    await page.evaluate("window.overlayFixture.invalidate()")
    assert(await page.getByRole("dialog", { name: "文件预览", exact: true }).isVisible())
    pass("existing resource-preview events use the same corrected Claw overlay route")

    await fixture(page)
    for (const [mode, title] of [["preview", "文件预览"], ["browser", "内置浏览器"], ["git", "Git 面板"]]) {
      await page.evaluate((value) => Reflect.get(window, "overlayFixture").manual(value), mode)
      await page.getByRole("dialog", { name: title, exact: true }).waitFor()
      await page.evaluate("window.overlayFixture.invalidate()")
      assert(await page.getByRole("dialog", { name: title, exact: true }).isVisible())
    }
    pass("explicit preview, browser and Git drawers remain open without a protected request")

    await fixture(page, "work")
    await page.getByRole("link", { name: "Workspace report", exact: true }).click()
    await page.waitForFunction("window.overlayFixture.facts.some(row=>row[0]==='link')")
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    assert.equal(await page.locator("[data-panel-slot-spy]").count(), 0)
    assert.equal(await page.evaluate("window.overlayFixture.facts.some(row=>row[0]==='snapshot')"), false)
    pass("expanded non-Claw standard panels leave overlay inactive and do not create a duplicate snapshot reader")

    for (const [collapsed, focused] of [[true, false], [false, true]]) {
      await fixture(page, "work", collapsed, focused)
      await page.getByRole("link", { name: "Workspace report", exact: true }).click()
      await page.getByText("SAFE_NATIVE_OVERLAY_SNAPSHOT", { exact: true }).waitFor()
      await page.evaluate("window.overlayFixture.thread('other-thread')")
      await page.waitForFunction("!document.querySelector('[data-function-protected-preview-content]')")
      await page.getByRole("dialog", { name: "文件预览", exact: true }).waitFor({ state: "detached" })
      pass(`${collapsed ? "collapsed sidebar" : "Agent focus"} retains the existing overlay route and thread changes clear the protected snapshot`)
    }
    assert.deepEqual(errors, [])
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error)
    await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true }).catch(() => {})
    throw error
  } finally {
    writeFileSync(resolve(output, "report.json"), JSON.stringify({ checks, errors, failure,
      scope: "Actual React ResourcePanelOverlay/OverlayDrawer/Markdown/preview with controlled IPC and an explicit unrelated RightPanel-tabs slot spy; does not prove Main file authorization or full App shell." }, null, 2))
    await browser.close()
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
