/** Small renderer/native-transport fixture; no app, model, IDE or process is launched by a Mod. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { resolve, join } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output", `native-editor-browser-${randomUUID()}`)
  mkdirSync(output)
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.message))
    await page.setContent(
      '<div id="root"></div><style>body{margin:0}section{position:absolute;inset:40px 0 0;background:white;display:flex;flex-direction:column}pre{margin:0}mark{display:inline-block}button{margin:4px}</style>'
    )
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: "tsx",
        contents: `
      import React,{useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {NativeEditorIntentHost} from ${JSON.stringify(resolve("src/renderer/src/lib/native-editor-intent.tsx"))};
      const calls=[], listeners=new Set(), presenters=new Set(), offers=new Map();let late,resolveLate,hold=false,mounts=0,version=1,clock=Date.now();Date.now=()=>clock;
      window.api={windowPresentation:{read:async()=>({version,presentable:true}),onChanged:fn=>{presenters.add(fn);return()=>presenters.delete(fn)}}};
      const base={id:'one',threadId:'thread',workspace:'C:/owned',scopeKey:'birth',path:'safe.html',line:120,column:3,expiresAt:Date.now()+30000,externalAvailable:true,source:{provider:'author',digest:'digest',generation:'one'}};
      const text=Array.from({length:160},(_,i)=>i===119?'abTARGET<script>window.BAD=true</script>':'line '+(i+1)).join('\\n');
      const api={onEditorNavigation:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
        editorNavigationAccept:async id=>{calls.push(['accept',id]);if(hold)await new Promise(r=>resolveLate=r);return {...(offers.get(id)||base),id,text,fingerprint:'sha'}},
        editorNavigationAck:async ack=>{calls.push(['ack',ack])},
        editorNavigationClose:async id=>{calls.push(['close',id])},
        editorNavigationLaunchExternal:async id=>{calls.push(['external',id]);return {status:'external-launch-requested',display:'unknown'}}};
      window.fixture={calls,listenerCount:()=>listeners.size,advance:ms=>{clock+=ms},emit:(value={})=>{const intent={...base,expiresAt:Date.now()+30000,...value};offers.set(intent.id,intent);for(const fn of listeners)fn({kind:'offer',intent})},
        retire:id=>{for(const fn of listeners)fn({kind:'retire',id})},
        hold:()=>{hold=true},finish:()=>{hold=false;resolveLate?.()},mounts:()=>mounts,
        presentation:presentable=>{for(const fn of presenters)fn({version:++version,presentable})}};
      function Parent(){const [thread,setThread]=useState('thread'),[bridge,setBridge]=useState(api),[,redraw]=useState(0);window.fixture.switch=()=>setThread('other');window.fixture.redraw=()=>redraw(n=>n+1);window.fixture.bridge=missing=>setBridge(missing==='all'?{}:missing?{...api,[missing]:undefined}:api);
        React.useEffect(()=>{mounts++},[]);
        return <><textarea aria-label="原草稿" defaultValue="保留草稿"/><NativeEditorIntentHost threadId={thread} workspace="C:/owned" scopeKey={thread==='thread'?'birth':'other-birth'} active api={bridge}/></>}
      createRoot(document.getElementById('root')).render(<Parent/>);
    `
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      alias: { "@": resolve("src/renderer/src") },
      plugins: [
        {
          name: "no-highlight-worker-for-source-target",
          setup(builder) {
            builder.onResolve({ filter: /\?worker$/ }, () => ({
              path: "unused",
              namespace: "test-worker"
            }))
            builder.onLoad({ filter: /.*/, namespace: "test-worker" }, () => ({
              contents:
                'export default class { constructor(){throw Error("SOURCE_TARGET_MUST_NOT_HIGHLIGHT")} }'
            }))
          }
        }
      ],
      define: { "process.env.NODE_ENV": '"test"', "import.meta.hot": "undefined" }
    })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByRole("textbox", { name: "原草稿" }).waitFor()
    const fixture = (script: string) => page.evaluate(script)
    await fixture("window.fixture.emit({scopeKey:'stale'})")
    assert.equal(await page.locator("[data-native-editor-source]").count(), 0)
    await fixture("window.fixture.emit()")
    const mark = page.locator("[data-native-editor-column='3']")
    await mark.waitFor()
    await page.waitForFunction(() =>
      (window as unknown as { fixture: { calls: unknown[][] } }).fixture.calls.some(
        (row) => row[0] === "ack"
      )
    )
    assert.equal(await mark.innerText(), "T")
    assert(await mark.isVisible())
    assert.equal(await fixture("window.BAD === undefined"), true)
    assert.equal(await page.locator("[data-native-editor-source] script").count(), 0)
    assert.equal(await page.getByRole("textbox", { name: "原草稿" }).inputValue(), "保留草稿")
    await page.getByText("已加载源文件快照（非实时）", { exact: false }).waitFor()
    await fixture("window.fixture.advance(31000);window.fixture.redraw()")
    assert(await mark.isVisible(), "LOADED_SNAPSHOT_MUST_SURVIVE_31S")
    await fixture("window.fixture.advance(-31000)")
    await page.screenshot({ path: join(output, "safe-source-target.png") })
    await page.getByRole("button", { name: "在已配置的 IDE 打开" }).click()
    await page.getByRole("status").filter({ hasText: "外部窗口及定位状态未知" }).waitFor()
    assert.equal(await fixture("window.fixture.calls.filter(row=>row[0]==='external').length"), 1)
    assert(await page.getByRole("button", { name: "在已配置的 IDE 打开" }).isDisabled())
    await fixture("window.fixture.retire('one')")
    assert.equal(await page.locator("[data-native-editor-source]").count(), 0)
    await fixture("window.fixture.emit({id:'visibility'})")
    await page.locator("[data-native-editor-intent='visibility']").waitFor()
    await fixture("window.fixture.presentation(false)")
    await page.waitForFunction(() => !document.querySelector("[data-native-editor-source]"))
    await fixture("window.fixture.presentation(true)")
    assert.equal(await page.locator("[data-native-editor-source]").count(), 0)
    await fixture("window.fixture.hold();window.fixture.emit({id:'late'})")
    await page.waitForFunction(() =>
      (window as unknown as { fixture: { calls: unknown[][] } }).fixture.calls.some(
        (row) => row[0] === "accept" && row[1] === "late"
      )
    )
    await fixture("window.fixture.retire('late');window.fixture.finish()")
    await page.waitForFunction(() =>
      (window as unknown as { fixture: { calls: unknown[][] } }).fixture.calls.some(
        (row) => row[0] === "close" && row[1] === "late"
      )
    )
    assert.equal(await page.locator("[data-native-editor-source]").count(), 0)
    const originalDraft = await page.getByRole("textbox", { name: "原草稿" }).elementHandle()
    assert(originalDraft)
    await page
      .getByRole("textbox", { name: "原草稿" })
      .evaluate((node) => (node as HTMLTextAreaElement).setSelectionRange(1, 3))
    for (const missing of [
      "all",
      "onEditorNavigation",
      "editorNavigationAccept",
      "editorNavigationAck",
      "editorNavigationClose",
      "editorNavigationLaunchExternal"
    ]) {
      await fixture(`window.fixture.bridge(${JSON.stringify(missing)})`)
      await page.waitForFunction(
        () =>
          (
            window as unknown as { fixture: { listenerCount(): number } }
          ).fixture.listenerCount() === 0
      )
      const before = await fixture("window.fixture.calls.length")
      await fixture("window.fixture.emit({id:'unsupported'})")
      assert.equal(await fixture("window.fixture.calls.length"), before)
      assert.equal(await page.locator("[data-native-editor-source]").count(), 0)
    }
    await fixture("window.fixture.bridge(null)")
    await page.waitForFunction(
      () =>
        (window as unknown as { fixture: { listenerCount(): number } }).fixture.listenerCount() ===
        1
    )
    await fixture("window.fixture.emit({id:'restored'})")
    await page.locator("[data-native-editor-intent='restored']").waitFor()
    await fixture("window.fixture.bridge('all')")
    await page.waitForFunction(
      () =>
        (window as unknown as { fixture: { listenerCount(): number } }).fixture.listenerCount() ===
        0
    )
    assert.equal(await page.locator("[data-native-editor-source]").count(), 0)
    assert(
      await originalDraft.evaluate(
        (node) => node === document.querySelector('textarea[aria-label="原草稿"]')
      )
    )
    assert.deepEqual(
      await originalDraft.evaluate((node) => ({
        start: (node as HTMLTextAreaElement).selectionStart,
        end: (node as HTMLTextAreaElement).selectionEnd
      })),
      { start: 1, end: 3 }
    )
    await originalDraft.dispose()
    await fixture("window.fixture.bridge(null)")
    await page.waitForFunction(
      () =>
        (window as unknown as { fixture: { listenerCount(): number } }).fixture.listenerCount() ===
        1
    )
    await fixture("window.fixture.switch();window.fixture.emit()")
    assert.equal(await page.locator("[data-native-editor-source]").count(), 0)
    assert.equal(await fixture("window.fixture.mounts()"), 1)
    assert.equal(await page.getByRole("textbox", { name: "原草稿" }).inputValue(), "保留草稿")
    assert.deepEqual(pageErrors, [])
    console.log(
      JSON.stringify({
        passed: true,
        checks: [
          "real-target-ack",
          "html-as-text",
          "external-intent-only",
          "retire",
          "late-accept",
          "scope-switch",
          "window-presentation",
          "draft-preserved",
          "loaded-over-31s",
          "missing-five-bridge",
          "bridge-false-true-false"
        ],
        output
      })
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
