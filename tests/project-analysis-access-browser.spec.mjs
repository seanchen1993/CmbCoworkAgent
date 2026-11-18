import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

const renderer = resolve("src/renderer/src")
const bundle = await build({
  stdin: {
    resolveDir: renderer,
    loader: "tsx",
    contents: `
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {ProjectModePanel} from './components/dashboard/panels/ProjectModePanel';
      import {ProjectAgentWorkspaceHost} from './components/dashboard/ProjectAgentWorkspaceHost';
      import {TooltipProvider} from './components/ui/tooltip';
      import {makeMockRunAnalysis} from '../../main/ipc/project-run-analysis-mock';
      const qa=window.accessQA={loads:0};
      window.api={dashboard:{
        projectModeRunAnalysis:async (range,options)=>{
          qa.loads++;
          return {success:true,data:makeMockRunAnalysis(range,options)};
        },
        cancelRequests:async()=>({cancelled:0})
      }};
      function App(){
        const [allowed,setAllowed]=useState(false);qa.setAllowed=setAllowed;
        return <TooltipProvider><ProjectModePanel data={null} loading={false} error={null}
          codeSource={null} codeStatsOverride={null} codeStatsLoading={false} onCodeSourceChange={()=>{}}
          createdInRangeProjectsOnly={false} runAnalysisAllowed={allowed}
          runAnalysisRange={{from:'2020-01-01T00:00:00Z',to:'2030-01-01T00:00:00Z'}}
          runAnalysisTimeControl={{granularity:'custom',onGranularityChange:()=>{},onNavigate:()=>{},onCustomRange:()=>{}}}
          runAnalysisOptions={{}} projectPages={{}} projectPageLoading={{active:false,archived:false}}
          projectPageError={{}} onProjectPageChange={()=>{}} onOpenTraces={()=>{}}
          onOpenFeatureCommits={()=>{}} onOpenProjectCommits={()=>{}} loadFeatureNodes={async()=>[]}
          loadOperationalDetails={async()=>null} loadStageAnalysis={async()=>null}
          loadPluginAggregate={async()=>[]} fetchAdapterProjectPage={async()=>null}/>
          <ProjectAgentWorkspaceHost enabled accountRevision={0}/></TooltipProvider>
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
      name: "unused-preview-worker",
      setup(build) {
        build.onResolve({ filter: /\?worker$/ }, (args) => ({
          path: args.path,
          namespace: "unused-worker"
        }))
        build.onLoad({ filter: /.*/, namespace: "unused-worker" }, () => ({
          contents: "export default class {}",
          loader: "js"
        }))
      }
    }
  ],
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env": JSON.stringify({ DEV: false, VITE_PROJECT_ANALYSIS_AGENT_ENABLED: "false" })
  }
})
const browser = await chromium.launch({
  ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }),
  headless: true
})
try {
  const page = await browser.newPage()
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body><div id="root"></div></body></html>'
    })
  )
  await page.goto("http://localhost:41739/access")
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const analysis = page.getByRole("tab", { name: "项目分析", exact: true })
  const list = page.getByRole("tab", { name: "项目列表", exact: true })
  await list.waitFor()
  assert.equal(await analysis.count(), 0)
  assert.equal(await page.evaluate(() => window.accessQA.loads), 0)
  await page.evaluate(() => window.accessQA.setAllowed(true))
  await analysis.click()
  await page.getByText("1 / 2 页 · 30条").waitFor()
  assert.equal(await page.getByRole("button", { name: "项目分析 Agent", exact: true }).count(), 0)
  assert.equal(await page.getByRole("dialog").count(), 0)
  assert.equal(await page.getByRole("button", { name: "导出Excel", exact: true }).isEnabled(), true)
  const loads = await page.evaluate(() => window.accessQA.loads)
  await page.evaluate(() => window.accessQA.setAllowed(false))
  await page.getByRole("region", { name: "项目分析", exact: true }).waitFor({ state: "detached" })
  assert.equal(await analysis.count(), 0)
  assert.equal(await list.getAttribute("aria-selected"), "true")
  assert.equal(await page.evaluate(() => window.accessQA.loads), loads)
  assert.deepEqual(errors, [])
  console.log(
    "Project analysis visibility, permission revocation and disabled Agent browser checks passed."
  )
} finally {
  await browser.close()
}
