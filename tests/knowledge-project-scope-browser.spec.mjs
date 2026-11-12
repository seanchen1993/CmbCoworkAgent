import assert from "node:assert/strict"
import { resolve } from "node:path"
import { existsSync } from "node:fs"
import { build } from "esbuild"
import { chromium } from "playwright"

// Local fixtures only. No Elasticsearch or knowledge service connections.
const renderer = resolve("src/renderer/src")
const bundle = await build({
  stdin: {
    resolveDir: renderer,
    loader: "tsx",
    contents: `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useKnowledgeOverview} from './components/dashboard/use-knowledge-overview';
import {KnowledgeOverviewPanel} from './components/dashboard/panels/KnowledgeOverviewPanel';
import {TooltipProvider} from './components/ui/tooltip';
const qa=window.qa={calls:[],pending:[]};
window.api={dashboard:{
 knowledgeProjectStats:(range,opts)=>{qa.calls.push({kind:'projects',range,opts});return new Promise(resolve=>qa.pending.push(resolve))},
 knowledgeAccumulation:async()=>{qa.calls.push({kind:'accumulation'});return {success:true,data:{totals:{totalNum:0,abandonedNum:0,activeNum:0},users:[],orgs:[],systems:[],errors:{}}}},
 knowledgeRecentConstraintFiles:async()=>{qa.calls.push({kind:'recent'});return {success:true,data:{fileCount:0,complete:true}}},
 cancelRequests:async()=>{}
}};
qa.finish=(index,n)=>qa.pending[index]({success:true,data:{projectCount:n,loadedProjectCount:n,readProjectCount:n,successfulReadCount:n}});
function App(){
 const [range,setRange]=useState({from:'2026-10-01',to:'2026-10-31'});
 const [rooms,setRooms]=useState(['A']); const [created,setCreated]=useState(false);
 qa.setRange=setRange;qa.setRooms=setRooms;
 const data=useKnowledgeOverview(true,range,rooms,0,created);
 return <TooltipProvider><KnowledgeOverviewPanel {...data} rooms={rooms} refreshKey={0} rate={null} rateLoading={false} rateError={null} createdInRangeOnly={created} onCreatedInRangeOnlyChange={setCreated}/></TooltipProvider>
}
createRoot(document.getElementById('root')).render(<App/>);
`
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  alias: { "@": renderer },
  loader: { ".png": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" }
})
const browser = await chromium.launch({
  headless: true,
  ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
})
try {
  const page = await browser.newPage()
  const errors = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const count = () =>
    page.evaluate(() => window.qa.calls.filter((c) => c.kind === "projects").length)
  const waitCount = (n) =>
    page.waitForFunction(
      (n) => window.qa.calls.filter((c) => c.kind === "projects").length === n,
      n
    )
  const settle = () =>
    page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await waitCount(1)
  assert.equal(
    await page
      .getByRole("button", { name: "仅本期新建", exact: true })
      .getAttribute("aria-pressed"),
    "false"
  )
  assert.equal(
    await page.evaluate(() => window.qa.calls.find((c) => c.kind === "projects").range),
    null
  )
  await page.evaluate(() => window.qa.setRange({ from: "2026-09-01", to: "2026-09-30" }))
  await settle()
  assert.equal(await count(), 1)
  await page.getByRole("button", { name: "仅本期新建", exact: true }).click()
  await waitCount(2)
  assert.deepEqual(
    await page.evaluate(() => window.qa.calls.filter((c) => c.kind === "projects").at(-1).range),
    { from: "2026-09-01", to: "2026-09-30" }
  )
  await page.evaluate(() => window.qa.finish(0, 101))
  await settle()
  assert.equal(await page.getByText("101", { exact: true }).count(), 0)
  await page.evaluate(() => window.qa.finish(1, 23))
  await page.getByText("23", { exact: true }).first().waitFor()
  await page.evaluate(() => window.qa.setRange({ from: "2026-08-01", to: "2026-08-31" }))
  await waitCount(3)
  await page.getByRole("button", { name: "仅本期新建", exact: true }).click()
  await waitCount(4)
  await page.evaluate(() => window.qa.finish(2, 99))
  await settle()
  assert.equal(await page.getByText("99", { exact: true }).count(), 0)
  await page.evaluate(() => window.qa.finish(3, 101))
  await page.getByText("101", { exact: true }).first().waitFor()
  const related = await page.evaluate(() => window.qa.calls.filter((c) => c.kind !== "projects"))
  assert.deepEqual(related.map((c) => c.kind).sort(), ["accumulation", "recent"])
  await page.evaluate(() => window.qa.setRooms(["B"]))
  await waitCount(5)
  assert.deepEqual(
    await page.evaluate(
      () => window.qa.calls.filter((c) => c.kind === "projects").at(-1).opts.upperOrgLv1
    ),
    ["B"]
  )
  assert.deepEqual(errors, [])
  console.log(
    "Knowledge scope browser checks passed: default lifetime, date-query isolation, created toggle, stale-response isolation, room scope, unrelated metrics preserved."
  )
} finally {
  await browser.close()
}
