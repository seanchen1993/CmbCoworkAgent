import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
interface FixtureWindow extends Window {
  fixture: {
    reads(): number
    calls: unknown[]
    state(value: string): void
    settings(): unknown[]
    reset(): void
    hold(): void
    release(): void
    failDisconnect(): void
    holdDisconnect(): void
    releaseDisconnect(): void
    incarnation(): void
    account(): void
    workspace(): void
  }
}

async function main() {
  const root = process.cwd()
  const output = resolve("output/mods-mcp-connections-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import React from "react";import{createRoot}from"react-dom/client";
      import{McpConnectionStatus}from"./src/renderer/src/components/customize/McpConnectionStatus";
      import{McpPanel}from"./src/renderer/src/components/customize/McpPanel";
      import{useAppStore}from"@/lib/store";
      let reads=0,held=false,release,holdDisconnect=false,releaseDisconnect,failDisconnect=false;const calls=[];
      let connection={server:"devclaw-mcp:one",sourceId:"connector-one",configDigest:"digest",
        owner:"owner-one",component:"资料助手",state:"connecting",toolCount:0};
      const view=()=>({workspace:"c:/work",connections:connection?[{...connection}]:[]});
      window.api={mods:{mcpConnections:async()=>{reads++;const value=view();if(held){held=false;await new Promise(r=>release=r)}return value},
        mcpDisconnect:async(id,input)=>{calls.push(["disconnect",id,input]);if(failDisconnect){failDisconnect=false;throw Error("NETWORK_UNCONFIRMED")}const result={workspace:"c:/work",connections:[{...connection,state:"closed"}]};
          if(holdDisconnect){holdDisconnect=false;await new Promise(r=>releaseDisconnect=r)}else connection.state="closed";return result}},
        mcp:{list:async()=>[{id:"connector-one",name:"精确来源",url:"https://private.invalid",enabled:true},
          {id:"unrelated",name:"其他来源",url:"https://other.invalid",enabled:true}]}};
      window.fixture={calls,state:(state)=>{connection={...connection,state,toolCount:state==="connected"?1:0}},
        hold:()=>held=true,release:()=>release?.(),reads:()=>reads,
        failDisconnect:()=>failDisconnect=true,holdDisconnect:()=>holdDisconnect=true,releaseDisconnect:()=>releaseDisconnect?.(),
        incarnation:()=>{connection={...connection,server:"devclaw-mcp:new-birth",state:"connected"};
          useAppStore.setState({threads:[{thread_id:"thread",created_at:"new-birth",metadata:{workspacePath:"c:/work"}}]})},
        account:()=>useAppStore.setState({accountRevision:2}),
        workspace:()=>useAppStore.setState({threads:[{thread_id:"thread",metadata:{workspacePath:"c:/other"}}]}),
        reset:()=>{connection={...connection,state:"connected"};useAppStore.setState({accountRevision:1,
          tab:"claw",threads:[{thread_id:"thread",metadata:{workspacePath:"c:/work"}}]})},
        empty:()=>{connection=null},settings:()=>useAppStore.getState().settings};
      function App(){const state=useAppStore(s=>s);return state.tab==="connectors"?<McpPanel/>:
        <McpConnectionStatus threadId="thread" workspace="c:/work"/>}
      createRoot(document.getElementById("root")).render(<React.StrictMode><App/></React.StrictMode>);
    ` },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "mcp-settings-fixtures", setup(builder) {
      builder.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, () => ({ path: "store", namespace: "fixture" }))
      builder.onResolve({ filter: /(?:api\/market|AddMcpConnectorDialog|MCPConnectorDetail|MarketPublishDialog|marketPublishStorage)$/ }, args => ({ path: args.path, namespace: "fixture" }))
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ loader: "tsx", resolveDir: root,
        contents: args.path === "store" ? `import{useSyncExternalStore}from"react";
          const listeners=new Set();let state={accountRevision:1,tab:"claw",settings:[],
            threads:[{thread_id:"thread",metadata:{workspacePath:"c:/work"}}],
            setShowCustomizeView:(show,tab)=>{state.settings.push([show,tab]);useAppStore.setState({tab})}};
          export function useAppStore(select){return useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>select(state))}
          useAppStore.getState=()=>state;useAppStore.setState=next=>{state={...state,...next};listeners.forEach(fn=>fn())};
          export const isThreadRetired=()=>false,isThreadDeletionPending=()=>false;` :
        args.path.endsWith("api/market") ? "export const marketApi={getMcps:async()=>({success:true,data:[]})}" :
        args.path.endsWith("MCPConnectorDetail") ? "export function MCPConnectorDetail(props){return <div aria-label='来源详情'>{JSON.stringify(props.connector||props.mcpConnector)}</div>}" :
        args.path.endsWith("marketPublishStorage") ? "export const readUploadedItemNamesFromStorage=()=>new Set()" :
        `export function ${args.path.split("/").at(-1)}(){return null}`
      }))
    }}], logLevel: "warning"
  })
  const css = resolve("src/renderer/src/index.css")
  const compiler = await compile(readFileSync(css, "utf8"), { base: dirname(css), from: css,
    onDependency() { /* Isolated fixture; no build dependency graph is retained. */ } })
  const candidates = new Scanner({}).scanFiles([
    "src/renderer/src/components/customize/McpConnectionStatus.tsx",
    "src/renderer/src/components/customize/McpPanel.tsx",
    "src/renderer/src/components/ui/button.tsx"
  ].map(file => ({ content: readFileSync(resolve(file), "utf8"), extension: "tsx" })))
  const styles = compiler.build(candidates)
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  const page = await browser.newPage({ viewport: { width: 900, height: 750 } })
  const failures: string[] = []
  page.on("pageerror", error => failures.push(error.message))
  try {
    await page.route("http://127.0.0.1/", route => route.fulfill({ contentType: "text/html",
      body: `<html><head><style>${styles}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>` }))
    await page.goto("http://127.0.0.1/")
    await page.getByRole("button", { name: "取消连接", exact: true }).waitFor()
    await page.clock.install()
    await page.evaluate(() => (window as FixtureWindow).fixture.hold())
    await page.getByRole("button", { name: "刷新连接状态" }).click()
    const slowReadCount = await page.evaluate(() => (window as FixtureWindow).fixture.reads())
    for (let i = 0; i < 8; i++) {
      await page.clock.fastForward(6000)
      assert.equal(await page.evaluate(() => (window as FixtureWindow).fixture.reads()), slowReadCount + i)
      await page.evaluate((iteration) => {
        const fixture = (window as FixtureWindow).fixture
        fixture.state(iteration % 2 === 0 ? "connected" : "connecting")
        fixture.hold()
        fixture.release()
      }, i)
      await page.waitForFunction((expected) => (window as FixtureWindow).fixture.reads() === expected, slowReadCount + i + 1)
      if (i > 0) await page.getByText(i % 2 === 0 ? "正在连接" : "已连接", { exact: false }).waitFor()
    }
    await page.evaluate(() => (window as FixtureWindow).fixture.release())
    await page.clock.resume()
    await page.getByRole("button", { name: "取消连接", exact: true }).waitFor()
    await page.getByRole("button", { name: "取消连接", exact: true }).click()
    await page.getByText("已断开", { exact: false }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as FixtureWindow).fixture.calls), [
      ["disconnect", "thread", { workspace: "c:/work", owner: "owner-one", server: "devclaw-mcp:one" }]
    ])
    await page.evaluate(() => (window as FixtureWindow).fixture.state("unknown"))
    await page.getByRole("button", { name: "刷新连接状态" }).click()
    await page.getByText("清理结果待核对", { exact: false }).waitFor()
    assert.equal(await page.getByRole("button", { name: "断开连接", exact: true }).count(), 0)
    await page.evaluate(() => (window as FixtureWindow).fixture.state("connected"))
    await page.getByRole("button", { name: "刷新连接状态" }).click()
    await page.getByRole("button", { name: "断开连接", exact: true }).waitFor()
    await page.evaluate(() => (window as FixtureWindow).fixture.failDisconnect())
    await page.getByRole("button", { name: "断开连接", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "断开结果未确认" }).waitFor()
    await page.clock.fastForward(6000)
    assert.match(await page.getByRole("alert").innerText(), /断开结果未确认/)
    await page.getByRole("button", { name: "刷新连接状态" }).click()
    await page.getByRole("alert").waitFor({ state: "detached" })
    await page.screenshot({ path: resolve(output, "connected.png"), fullPage: true })
    await page.getByRole("button", { name: "查看来源设置" }).click()
    await page.getByLabel("来源详情").filter({ hasText: "connector-one" }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as FixtureWindow).fixture.settings()), [[true, "connectors"]])
    await page.evaluate(() => (window as FixtureWindow).fixture.reset())
    await page.getByRole("button", { name: "断开连接", exact: true }).waitFor()
    await page.evaluate(() => (window as FixtureWindow).fixture.holdDisconnect())
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find(item => item.textContent === "断开连接")!
      button.click(); button.click()
    })
    assert.equal(await page.evaluate(() => (window as FixtureWindow).fixture.calls.length), 3)
    await page.evaluate(() => (window as FixtureWindow).fixture.incarnation())
    await page.getByRole("button", { name: "断开连接", exact: true }).waitFor({ state: "visible" })
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[disabled]'))
    await page.evaluate(() => (window as FixtureWindow).fixture.releaseDisconnect())
    await page.getByRole("button", { name: "断开连接", exact: true }).waitFor()
    assert.equal(await page.getByText("已断开", { exact: false }).count(), 0)
    await page.setViewportSize({ width: 375, height: 700 })
    await page.screenshot({ path: resolve(output, "narrow-real-css.png"), fullPage: true })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    await page.evaluate(() => (window as FixtureWindow).fixture.holdDisconnect())
    await page.getByRole("button", { name: "断开连接", exact: true }).click()
    await page.evaluate(() => (window as FixtureWindow).fixture.account())
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[disabled]'))
    await page.evaluate(() => (window as FixtureWindow).fixture.releaseDisconnect())
    await page.getByRole("button", { name: "断开连接", exact: true }).waitFor()
    assert.equal(await page.getByText("已断开", { exact: false }).count(), 0)
    await page.evaluate(() => (window as FixtureWindow).fixture.hold())
    await page.getByRole("button", { name: "刷新连接状态" }).click()
    await page.evaluate(() => { (window as FixtureWindow).fixture.workspace(); (window as FixtureWindow).fixture.release() })
    assert.equal(await page.getByRole("button", { name: "查看来源设置" }).count(), 0)
    assert.deepEqual(await page.evaluate(() => (window as FixtureWindow).fixture.settings()), [[true, "connectors"]])
    await page.waitForFunction(() => document.querySelector('button')?.disabled === false)
    assert.equal(await page.getByRole("button", { name: "断开连接", exact: true }).count(), 0)
    assert.deepEqual(failures, [])
    writeFileSync(resolve(output, "results.json"), JSON.stringify({ passed: true,
      cases: ["read-only-status", "cancel-exact-lease", "unknown-no-reconnect", "exact-settings-source", "late-workspace", "account-retirement"] }, null, 2))
    console.log(`PASS mods MCP connections browser: ${output}`)
  } catch (error) {
    writeFileSync(resolve(output, "failure.json"), JSON.stringify({ failures,
      text: await page.locator("body").innerText() }, null, 2))
    throw error
  } finally { await browser.close() }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
