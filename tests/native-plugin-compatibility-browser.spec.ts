/** Real compatibility card. Controlled read-only replies never stand in for execution approval. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"

async function main() {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {NativePluginCompatibility} from './src/renderer/src/components/customize/NativePluginCompatibility';
    let held=false,releases=[],mode='normal';const calls=[];
    window.api={nodeComposition:{compatibility:async input=>{calls.push(input);const result={source:{pluginId:'installed',name:'Docs',version:window.fixture.version,enabled:true,packageDigest:'a'.repeat(64)},checkedAt:1,status:'declared',authorization:mode==='unknown'?undefined:'not-evaluated',chat:'check-in-chat',reasons:[],entries:[
      {id:'notes',title:'独立笔记',kind:'capability',available:true,reasons:[]},
      {id:'host',title:'文档流程',kind:'flow',runtimeMode:'host',available:true,reasons:[]},
      {id:'legacy',title:'未知原引擎',kind:'flow',runtimeMode:'legacy',available:false,reasons:['此流程暂不支持组合，请继续从原项目入口使用。']},
      {id:'mods',title:'灵件宿主流程',kind:'flow',runtimeMode:'host',available:false,reasons:['此流程尚不能组合：HOST_PROJECT_PINNED_MODS_UNSUPPORTED']},
      {id:'mcp',title:'外部工具宿主流程',kind:'flow',runtimeMode:'host',available:false,reasons:['此流程尚不能组合：HOST_PROJECT_PINNED_MCP_UNSUPPORTED']}]};if(held)await new Promise(done=>releases.push(done));return result}}};
    function Fixture(){const [version,setVersion]=useState('1'),[active,setActive]=useState(true);
      window.fixture={calls,version,setVersion,setActive,mode:value=>mode=value,hold:()=>held=true,held:()=>releases.length,release:()=>{held=false;releases.splice(0).forEach(done=>done())}};
      return <NativePluginCompatibility threadId='thread' workspace='C:/fixture' pluginId='installed' version={version} enabled revision={1} active={active}/>}
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 850 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent("<div id='root'></div>")
    const cssFile = resolve("src/renderer/src/index.css")
    const compiler = await compile(readFileSync(cssFile, "utf8"), {
      base: dirname(cssFile),
      from: cssFile,
      onDependency() {
        /* The fixture uses generated CSS directly without a persistent dependency graph. */
      }
    })
    const candidates = new Scanner({}).scanFiles(
      [
        "src/renderer/src/components/customize/NativePluginCompatibility.tsx",
        "src/renderer/src/components/ui/button.tsx"
      ].map((file) => ({ content: readFileSync(file, "utf8"), extension: "tsx" }))
    )
    await page.addStyleTag({ content: compiler.build(candidates) })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const act = (code: string) => page.evaluate(code)
    const check = () => page.getByRole("button", { name: /^(?:重新)?检查适用范围$/ }).click()
    await page.getByRole("button", { name: "检查适用范围", exact: true }).waitFor()
    assert.equal(await act("window.fixture.calls.length"), 0)
    await check()
    await page.getByLabel("已核对的适用范围").waitFor()
    for (const label of ["普通聊天", "项目独立技能", "完整项目流程"])
      assert.equal(await page.getByText(label, { exact: true }).count(), 1)
    assert(await page.getByText(/当前聊天的可用性与权限尚未核对/).isVisible())
    assert(await page.getByText(/文档流程 · 宿主流程 · 已通过项目组合检查/).isVisible())
    assert(await page.getByText(/未知原引擎 · 原引擎流程 · 暂不能/).isVisible())
    assert(await page.getByText(/暂不支持固定包含灵件模块/).isVisible())
    assert(await page.getByText(/暂不支持插件自带的外部工具连接/).isVisible())
    assert(await page.getByText(/检查通过不代表已授权/).isVisible())
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    const artifacts = resolve("output/plugin-compatibility")
    mkdirSync(artifacts, { recursive: true })
    await page.screenshot({ path: resolve(artifacts, "compatibility-mobile.png"), fullPage: true })
    assert.deepEqual(await act("window.fixture.calls"), [
      { threadId: "thread", expectedWorkspace: "C:/fixture", pluginId: "installed" }
    ])
    console.log(
      "PASS explicit check only; separate chat/project skills/Host/Legacy ranges and actual Mods/MCP refusal reasons"
    )
    await act("window.fixture.mode('unknown')")
    await check()
    await page.getByRole("alert").waitFor()
    assert.equal(await page.getByLabel("已核对的适用范围").count(), 0)
    console.log("PASS unknown permission result cannot produce an eligible capability card")
    await act("window.fixture.mode('normal');window.fixture.hold()")
    await check()
    await page.waitForFunction("window.fixture.held()===1")
    await act("window.fixture.setVersion('2')")
    await page.getByRole("button", { name: "检查适用范围", exact: true }).waitFor()
    await act("window.fixture.release()")
    assert.equal(await page.getByLabel("已核对的适用范围").count(), 0)
    await check()
    await page.getByText(/本次检查的安装版本 2/).waitFor()
    await act("window.fixture.setActive(false)")
    await page.getByLabel("已核对的适用范围").waitFor({ state: "detached" })
    await act("window.fixture.setActive(true)")
    assert.equal(await page.getByLabel("已核对的适用范围").count(), 0)
    await check()
    await page.getByText(/本次检查的安装版本 2/).waitFor()
    await act("window.fixture.setVersion('3')")
    await page.getByLabel("已核对的适用范围").waitFor({ state: "detached" })
    await act("window.fixture.setVersion('2')")
    assert.equal(await page.getByLabel("已核对的适用范围").count(), 0)
    assert.deepEqual(errors, [])
    console.log(
      "PASS changed installed version, late reply, scope retirement and A-B-A cannot revive old inspection results"
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
