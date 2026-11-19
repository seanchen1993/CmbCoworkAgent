import assert from "node:assert/strict"
import { join, resolve } from "node:path"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"

// Local fixtures only. No Elasticsearch or knowledge service connections.
const renderer = resolve("src/renderer/src")
const output = resolve("output/knowledge-user-details")
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
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useKnowledgeOverview} from './components/dashboard/use-knowledge-overview';
import {KnowledgeOverviewPanel} from './components/dashboard/panels/KnowledgeOverviewPanel';
import {TooltipProvider} from './components/ui/tooltip';
const qa=window.qa={calls:[],pending:[],userPending:[],deferUsers:false,exports:[]};
qa.users=Array.from({length:45},(_,i)=>({
 userName:'演示用户'+(i+1),roomName:['零售信息应用开发六室(杭州)','零售基础客群经营开发室(成都)','演示开发一室'][i%3],
 totalNum:100+i*10,abandonedNum:i%7,recentNum:90-i,updateActiveNum:i%11,readActiveNum:i%13
}));
window.api={dashboard:{
 knowledgeProjectStats:(range,opts)=>{qa.calls.push({kind:'projects',range,opts});return new Promise(resolve=>qa.pending.push(resolve))},
 knowledgeAccumulation:async()=>{qa.calls.push({kind:'accumulation'});return {success:true,data:{totals:{totalNum:0,abandonedNum:0,activeNum:0},users:[],orgs:[],systems:[],errors:{}}}},
 knowledgeRecentConstraintFiles:async()=>{qa.calls.push({kind:'recent'});return {success:true,data:{fileCount:0,complete:true}}},
 knowledgeUserDetails:async(opts)=>{qa.calls.push({kind:'userDetails',opts});return qa.deferUsers ? new Promise(resolve=>qa.userPending.push(resolve)) : {success:true,data:{items:qa.users}}},
 exportExcel:async(sheets,options)=>{qa.exports.push({sheets,options});return qa.exportResult ?? {success:true}},
 cancelRequests:async()=>{}
}};
qa.finish=(index,n)=>qa.pending[index]({success:true,data:{projectCount:n,loadedProjectCount:n,readProjectCount:n,successfulReadCount:n}});
function App(){
 const [range,setRange]=useState({from:'2026-10-01',to:'2026-10-31'});
 const [rooms,setRooms]=useState(['A']); const [created,setCreated]=useState(false);
 const [refreshKey,setRefreshKey]=useState(0);
 qa.setRange=setRange;qa.setRooms=setRooms;qa.refresh=()=>setRefreshKey(n=>n+1);
 const data=useKnowledgeOverview(true,range,rooms,refreshKey,created);
 return <TooltipProvider><main style={{padding:24}}><KnowledgeOverviewPanel {...data} rooms={rooms} refreshKey={refreshKey} rate={null} rateLoading={false} rateError={null} createdInRangeOnly={created} onCreatedInRangeOnlyChange={setCreated}/></main></TooltipProvider>
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.setContent('<div id="root"></div>')
  await page.addStyleTag({ content: css.build(scanner.scan()) })
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
  assert.deepEqual(related.map((c) => c.kind).sort(), ["accumulation", "recent", "userDetails"])
  await page.evaluate(() => window.qa.setRooms(["B"]))
  await waitCount(5)
  assert.deepEqual(
    await page.evaluate(
      () => window.qa.calls.filter((c) => c.kind === "projects").at(-1).opts.upperOrgLv1
    ),
    ["B"]
  )
  const section = page.getByRole("region", { name: "用户知识沉淀明细列表" })
  const table = section.getByRole("table")
  await section.getByText("共 45 条", { exact: true }).waitFor()
  assert.deepEqual(
    await page.evaluate(() =>
      window.qa.calls.filter((c) => c.kind === "userDetails").map((c) => c.opts)
    ),
    [{ upperOrgLv1: ["A"] }, { upperOrgLv1: ["B"] }]
  )
  assert.equal(await table.locator("tbody tr").count(), 10)
  assert.equal(await section.getByText(/展示所选室范围内的全量/).count(), 0)
  assert.equal(
    await table.locator("tbody tr").first().locator("td").first().innerText(),
    "演示用户45"
  )
  await section.getByRole("button", { name: "用户明细下一页" }).click()
  await section.getByRole("button", { name: "用户明细下一页" }).click()
  await section.getByRole("button", { name: "用户明细下一页" }).click()
  await section.getByRole("button", { name: "用户明细下一页" }).click()
  assert.equal(await table.locator("tbody tr").count(), 5)
  assert.equal(
    await table.locator("tbody tr").last().locator("td").first().innerText(),
    "演示用户1"
  )

  // Every data column sorts globally before local pagination, without another request.
  const fields = [
    "userName",
    "roomName",
    "totalNum",
    "abandonedNum",
    "recentNum",
    "updateActiveNum",
    "readActiveNum"
  ]
  const labels = [
    "用户",
    "所属室",
    "知识沉淀总数",
    "废弃知识沉淀数",
    "近一个月知识沉淀数",
    "更新活跃知识沉淀数",
    "阅读活跃知识沉淀数"
  ]
  const exportButton = section.getByRole("button", { name: "导出 Excel", exact: true })
  await exportButton.click()
  const exported = await page.evaluate(() => window.qa.exports.at(-1))
  assert.deepEqual(exported.options, { fileName: "用户知识沉淀明细" })
  assert.equal(exported.sheets[0].name, "用户知识沉淀明细")
  assert.deepEqual(exported.sheets[0].header, labels)
  assert.deepEqual(
    exported.sheets[0].rows,
    await page.evaluate(
      (fields) => [...window.qa.users].reverse().map((row) => fields.map((key) => row[key])),
      fields
    )
  )
  for (let column = 0; column < fields.length; column++) {
    const numeric = column >= 2
    for (const direction of numeric ? ["desc", "asc"] : ["asc", "desc"]) {
      await table.getByRole("button", { name: new RegExp("^按" + labels[column] + "排序") }).click()
      assert.equal(
        await table.locator("th").nth(column).getAttribute("aria-sort"),
        direction === "asc" ? "ascending" : "descending"
      )
      const expected = await page.evaluate(
        ({ key, direction }) => {
          const compare = (a, b) => a.localeCompare(b, "zh-CN", { numeric: true })
          return [...window.qa.users]
            .sort((a, b) => {
              const cmp = typeof a[key] === "number" ? a[key] - b[key] : compare(a[key], b[key])
              return (
                (direction === "asc" ? 1 : -1) * cmp ||
                compare(a.userName, b.userName) ||
                compare(a.roomName, b.roomName)
              )
            })
            .slice(0, 10)
            .map((row) => fieldsForTest(row))
          function fieldsForTest(row) {
            return [
              row.userName,
              row.roomName,
              ...["totalNum", "abandonedNum", "recentNum", "updateActiveNum", "readActiveNum"].map(
                (k) => row[k].toLocaleString("zh-CN")
              )
            ]
          }
        },
        { key: fields[column], direction }
      )
      const actual = await table
        .locator("tbody tr")
        .evaluateAll((rows) => rows.map((row) => [...row.cells].map((cell) => cell.innerText)))
      assert.deepEqual(actual, expected)
      await section.getByText("1 / 5", { exact: true }).waitFor()
    }
  }
  const search = section.getByRole("textbox", { name: "搜索用户知识沉淀明细" })
  await search.fill("演示用户45")
  assert.equal(await table.locator("tbody tr").count(), 1)
  await search.fill("杭州")
  assert.equal(await table.locator("tbody tr").count(), 10)
  await exportButton.click()
  const filteredExport = await page.evaluate(() => window.qa.exports.at(-1).sheets[0].rows)
  assert.equal(filteredExport.length, 15)
  assert.ok(filteredExport.every((row) => row[1].includes("杭州")))
  assert.ok(filteredExport.every((row, index) => !index || filteredExport[index - 1][6] <= row[6]))
  await page.evaluate(() => {
    window.qa.exportResult = { success: false, error: "保存失败" }
  })
  await exportButton.click()
  await section.getByRole("alert").getByText("保存失败").waitFor()
  await page.evaluate(() => {
    window.qa.exportResult = { success: false, canceled: true }
  })
  await exportButton.click()
  await settle()
  assert.equal(await section.getByRole("alert").count(), 0)
  assert.equal(await exportButton.isEnabled(), true)
  await search.fill("不存在用户")
  await section.getByText("没有匹配的用户明细").waitFor()
  assert.equal(await exportButton.isDisabled(), true)
  await search.fill("")
  assert.equal(
    await page.evaluate(() => window.qa.calls.filter((c) => c.kind === "userDetails").length),
    2
  )
  await section.screenshot({ path: join(output, "user-details-desktop.png") })
  await page.setViewportSize({ width: 900, height: 900 })
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true
  )
  await section.screenshot({ path: join(output, "user-details-narrow.png") })
  await page.setViewportSize({ width: 1440, height: 1000 })

  // Switching rooms hides old rows immediately and ignores a late previous response.
  await page.evaluate(() => {
    window.qa.deferUsers = true
    window.qa.setRooms(["C"])
  })
  await section.getByRole("status").waitFor()
  assert.equal(await exportButton.isDisabled(), true)
  assert.equal(await table.count(), 0)
  await page.waitForFunction(() => window.qa.userPending.length === 1)
  await page.evaluate(() => window.qa.setRooms(["D"]))
  await page.waitForFunction(() => window.qa.userPending.length === 2)
  await page.evaluate(() =>
    window.qa.userPending[0]({ success: true, data: { items: window.qa.users } })
  )
  await settle()
  assert.equal(await table.count(), 0)
  await page.evaluate(() => window.qa.userPending[1]({ success: false, error: "接口暂不可用" }))
  await section.getByRole("alert").waitFor()
  await section.getByRole("button", { name: "重试", exact: true }).click()
  await page.waitForFunction(() => window.qa.userPending.length === 3)
  await page.evaluate(() => window.qa.userPending[2]({ success: true, data: { items: [] } }))
  await section.getByText("暂无用户知识沉淀明细").waitFor()
  await page.evaluate(() => window.qa.refresh())
  await page.waitForFunction(() => window.qa.userPending.length === 4)
  await page.evaluate(() =>
    window.qa.userPending[3]({
      success: true,
      data: { items: [], unavailableReason: "roomNotMapped" }
    })
  )
  await section.getByText("所选室未配置室编号，无法查询用户明细").waitFor()
  assert.equal(await exportButton.isDisabled(), true)
  assert.deepEqual(errors, [])
  console.log(
    "Knowledge browser checks passed: 10-row pages, all 7 sortable columns, full/filtered export with ordering and numeric cells, export cancellation/failure, scope/date isolation, search, refresh/retry and responsive layout."
  )
} finally {
  await browser.close()
}
