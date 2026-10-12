/** Real SQLite receipts and the actual button/store, including a lost response. */
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import type { BotSaveRoutineInput } from "../src/shared/bot-routines"
import { BotDomainError } from "../src/shared/bot-types"

async function main(): Promise<void> {
  const store = new BotStore(":memory:")
  const { bot } = store.createBot({ nonce: "bot", name: "巡检" })
  let routine = store.saveRoutine({
    botId: bot.id,
    name: "日检",
    prompt: "已确认的巡检内容",
    enabled: true,
    timezone: "UTC",
    schedule: { kind: "event", topic: "build" }
  })
  const bundle = await build({
    stdin: {
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotRoutineRunButton}from'./src/renderer/src/components/bots/BotRoutineRunButton';import{BotResources}from'./src/renderer/src/components/bots/BotResources';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';
    const host={hostId:'fixture',protocol:1,platform:'darwin',runtimeReady:true,error:null,capabilities:['routine-run-version','routine-management','routine-editor']};
    window.api={bots:{runRoutine:window.fixtureRun,snapshot:window.fixtureSnapshot,status:async()=>host,messages:window.fixtureMessages,routines:window.fixtureRoutines,saveRoutine:window.fixtureSave,skills:async()=>[]}};
    function Fixture({initial,bot}){const[resources,setResources]=useState(false);const[routine,setRoutine]=useState(initial);const[open,setOpen]=useState(true);return <><button onClick={()=>setResources(true)}>管理例程</button>{resources&&<BotResources bot={bot} tab="routines" close={()=>setResources(false)}/>}<button onClick={()=>setOpen(false)}>关闭例程</button><button onClick={async()=>{setRoutine(await window.fixtureRoutine());setOpen(true)}}>打开例程</button><button onClick={()=>void useBotWorkspaceStore.getState().refresh()}>刷新状态</button>{open&&<BotRoutineRunButton key={routine.id} routine={routine} dataEpoch="initial" disabled={false}/>}</>}
    void(async()=>{await useBotWorkspaceStore.getState().refresh();createRoot(document.getElementById('root')).render(<Fixture initial={await window.fixtureRoutine()} bot={await window.fixtureBot()}/>);})();`,
      resolveDir: process.cwd(),
      loader: "tsx"
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  const requests: { id: string; nonce: string; revision?: number }[] = []
  let loseReply = true
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.route("http://localhost/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<html><head><style>.hidden,[hidden]{display:none}.contents{display:contents}</style></head><body><div id="root"></div></body></html>'
      })
    )
    await page.exposeFunction("fixtureSnapshot", () => store.snapshot())
    await page.exposeFunction("fixtureBot", () => bot)
    await page.exposeFunction("fixtureRoutines", () => store.routines(bot.id))
    const saveRequests: BotSaveRoutineInput[] = []
    let loseSaveReply = true
    await page.exposeFunction("fixtureSave", (input: BotSaveRoutineInput) => {
      saveRequests.push(input)
      const result = store.saveRoutine(input)
      routine = result
      if (loseSaveReply) {
        loseSaveReply = false
        throw new Error("fixture: toggle reply lost after commit")
      }
      return result
    })
    await page.exposeFunction("fixtureRoutine", () => routine)
    await page.exposeFunction("fixtureMessages", ({ conversationId }: { conversationId: string }) =>
      store.messages(conversationId)
    )
    await page.exposeFunction(
      "fixtureRun",
      (input: { id: string; nonce: string; revision?: number }) => {
        requests.push(input)
        let run
        try {
          run = store.runRoutine(input)
        } catch (error) {
          if (error instanceof BotDomainError)
            return { botFailure: { code: error.code, message: error.message } }
          throw error
        }
        if (loseReply) {
          loseReply = false
          throw new Error("fixture: reply lost after commit")
        }
        return run
      }
    )
    await page.goto("http://localhost/")
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByRole("button", { name: "运行一次", exact: true }).click()
    await page.getByRole("button", { name: "核对并重试", exact: true }).waitFor()
    assert.equal(store.snapshot().runs.length, 1)
    await page.getByRole("button", { name: "关闭例程", exact: true }).click()
    routine = store.saveRoutine({ ...routine, prompt: "后来修改的内容" })
    await page.getByRole("button", { name: "打开例程", exact: true }).click()
    await page.getByRole("button", { name: "核对并重试", exact: true }).click()
    const queued = page.getByRole("button", { name: "等待执行", exact: true })
    await queued.waitFor()
    assert.ok(await queued.isDisabled())
    assert.equal(requests.length, 2)
    assert.deepEqual(requests[1], requests[0])
    assert.equal(requests[0].revision, routine.revision - 1)
    assert.equal(store.snapshot().runs.length, 1)
    const claimed = store.claim("fixture-host")!
    await page.getByRole("button", { name: "刷新状态", exact: true }).click()
    await page.getByRole("button", { name: "运行中", exact: true }).waitFor()
    store.finish(claimed.lease, "succeeded", "巡检完成")
    await page.getByRole("button", { name: "刷新状态", exact: true }).click()
    await page.getByRole("button", { name: "运行一次", exact: true }).waitFor()
    // A genuinely new click after completion uses the new reviewed version.
    await page.getByRole("button", { name: "运行一次", exact: true }).click()
    await queued.waitFor()
    assert.equal(requests.length, 3)
    assert.notEqual(requests[2].nonce, requests[0].nonce)
    assert.equal(requests[2].revision, routine.revision)
    assert.equal(store.routineHistory({ botId: bot.id, routineId: routine.id }).items.length, 2)
    const second = store.claim("fixture-host")!
    store.finish(second.lease, "succeeded", "第二次巡检完成")
    await page.getByRole("button", { name: "刷新状态", exact: true }).click()
    await page.getByRole("button", { name: "运行一次", exact: true }).waitFor()
    // An external edit arrives before this view refreshes. The real transport
    // returns a data envelope, which the renderer must recognize as rejection.
    routine = store.saveRoutine({ ...routine, prompt: "另一个窗口更新的内容" })
    await page.getByRole("button", { name: "运行一次", exact: true }).click()
    await page.getByText("例程已修改，请刷新后确认运行内容", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "核对并重试", exact: true }).count(), 0)
    assert.equal(store.routineHistory({ botId: bot.id, routineId: routine.id }).items.length, 2)
    await page.getByRole("button", { name: "关闭例程", exact: true }).click()
    await page.getByRole("button", { name: "打开例程", exact: true }).click()
    await page.getByRole("button", { name: "运行一次", exact: true }).click()
    await queued.waitFor()
    assert.notEqual(requests[4].nonce, requests[3].nonce)
    assert.equal(requests[4].revision, routine.revision)
    assert.equal(store.routineHistory({ botId: bot.id, routineId: routine.id }).items.length, 3)
    await page.getByRole("button", { name: "管理例程", exact: true }).click()
    const row = page.locator(`#bot-routine-${routine.id}`)
    await row.getByRole("button", { name: "例程 日检 的更多操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "暂停", exact: true }).click()
    const editor = page.getByRole("dialog", { name: "编辑例程", exact: true })
    await editor.getByRole("button", { name: "重试核对保存", exact: true }).waitFor()
    assert.equal(routine.enabled, false)
    assert.ok(saveRequests[0].nonce)
    const pausedRevision = routine.revision
    await editor.getByRole("button", { name: "取消", exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()
    await page.getByRole("button", { name: "管理例程", exact: true }).click()
    await row.getByText("已暂停", { exact: true }).waitFor()
    await row.getByRole("button", { name: "例程 日检 的更多操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "恢复", exact: true }).click()
    await editor.getByRole("button", { name: "重试核对保存", exact: true }).waitFor()
    assert.equal(saveRequests.length, 1, "An unacknowledged pause must not become a resume")
    await editor.getByRole("button", { name: "重试核对保存", exact: true }).click()
    await editor.waitFor({ state: "hidden" })
    assert.deepEqual(saveRequests[1], saveRequests[0])
    assert.equal(routine.revision, pausedRevision)
    assert.equal(routine.enabled, false)
    await row.getByRole("button", { name: "例程 日检 的更多操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "恢复", exact: true }).click()
    await row.getByText("等待事件触发", { exact: true }).waitFor()
    assert.equal(routine.enabled, true)
    assert.notEqual(saveRequests[2].nonce, saveRequests[0].nonce)
    assert.deepEqual(errors, [])
    console.log(
      "PASS lost routine response recovers across remount without duplicate work; live status, reviewed versions and pause/resume receipts persist"
    )
  } catch (error) {
    console.error({
      pageErrors: errors,
      requests,
      pageText: await page.locator("body").innerText()
    })
    throw error
  } finally {
    await browser.close()
    store.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
