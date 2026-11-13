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
      import {TimeControlBar} from './components/dashboard/TimeControlBar';
      import {getDefaultRange,navigateRange} from './components/dashboard/use-dashboard';
      import {ProjectModePanel} from './components/dashboard/panels/ProjectModePanel';
      import {TooltipProvider} from './components/ui/tooltip';
      import {makeMockRunAnalysis, makeMockRunAnalysisStages} from '../../main/ipc/project-run-analysis-mock';
      import {resolveOperationsPeriod} from '../../shared/project-operations-period';
      import {RECOMMENDED_REPORT_TEMPLATE_ID,RECOMMENDED_REPORT_TEMPLATE_NAME} from '../../shared/project-analysis-report';
      const range = {from:'2020-01-01T00:00:00Z', to:'2030-01-01T00:00:00Z'};
      const calls = [], pending = new Map(), rejected = new Map();
      const qa = window.runQA = {calls, finish: key => pending.get(key)?.(), fail:key=>rejected.get(key)?.(), copied:'', opened:[]};
      Object.defineProperty(navigator, 'clipboard', {value:{writeText: async text => {qa.copied=text}}});
      qa.agentReplies=[]; qa.agentEvents=[]; qa.reportEvents=[];
      qa.finishAgent=(index,response)=>qa.agentReplies[index](response);
      qa.reportReplies=[];
      qa.reportDocs=new Map();
      qa.recommendedId=RECOMMENDED_REPORT_TEMPLATE_ID;
      qa.reportWorkspace={ownRoom:'E',canChooseRoom:false,rooms:['E','管理员备用室'],templates:[{id:RECOMMENDED_REPORT_TEMPLATE_ID,name:RECOMMENDED_REPORT_TEMPLATE_NAME,kind:'builtin',preferences:'按综合报告模块组织，允许用户调整',createdAt:'2026-11-13T00:00:00Z',updatedAt:'2026-11-13T00:00:00Z'}],reports:[]};
      qa.makeReport=(id,version,scope)=>({
        summary:{id,title:scope.upperOrgLv1+' · 综合'+(scope.period.kind==='week'?'周报':'月报'),room:scope.upperOrgLv1,
          selection:scope.period,period:resolveOperationsPeriod(scope.period),dataAsOf:'2026-11-12T01:00:00Z',
          createdAt:'2026-11-12T01:00:00Z',updatedAt:'2026-11-12T02:00:00Z',latestVersion:version,exampleData:true},
        version:{version,createdAt:'2026-11-12T02:00:00Z',instruction:'验收要求',modelName:'验收默认模型'},
        versions:[{version,createdAt:'2026-11-12T02:00:00Z',instruction:'验收要求',modelName:'验收默认模型'}],
        html:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui;padding:24px;color:#172b4d}h1{font-size:24px}p{line-height:1.8}</style></head><body><h1>报告版本 '+version+'</h1><p>全室完整活动 · 对话与代码及知识调用</p><p>此报告由模型自由设计。</p><script>try{parent.document.body.dataset.reportAccess="unexpected"}catch{document.body.dataset.isolated="yes"}</script></body></html>',
        notes:['知识调用按汇总事件时间归期，缺失不是零','当前阶段为生成时快照']
      });
      qa.finishReport=(index,response,persist=true)=>{
        if(persist&&response.success&&response.data){
          const doc=response.data, stored=qa.reportDocs.get(doc.summary.id)??new Map();
          stored.set(doc.version.version,doc);
          const versions=[...stored.values()].map(d=>d.version).sort((a,b)=>a.version-b.version);
          for(const value of stored.values()){value.versions=versions;value.summary={...doc.summary,latestVersion:Math.max(...versions.map(v=>v.version))}}
          qa.reportDocs.set(doc.summary.id,stored);
        }
        qa.reportReplies[index](response);
      };
      window.api = {dashboard:{
        projectReportWorkspace: async()=>{
          calls.push({type:'reportWorkspace'});
          if(qa.workspaceFailure)return {success:false,error:'验收工作区暂时不可用'};
          return {success:true,data:{...qa.reportWorkspace,reports:[...qa.reportDocs.values()].map(versions=>[...versions.values()].at(-1).summary)}};
        },
        projectReportGenerate: (request,onEvent)=>{qa.reportEvents.push(onEvent);calls.push({type:'reportGenerate',request});return new Promise(resolve=>qa.reportReplies.push(resolve))},
        projectReportRead: async request=>{
          calls.push({type:'reportRead',request});
          const versions=qa.reportDocs.get(request.reportId);
          return {success:true,data:request.version?versions.get(request.version):[...versions.values()].at(-1)};
        },
        projectReportExport: async request=>{calls.push({type:'reportExport',request});return {success:true,data:{filePath:'/tmp/验收报告.html'}}},
        projectReportSaveTemplate: async request=>{
          calls.push({type:'reportSaveTemplate',request});
          const template={id:'template-'+(qa.reportWorkspace.templates.filter(t=>t.kind!=='builtin').length+1),name:request.name,preferences:request.preferences,createdAt:'2026-11-12T01:00:00Z',updatedAt:'2026-11-12T01:00:00Z'};
          qa.reportWorkspace.templates.push(template);return {success:true,data:template};
        },
        projectReportDeleteTemplate: async request=>{calls.push({type:'reportDeleteTemplate',request});qa.reportWorkspace.templates=qa.reportWorkspace.templates.filter(t=>t.id!==request.templateId);return {success:true,data:null}},
        projectReportDelete: async request=>{calls.push({type:'reportDelete',request});qa.reportDocs.delete(request.reportId);return {success:true,data:null}},
        projectModeAnalysisAgent: (request,onEvent) => {
          qa.agentEvents.push(onEvent);
          calls.push({type:'agent',request});
          return new Promise(resolve=>qa.agentReplies.push(resolve));
        },
        cancelRequests: async families => {calls.push({type:'cancel',families});return {cancelled:1}},
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
        const [overviewRequest,setOverviewRequest]=useState({loading:false,error:null});
        qa.overviewRequest=overviewRequest;qa.setOverviewRequest=setOverviewRequest;
        const [currentRange,setCurrentRange]=useState(range), [granularity,setGranularity]=useState('custom');
        const timeControl={granularity,customRangeMaxDays:92,
          onGranularityChange:(g)=>{setGranularity(g);if(g!=='custom')setCurrentRange(getDefaultRange(g));},
          onNavigate:(dir)=>setCurrentRange(r=>navigateRange(granularity,r.from,dir)),
          onCustomRange:(from,to)=>{setGranularity('custom');setCurrentRange({from,to});}};
        qa.timeRange=currentRange;qa.granularity=granularity;
        qa.setActive=setActive; qa.setRoom=setRoom; qa.setIntegrated=setIntegrated;
        const load=useCallback((r,o)=>{
          const key=room+':'+o.membership;
          calls.push({type:'load',key,options:o,range:r});
          return new Promise((resolve,reject) => {rejected.set(key,()=>reject(Error('验收模拟查询失败'))); pending.set(key,()=>{
            const data=makeMockRunAnalysis(r,o);
            data.rows.forEach(row=>{row.projectName=room+' · '+row.projectName;if(qa.newProjectIds&&o.membership==='executed')row.projectId='period-'+row.projectId;});qa.loadedRows=data.rows;
            resolve(data);
          });});
        },[room]);
        qa.load=load;
        return <TooltipProvider><main style={{padding:20,minWidth:0}}>
          <div data-testid="dashboard-time-control"><TimeControlBar key={currentRange.from+currentRange.to} {...timeControl} range={currentRange}/></div>
          {integrated ? <ProjectModePanel data={null} loading={overviewRequest.loading} error={overviewRequest.error} codeSource={null}
            codeStatsOverride={null} codeStatsLoading={false} onCodeSourceChange={()=>{}}
            createdInRangeProjectsOnly runAnalysisRange={currentRange} runAnalysisTimeControl={timeControl} runAnalysisOptions={{upperOrgLv1:[room]}}
            projectPages={{}} projectPageLoading={{active:false,archived:false}} projectPageError={{}}
            onProjectPageChange={()=>{}} onOpenTraces={()=>{}} onOpenFeatureCommits={()=>{}} onOpenProjectCommits={()=>{}}
            loadFeatureNodes={async()=>[]} loadOperationalDetails={async()=>null} loadStageAnalysis={async()=>null}/>
          : <ProjectRunAnalysis range={currentRange} timeControl={timeControl} options={{upperOrgLv1:[room]}} active={active} loadData={load}
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
  plugins: [
    {
      name: "preview-worker-not-used",
      setup(build) {
        build.onResolve({ filter: /\?worker$/ }, (args) => ({
          path: args.path,
          namespace: "preview-worker"
        }))
        build.onLoad({ filter: /.*/, namespace: "preview-worker" }, () => ({
          contents:
            'export default class { constructor() { throw new Error("Source highlighting is outside this preview-only acceptance") } }',
          loader: "js"
        }))
      }
    }
  ],
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
    acceptDownloads: true,
    timezoneId: "Asia/Shanghai"
  })
  const errors = []
  page.on("pageerror", (e) => {
    errors.push(e.message)
    console.error("Browser runtime error:", e.message)
  })
  // HtmlPreview uses the same secure-context APIs as the Electron renderer.
  // Fulfill localhost entirely in Playwright; no HTTP server or backend is used.
  await page.route("http://localhost:41739/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><div id="root"></div></body></html>'
    })
  )
  await page.goto("http://localhost:41739/acceptance")
  await page.addStyleTag({ content: css.build(scanner.scan()) })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.getByRole("region", { name: "项目分析" }).waitFor()
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
  const tableRows = page.getByRole("region", { name: "项目分析" }).locator("table > tbody > tr")
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
  await page.getByRole("spinbutton", { name: "未使用 Skill 主对话数值（轮）" }).fill("19")
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
  await tableRows.first().locator('td:last-child button[aria-label^="查看"]').click()
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
  await page.getByRole("heading", { name: "项目分析 · 完整会话", exact: true }).waitFor()
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
  await tableRows.first().locator('td:last-child button[aria-label^="查看"]').click()
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
  await page.getByRole("tab", { name: "项目分析", exact: true }).click()
  await page.waitForFunction(
    (n) => window.runQA.calls.filter((c) => c.type === "load").length === n + 1,
    beforeIntegration
  )
  await finish("D:active")
  await page.getByText("1 / 2 页 · 36条").waitFor()
  await page.getByRole("tab", { name: "项目列表", exact: true }).click()
  assert.equal(await page.getByRole("region", { name: "项目分析" }).count(), 0)
  await page.getByRole("tab", { name: "项目分析", exact: true }).click()
  await page.getByText("1 / 2 页 · 36条").waitFor()
  assert.equal(
    await page.evaluate(() => window.runQA.calls.filter((c) => c.type === "load").length),
    beforeIntegration + 1
  )
  // Comparison controls are independent and preserve strict boundaries.
  await page.getByRole("button", { name: "更多筛选", exact: true }).click()
  await page.getByRole("combobox", { name: "未使用 Skill 主对话比较方式" }).selectOption("lt")
  await page.getByRole("spinbutton", { name: "未使用 Skill 主对话数值（轮）" }).fill("19")
  assert.ok((await tableRows.count()) > 0)
  for (const value of await tableRows.locator("td:nth-child(7)").allTextContents())
    assert.doesNotMatch(value, /20轮/)
  await page.getByRole("combobox", { name: "有效生成行数比较方式" }).selectOption("between")
  await page.getByRole("spinbutton", { name: "有效生成行数下限（行）" }).fill("100")
  await page.getByRole("spinbutton", { name: "有效生成行数上限（行）" }).fill("10")
  await page.getByRole("alert").filter({ hasText: "下限不能大于上限" }).waitFor()
  await page.getByText("请补全或修正筛选条件后查看结果。", { exact: true }).waitFor()
  await page.getByRole("button", { name: "项目分析 Agent", exact: true }).click()
  await page.getByRole("textbox", { name: "项目分析问题" }).fill("筛选无效时不能分析")
  assert.equal(await page.getByRole("button", { name: "发送", exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole("tab", { name: "综合报告", exact: true }).isEnabled(), true)
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "清除全部筛选", exact: true }).click()
  await page.getByText("1 / 2 页 · 36条").waitFor()

  const waitAgent = (n) =>
    page.waitForFunction(
      (n) => window.runQA.calls.filter((c) => c.type === "agent").length === n,
      n
    )
  const minimizedAgent = page.getByRole("region", { name: "最小化的项目分析 Agent", exact: true })
  const cancelCount = (family) =>
    page.evaluate(
      (family) =>
        window.runQA.calls.filter(
          (call) => call.type === "cancel" && call.families.includes(family)
        ).length,
      family
    )
  const agentReply = async (index, content) =>
    page.evaluate(
      ({ index, content }) => {
        const request = window.runQA.calls.filter((c) => c.type === "agent")[index].request
        window.runQA.finishAgent(index, {
          success: true,
          data: {
            content,
            modelName: "验收模型",
            dataAsOf: "2026-11-12T01:00:00Z",
            projectCount: request.target ? 1 : 12,
            featureCount: request.target ? 1 : 36,
            exampleData: true,
            toolCalls: [],
            evidence: [
              {
                id: "E1",
                label: "当前筛选汇总",
                summary: request.target ? "1个项目，1个特性" : "12个项目，36个特性",
                target:
                  request.target ??
                  (() => {
                    const row = window.runQA.loadedRows.find(
                      (r) =>
                        r.featureSlug &&
                        (!request.filters.stage || r.currentStage === request.filters.stage)
                    )
                    return row
                      ? { projectId: row.projectId, featureSlug: row.featureSlug }
                      : undefined
                  })()
              }
            ]
          }
        })
      },
      { index, content }
    )
  await page.getByRole("button", { name: "项目分析 Agent", exact: true }).click()
  await page.getByRole("heading", { name: "项目分析 Agent", exact: true }).waitFor()
  await page
    .getByRole("textbox", { name: "项目分析问题", exact: true })
    .fill("概览刷新时保留的输入")
  await page.evaluate(() => window.runQA.setOverviewRequest({ loading: true, error: null }))
  await page.waitForFunction(() => window.runQA.overviewRequest.loading)
  assert.ok(await page.getByRole("dialog", { name: "项目分析 Agent", exact: true }).isVisible())
  await page.evaluate(() =>
    window.runQA.setOverviewRequest({ loading: false, error: "概览暂时不可用" })
  )
  await page.waitForFunction(() => !!window.runQA.overviewRequest.error)
  assert.equal(
    await page.getByRole("textbox", { name: "项目分析问题", exact: true }).inputValue(),
    "概览刷新时保留的输入"
  )
  await page.evaluate(() => window.runQA.setOverviewRequest({ loading: false, error: null }))
  await page.getByRole("textbox", { name: "项目分析问题", exact: true }).fill("")
  const initialAgentViewport = page.viewportSize()
  await page.screenshot({ path: join(output, "project-agent-date-entry.png") })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: join(output, "project-agent-date-entry-phone.png") })
  const initialComposer = await page
    .getByRole("textbox", { name: "项目分析问题", exact: true })
    .boundingBox()
  const initialDialog = await page
    .getByRole("dialog", { name: "项目分析 Agent", exact: true })
    .boundingBox()
  assert.ok(
    initialComposer.y + initialComposer.height <= initialDialog.y + initialDialog.height,
    "Visible date controls keep the initial composer inside the dialog"
  )
  await page.setViewportSize(initialAgentViewport)
  await page.getByRole("textbox", { name: "项目分析问题" }).fill("分析当前特性")
  await page.getByRole("button", { name: "发送", exact: true }).click()
  await waitAgent(1)
  assert.deepEqual(
    await page.evaluate(
      () => window.runQA.calls.find((c) => c.type === "agent").request.options.upperOrgLv1
    ),
    ["D"]
  )
  await page.evaluate(() => {
    const emit = window.runQA.agentEvents[0]
    emit({
      type: "step",
      step: {
        id: "m1",
        kind: "model",
        title: "模型分析 · 流式验收模型 · 第 1 轮",
        status: "running",
        startedAt: Date.now(),
        detail: "正在接收模型输出"
      }
    })
    emit({ type: "text", stepId: "m1", text: "", reset: true })
    emit({ type: "text", stepId: "m1", text: "第一段流式回答。" })
  })
  await page.getByText("第一段流式回答。", { exact: true }).waitFor()
  assert.equal(await page.getByRole("button", { name: "终止任务", exact: true }).isVisible(), true)
  await page.evaluate(() => {
    const emit = window.runQA.agentEvents[0]
    emit({ type: "text", stepId: "m1", text: "第二段流式回答。" })
    for (let i = 1; i <= 2; i++)
      emit({
        type: "step",
        step: {
          id: "t" + i,
          kind: "tool",
          title: "查询项目分析指标",
          status: "completed",
          startedAt: Date.now() - 200,
          elapsedMs: 200,
          detail: "共36条，本次返回12条",
          input: JSON.stringify({ view: "features", offset: (i - 1) * 12 }),
          output: JSON.stringify({ total: 36, nextOffset: i * 12 })
        }
      })
  })
  await page.getByText("第一段流式回答。第二段流式回答。", { exact: true }).waitFor()
  await page.evaluate(() =>
    window.runQA.agentEvents[0]({
      type: "text",
      stepId: "m1",
      text: Array.from({ length: 24 }, (_, i) => "可读分析段落 " + i).join("\n\n"),
      reset: true
    })
  )
  await page.getByText("可读分析段落 23", { exact: true }).waitFor()
  await page.getByRole("log").evaluate((el) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event("scroll"))
  })
  await page.evaluate(() =>
    window.runQA.agentEvents[0]({ type: "text", stepId: "m1", text: "\n\n新追加段落" })
  )
  await page.getByRole("button", { name: "有新内容，回到底部", exact: true }).waitFor()
  assert.ok(
    (await page.getByRole("log").evaluate((el) => el.scrollTop)) < 5,
    "Streaming never steals scroll from a reader"
  )
  await page.getByRole("button", { name: "有新内容，回到底部", exact: true }).click()
  await page.getByText("运行明细 · 1 次模型调用 · 2 次工具查询", { exact: true }).click()
  assert.equal(await page.getByText("查询参数与结果预览", { exact: true }).count(), 2)
  await page.getByText("查询参数与结果预览", { exact: true }).first().click()
  await page.screenshot({ path: join(output, "project-agent-streaming.png") })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.getByRole("button", { name: "终止任务", exact: true }).isVisible())
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390))
  const stopRect = await page.getByRole("button", { name: "终止任务", exact: true }).boundingBox()
  const phoneDialog = await page
    .getByRole("dialog", { name: "项目分析 Agent", exact: true })
    .boundingBox()
  assert.ok(
    stopRect.y >= 0 && stopRect.y + stopRect.height <= phoneDialog.y + phoneDialog.height - 10,
    "Stop stays inside the dialog with expanded run details"
  )
  await page.screenshot({ path: join(output, "project-agent-streaming-phone.png") })
  await page.getByText("运行明细 · 1 次模型调用 · 2 次工具查询", { exact: true }).click()
  await page.setViewportSize({ width: 760, height: 720 })
  await agentReply(0, "验收分析结果 [E1]")
  assert.equal(
    await page.locator('[aria-label="正在生成的分析"]').count(),
    0,
    "Final answer replaces the partial response"
  )
  await page.getByText("验收分析结果 [E1]", { exact: true }).waitFor()
  await page.getByText("数据依据（1）", { exact: true }).click()
  await page.getByText("12个项目，36个特性", { exact: true }).waitFor()
  await page.getByRole("button", { name: "复制分析结果" }).click()
  assert.equal(await page.evaluate(() => window.runQA.copied), "验收分析结果 [E1]")
  await page.getByRole("textbox", { name: "项目分析问题" }).fill("继续解释")
  await page.getByRole("button", { name: "发送", exact: true }).click()
  await waitAgent(2)
  assert.equal(
    await page.evaluate(
      () => window.runQA.calls.filter((c) => c.type === "agent")[1].request.messages.length
    ),
    2
  )
  await page.evaluate(() =>
    window.runQA.finishAgent(1, { success: false, error: "验收模型暂时不可用" })
  )
  await page.getByRole("alert").filter({ hasText: "验收模型暂时不可用" }).waitFor()
  await page.getByRole("button", { name: "重试分析", exact: true }).click()
  await waitAgent(3)
  assert.deepEqual(
    await page.evaluate(() => window.runQA.calls.filter((c) => c.type === "agent")[2].request),
    await page.evaluate(() => window.runQA.calls.filter((c) => c.type === "agent")[1].request)
  )
  await agentReply(2, "验收重试成功")
  await page.getByText("验收重试成功", { exact: true }).waitFor()
  await page.getByRole("textbox", { name: "项目分析问题" }).fill("会被停止的问题")
  await page.getByRole("button", { name: "发送", exact: true }).click()
  await waitAgent(4)
  const beforeAnalysisStop = await cancelCount("dashboard:projectModeAnalysisAgent")
  await page.getByRole("button", { name: "最小化项目分析 Agent", exact: true }).click()
  await minimizedAgent.waitFor()
  assert.equal(await cancelCount("dashboard:projectModeAnalysisAgent"), beforeAnalysisStop)
  await minimizedAgent.getByRole("button", { name: "终止任务", exact: true }).click()
  await minimizedAgent.getByText("任务已终止，展开继续", { exact: true }).waitFor()
  assert.equal(await cancelCount("dashboard:projectModeAnalysisAgent"), beforeAnalysisStop + 1)
  await page.evaluate(() =>
    window.runQA.agentEvents[3]({ type: "text", stepId: "late", text: "取消后的迟到流片段" })
  )
  assert.equal(await page.getByText("取消后的迟到流片段", { exact: false }).count(), 0)
  await agentReply(3, "这条迟到结果不能出现")
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  )
  await minimizedAgent.getByRole("button", { name: "展开项目分析 Agent", exact: true }).click()
  assert.equal(await page.getByText("这条迟到结果不能出现", { exact: true }).count(), 0)
  await page.getByRole("textbox", { name: "项目分析问题" }).fill("会被范围切换取消的问题")
  await page.getByRole("button", { name: "发送", exact: true }).click()
  await waitAgent(5)
  await page.evaluate(() => window.runQA.setRoom("E"))
  await waitLoad("E:active")
  assert.equal(await page.getByRole("heading", { name: "项目分析 Agent", exact: true }).count(), 0)
  await agentReply(4, "旧室的结果不能出现")
  await finish("E:active")
  await page.getByText("1 / 2 页 · 36条").waitFor()
  assert.equal(await tableRows.getByRole("button", { name: /^分析/ }).count(), 0)
  await page.getByRole("button", { name: "项目分析 Agent", exact: true }).click()
  await page.getByRole("textbox", { name: "项目分析问题" }).fill("分析当前范围")
  await page.getByRole("button", { name: "发送", exact: true }).click()
  await waitAgent(6)
  const scoped = await page.evaluate(
    () => window.runQA.calls.filter((c) => c.type === "agent")[5].request
  )
  assert.equal(scoped.target, undefined)
  assert.deepEqual(scoped.options.upperOrgLv1, ["E"])
  assert.deepEqual(scoped.messages, [])
  await agentReply(5, "当前范围分析 [E1]")
  await page.getByText("当前范围分析 [E1]", { exact: true }).waitFor()
  const agentRect = await page.getByRole("dialog").evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    left: el.getBoundingClientRect().left
  }))
  assert.ok(agentRect.width <= 760 && agentRect.left >= 0)
  await page.screenshot({ path: join(output, "project-agent-narrow.png") })
  await page.getByText("数据依据（1）", { exact: true }).click()
  await page.getByRole("button", { name: "查看特性诊断", exact: true }).click()
  await page.getByRole("dialog", { name: /^特性诊断/ }).waitFor()
  await page.keyboard.press("Escape")
  const analysisDialog = page.getByRole("dialog", { name: "项目分析 Agent", exact: true })
  await analysisDialog.waitFor()
  await analysisDialog.getByText("数据依据（1）", { exact: true }).click()
  await analysisDialog.getByRole("link", { name: "[E1]", exact: true }).click()
  const evidence = analysisDialog.locator('[id^="analysis-evidence-"]')
  assert.equal(await evidence.isVisible(), true, "Citation opens its evidence section")
  assert.equal(await evidence.evaluate((el) => el === document.activeElement), true)

  await page.getByRole("textbox", { name: "项目分析问题" }).fill("列出完整对比表")
  await page.getByRole("button", { name: "发送", exact: true }).click()
  await waitAgent(7)
  await agentReply(
    6,
    [
      "这是一段对比说明，应当在对话区域内换行。",
      "| 项目及特性 | 主 Agent 对话 | 有效生成行数 | Commit 采纳率 | Push 采纳率 | 最近执行 | 建议 |",
      "| --- | ---: | ---: | ---: | ---: | --- | --- |",
      ...Array.from(
        { length: 9 },
        (_, i) =>
          `| 客户经营系统特性 ${i + 1} | 32 | 12800 | 52.3% | 41.2% | 2026-11-09 16:30 | 核实实际交付情况 [E1] |`
      ),
      "",
      "表格之后的建议也应当直接可读。",
      "",
      "```text",
      "宽代码样本".repeat(80),
      "[E1]",
      "```"
    ].join("\n")
  )
  await page.getByText("表格之后的建议也应当直接可读。", { exact: true }).waitFor()
  const logWidth = await page.getByRole("log").evaluate((el) => ({
    client: el.clientWidth,
    scroll: el.scrollWidth
  }))
  assert.ok(
    logWidth.scroll <= logWidth.client + 1,
    "Wide tables must not overflow the conversation"
  )
  const tableWidth = await analysisDialog
    .locator(".streaming-markdown-table-wrap")
    .evaluate((el) => ({
      client: el.clientWidth,
      scroll: el.scrollWidth
    }))
  assert.ok(tableWidth.scroll > tableWidth.client, "Wide tables scroll inside their own container")
  assert.equal(
    await analysisDialog.locator("pre a").count(),
    0,
    "Code samples keep literal citations"
  )
  await analysisDialog
    .getByText("这是一段对比说明，应当在对话区域内换行。", { exact: true })
    .scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(output, "project-agent-wide-table.png") })

  await page.getByRole("textbox", { name: "项目分析问题" }).fill("尚未发送的问题")
  await page.keyboard.press("Escape")
  await analysisDialog.waitFor({ state: "hidden" })
  assert.equal(await tableRows.getByRole("button", { name: /^分析/ }).count(), 0)
  await page.getByRole("button", { name: "项目分析 Agent", exact: true }).click()
  await page.getByText("当前范围分析 [E1]", { exact: true }).waitFor()
  assert.equal(
    await page.getByRole("textbox", { name: "项目分析问题" }).inputValue(),
    "尚未发送的问题"
  )
  await page.getByRole("button", { name: "发送", exact: true }).click()
  await waitAgent(8)
  const beforeBackgroundAnalysis = await cancelCount("dashboard:projectModeAnalysisAgent")
  assert.ok(await page.getByRole("tab", { name: "综合报告", exact: true }).isDisabled())
  await page.getByRole("button", { name: "最小化项目分析 Agent", exact: true }).click()
  await analysisDialog.waitFor({ state: "hidden" })
  await minimizedAgent.waitFor()
  await page.getByRole("tab", { name: "项目列表", exact: true }).click()
  await page.evaluate(() => {
    window.runQA.agentEvents[7]({
      type: "text",
      stepId: "background-analysis",
      text: "最小化期间的流式内容"
    })
    window.runQA.agentEvents[7]({
      type: "step",
      step: {
        id: "background-analysis",
        kind: "model",
        title: "正在后台分析项目",
        status: "running",
        startedAt: Date.now()
      }
    })
  })
  await minimizedAgent.getByText("正在后台分析项目", { exact: true }).waitFor()
  assert.equal(await cancelCount("dashboard:projectModeAnalysisAgent"), beforeBackgroundAnalysis)
  await page.screenshot({ path: join(output, "project-agent-minimized-running.png") })
  await minimizedAgent.getByRole("button", { name: "展开项目分析 Agent", exact: true }).click()
  await page.getByText("最小化期间的流式内容", { exact: true }).waitFor()
  await analysisDialog.getByRole("button", { name: "Close", exact: true }).click()
  await analysisDialog.waitFor({ state: "hidden" })
  assert.equal(await cancelCount("dashboard:projectModeAnalysisAgent"), beforeBackgroundAnalysis)
  await agentReply(7, "后台完成的分析结果")
  await minimizedAgent.getByText("分析已完成，展开查看", { exact: true }).waitFor()
  await minimizedAgent.getByRole("button", { name: "展开项目分析 Agent", exact: true }).click()
  await page.getByText("后台完成的分析结果", { exact: true }).waitFor()
  await page.keyboard.press("Escape")
  await page.getByRole("tab", { name: "项目分析", exact: true }).click()
  assert.equal(await tableRows.getByRole("button", { name: /^分析/ }).count(), 0)
  assert.equal(
    await page.evaluate(() => window.runQA.calls.filter((call) => call.type === "agent").length),
    8
  )

  // The sole top entry retains the current filters in both feature and project views.
  await page.getByRole("combobox", { name: "当前阶段", exact: true }).selectOption("dev-编码实现")
  await page.getByRole("button", { name: "按项目", exact: true }).click()
  await page.getByRole("button", { name: "项目分析 Agent", exact: true }).click()
  await analysisDialog.getByText(/\d+ 个项目 · \d+ 个匹配特性/).waitFor()
  await analysisDialog.getByText("查看本次分析范围与筛选", { exact: false }).click()
  await analysisDialog.getByText("室：E", { exact: true }).waitFor()
  await analysisDialog.getByText("筛选：阶段：dev-编码实现", { exact: true }).waitFor()
  assert.equal(await analysisDialog.getByText("当前范围分析 [E1]", { exact: true }).count(), 0)
  await page.getByRole("textbox", { name: "项目分析问题" }).fill("分析当前筛选的匹配特性")
  await page.getByRole("button", { name: "发送", exact: true }).click()
  await waitAgent(9)
  const projectRequest = await page.evaluate(
    () => window.runQA.calls.filter((c) => c.type === "agent")[8].request
  )
  assert.equal(projectRequest.filters.stage, "dev-编码实现")
  assert.equal(projectRequest.target, undefined)
  assert.deepEqual(projectRequest.messages, [])
  await page.screenshot({ path: join(output, "project-agent-filtered-scope.png") })
  await agentReply(8, "当前筛选分析已完成")
  await page.getByText("当前筛选分析已完成", { exact: true }).waitFor()
  await page.keyboard.press("Escape")
  assert.ok(
    (await page.evaluate(
      () =>
        window.runQA.calls.filter(
          (c) => c.type === "cancel" && c.families.includes("dashboard:projectModeAnalysisAgent")
        ).length
    )) >= 2
  )
  assert.equal(
    await page.evaluate(
      () => window.runQA.calls.filter((call) => call.type === "reportWorkspace").length
    ),
    0,
    "Analysis must not eagerly load report history or templates"
  )
  const waitReport = (count) =>
    page.waitForFunction(
      (count) =>
        window.runQA.calls.filter((call) => call.type === "reportGenerate").length === count,
      count
    )
  const reportRequest = (index) =>
    page.evaluate(
      (index) => window.runQA.calls.filter((call) => call.type === "reportGenerate")[index].request,
      index
    )
  const replyReport = (index, id, version, scope, persist = true) =>
    page.evaluate(
      ({ index, id, version, scope, persist }) =>
        window.runQA.finishReport(
          index,
          {
            success: true,
            data: window.runQA.makeReport(id, version, scope)
          },
          persist
        ),
      { index, id, version, scope, persist }
    )
  const choose = async (label, option) => {
    await page.getByRole("combobox", { name: label, exact: true }).click()
    await page.getByRole("option", { name: option, exact: typeof option === "string" }).click()
  }
  const reportFrame = () => page.frameLocator('[aria-label="报告 HTML 预览"] iframe')
  const waitReportVersion = (version) =>
    reportFrame()
      .getByRole("heading", { name: "报告版本 " + version, exact: true })
      .waitFor()
  const expectReportLayout = async (width, screenshot) => {
    await page.setViewportSize({ width, height: 960 })
    await analysisDialog.waitFor()
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[role="dialog"]')
      if (!dialog) return false
      const bounds = dialog.getBoundingClientRect()
      return bounds.left >= 0 && bounds.right <= innerWidth + 1
    })
    const bounds = await analysisDialog.evaluate((element) => ({
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      client: element.clientWidth,
      scroll: element.scrollWidth
    }))
    assert.ok(
      bounds.left >= 0 && bounds.right <= width + 1,
      "Report dialog remains inside viewport: " + JSON.stringify(bounds)
    )
    assert.ok(bounds.scroll <= bounds.client + 1, "Report controls must not overflow")
    const bodyBounds = await page
      .getByTestId("project-report-body")
      .evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }))
    assert.ok(bodyBounds.scroll <= bodyBounds.client + 1, "Report body must not overflow")
    const preview = page.locator('[aria-label="报告 HTML 预览"]')
    if (await preview.count()) {
      const frameWidth = await preview
        .locator("iframe")
        .evaluate((element) => element.getBoundingClientRect().width)
      const containerWidth = await preview.evaluate(
        (element) => element.getBoundingClientRect().width
      )
      assert.ok(frameWidth <= containerWidth, "HTML preview uses available report width")
    }
    await page.screenshot({ path: join(output, screenshot) })
  }

  await page.getByRole("button", { name: "项目分析 Agent", exact: true }).click()
  await page.getByRole("tab", { name: "综合报告", exact: true }).click()
  await page
    .getByText("报告覆盖所选室在周期内的全部项目活动（含归档）。当前列表筛选不影响报告。", {
      exact: true
    })
    .waitFor()
  assert.equal(
    await page.getByRole("textbox", { name: "报告所属室", exact: true }).inputValue(),
    "E"
  )
  assert.equal(
    await page.getByRole("textbox", { name: "报告所属室", exact: true }).isDisabled(),
    true,
    "Non-admin room is locked"
  )
  const templateSelector = page.getByRole("combobox", { name: "报告模板", exact: true })
  assert.match(await templateSelector.innerText(), /室级综合运营报告 · 内置推荐/)
  assert.equal(await page.getByRole("button", { name: "更多模板操作", exact: true }).count(), 0)
  await templateSelector.click()
  assert.equal(await page.getByRole("option").first().innerText(), "室级综合运营报告 · 内置推荐")
  await page.keyboard.press("Escape")
  const defaultWeek = await page.getByLabel("报告周内日期", { exact: true }).inputValue()
  const defaultStart = Date.parse(defaultWeek + "T00:00:00+08:00")
  assert.equal(new Date(defaultWeek + "T00:00:00Z").getUTCDay(), 1, "Default week starts on Monday")
  assert.ok(defaultStart + 7 * 86400000 <= Date.now(), "Default is a complete past week")
  assert.ok(defaultStart + 14 * 86400000 > Date.now(), "Default is the most recent complete week")
  await page.getByLabel("报告周内日期", { exact: true }).fill("2026-11-02")
  await page
    .getByRole("textbox", { name: "报告生成要求", exact: true })
    .fill("突出个人贡献和知识调用")
  await expectReportLayout(390, "project-report-create-mobile.png")
  await page.getByRole("button", { name: "生成报告", exact: true }).click()
  await waitReport(1)
  const created = await reportRequest(0)
  assert.deepEqual(
    created,
    {
      action: "create",
      scope: { upperOrgLv1: "E", period: { kind: "week", anchorDate: "2026-11-02" } },
      instruction: "突出个人贡献和知识调用",
      templateId: await page.evaluate(() => window.runQA.recommendedId)
    },
    "Report request must not inherit project target, membership or list filters"
  )
  const beforeBackgroundReport = await cancelCount("dashboard:projectReportGenerate")
  assert.ok(await page.getByRole("tab", { name: "项目分析", exact: true }).last().isDisabled())
  await page.getByRole("button", { name: "最小化项目分析 Agent", exact: true }).click()
  await analysisDialog.waitFor({ state: "hidden" })
  await minimizedAgent.waitFor()
  await page.getByRole("tab", { name: "项目列表", exact: true }).click()
  await page.evaluate(() =>
    window.runQA.reportEvents[0]({
      type: "step",
      step: {
        id: "background-report",
        kind: "model",
        title: "正在后台生成 HTML",
        status: "running",
        startedAt: Date.now()
      }
    })
  )
  await minimizedAgent.getByText("正在后台生成 HTML", { exact: true }).waitFor()
  const dockBounds = await minimizedAgent.boundingBox()
  assert.ok(dockBounds.x >= 0 && dockBounds.x + dockBounds.width <= 390)
  await page.screenshot({ path: join(output, "project-report-minimized-phone.png") })
  await page.getByRole("tab", { name: "项目分析", exact: true }).click()
  // Filtering the underlying list must not discard the independent report task.
  await page.getByRole("textbox", { name: "项目或特性关键词", exact: true }).fill("渠道")
  assert.equal(await cancelCount("dashboard:projectReportGenerate"), beforeBackgroundReport)
  await replyReport(0, "report-1", 1, created.scope)
  await minimizedAgent.getByText("报告已生成，展开查看", { exact: true }).waitFor()
  await page.getByRole("textbox", { name: "项目或特性关键词", exact: true }).fill("")
  await minimizedAgent.getByRole("button", { name: "展开项目分析 Agent", exact: true }).click()
  await waitReportVersion(1)
  assert.equal(await reportFrame().locator("body").getAttribute("data-isolated"), "yes")
  assert.equal(
    await page.locator('[aria-label="报告 HTML 预览"] iframe').getAttribute("sandbox"),
    "allow-scripts"
  )
  await expectReportLayout(760, "project-report-preview-narrow.png")
  await expectReportLayout(390, "project-report-preview-mobile.png")
  await page.getByRole("textbox", { name: "报告修改要求", exact: true }).fill("把成员贡献改成表格")
  await page.getByRole("button", { name: "应用修改", exact: true }).click()
  await waitReport(2)
  assert.deepEqual(await reportRequest(1), {
    action: "revise",
    reportId: "report-1",
    baseVersion: 1,
    instruction: "把成员贡献改成表格"
  })
  await page.evaluate(() =>
    window.runQA.finishReport(1, { success: false, error: "验收报告模型暂时不可用" })
  )
  await page.getByRole("alert").filter({ hasText: "验收报告模型暂时不可用" }).waitFor()
  await waitReportVersion(1)
  await page.getByRole("button", { name: "重试生成", exact: true }).click()
  await waitReport(3)
  assert.deepEqual(await reportRequest(2), await reportRequest(1))
  await replyReport(2, "report-1", 2, created.scope)
  await waitReportVersion(2)
  await choose("报告版本", "版本 v1")
  await waitReportVersion(1)
  await page.getByRole("textbox", { name: "报告修改要求", exact: true }).fill("会被主动停止的修改")
  await page.getByRole("button", { name: "应用修改", exact: true }).click()
  await waitReport(4)
  assert.equal((await reportRequest(3)).baseVersion, 1, "Revision uses the selected older version")
  await page.getByRole("button", { name: "终止任务", exact: true }).click()
  await replyReport(3, "report-1", 3, created.scope, false)
  await waitReportVersion(1)
  assert.equal(
    await page.getByRole("textbox", { name: "报告修改要求", exact: true }).isEnabled(),
    true,
    "Stopping must restore the editor without resubmitting its draft"
  )
  assert.equal(
    await page.evaluate(
      () => window.runQA.calls.filter((call) => call.type === "reportGenerate").length
    ),
    4
  )
  await page
    .getByRole("textbox", { name: "报告修改要求", exact: true })
    .fill("关闭后保留的修改草稿")
  await page.keyboard.press("Escape")
  await analysisDialog.waitFor({ state: "hidden" })
  await page.getByRole("button", { name: "项目分析 Agent", exact: true }).click()
  await waitReportVersion(1)
  assert.equal(
    await page.getByRole("textbox", { name: "报告修改要求", exact: true }).inputValue(),
    "关闭后保留的修改草稿"
  )
  await page.getByRole("tab", { name: "项目分析", exact: true }).click()
  await page.getByRole("textbox", { name: "项目分析问题" }).waitFor()
  await page.getByRole("tab", { name: "综合报告", exact: true }).click()
  await waitReportVersion(1)
  assert.equal(
    await page.evaluate(
      () => window.runQA.calls.filter((call) => call.type === "reportWorkspace").length
    ),
    1
  )
  await page.getByRole("button", { name: "应用修改", exact: true }).click()
  await waitReport(5)
  const beforeBackgroundFailure = await cancelCount("dashboard:projectReportGenerate")
  await page.keyboard.press("Escape")
  await analysisDialog.waitFor({ state: "hidden" })
  assert.equal(await cancelCount("dashboard:projectReportGenerate"), beforeBackgroundFailure)
  await page.evaluate(() =>
    window.runQA.finishReport(4, { success: false, error: "后台报告生成失败，原版本仍可查看" })
  )
  await minimizedAgent.getByText("任务未完成，展开查看原因", { exact: true }).waitFor()
  await minimizedAgent.getByRole("button", { name: "展开项目分析 Agent", exact: true }).click()
  await waitReportVersion(1)
  await page.getByRole("alert").filter({ hasText: "后台报告生成失败，原版本仍可查看" }).waitFor()

  await page.getByRole("button", { name: "保存为我的模板", exact: true }).click()
  const templateDialog = page.getByRole("dialog", { name: "保存为我的模板", exact: true })
  await templateDialog.getByRole("textbox", { name: "模板名称", exact: true }).fill("我的贡献简报")
  await templateDialog
    .getByRole("textbox", { name: "模板偏好", exact: true })
    .fill("先概览，再成员贡献；控制在三屏内")
  await templateDialog.getByRole("button", { name: "保存模板", exact: true }).click()
  await templateDialog.waitFor({ state: "hidden" })
  assert.deepEqual(
    await page.evaluate(
      () => window.runQA.calls.find((call) => call.type === "reportSaveTemplate").request
    ),
    {
      reportId: "report-1",
      version: 1,
      name: "我的贡献简报",
      preferences: "先概览，再成员贡献；控制在三屏内"
    }
  )
  assert.equal(
    await page.evaluate(
      () => window.runQA.calls.filter((call) => call.type === "reportGenerate").length
    ),
    5,
    "Saving a template must not invoke the model"
  )
  await page.getByRole("button", { name: "下载 HTML", exact: true }).click()
  await page.getByText("HTML 已保存：/tmp/验收报告.html", { exact: true }).waitFor()
  assert.deepEqual(
    await page.evaluate(
      () => window.runQA.calls.find((call) => call.type === "reportExport").request
    ),
    { reportId: "report-1", version: 1 }
  )

  await page.getByRole("button", { name: "新报告", exact: true }).click()
  await templateSelector.click()
  assert.equal(await page.getByRole("option").first().innerText(), "室级综合运营报告 · 内置推荐")
  await page.keyboard.press("Escape")
  await choose("报告周期", "自然月")
  await page.getByLabel("报告月份", { exact: true }).fill("2026-11")
  await page.getByRole("button", { name: "生成报告", exact: true }).click()
  await waitReport(6)
  const monthRequest = await reportRequest(5)
  assert.deepEqual(monthRequest.scope, {
    upperOrgLv1: "E",
    period: { kind: "month", month: "2026-11" }
  })
  assert.equal(monthRequest.templateId, "template-1")
  assert.equal(monthRequest.instruction, "", "Brief generation requirements are optional")
  await page.getByLabel("报告月份", { exact: true }).fill("2026-10")
  await replyReport(5, "ignored-month", 1, monthRequest.scope, false)
  assert.equal(
    await page.locator('[aria-label="报告 HTML 预览"]').count(),
    0,
    "Changing the period ignores a late create response"
  )
  await choose("最近报告", /E · 综合周报/)
  await waitReportVersion(2)
  await page.getByRole("button", { name: "新报告", exact: true }).click()
  await page.getByRole("button", { name: "生成报告", exact: true }).click()
  await waitReport(7)
  const octoberRequest = await reportRequest(6)
  await replyReport(6, "report-2", 1, octoberRequest.scope)
  await waitReportVersion(1)
  await page.getByRole("button", { name: "新报告", exact: true }).click()
  await page.getByRole("button", { name: "更多模板操作", exact: true }).click()
  await page.getByRole("button", { name: "删除选中的模板", exact: true }).click()
  await page
    .getByRole("dialog", { name: "删除我的模板", exact: true })
    .getByRole("button", { name: "确认删除", exact: true })
    .click()
  await page.getByText("模板已删除，已生成的报告不受影响", { exact: true }).waitFor()
  assert.match(await templateSelector.innerText(), /室级综合运营报告 · 内置推荐/)
  assert.equal(await page.getByRole("button", { name: "更多模板操作", exact: true }).count(), 0)

  await choose("最近报告", /E · 综合月报/)
  await page.getByRole("button", { name: "更多报告操作", exact: true }).click()
  await page.getByRole("button", { name: "删除报告及其版本", exact: true }).click()
  await page
    .getByRole("dialog", { name: "删除报告", exact: true })
    .getByRole("button", { name: "确认删除", exact: true })
    .click()
  await page.getByText("报告及其版本已删除", { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.runQA.reportDocs.has("report-2")), false)
  assert.equal(await page.evaluate(() => window.runQA.reportDocs.has("report-1")), true)

  await page.evaluate(() => {
    window.runQA.reportWorkspace.canChooseRoom = true
    window.runQA.reportWorkspace.rooms = []
    window.runQA.setRoom("F")
  })
  await waitLoad("F:active")
  await finish("F:active")
  await page.getByRole("button", { name: "项目分析 Agent", exact: true }).click()
  await page.getByRole("tab", { name: "综合报告", exact: true }).click()
  const adminRoom = page.getByRole("combobox", { name: "报告所属室", exact: true })
  await adminRoom.waitFor()
  assert.equal(await adminRoom.inputValue(), "F", "Admin defaults to the selected dashboard room")
  assert.equal(await adminRoom.isEnabled(), true)
  await adminRoom.fill("手动输入的研发室")
  await choose("报告模板", "自由生成 · 由 Agent 设计")
  await page.getByRole("button", { name: "生成报告", exact: true }).click()
  await waitReport(8)
  const adminRequest = await reportRequest(7)
  assert.equal(adminRequest.templateId, undefined, "Free design must not pass a template")
  assert.equal(
    adminRequest.scope.upperOrgLv1,
    "手动输入的研发室",
    "Admin may enter an exact room when room listing is unavailable"
  )
  await replyReport(7, "report-3", 1, adminRequest.scope)
  await waitReportVersion(1)
  await page
    .getByRole("textbox", { name: "报告修改要求", exact: true })
    .fill("外层切换室后不能出现")
  await page.getByRole("button", { name: "应用修改", exact: true }).click()
  await waitReport(9)
  await page.evaluate(() => {
    window.runQA.workspaceFailure = true
    window.runQA.setRoom("G")
  })
  await waitLoad("G:active")
  await replyReport(8, "report-3", 2, adminRequest.scope, false)
  await finish("G:active")
  await page.getByRole("button", { name: "项目分析 Agent", exact: true }).click()
  await page.getByRole("tab", { name: "综合报告", exact: true }).click()
  await page.getByRole("alert").filter({ hasText: "验收工作区暂时不可用" }).waitFor()
  await page.evaluate(() => {
    window.runQA.workspaceFailure = false
  })
  await page.getByRole("button", { name: "重试加载", exact: true }).click()
  await page.getByRole("combobox", { name: "报告所属室", exact: true }).waitFor()
  await choose("最近报告", /手动输入的研发室 · 综合周报/)
  await waitReportVersion(1)
  await expectReportLayout(760, "project-report-history-narrow.png")
  assert.ok(
    (await page.evaluate(
      () =>
        window.runQA.calls.filter(
          (call) =>
            call.type === "cancel" && call.families.includes("dashboard:projectReportGenerate")
        ).length
    )) >= 3
  )
  assert.equal(
    await page.locator("body").getAttribute("data-report-access"),
    null,
    "HTML report must not access the renderer document"
  )
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "项目分析 Agent", exact: true }).click()
  await page.getByRole("tab", { name: "综合报告", exact: true }).click()
  await page
    .getByRole("textbox", { name: "报告修改要求", exact: true })
    .fill("修改日期后也要保留的报告草稿")
  await page.getByRole("tab", { name: "项目分析", exact: true }).click()
  await analysisDialog
    .getByRole("combobox", { name: "查看范围", exact: true })
    .selectOption("executed")
  await waitLoad("G:executed")
  await finish("G:executed")
  // Both surfaces use the dashboard's day/week/month navigation and one state.
  for (const [label, value] of [
    ["日", "day"],
    ["周", "week"],
    ["月", "month"]
  ]) {
    await analysisDialog.getByRole("button", { name: label, exact: true }).click()
    await waitLoad("G:executed")
    assert.equal(await page.evaluate(() => window.runQA.granularity), value)
    assert.equal(
      await page
        .getByTestId("dashboard-time-control")
        .getByRole("button", { name: label, exact: true, includeHidden: true })
        .getAttribute("aria-pressed"),
      "true"
    )
    await finish("G:executed")
  }
  const currentMonth = await page.evaluate(() => window.runQA.timeRange)
  await analysisDialog.getByRole("button", { name: "上一周期", exact: true }).click()
  await waitLoad("G:executed")
  assert.ok(
    Date.parse((await page.evaluate(() => window.runQA.timeRange)).to) <
      Date.parse(currentMonth.from)
  )
  await finish("G:executed")
  await analysisDialog.getByRole("button", { name: "下一周期", exact: true }).click()
  await waitLoad("G:executed")
  assert.equal((await page.evaluate(() => window.runQA.timeRange)).from, currentMonth.from)
  await finish("G:executed")
  const agentBase = await page.evaluate(
    () => window.runQA.calls.filter((c) => c.type === "agent").length
  )
  await page.getByRole("textbox", { name: "项目分析问题", exact: true }).fill("旧范围回答")
  await page.getByRole("button", { name: "发送", exact: true }).click()
  await waitAgent(agentBase + 1)
  await agentReply(agentBase, "旧范围分析结论")
  await page.getByText("旧范围分析结论", { exact: true }).waitFor()
  await page.getByRole("textbox", { name: "项目分析问题", exact: true }).fill("新范围待发送问题")
  const loadCount = await page.evaluate(
    () => window.runQA.calls.filter((c) => c.type === "load").length
  )
  await analysisDialog.getByRole("button", { name: "自定义", exact: true }).click()
  await analysisDialog.getByLabel("开始日期", { exact: true }).fill("2026-11-12")
  await analysisDialog.getByLabel("结束日期", { exact: true }).fill("2026-11-01")
  await analysisDialog.getByRole("button", { name: "确认", exact: true }).click()
  await analysisDialog.getByText("结束日期不能早于开始日期", { exact: true }).waitFor()
  await analysisDialog.getByLabel("开始日期", { exact: true }).fill("2026-01-01")
  await analysisDialog.getByRole("button", { name: "确认", exact: true }).click()
  await analysisDialog.getByText("自定义范围最多选择 92 天", { exact: true }).waitFor()
  assert.equal(
    await page.evaluate(() => window.runQA.calls.filter((c) => c.type === "load").length),
    loadCount,
    "Invalid or unconfirmed dates must not change the shared range"
  )
  await analysisDialog.getByText("旧范围分析结论", { exact: true }).waitFor()
  await analysisDialog.getByLabel("开始日期", { exact: true }).fill("2026-11-01")
  await analysisDialog.getByLabel("结束日期", { exact: true }).fill("2026-11-07")
  const customViewport = page.viewportSize()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.screenshot({ path: join(output, "project-agent-shared-filter-custom.png") })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: join(output, "project-agent-shared-filter-custom-phone.png") })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390))
  const customComposer = await page
    .getByRole("textbox", { name: "项目分析问题", exact: true })
    .boundingBox()
  const customDialog = await analysisDialog.boundingBox()
  assert.ok(
    customComposer.y + customComposer.height <= customDialog.y + customDialog.height,
    "Custom dates must leave the composer accessible"
  )
  await page.setViewportSize(customViewport)
  await page.evaluate(() => {
    window.runQA.newProjectIds = true
  })
  await analysisDialog.getByRole("button", { name: "确认", exact: true }).click()
  await waitLoad("G:executed")
  await analysisDialog.waitFor()
  assert.equal(
    await page.getByText("旧范围分析结论", { exact: true }).count(),
    0,
    "Changing dates clears only the old analysis history"
  )
  assert.equal(
    await page.getByRole("textbox", { name: "项目分析问题", exact: true }).inputValue(),
    "新范围待发送问题"
  )
  assert.equal(
    await page.getByRole("button", { name: "发送", exact: true }).isDisabled(),
    true,
    "Old counts cannot allow analysis while new scope is loading"
  )
  await finish("G:executed")
  await page.getByRole("button", { name: "发送", exact: true }).click()
  await waitAgent(agentBase + 2)
  const dated = await page.evaluate(
    () => window.runQA.calls.filter((c) => c.type === "agent").at(-1).request
  )
  assert.deepEqual(dated.range, {
    from: "2026-10-31T16:00:00.000Z",
    to: "2026-11-07T15:59:59.999Z"
  })
  assert.deepEqual(dated.range, await page.evaluate(() => window.runQA.timeRange))
  assert.match(
    await page.getByTestId("dashboard-time-control").textContent(),
    /2026-11-01 ~ 2026-11-07/
  )
  assert.equal(dated.options.membership, "executed")
  assert.deepEqual(dated.messages, [])
  await page.evaluate((index) => {
    const qa = window.runQA,
      request = qa.calls.filter((c) => c.type === "agent").at(-1).request
    const row = qa.loadedRows.find(
      (row) => !request.filters.stage || row.currentStage === request.filters.stage
    )
    qa.finishAgent(index, {
      success: true,
      data: {
        content: "新范围分析结果 [E1]",
        modelName: "验收流式模型",
        dataAsOf: new Date().toISOString(),
        projectCount: 12,
        featureCount: 36,
        exampleData: true,
        toolCalls: [],
        evidence: [
          {
            id: "E1",
            label: "新范围证据",
            summary: "来自新的日期范围",
            target: { projectId: row.projectId, featureSlug: row.featureSlug }
          }
        ]
      }
    })
  }, agentBase + 1)
  await page.getByText("新范围分析结果 [E1]", { exact: true }).waitFor()
  await page.getByText("数据依据（1）", { exact: true }).click()
  await page.getByRole("button", { name: "查看特性诊断", exact: true }).click()
  await page.getByRole("dialog", { name: /^特性诊断/ }).waitFor()
  assert.match(
    await page.evaluate(
      () => window.runQA.calls.filter((c) => c.type === "stages").at(-1).request.projectId
    ),
    /^period-/,
    "Diagnosis must use the refreshed project list"
  )
  await page.keyboard.press("Escape")
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: join(output, "project-agent-date-scope-phone.png") })
  const composer = await page
    .getByRole("textbox", { name: "项目分析问题", exact: true })
    .boundingBox()
  const scopedDialog = await analysisDialog.boundingBox()
  assert.ok(
    composer.y + composer.height <= scopedDialog.y + scopedDialog.height,
    "Date controls leave the composer accessible"
  )
  await page.getByRole("tab", { name: "综合报告", exact: true }).click()
  await waitReportVersion(1)
  assert.equal(
    await page.getByRole("textbox", { name: "报告修改要求", exact: true }).inputValue(),
    "修改日期后也要保留的报告草稿"
  )
  await page.keyboard.press("Escape")
  await page
    .getByTestId("dashboard-time-control")
    .getByRole("button", { name: "周", exact: true })
    .click()
  await waitLoad("G:executed")
  await finish("G:executed")
  await page.getByRole("button", { name: "项目分析 Agent", exact: true }).click()
  await page.getByRole("tab", { name: "项目分析", exact: true }).click()
  assert.equal(
    await analysisDialog
      .getByRole("button", { name: "周", exact: true })
      .getAttribute("aria-pressed"),
    "true"
  )
  assert.equal(
    await analysisDialog.getByRole("button", { name: "近 7 天", exact: true }).count(),
    0
  )
  await page.getByRole("tab", { name: "综合报告", exact: true }).click()
  assert.equal(
    await page.getByRole("textbox", { name: "报告修改要求", exact: true }).inputValue(),
    "修改日期后也要保留的报告草稿"
  )
  await page.keyboard.press("Escape")
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
          "narrow viewport",
          "comparison/range filtering",
          "project agent scope/history/retry/cancellation",
          "citation navigation",
          "SSE text arrives before completion and cancelled events are ignored",
          "run details with tool arguments/results and mobile controls",
          "streaming does not steal scroll position",
          "dialog date changes reload scope and preserve report drafts",
          "shared dashboard day/week/month/custom controls, navigation, validation and synchronized state",
          "overview refresh/failure does not unmount the Agent workspace",
          "diagnosis targets the refreshed scoped list",
          "wide reply table/code containment",
          "close/reopen draft preservation",
          "minimize/close/Escape preserve running analysis and reports, streamed progress and final results",
          "minimized tasks survive project-list tabs and report tasks survive list filters",
          "explicit task termination ignores late stream and completion events",
          "minimized report failure preserves the previous version and exposes the error on restore",
          "filtered project scope disclosure",
          "lazy report workspace and recoverable load failure",
          "full-room natural-week/month scope independent of filters",
          "frozen-data report revision/version/retry/cancellation",
          "report close/reopen draft and successful version preservation",
          "HTML sandbox preview at 760px/390px",
          "template save/reuse/delete without model calls",
          "exact-version export and report deletion",
          "locked own room and administrator manual room fallback"
        ]
      },
      null,
      2
    )
  )
  console.log(
    "Run analysis browser acceptance passed: existing analysis checks plus full-room reports, version/retry/cancellation, templates, export, sandbox preview and 760px/390px layouts."
  )
} finally {
  await browser.close()
}
