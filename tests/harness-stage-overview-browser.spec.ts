/** Production feature detail in real React/browser; controlled runtime/API fixtures only. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

const renderer = resolve("src/renderer/src")
const entry = resolve(renderer, "components/harness-board/HarnessBoardView.tsx")

async function main() {
  const output = resolve("output", `harness-stage-overview-browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const bundled = await build({
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `
      import React,{useState} from 'react';import{createRoot}from'react-dom/client';
      import{FeatureDetailPage}from${JSON.stringify(entry)};
      const root=createRoot(document.getElementById('root')),calls=[];
      const definitions=[['biz.prd','需求澄清与 PRD','Biz'],['dev.specs','行为规格','Dev'],
        ['dev.design','技术设计','Dev'],['dev.plan','执行计划','Dev'],['dev.detail_design','详细设计','Dev'],
        ['dev.code','代码实现','Dev'],['warehouse.model','订单数仓建模','Dev'],
        ['warehouse.sql','订单SQL与本地执行','Dev'],['warehouse.quality','本地数据质量与金额对账','Ops']];
      function make(mode='nine'){
        const source=mode==='custom'?[['first','澄清边界','业务准备'],['review','团队质量核对','团队校验'],['last','交付总结','']]:
          mode==='single'?[['draft','起草','文档'],['check','检查','文档']]:definitions;
        const nodes=source.map(([id,label,group],index)=>({id,label,group,nodeStatus:index===0?'in_progress':'not_started',
          status:{label:index===0?'进行中':'未开始',uiKind:index===0?'active':'unknown'},artifacts:[],hooks:[]}));
        return {project:{projectId:'project',name:'受控项目',projectRootPath:'C:/controlled'},
          workflow:{display:{mode:'ordered_nodes'},nodes:nodes.map(n=>({...n,states:[]}))},
          run:{slug:mode,title:'受控全流程 '+mode,currentNodeId:nodes[0].id,nodes,featureStatus:'in_progress',
            skipNodeAvailable:mode!=='single',selectedDeployUnits:[],resolvedSessionWorkspacePath:'C:/controlled'},
          adapterSnapshot:{mock:false},sessions:[]};
      }
      let current=make();
      window.api={builtinRobot:{getStatus:async()=>({settings:{enabled:false},connectionState:'offline',identityState:'unknown'}),onStatus:()=>()=>{},
        getRemoteAccess:async()=>({featureGrants:[],threadGrants:[]}),onRemoteAccessChanged:()=>()=>{}},
        workspace:{cancelGitPanelReads:async()=>{}},
        appNotifications:{list:async()=>[],onChanged:()=>()=>{}},harnessBoard:{
          skipNode:async input=>{calls.push(['skip',input]);current=structuredClone(current);const row=current.run.nodes.find(n=>n.id===input.nodeId);
            row.nodeStatus='skipped';row.status={label:'跳过',uiKind:'skipped'};
            current.run.currentNodeId=current.run.nodes[current.run.nodes.indexOf(row)+1]?.id||row.id;return{}},
          getRunDetail:async()=>structuredClone(current)}};
      function Fixture(){const[detail,setDetail]=useState(current);window.stageFixture={calls,
        show:mode=>{current=make(mode);setDetail(current)},refresh:()=>setDetail(structuredClone(current))};
        return <div style={{height:'100vh'}}><FeatureDetailPage detail={detail} loading={false} isViewingSession={false}
          onBackToList={()=>{}} onBackToProject={()=>{}} onEditDeployUnits={()=>{}}
          onRefresh={()=>setDetail(structuredClone(current))} onFeatureImManagementSaved={()=>{}}/></div>}
      root.render(<Fixture/>);
    `
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": renderer },
    loader: { ".png": "dataurl", ".md": "text" },
    define: {
      "process.env.NODE_ENV": '"development"',
      "import.meta.env": "{}",
      "import.meta.hot": "undefined"
    },
    plugins: [
      {
        name: "feature-detail-test-entry",
        setup(builder) {
          builder.onLoad({ filter: /HarnessBoardView\.tsx$/ }, () => ({
            loader: "tsx",
            resolveDir: dirname(entry),
            contents: readFileSync(entry, "utf8") + "\nexport { FeatureDetailPage }\n"
          }))
          builder.onResolve({ filter: /(?:^|\/)thread-context$/ }, () => ({
            path: "thread-context",
            namespace: "fixture"
          }))
          builder.onResolve({ filter: /(?:^@\/lib\/store$|^\.\/store$|\/lib\/store$)/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "js",
            contents:
              args.path === "thread-context"
                ? `
            const empty={};export const useThreadContext=()=>({getAllStreamLoadingStates:()=>empty,getThreadStateSummaries:()=>empty});
            export const useThreadStateSummaries=()=>empty,useAllStreamLoadingStates=()=>empty,useAllThreadStates=()=>empty;
            export const useThreadStateSelector=()=>null,useThreadState=()=>null,useThreadActions=()=>null,useCurrentThread=()=>empty,useThreadStream=()=>empty;
            export const ThreadProvider=({children})=>children,THREAD_MESSAGE_RESIDENT_LIMIT=1500,THREAD_MESSAGE_PROTECTED_TAIL=320;
          `
                : `
            const state={threads:[],models:[],installedPlugins:[],createThread:async()=>({thread_id:'unused'}),selectThread:async()=>{}};
            export const useAppStore=selector=>selector(state);useAppStore.getState=()=>state;useAppStore.subscribe=()=>()=>{};
            export const isThreadDeletionPending=()=>false,isThreadRetired=()=>false;
          `
          }))
        }
      },
      browserWorkerPlugin()
    ]
  })
  const cssEntry = resolve(renderer, "index.css")
  const compiler = await compile(readFileSync(cssEntry, "utf8"), {
    base: renderer,
    from: cssEntry,
    onDependency() {
      return undefined
    }
  })
  const candidates = new Scanner({}).scanFiles([
    { content: readFileSync(entry, "utf8"), extension: "tsx" },
    {
      content: readFileSync(resolve(renderer, "components/ui/button.tsx"), "utf8"),
      extension: "tsx"
    }
  ])
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const errors: string[] = [],
    checks: string[] = []
  let failure = ""
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
  page.setDefaultTimeout(10000)
  page.on("pageerror", (error) => errors.push(error.message))
  const pass = (message: string) => {
    checks.push(message)
    console.log("PASS " + message)
  }
  try {
    await page.setContent('<div id="root"></div>')
    await page.addStyleTag({ content: compiler.build(candidates) })
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    const nodes = page.locator("[data-stage-node]")
    await nodes.first().waitFor()
    assert.equal(await nodes.count(), 9)
    assert.deepEqual(
      await nodes.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-stage-node"))),
      [
        "biz.prd",
        "dev.specs",
        "dev.design",
        "dev.plan",
        "dev.detail_design",
        "dev.code",
        "warehouse.model",
        "warehouse.sql",
        "warehouse.quality"
      ]
    )
    await page.locator('[data-stage-node="warehouse.quality"] > button').focus()
    await page.keyboard.press("Enter")
    await page.getByText("正在查看：本地数据质量与金额对账", { exact: true }).waitFor()
    await page.getByText("所选步骤", { exact: true }).waitFor()
    assert.equal(await nodes.count(), 9)
    assert.equal(
      await page.getByRole("button", { name: "全流程", exact: true }).getAttribute("aria-pressed"),
      "true"
    )
    pass("all nine nodes remain visible when current Biz and selected Ops differ")
    await page.screenshot({ path: resolve(output, "nine-node-overview.png"), fullPage: true })

    await page.getByRole("button", { name: "筛选阶段：Dev", exact: true }).click()
    assert.equal(await nodes.count(), 7)
    await page.getByRole("button", { name: "全流程", exact: true }).focus()
    await page.keyboard.press("Space")
    assert.equal(await nodes.count(), 9)
    assert.equal(await page.locator("button button").count(), 0)
    await page.getByRole("button", { name: "跳过当前节点", exact: true }).click()
    await page.waitForFunction("window.stageFixture.calls.length===1")
    assert.deepEqual(await page.evaluate("window.stageFixture.calls[0]"), [
      "skip",
      { projectId: "project", slug: "nine", nodeId: "biz.prd" }
    ])
    assert.equal(await nodes.count(), 9)
    await page.getByText("11%", { exact: true }).waitFor()
    assert(
      await page
        .getByRole("button", { name: "筛选阶段：Biz", exact: true })
        .getByText("1/1", { exact: true })
        .isVisible()
    )
    pass(
      "explicit stage filtering, keyboard return and original skip action preserve the whole workflow"
    )

    await page.evaluate("window.stageFixture.show('custom')")
    await page.locator('[data-stage-node="last"]').waitFor()
    assert.equal(await nodes.count(), 3)
    await page.getByRole("button", { name: "筛选阶段：团队校验", exact: true }).focus()
    await page.keyboard.press("Enter")
    assert.equal(await nodes.count(), 1)
    assert.equal(await nodes.first().getAttribute("data-stage-node"), "review")
    await page.getByRole("button", { name: "全流程", exact: true }).click()
    assert.equal(await nodes.count(), 3)
    pass(
      "arbitrary custom groups and ungrouped nodes remain selectable without domain-specific code"
    )

    await page.getByRole("button", { name: "筛选阶段：业务准备", exact: true }).click()
    await page.evaluate("window.stageFixture.show('single')")
    await page.locator('[data-stage-node="check"]').waitFor()
    assert.equal(await nodes.count(), 2)
    assert.equal(await page.getByRole("button", { name: "跳过当前节点", exact: true }).count(), 0)
    await page.getByRole("button", { name: "筛选阶段：文档", exact: true }).click()
    assert.equal(await nodes.count(), 2)
    await page.getByRole("button", { name: "全流程", exact: true }).click()
    assert.equal(await nodes.count(), 2)
    await page.screenshot({ path: resolve(output, "single-group-overview.png"), fullPage: true })
    pass("a new feature defaults to all nodes and fixed single-group workflows retain their nodes")
    assert.deepEqual(errors, [])
  } catch (error) {
    failure = String(error)
    console.error({ errors, body: await page.locator("body").innerText() })
    throw error
  } finally {
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          scope:
            "Production FeatureDetailPage and real browser interactions with controlled runtime/API fixtures",
          checks,
          errors,
          failure,
          complete: !failure && !errors.length
        },
        null,
        2
      )
    )
    console.log("Evidence: " + output)
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
