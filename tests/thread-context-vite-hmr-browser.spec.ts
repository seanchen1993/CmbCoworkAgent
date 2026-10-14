/** Actual Vite hot.data lifecycle with real production Provider, hook and sidebar. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createServer as createPortReservation } from "node:net"
import { createServer, transformWithEsbuild } from "vite"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output/thread-context-hmr-20261011", `vite-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const negative = process.argv.includes("--without-context-cache")
  const fixtures = readFileSync("tests/mods-model-intent-provider-browser.spec.ts", "utf8")
  const literal = (name: string) => {
    const match = fixtures.match(new RegExp(`const ${name} = \x60([\\s\\S]*?)\x60`))
    assert(match)
    return match[1]
  }
  const contextPath = resolve("src/renderer/src/lib/thread-context.tsx").replace(/\\/g, "/")
  const bootstrap =
    literal("bootstrap") +
    `
    window.api.featureGates={isEnabled:async()=>({enabled:false})};
    window.api.update={getStatus:async()=>({status:'idle'}),getStartupResult:async()=>null,
      onAvailable:()=>()=>{},onDownloaded:()=>()=>{},onError:()=>()=>{},onProgress:()=>()=>{}};
    window.electron={ipcRenderer:{on:()=>()=>{},removeListener(){},invoke:async()=> 'hmr-fixture'}};
    window.hmrPageIdentity=Math.random();window.hmrGeneration=0;window.hmrStacks=[];window.hmrLifecycle=[];
  `
  let generation = 0
  const reservation = createPortReservation()
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done))
  const reserved = reservation.address()
  assert(reserved && typeof reserved !== "string" && reserved.port !== 5173)
  await new Promise<void>((done, reject) =>
    reservation.close((error) => (error ? reject(error) : done()))
  )
  const entry = `
    import React,{useState}from'react';import{createRoot}from'react-dom/client';
    import*as original from'@/lib/thread-context';import{ThreadSidebar}from'@/components/sidebar/ThreadSidebar';
    const RetainedProvider=original.ThreadProvider;
    window.hmrNext=original;
    import.meta.hot.on('vite:beforeUpdate',()=>window.hmrLifecycle.push('beforeUpdate'));
    import.meta.hot.on('vite:afterUpdate',()=>window.hmrLifecycle.push('afterUpdate'));
    class Boundary extends React.Component{state={error:''};static getDerivedStateFromError(e){return{error:String(e)}}
      componentDidCatch(e,info){window.hmrStacks.push(info.componentStack)}
      render(){return this.state.error?<p role='alert'>{this.state.error}</p>:this.props.children}}
    function Before(){const c=original.useThreadContext();window.hmrReadOld=()=>c.getThreadState('intent-a').error;
      return <p>Original Provider ready</p>}
    function NewHook(){const c=window.hmrNext.useThreadContext();
      window.hmrWriteNew=value=>c.getThreadActions('intent-a').setError(value);
      return <p>Fresh hook connected</p>}
    function Forward(){const[show,setShow]=useState(0);return <><Before/>
      <button onClick={()=>setShow(v=>v+1)}>Replay Theater</button>
      {show&&<Boundary><NewHook/></Boundary>}</>}
    function Reverse(){const[show,setShow]=useState(0);const NewProvider=window.hmrNext.ThreadProvider;
      return <><button onClick={()=>setShow(v=>v+1)}>Open updated Sidebar</button>
      {show&&<Boundary><NewProvider><ThreadSidebar/><p>Actual Sidebar connected</p></NewProvider></Boundary>}</>}
    createRoot(document.getElementById('root')).render(<><RetainedProvider><Forward/></RetainedProvider><Reverse/></>);
  `
  console.log("Creating isolated Vite")
  const server = await createServer({
    configFile: false,
    cacheDir: resolve(output, "vite-cache"),
    root: resolve("."),
    server: { host: "127.0.0.1", port: reserved.port, strictPort: true, watch: null },
    resolve: { alias: { "@": resolve("src/renderer/src") } },
    define: { __APP_VERSION__: JSON.stringify("hmr-fixture") },
    esbuild: { jsx: "automatic" },
    optimizeDeps: {
      entries: [contextPath, resolve("src/renderer/src/components/sidebar/ThreadSidebar.tsx")],
      include: ["react", "react-dom/client", "react/jsx-runtime", "camelcase"]
    },
    plugins: [
      {
        name: "isolated-production-hmr-fixture",
        enforce: "pre",
        resolveId(id, importer) {
          if (id === "/hmr-entry.tsx") return "\0hmr-entry.tsx"
          if (
            id === "@/lib/store" ||
            id.replace(/\\/g, "/").endsWith("/src/renderer/src/lib/store") ||
            (id === "./store" && importer?.replace(/\\/g, "/").includes("/src/renderer/src/lib/"))
          )
            return "\0hmr-store.js"
        },
        async load(id) {
          if (id === "\0hmr-entry.tsx")
            return transformWithEsbuild(entry, "hmr-entry.tsx", { loader: "tsx", jsx: "automatic" })
          if (id === "\0hmr-store.js")
            return (
              literal("storeModule") +
              `
          state.touchThreadSummaries=()=>{};state.mainView='chat';
          state.threadDirectoryHasMore=false;state.threadDirectoryLoadingMore=false;
          state.showCustomizeView=false;state.appUpdate={status:'idle'};
        `
            )
        },
        transform(code, id) {
          if (id.replace(/\\/g, "/").split("?")[0] !== contextPath) return
          if (negative) code = code.replace("import.meta.hot?.data.devclawThreadContext ?? ", "")
          return (
            code +
            `\nexport const fixtureGeneration=${generation};
          if(import.meta.hot)import.meta.hot.accept(next=>{
            window.hmrNext=next;window.hmrGeneration=next.fixtureGeneration;
          });`
          )
        },
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            if (request.url !== "/") return next()
            response.setHeader("Content-Type", "text/html")
            response.end(
              await vite.transformIndexHtml(
                "/",
                `<!doctype html><div id="root"></div>
            <script>${bootstrap}</script><script type="module" src="/hmr-entry.tsx"></script>`
              )
            )
          })
        }
      }
    ]
  })
  console.log("Starting isolated Vite")
  await server.listen()
  const address = server.httpServer?.address()
  assert(address && typeof address !== "string")
  console.log("Launching isolated browser")
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => {
    errors.push(error.message)
    console.error(error.message)
  })
  try {
    console.log("Vite fixture listening", address.port)
    await page.goto(`http://127.0.0.1:${address.port}/`)
    console.log("Vite fixture loaded")
    await page.getByText("Original Provider ready", { exact: true }).waitFor()
    const identity = await page.evaluate("window.hmrPageIdentity")
    const module = server.moduleGraph.getModuleById(contextPath)
    assert(module, "Actual production context must be in the Vite module graph")
    for (const round of [1, 2]) {
      generation++
      const timestamp = Date.now()
      server.moduleGraph.invalidateModule(module)
      server.ws.send({
        type: "update",
        updates: [{ type: "js-update", timestamp, path: module.url, acceptedPath: module.url }]
      })
      await page.waitForFunction(
        (round) => (window as unknown as { hmrGeneration: number }).hmrGeneration === round,
        round
      )
      assert.equal(await page.evaluate("window.hmrPageIdentity"), identity, "No full-page reload")
      await page.getByRole("button", { name: "Open updated Sidebar", exact: true }).click()
      if (negative) {
        const alert = await page.getByRole("alert").innerText()
        const stacks = await page.evaluate("window.hmrStacks")
        writeFileSync(
          resolve(output, "negative-control.json"),
          JSON.stringify({ alert, stacks, removedCacheReadOnlyInFixture: true }, null, 2)
        )
        assert.fail("Baseline negative control: " + alert)
      }
      await page.getByText("Actual Sidebar connected", { exact: true }).waitFor()
      await page.getByRole("button", { name: "Replay Theater", exact: true }).click()
      await page.getByText("Fresh hook connected", { exact: true }).waitFor()
      await page.evaluate(
        (round) =>
          (window as unknown as { hmrWriteNew(value: string): void }).hmrWriteNew(`round-${round}`),
        round
      )
      assert.equal(await page.evaluate("window.hmrReadOld()"), `round-${round}`)
    }
    const lifecycle = await page.evaluate("window.hmrLifecycle")
    assert.deepEqual(lifecycle, ["beforeUpdate", "afterUpdate", "beforeUpdate", "afterUpdate"])
    assert.deepEqual(await page.getByRole("alert").allTextContents(), [])
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "result.json"),
      JSON.stringify(
        {
          passed: true,
          actualViteHmr: true,
          fullReload: false,
          rounds: 2,
          lifecycle,
          boundary:
            "fixture self-accept preserves old consumer closures; not the full App default refresh graph",
          errors
        },
        null,
        2
      )
    )
    console.log(
      "PASS actual Vite HMR retains production context across both Provider/hook generations"
    )
  } catch (error) {
    console.error("Vite fixture failure", error)
    throw error
  } finally {
    await browser.close()
    await server.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
