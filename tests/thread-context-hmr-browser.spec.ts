/** Evaluate two generations of the actual production module with one retained Provider. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { createServer } from "node:http"
import { build } from "esbuild"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const root = resolve(".")
  const output = resolve("output/thread-context-hmr-20261011", `browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  // Reuse the established real-Provider fixture's finite IPC/store leaves only.
  const fixture = readFileSync(resolve("tests/mods-model-intent-provider-browser.spec.ts"), "utf8")
  const literal = (name: string) => {
    const match = fixture.match(new RegExp(`const ${name} = \x60([\\s\\S]*?)\x60`))
    assert(match, `Missing existing ${name} fixture`)
    return match[1]
  }
  const source = resolve("src/renderer/src/lib/thread-context.tsx")
  const errors: string[] = []
  const entry = `
    import React,{useState,useSyncExternalStore}from'react';import{createRoot}from'react-dom/client';
    import{ThreadProvider,useThreadContext as oldHook}from'context:old';
    import{ThreadProvider as NewProvider,useThreadContext as newHook}from'context:new';
    import{ThreadSidebar}from'@/components/sidebar/ThreadSidebar';
    function OldProbe(){oldHook();return <p>Original Provider ready</p>}
    function StateProbe({reverse=false}){const c=reverse?oldHook():newHook();
      const state=useSyncExternalStore(fn=>c.subscribeToThreadState('intent-a',fn),()=>c.getThreadState('intent-a'));
      window.hmrContexts??={};window.hmrContexts[reverse?'right':'left']=c;
      return <><p data-state={reverse?'right':'left'}>{state.error||'empty'}</p>
        {!reverse&&<button onClick={()=>c.getThreadActions('intent-a').setError('updated through new hook')}>Update context value</button>}</>}
    function UpdatedSidebar(){return <><ThreadSidebar/><p>Updated hook connected</p><StateProbe/></>}
    class Boundary extends React.Component{state={error:''};static getDerivedStateFromError(e){return{error:String(e)}}
      render(){return this.state.error?<p role='alert'>{this.state.error}</p>:this.props.children}}
    function Entry(){const[clicked,setClicked]=useState(false);return <><OldProbe/>
      <button onClick={()=>setClicked(true)}>Replay Theater</button>
      {clicked&&<Boundary><UpdatedSidebar/></Boundary>}</>}
    function Missing(){newHook();return null}
    function App(){const[missing,setMissing]=useState(false);return <>
      <ThreadProvider><Entry/></ThreadProvider>
      <NewProvider><Boundary><StateProbe reverse/></Boundary></NewProvider>
      <button onClick={()=>setMissing(true)}>Check missing Provider</button>
      {missing&&<Boundary><Missing/></Boundary>}</>}
    createRoot(document.getElementById('root')).render(<App/>);
  `
  const result = await build({
    stdin: { contents: entry, loader: "tsx", resolveDir: root },
    bundle: true,
    jsx: "automatic",
    write: false,
    platform: "browser",
    format: "iife",
    loader: { ".png": "dataurl", ".svg": "dataurl" },
    alias: { "@": resolve("src/renderer/src") },
    define: {
      "process.env.NODE_ENV": '"development"',
      "import.meta.env.DEV": "true",
      __APP_VERSION__: '"hmr-fixture"',
      "import.meta.hot": "window.__threadHot"
    },
    plugins: [
      {
        name: "production-context-generations",
        setup(builder) {
          builder.onResolve({ filter: /^context:(old|new)$/ }, (args) => ({
            path: args.path,
            namespace: "context-generation"
          }))
          builder.onResolve({ filter: /^@\/lib\/thread-context$/ }, () => ({
            path: "context:new",
            namespace: "context-generation"
          }))
          builder.onLoad({ filter: /.*/, namespace: "context-generation" }, () => ({
            contents: readFileSync(source, "utf8"),
            loader: "tsx",
            resolveDir: dirname(source)
          }))
          builder.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, (args) => {
            if (args.path === "./store" && !args.importer.replace(/\\/g, "/").includes("/lib/"))
              return
            return { path: "store", namespace: "fixture-store" }
          })
          builder.onLoad({ filter: /.*/, namespace: "fixture-store" }, () => ({
            contents:
              literal("storeModule") +
              `
          state.touchThreadSummaries=()=>{};state.mainView='chat';
          state.threadDirectoryHasMore=false;state.threadDirectoryLoadingMore=false;
          state.showCustomizeView=false;state.appUpdate={status:'idle'};
        `,
            loader: "js",
            resolveDir: root
          }))
        }
      },
      browserWorkerPlugin()
    ]
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const server = createServer((_request, response) => {
    response.end('<div id="root"></div>')
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.addScriptTag({
      content:
        literal("bootstrap") +
        `
      window.__threadHot={data:{},accept(){},dispose(){}};
      window.api.featureGates={isEnabled:async()=>({enabled:false})};
      window.api.update={getStatus:async()=>({status:'idle'}),getStartupResult:async()=>null,
        onAvailable:()=>()=>{},onDownloaded:()=>()=>{},onError:()=>()=>{},onProgress:()=>()=>{}};
      window.electron={ipcRenderer:{on:()=>()=>{},removeListener(){},invoke:async()=> 'hmr-fixture'}};
    `
    })
    await page.addScriptTag({ content: result.outputFiles[0].text })
    await page.getByText("Original Provider ready", { exact: true }).waitFor()
    assert.deepEqual(errors, [])
    await page.getByRole("button", { name: "Replay Theater", exact: true }).click()
    await page.waitForTimeout(150)
    const alerts = await page.getByRole("alert").allTextContents()
    writeFileSync(
      resolve(output, "result.json"),
      JSON.stringify(
        { alerts, errors, originalProviderMounted: true, productionModuleEvaluations: 2 },
        null,
        2
      )
    )
    assert.deepEqual(alerts, [], "New production hook/sidebar must read retained original Provider")
    await page.getByText("Updated hook connected", { exact: true }).waitFor()
    assert.deepEqual(errors, [])
    await page.getByRole("button", { name: "Update context value", exact: true }).click()
    await page
      .locator('[data-state="left"]')
      .filter({ hasText: "updated through new hook" })
      .waitFor()
    assert.equal(await page.locator('[data-state="right"]').textContent(), "empty")
    await page.getByRole("button", { name: "Check missing Provider", exact: true }).click()
    assert.match(
      await page.getByRole("alert").innerText(),
      /useThreadContext must be used within a ThreadProvider/
    )
    console.log(
      "PASS original production Provider serves updated hook and real ThreadSidebar after click"
    )
  } finally {
    await browser.close()
    server.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
