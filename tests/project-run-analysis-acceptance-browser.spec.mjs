import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import XLSX from "xlsx"

// Browser acceptance against the real component. All data is local fixtures;
// the harness never starts or connects to Elasticsearch.
const renderer = resolve("src/renderer/src")
const output = resolve("output/project-run-analysis-acceptance")
mkdirSync(output, { recursive: true })
const css = await compile(
  readFileSync(join(renderer, "index.css"), "utf8").replace(/^@import "@fontsource[^\n]+\n/gm, ""),
  { base: renderer, onDependency: () => undefined }
)
const scanner = new Scanner({
  sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
})
const bundle = await build({
  stdin: {
    resolveDir: renderer,
    loader: "tsx",
    contents: `
      import React, {useCallback, useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {ProjectRunAnalysis} from './components/dashboard/ProjectRunAnalysis';
      import {ProjectModePanel} from './components/dashboard/panels/ProjectModePanel';
      import {TooltipProvider} from './components/ui/tooltip';
      import {makeMockRunAnalysis, makeMockRunAnalysisStages} from '../../main/ipc/project-run-analysis-mock';
      const range = {from:'2020-01-01T00:00:00Z', to:'2030-01-01T00:00:00Z'};
      const calls = [], pending = new Map(), rejected = new Map();
      const qa = window.runQA = {calls, finish: key => pending.get(key)?.(), fail:key=>rejected.get(key)?.(), copied:'', opened:[]};
      Object.defineProperty(navigator, 'clipboard', {value:{writeText: async text => {qa.copied=text}}});
      window.api = {dashboard:{
        projectModeRunAnalysis: async (range,options) => ({success:true,data:await qa.load(range,options)}),
        projectModeRunAnalysisStages: async request => {
          calls.push({type:'stages',request});
          return {success:true,data:{rows:makeMockRunAnalysisStages(),dataAsOf:new Date().toISOString()}};
        },
        projectModeRunAnalysisSessions: async request => {
          calls.push({type:'sessions',request});
          return {success:true,data:{total:1,after:null,rows:[{
            traceId:'acceptance-trace',threadId:'acceptance-thread',startedAt:'2026-10-20T01:00:00Z',
            endedAt:'2026-10-20T01:01:00Z',durationMs:60000,nodeName:request.nodeName??'dev-编码实现',usedSkills:[]
          }]}};
        },
        projectModeRunAnalysisTrace: async request => {
          calls.push({type:'trace',request});
          return {success:true,data:{traceId:request.traceId,threadId:'acceptance-thread',
            startedAt:'2026-10-20T01:00:00Z',endedAt:'2026-10-20T01:01:00Z',durationMs:60000,
            userMessage:'验收会话：检查本次执行',outcome:'success',totalToolCalls:1,modelCallCount:1,
            userInputRequestCount:0,totalInputTokens:100,totalOutputTokens:50,totalTokens:150,
            usedSkills:[],evolvedSkills:[],traceKind:'root',rawAvailable:true,nodes:[{
              id:'msg1',type:'message',parentId:null,name:'assistant',startedAt:'2026-10-20T01:01:00Z',
              output:'验收回复：本次执行已完成',metadata:{role:'assistant'}
            }]}};
        },
        threadTraces: () => {throw Error('Unexpected whole-thread fetch')}
      }};
      function App() {
        const [active,setActive]=useState(false), [room,setRoom]=useState('A'), [integrated,setIntegrated]=useState(false);
        qa.setActive=setActive; qa.setRoom=setRoom; qa.setIntegrated=setIntegrated;
        const load=useCallback((r,o)=>{
          const key=room+':'+o.membership;
          calls.push({type:'load',key,options:o});
          return new Promise((resolve,reject) => {rejected.set(key,()=>reject(Error('验收模拟查询失败'))); pending.set(key,()=>{
            const data=makeMockRunAnalysis(r,o);
            data.rows.forEach(row=>{row.projectName=room+' · '+row.projectName});
            resolve(data);
          });});
        },[room]);
        qa.load=load;
        return <TooltipProvider><main style={{padding:20,minWidth:0}}>
          {integrated ? <ProjectModePanel data={null} loading={false} error={null} codeSource={null}
            codeStatsOverride={null} codeStatsLoading={false} onCodeSourceChange={()=>{}}
            createdInRangeProjectsOnly runAnalysisRange={range} runAnalysisOptions={{upperOrgLv1:[room]}}
            projectPages={{}} projectPageLoading={{active:false,archived:false}} projectPageError={{}}
            onProjectPageChange={()=>{}} onOpenTraces={()=>{}} onOpenFeatureCommits={()=>{}} onOpenProjectCommits={()=>{}}
            loadFeatureNodes={async()=>[]} loadOperationalDetails={async()=>null} loadStageAnalysis={async()=>null}/>
          : <ProjectRunAnalysis range={range} options={{upperOrgLv1:[room]}} active={active} loadData={load}
            onOpenFeatureCommits={(row,pushed)=>qa.opened.push({row,pushed})}
            onOpenCodeTrace={row=>qa.opened.push({code:row.projectId})}/>}
        </main></TooltipProvider>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    `
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  loader: { ".png": "dataurl" },
  alias: { "@": renderer },
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env": JSON.stringify({ DEV: false, VITE_API_BASE_URL: "" })
  }
})
const browser = await chromium.launch({
  ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }),
  headless: true
})
try {
  const page = await browser.newPage({
    viewport: { width: 1536, height: 960 },
    acceptDownloads: true
  })
  const errors = []
  page.on("pageerror", (e) => {
    errors.push(e.message)
    console.error("Browser runtime error:", e.message)
  })
  await page.setContent('<div id="root"></div>')
  await page.addStyleTag({ content: css.build(scanner.scan()) })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.getByRole("region", { name: "运行分析" }).waitFor()
  assert.equal(
    await page.evaluate(() => window.runQA.calls.length),
    0,
    "Hidden analysis must not query"
  )
  const finish = (key) => page.evaluate((k) => window.runQA.finish(k), key)
  const waitLoad = (key) =>
    page.waitForFunction(
      (k) => window.runQA.calls.some((c) => c.type === "load" && c.key === k),
      key
    )
  const tableRows = page.getByRole("region", { name: "运行分析" }).locator("table > tbody > tr")
  await page.evaluate(() => window.runQA.setActive(true))
  await waitLoad("A:active")
  await finish("A:active")
  await page.getByText("1 / 2 页 · 36条").waitFor()
  assert.equal(await tableRows.count(), 20)
  await page.evaluate(() => window.runQA.setActive(false))
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
  await page.evaluate(() => window.runQA.setActive(true))
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
  assert.equal(
    await page.evaluate(() => window.runQA.calls.filter((c) => c.type === "load").length),
    1,
    "Returning to the same fresh scope must reuse results"
  )
  await page.getByRole("button", { name: "下一页", exact: true }).click()
  assert.equal(await tableRows.count(), 16)
  await page.getByRole("textbox", { name: "项目或特性关键词" }).fill("客户经营平台 1")
  await page.getByText("1 / 1 页 · 3条").waitFor()
  assert.equal(await tableRows.count(), 3, "Filter must apply to all pages")
  await page.getByRole("button", { name: "清除全部筛选", exact: true }).click()
  await page.getByRole("combobox", { name: "快速筛选", exact: true }).selectOption("noSkill")
  assert.equal(
    await page.getByRole("button", { name: "更多筛选", exact: true }).getAttribute("aria-expanded"),
    "false"
  )
  await page.getByRole("button", { name: "更多筛选", exact: true }).click()
  await page.getByRole("spinbutton", { name: "未使用 Skill 主对话不少于（轮）" }).fill("19")
  assert.equal(
    await page.getByRole("combobox", { name: "快速筛选", exact: true }).inputValue(),
    "custom"
  )
  assert.ok((await tableRows.count()) > 0)
  for (const value of await tableRows.locator("td:nth-child(7)").allTextContents())
    assert.match(value, /20轮共 30 轮主对话/)
  assert.equal(
    await page.evaluate(() => window.runQA.calls.filter((c) => c.type === "load").length),
    1,
    "UI filtering must not requery"
  )
  await page.getByRole("button", { name: "清除全部筛选", exact: true }).click()
  await page.getByRole("button", { name: "更多筛选", exact: true }).click()
  const quick = page.getByRole("combobox", { name: "快速筛选", exact: true })
  for (const key of ["idle", "span", "adoption", "vibe", "noSkill", "calls"]) {
    const label = await quick.locator(`option[value="${key}"]`).textContent()
    const expected = Number(label.match(/（(\d+)个特性）/)[1])
    await quick.selectOption(key)
    assert.equal(await tableRows.count(), Math.min(expected, 20))
    assert.equal(await page.getByRole("table").count(), 1, "One consistent metrics table")
    if (key === "adoption") {
      const rates = (await tableRows.locator("td:nth-child(5) button").allTextContents()).map((v) =>
        parseFloat(v)
      )
      assert.deepEqual(
        rates,
        [...rates].sort((a, b) => a - b),
        "Lowest adoption first"
      )
    }
    await quick.selectOption("")
    await page.getByText("1 / 2 页 · 36条").waitFor()
  }
  for (const oldTab of ["综合概览", "代码采纳", "调用与代理"])
    assert.equal(await page.getByRole("button", { name: oldTab, exact: true }).count(), 0)
  await page.getByRole("textbox", { name: "项目或特性关键词" }).fill("客户经营平台 1")
  await page.getByRole("combobox", { name: "快速筛选", exact: true }).selectOption("noSkill")
  assert.equal(
    await page.getByRole("textbox", { name: "项目或特性关键词" }).inputValue(),
    "客户经营平台 1"
  )
  for (const value of await tableRows.locator("td:first-child").allTextContents())
    assert.match(value, /客户经营平台 1/)
  await page.getByRole("button", { name: /^移除筛选：未使用 Skill/ }).click()
  await page.getByText("1 / 1 页 · 3条").waitFor()
  await page.getByRole("button", { name: "清除全部筛选", exact: true }).click()
  assert.equal(
    await page.evaluate(() => window.runQA.calls.filter((c) => c.type === "load").length),
    1,
    "Quick filters, chips and search never requery ES"
  )
  const downloadPromise = page.waitForEvent("download")
  await page.getByRole("button", { name: "导出Excel", exact: true }).click()
  const download = await downloadPromise
  const workbook = XLSX.readFile(await download.path())
  assert.equal(
    XLSX.utils.sheet_to_json(workbook.Sheets["匹配特性"]).length,
    36,
    "Export must include all pages"
  )
  await page.getByRole("button", { name: "复制汇总", exact: true }).click()
  assert.match(await page.evaluate(() => window.runQA.copied), /36/)
  await page.getByRole("button", { name: "按项目", exact: true }).click()
  assert.equal(await tableRows.count(), 12)
  await tableRows.first().getByRole("button", { name: /^展开/ }).click()
  await page.getByText("匹配特性", { exact: true }).waitFor()
  await page.getByRole("button", { name: "按特性", exact: true }).click()
  await tableRows.first().locator("td:last-child button").click()
  await page
    .getByRole("dialog")
    .getByRole("cell", { name: "design-方案设计", exact: true })
    .waitFor()
  assert.equal(await page.getByRole("dialog").locator("tbody > tr").count(), 3)
  await page
    .getByRole("dialog")
    .locator("tbody > tr")
    .first()
    .locator("td:nth-child(5)")
    .getByRole("button")
    .click()
  const sessions = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "未使用Skill的主Agent对话", exact: true }) })
  await sessions.getByRole("button", { name: "查看完整会话", exact: true }).click()
  await page.getByRole("heading", { name: "运行分析 · 完整会话", exact: true }).waitFor()
  await page.getByText("验收会话：检查本次执行", { exact: false }).first().waitFor()
  const detailCalls = await page.evaluate(() => window.runQA.calls.filter((c) => c.type !== "load"))
  assert.deepEqual(
    detailCalls.map((c) => c.type),
    ["stages", "sessions", "trace"]
  )
  assert.equal(detailCalls[1].request.metric, "noSkill")
  assert.equal(detailCalls[1].request.nodeName, "design-方案设计")
  assert.equal(detailCalls[2].request.traceId, "acceptance-trace")
  assert.deepEqual(detailCalls[2].request.upperOrgLv1, ["A"])
  await page.screenshot({ path: join(output, "trace.png") })
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  await page.evaluate(() => window.runQA.setRoom("B"))
  await waitLoad("B:active")
  assert.equal(await tableRows.count(), 0, "Old room results cannot remain visible")
  assert.equal(
    await page.getByRole("button", { name: "导出Excel", exact: true }).isDisabled(),
    true
  )
  await page.evaluate(() => window.runQA.setRoom("C"))
  await waitLoad("C:active")
  await finish("C:active")
  await tableRows.first().getByText(/C ·/).waitFor()
  await finish("B:active")
  assert.equal(
    await tableRows.getByText(/B ·/).count(),
    0,
    "Late room response cannot replace latest scope"
  )
  await page.getByRole("button", { name: "刷新", exact: true }).click()
  await page.waitForFunction(
    () => window.runQA.calls.filter((c) => c.type === "load" && c.key === "C:active").length === 2
  )
  assert.equal(
    await page.evaluate(
      () => window.runQA.calls.filter((c) => c.type === "load").at(-1).options.refresh
    ),
    true
  )
  await page.evaluate(() => window.runQA.fail("C:active"))
  await page.getByRole("alert").filter({ hasText: "验收模拟查询失败" }).waitFor()
  assert.equal(
    await page.getByRole("button", { name: "导出Excel", exact: true }).isDisabled(),
    true
  )
  await page.getByRole("button", { name: "重试", exact: true }).click()
  await page.waitForFunction(
    () => window.runQA.calls.filter((c) => c.type === "load" && c.key === "C:active").length === 3
  )
  await finish("C:active")
  await tableRows.first().getByText(/C ·/).waitFor()
  await page.evaluate(() => window.runQA.setRoom("D"))
  await waitLoad("D:active")
  assert.equal(
    await page.evaluate(
      () => window.runQA.calls.filter((c) => c.type === "load").at(-1).options.refresh
    ),
    false,
    "Refreshing once must not permanently disable the scoped cache"
  )
  await finish("D:active")
  await tableRows.first().getByText(/D ·/).waitFor()
  await page.screenshot({ path: join(output, "analysis-wide.png") })
  await page.setViewportSize({ width: 760, height: 720 })
  const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  assert.ok(bodyWidth <= 760, `Analysis must not overflow body: ${bodyWidth}`)
  await tableRows.first().locator("td:last-child button").click()
  const rect = await page.getByRole("dialog").evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, right: r.right }
  })
  assert.ok(rect.x >= 0 && rect.right <= 761, "Diagnosis must fit narrow viewport")
  await page.screenshot({ path: join(output, "analysis-narrow.png") })
  await page.keyboard.press("Escape")
  const beforeIntegration = await page.evaluate(
    () => window.runQA.calls.filter((c) => c.type === "load").length
  )
  await page.evaluate(() => window.runQA.setIntegrated(true))
  await page.getByRole("tab", { name: "项目列表", exact: true }).waitFor()
  assert.equal(
    await page.getByRole("tab", { name: "项目列表", exact: true }).getAttribute("aria-selected"),
    "true"
  )
  assert.equal(
    await page.evaluate(() => window.runQA.calls.filter((c) => c.type === "load").length),
    beforeIntegration
  )
  await page.getByRole("tab", { name: "运行分析", exact: true }).click()
  await page.waitForFunction(
    (n) => window.runQA.calls.filter((c) => c.type === "load").length === n + 1,
    beforeIntegration
  )
  await finish("D:active")
  await page.getByText("1 / 2 页 · 36条").waitFor()
  await page.getByRole("tab", { name: "项目列表", exact: true }).click()
  assert.equal(await page.getByRole("region", { name: "运行分析" }).count(), 0)
  await page.getByRole("tab", { name: "运行分析", exact: true }).click()
  await page.getByText("1 / 2 页 · 36条").waitFor()
  assert.equal(
    await page.evaluate(() => window.runQA.calls.filter((c) => c.type === "load").length),
    beforeIntegration + 1
  )
  assert.deepEqual(errors, [], "No renderer runtime errors")
  const calls = await page.evaluate(() => window.runQA.calls)
  writeFileSync(
    join(output, "result.json"),
    JSON.stringify(
      {
        calls,
        errors,
        exportRows: 36,
        checks: [
          "lazy load",
          "all-page filtering",
          "no filter requery",
          "all-page Excel export",
          "project grouping",
          "stage diagnosis",
          "scoped single Trace",
          "late-response isolation",
          "narrow viewport"
        ]
      },
      null,
      2
    )
  )
  console.log(
    "Run analysis browser acceptance passed: all-page export 36 rows; lazy/scope/detail/narrow checks passed."
  )
} finally {
  await browser.close()
}
