/** Real React/FileViewer/submit hook with fake file and stream IPC; isolated Electron profile. */
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { _electron } from "playwright"

async function main() {
  const directory = await mkdtemp(join(tmpdir(), "file-preview-visual-edit-"))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: "tsx",
        contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {FileViewer} from './src/renderer/src/components/tabs/FileViewer';
import {useVisualEditSubmit} from './src/renderer/src/components/visual-edit/useVisualEditSubmit';
window.fixture={calls:[],results:{},state:{models:[{id:'fake',available:true}],threads:[
 {thread_id:'ordinary',metadata:{}},
 {thread_id:'requirement',metadata:{requirementSession:true}},
 {thread_id:'bot',metadata:{botId:'b',botHostId:'local'}},
 {thread_id:'partner',metadata:{cmb_devclaw_partner_task:{taskId:'t'}}}
],generateTitleForFirstMessage:()=>{}}};
window.api={agent:{isCoordinatorModeForced:async()=>false},threads:{mergeThreadValues:async()=>{}},workspace:{}};
const html='<html><body><main>PREVIEW_OK</main></body></html>';
const transport={readFilePreview:async()=>({success:true,content:html,contentBytes:html.length,size:html.length,
 modified_at:'now',offset:0,nextOffset:null,hasMore:false,hasPrevious:false,truncated:false,lineCount:1}),
 cancelFilePreview:async()=>{},releaseFilePreview:async()=>{}};
const context={threadId:'ordinary',targetKind:'html-preview',targetPath:'index.html',annotations:[
 {id:'A1',kind:'comment',pageX:1,pageY:1,text:'change',status:'pending',createdAt:1}]};
function Probe({id}){const {submitVisualFeedback}=useVisualEditSubmit(id);return <button data-probe={id}
 onClick={async()=>{window.fixture.results[id]=await submitVisualFeedback({...context,threadId:id})}}>probe {id}</button>}
function Viewer({id,policy}){return <section data-viewer={id}><FileViewer filePath='index.html' threadId={id}
 workspacePathKind='relative' transport={transport} cacheNamespace={id} previewMode='preview'
 htmlPreviewPolicy='workspace-scripted' visualEditPolicy={policy}/></section>}
createRoot(document.getElementById('root')).render(<><Viewer id='bot' policy='disabled'/>
 <Viewer id='ordinary' policy='thread-submit'/><Viewer id='requirement' policy='thread-submit'/>
 <Viewer id='missing'/>{['ordinary','requirement','bot','partner','missing'].map(id=><Probe key={id} id={id}/>)}</>);`
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      write: false,
      define: { "process.env.NODE_ENV": '"production"' },
      alias: { "@": resolve("src/renderer/src") },
      plugins: [
        {
          name: "isolated-thread-transport",
          setup(builder) {
            builder.onResolve({ filter: /^@\/lib\/(store|thread-context)$/ }, (args) => ({
              path: args.path,
              namespace: "fixture"
            }))
            builder.onResolve({ filter: /CodeViewer$/ }, () => ({
              path: "code",
              namespace: "fixture"
            }))
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
              loader: "js",
              resolveDir: process.cwd(),
              contents: args.path.endsWith("/store")
                ? `export function useAppStore(select){return select(window.fixture.state)};useAppStore.getState=()=>window.fixture.state;`
                : args.path.endsWith("/thread-context")
                  ? `export function useCurrentThread(){return {currentModel:'fake',approvalQueue:[],messages:[{id:'existing'}],workspacePath:'/fixture',appendMessage(){},clearError(){},clearFinishedWorkflowRun(){},setActiveTab(){},setActiveTurnStartTime(){},setError(){},setMessages(){}}}
export function useThreadStream(id){return {isLoading:false,stream:{submit:async()=>window.fixture.calls.push(id)}}}`
                  : `import React from 'react';export function CodeViewer({content}){return React.createElement('pre',null,content)}`
            }))
          }
        }
      ]
    })
    const html = join(directory, "index.html"),
      entry = join(directory, "main.cjs")
    await writeFile(
      html,
      '<meta charset="utf-8"><style>section{height:400px;width:800px;position:relative}</style><div id="root"></div>'
    )
    await writeFile(
      entry,
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1000,height:900});w.loadFile(${JSON.stringify(html)})});`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)("electron"),
      args: [entry],
      env
    })
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.waitForURL(/index\.html$/)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    for (const id of ["bot", "ordinary", "requirement", "missing"]) {
      const viewer = page.locator(`[data-viewer="${id}"]`)
      await viewer.frameLocator("iframe").getByText("PREVIEW_OK").waitFor()
      assert.equal(
        await viewer.getByRole("button", { name: "标注修改", exact: true }).count(),
        id === "ordinary" || id === "requirement" ? 1 : 0
      )
    }
    for (const id of ["ordinary", "requirement", "bot", "partner", "missing"]) {
      await page.locator(`[data-probe="${id}"]`).click()
      await page.waitForFunction((id) => id in (window as any).fixture.results, id)
    }
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls), [
      "ordinary",
      "requirement"
    ])
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.results), {
      ordinary: true,
      requirement: true,
      bot: false,
      partner: false,
      missing: false
    })
    // Persisted ownership can change after rendering; the callback must recheck before submit.
    await page.evaluate(() => {
      ;(window as any).fixture.state.threads[0].metadata = { botId: "new", botHostId: "local" }
    })
    await page.locator('[data-probe="ordinary"]').click()
    await page.waitForFunction(() => (window as any).fixture.results.ordinary === false)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls), [
      "ordinary",
      "requirement"
    ])
    assert.deepEqual(errors, [])
    console.log(
      "PASS: real FileViewer keeps Bot/default HTML preview without ordinary submit; ordinary/requirement visual edit remains; actual hook rejects Bot, Partner, missing and stale ownership."
    )
  } finally {
    await app?.close()
    await rm(directory, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
