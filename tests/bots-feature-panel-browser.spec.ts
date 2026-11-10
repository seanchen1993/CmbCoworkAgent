import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

// Real right-panel component and CSS. Only main-process data and the navigation store are substituted.
async function main() {
  const result = await build({
    stdin: {
      resolveDir: resolve("."),
      loader: "tsx",
      contents: `
import {createRoot} from "react-dom/client";
import {BotWorkPanel} from "./src/renderer/src/components/bots/BotWorkPanel";
import {useState} from "react";
const root=createRoot(document.getElementById("root"));
const item={kind:"feature",state:"active",version:1,updatedAt:2,phase:"question",attentionThreadId:"draft",id:"follow",projectId:"p",projectName:"客户服务",slug:"export",title:"报表导出"};
const scopes=new Map();
window.api={};
window.created=[];
const client={works:{create:async input=>{window.created.push(input);return {work:{id:"created-"+input.operationId}}}},subscribe:()=>()=>{},features:{
  projects:async()=>[{id:"p",name:item.projectName}],
  catalog:async()=>[item],
  follow:async(bot,p,slug,group)=>{scopes.set(group,[item]);return item;},
  list:async(bot,group)=>scopes.get(group)||[],
  detail:async()=>({...item,sessions:[{threadId:"draft",title:"讨论导出范围",phase:"question"},{threadId:"review",title:"历史评审",phase:"idle"}]})
}};
function Panel({group,revoked}) {
  const [query,setQuery]=useState("");
  const w={id:"regular",title:"周会通知",state:"active",executionState:"completed",updatedAt:1};
  return <BotWorkPanel client={client} botId="bot" groupId={group} readOnlyGroup={revoked}
    heading={group?"群内任务":"任务"} disabled={false} selected={null} onSelect={id=>window.selected=id}
    controller={{query,setQuery,items:!query||w.title.includes(query)?[w]:[],priority:[],cursor:null,current:{current:{botId:"bot",audience:group||"desktop"}},more(){},refresh(){}}}/>
}
window.scope=(group,revoked=false)=>root.render(<Panel key={group||"private"} group={group} revoked={revoked}/>);
window.scope("group-a");`
    },
    bundle: true,
    write: false,
    jsx: "automatic",
    format: "iife",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"' },
    outdir: "/virtual",
    plugins: [
      {
        name: "desktop-navigation",
        setup(b) {
          b.onResolve({ filter: /^@\/lib\/store$/ }, () => ({
            path: "store",
            namespace: "desktop"
          }))
          b.onLoad({ filter: /.*/, namespace: "desktop" }, () => ({
            contents: `
          export const useAppStore={
            getState:()=>({threads:[{thread_id:"review",title:"历史评审"}],setShowHarnessBoardView:value=>window.board=value}),
            setState:value=>window.destination=value.botFeatureDestination
          };`
          }))
        }
      }
    ]
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "chrome" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 730 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route("http://localhost/bot-panel", (route) =>
      route.fulfill({ contentType: "text/html", body: '<meta charset="utf-8"><div id="root"></div>' })
    )
    await page.goto("http://localhost/bot-panel")
    await page.addStyleTag({
      content: result.outputFiles.find((f) => f.path.endsWith(".css"))!.text
    })
    await page.addScriptTag({
      content: result.outputFiles.find((f) => f.path.endsWith(".js"))!.text
    })
    const addTask = page.getByRole("button", { name: "添加任务" })
    const followFeature = page.getByRole("button", { name: "项目 Feature", exact: true })
    await addTask.click()
    await followFeature.click()
    await page.getByLabel("选择项目", { exact: true }).selectOption("p")
    await page.getByLabel("选择 Feature", { exact: true }).selectOption("export")
    await page.getByRole("button", { name: "跟进", exact: true }).click()
    const follow = page.getByRole("button", { name: /报表导出/ })
    await follow.waitFor()
    await addTask.click()
    await followFeature.click()
    await page.getByLabel("选择项目", { exact: true }).selectOption("p")
    const linkedOption = page.getByRole("option", { name: "报表导出 · 已关联" })
    await linkedOption.waitFor({ state: "attached", timeout: 3000 })
    assert.equal(await linkedOption.isDisabled(), true)
    assert.equal(await page.getByRole("button", { name: "跟进", exact: true }).isEnabled(), false)
    await page.getByRole("button", { name: "取消", exact: true }).click()
    assert.equal(await page.getByRole("textbox", { name: "搜索任务" }).count(), 1)
    const search = page.getByRole("textbox", { name: "搜索任务" })
    await page.getByRole("button", { name: /周会通知/ }).waitFor()
    await search.fill("客户服务")
    await page.getByRole("button", { name: /周会通知/ }).waitFor({ state: "detached" })
    await follow.click()
    assert.equal(await follow.getAttribute("aria-expanded"), "true")
    await page.getByRole("button", { name: /讨论导出范围.*等待回答/ }).click()
    assert.equal(await page.evaluate(() => (window as any).destination.threadId), "draft")
    assert.equal(await page.getByRole("button", { name: "关联已有会话" }).count(), 0)
    await page.getByRole("button", { name: /历史评审.*已空闲/ }).click()
    assert.deepEqual(
      await page.evaluate(() => [(window as any).board, (window as any).destination]),
      [true, { projectId: "p", slug: "export", threadId: "review" }]
    )
    await page.getByRole("button", { name: "打开 Feature" }).click()
    assert.deepEqual(
      await page.evaluate(() => JSON.parse(JSON.stringify((window as any).destination))),
      { projectId: "p", slug: "export" }
    )
    for (const scope of ["group-b", undefined]) {
      await page.evaluate((group) => (window as any).scope(group), scope)
      await follow.waitFor({ state: "detached" })
      await addTask.click()
      assert.equal(await page.getByRole("button", { name: "普通任务" }).getAttribute("aria-pressed"), "true")
      assert.equal(await followFeature.isVisible(), true)
      const submit = page.getByRole("button", { name: "交办任务" })
      assert.equal(await submit.isEnabled(), false)
      await page.getByLabel("任务名称").fill("准备评审")
      await page.getByLabel("交办目标").fill("列出讨论要点")
      const path = page.getByLabel("工作目录（可选）")
      assert.equal(await path.getAttribute("placeholder"), scope ? "留空使用本群默认目录" : "留空使用 Bot 默认目录")
      if (scope) await path.fill("/projects/report")
      await submit.click()
      await submit.waitFor({ state: "detached" })
      const { input, selected } = await page.evaluate(() => ({
        input: (window as any).created.at(-1), selected: (window as any).selected
      }))
      assert.equal(input.imConversationId, scope)
      assert.deepEqual(input.workspace, scope ? { kind: "directory", path: "/projects/report" } : undefined)
      assert.equal(selected, "created-" + input.operationId)
    }
    await page.evaluate(() => (window as any).scope("group-a", true))
    await addTask.waitFor({ state: "detached" })
    await follow.waitFor()
    assert.deepEqual(errors, [])
    console.log(
      "PASS: private and group manual task forms, group-scoped creation, read-only revoked group, Feature follow and session navigation"
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
