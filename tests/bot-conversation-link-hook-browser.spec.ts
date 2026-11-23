/** Hook ownership/race fixture. The full beta UI is tested separately by the App journey. */
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { _electron } from "playwright"
async function main() {
  const dir = await mkdtemp(join(tmpdir(), "m05-06-hook-"))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    const result = await build({
      stdin: {
        contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {useBotConversationLink} from './src/renderer/src/components/bots/use-bot-conversation-link';import {isManagedLocalWorkConversation} from './src/renderer/src/lib/thread-classification';
const state=window.fixture={calls:[],listeners:new Set(),held:[],active:new Map(),max:0};
window.api={bots:{conversations:{resolve:async(id)=>{state.calls.push(id);const active=(state.active.get(id)||0)+1;state.active.set(id,active);state.max=Math.max(state.max,active);try{if(id==='A')await new Promise(done=>state.held.push(done));return{bot:{id:'owner'},work:{id:'work-'+id},workspacePath:'/fixture'}}finally{state.active.set(id,state.active.get(id)-1)}}},subscribe:listener=>{state.listeners.add(listener);return()=>state.listeners.delete(listener)}}};
function Fixture(){const [id,setId]=useState('normal');const metadata=id==='A'||id==='B'?{botId:'owner',botHostId:'local',botWorkId:'work-'+id,botAudienceKey:'desktop'}:id==='project'?{harnessFeature:{projectId:'p',slug:'s'}}:id==='remote'?{targetKind:'inbox',imDeliveryContext:{},remoteReadOnly:true}:{};const value=useBotConversationLink(id,isManagedLocalWorkConversation({thread_id:id,metadata}));return <><nav>{['normal','project','remote','A','B'].map(key=><button key={key} onClick={()=>setId(key)}>{key}</button>)}</nav><output data-testid="state">{value.loading?'loading':value.error||value.value?.work.id||'ordinary usable'}</output></>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
        resolveDir: resolve("."),
        loader: "tsx"
      },
      bundle: true,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      write: false,
      define: { "process.env.NODE_ENV": '"production"' },
      alias: { "@": resolve("src/renderer/src") }
    })
    await writeFile(
      join(dir, "index.html"),
      '<meta charset="UTF-8"><div id="root"></div><script>' +
        result.outputFiles[0].text +
        "</script>"
    )
    await writeFile(
      join(dir, "main.cjs"),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(dir, "profile"))});app.whenReady().then(()=>new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}}).loadFile(${JSON.stringify(join(dir, "index.html"))}));`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)("electron"),
      args: [join(dir, "main.cjs")],
      env
    })
    const page = await app.firstWindow(),
      errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    const state = page.getByTestId("state")
    await state.getByText("ordinary usable").waitFor()
    for (const name of ["project", "remote", "normal"]) {
      await page.getByRole("button", { name, exact: true }).click()
      await state.getByText("ordinary usable").waitFor()
    }
    assert.equal(await page.evaluate(() => (window as any).fixture.calls.length), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.listeners.size), 0)
    await page.getByRole("button", { name: "A", exact: true }).click()
    await state.getByText("loading").waitFor()
    await page.getByRole("button", { name: "normal", exact: true }).click()
    await state.getByText("ordinary usable").waitFor()
    await page.evaluate(() => (window as any).fixture.held.splice(0).forEach((done) => done()))
    await state.getByText("ordinary usable").waitFor()
    await page.getByRole("button", { name: "A", exact: true }).click()
    await state.getByText("loading").waitFor()
    await page.getByRole("button", { name: "B", exact: true }).click()
    await state.getByText("work-B").waitFor()
    await page.evaluate(() => (window as any).fixture.held.splice(0).forEach((done) => done()))
    await state.getByText("work-B").waitFor()
    assert.equal(await page.evaluate(() => (window as any).fixture.max), 1)
    assert.deepEqual(errors, [])
    console.log(
      "hook proof",
      JSON.stringify(
        await page.evaluate(() => ({
          calls: (window as any).fixture.calls,
          maxPerScope: (window as any).fixture.max
        }))
      )
    )
  } finally {
    if (app) await app.close()
    await rm(dir, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
