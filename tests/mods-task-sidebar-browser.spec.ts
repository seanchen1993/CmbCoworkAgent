import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium } from "playwright"
import { chooseSteps, mount } from "./mods-flow-browser.spec"

async function main() {
  const output = resolve("output/mods-task-sidebar", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await mount(page, `
      window.fixture.taskState=status=>{const previous=runs.get(window.chat.run.id);runs.set(previous.id,{...previous,status,pendingApproval:undefined,summary:status==='interrupted'?'连接中断，已完成的内容仍保留。':undefined});emit('a')};
      window.api.mods.flowRecovery=async(id,key)=>{calls.push(['recovery',id,key]);return{runId:key,status:'eligible',sourceDigest:'d'.repeat(64),reasons:[],steps:[],consumedExecutions:1,remainingExecutions:63}};
      window.api.mods.flowResume=async(id,key,digest)=>{calls.push(['resume',id,key,digest]);const run={...runs.get(key),id:'resumed',status:'running',summary:undefined,pendingApproval:undefined};runs.set(run.id,run);emit(id);return run};
      window.fixture.ordinaryWorking=working=>{useAppStore.getState().selectThread('b');host.render(<ChatFixture id='b' enabled={false} taskWorking={working} taskOverview={<p>普通聊天正在整理需求</p>}/>)};
      window.fixture.revealResult=requestId=>revealClawPanes('b',[{key:'ordinary-result',openRequestId:requestId}]);
      host.render(<ChatFixture id='a' withChild/>);
    `)
    const assets = resolve("out/renderer/assets")
    const css = existsSync(assets) && readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
    if (css) await page.addStyleTag({ path: join(assets, css) })
    const call = (name: string, ...args: unknown[]) => page.evaluate(({ name, args }) =>
      (window as unknown as { fixture: Record<string, (...values: unknown[]) => unknown> }).fixture[name](...args), { name, args })
    const calls = () => page.evaluate(() =>
      (window as unknown as { fixture: { calls: unknown[][] } }).fixture.calls)
    const sidebar = page.getByRole("complementary", { name: "任务进展", exact: true })
    await page.getByRole("button", { name: "查看任务进展", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "选择执行步骤", exact: true }).count(), 0)
    await page.getByLabel("聊天消息").fill("整理今天需要跟进的事项")
    await page.getByRole("button", { name: "发送聊天", exact: true }).click()
    assert.equal((await calls()).filter(([name]) => name === "chat").length, 1)
    assert.equal((await calls()).filter(([name]) => name === "start").length, 0)
    await page.getByRole("button", { name: "查看任务进展", exact: true }).click()
    assert.equal(await sidebar.getByRole("tab", { name: "当前任务", exact: true }).getAttribute("aria-selected"), "true")
    await sidebar.getByText("直接说你想完成什么", { exact: true }).waitFor()
    assert.equal(await sidebar.getByLabel("本次使用的步骤").isVisible(), false)
    assert.equal(await sidebar.getByRole("button", { name: "用对话调整组合", exact: true }).isVisible(), false)
    await page.screenshot({ path: join(output, "ordinary-task-entry.png"), fullPage: true })
    await sidebar.getByRole("button", { name: "回到聊天输入", exact: true }).click()
    await page.getByLabel("聊天消息").fill("保留的草稿")
    await chooseSteps(page, "flow_a:1")
    assert.equal(await page.getByLabel("聊天消息").inputValue(), "保留的草稿")
    assert.equal((await calls()).filter(([name]) => name === "start").length, 0)
    await page.getByRole("button", { name: "改为普通发送", exact: true }).click()
    assert.equal(await page.getByLabel("聊天消息").inputValue(), "保留的草稿")
    await chooseSteps(page, "flow_a:1")
    await page.getByLabel("聊天消息").fill("检视订单导出并确认结果")
    await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
    const inlineTask = page.locator('[data-chat-task-id="run1"]')
    await inlineTask.getByRole("region", { name: "人工成果确认", exact: true }).waitFor()
    assert.equal(await inlineTask.getByLabel("当前步骤进度").isVisible(), false)
    assert.equal(await inlineTask.getByText(/流程保存修订/).isVisible(), false)
    await page.getByRole("button", { name: "查看任务进展", exact: true }).click()
    const task = sidebar.getByRole("region", { name: "当前任务进展", exact: true })
    await task.getByRole("region", { name: "人工成果确认", exact: true }).waitFor()
    assert.equal(await task.getByLabel("当前步骤进度").isVisible(), false)
    assert.equal(await task.getByText(/流程保存修订/).isVisible(), false)
    await task.getByRole("button", { name: "同意并继续", exact: true }).click()
    await task.getByText("成果已确认", { exact: true }).waitFor()
    assert.deepEqual((await calls()).filter(([name]) => name === "decide"), [
      ["decide", "a", "run1", "nonce1", true]
    ])
    await task.getByText("下一步：查看任务结果。需要补充或修改时，直接在聊天中说明。", { exact: true }).waitFor()
    await task.getByText("排查详情：执行记录", { exact: true }).click()
    await task.getByText("技术详情 · 运行编号与版本", { exact: true }).click()
    await task.getByText(/流程保存修订/).waitFor()
    await task.getByText("排查详情：执行记录", { exact: true }).click()
    await sidebar.getByRole("button", { name: "继续处理这个任务", exact: true }).click()
    assert((await page.getByLabel("聊天消息").inputValue()).includes("检视订单导出并确认结果"))
    assert.equal((await calls()).filter(([name]) => name === "start").length, 1)
    assert.equal((await calls()).filter(([name]) => name === "chat").length, 1)
    await call("taskState", "interrupted")
    await task.getByRole("button", { name: "检查能否继续", exact: true }).click()
    await task.getByRole("button", { name: "恢复运行", exact: true }).click()
    await sidebar.locator('[data-flow-run="resumed"]').waitFor()
    assert.deepEqual((await calls()).filter(([name]) => name === "resume"), [
      ["resume", "a", "run1", "d".repeat(64)]
    ])
    await sidebar.getByRole("button", { name: "停止任务", exact: true }).click()
    await sidebar.getByText("当前任务 · 已停止", { exact: true }).waitFor()
    assert.deepEqual((await calls()).filter(([name]) => name === "cancel"), [
      ["cancel", "a", "resumed"]
    ])
    await inlineTask.locator(":scope > details > summary").click()
    await inlineTask.getByRole("region", { name: "当前任务进展", exact: true }).waitFor()
    assert.equal(await inlineTask.getByLabel("当前步骤进度").isVisible(), false,
      "expanded past tasks also keep technical execution details collapsed")
    await sidebar.getByRole("tab", { name: "结果", exact: true }).click()
    await sidebar.getByText("受控插件结果", { exact: true }).waitFor()
    assert.equal(await sidebar.getByLabel("本次规范与运行概况").count(), 0)
    assert.deepEqual(await call("panelCounts"), [1, 0])
    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(output, "task-results.png"), fullPage: true })
    const beforeModsOff = (await calls()).length
    await call("chat", "b", false)
    await page.getByRole("button", { name: "查看任务进展", exact: true }).click()
    await sidebar.getByText("直接说你想完成什么", { exact: true }).waitFor()
    assert.equal((await calls()).slice(beforeModsOff).length, 0,
      "ordinary task progress remains accessible with Mods off and performs no Mods IPC")
    await call("ordinaryWorking", true)
    await sidebar.getByText("普通聊天正在整理需求", { exact: true }).waitFor()
    await call("revealResult", "working")
    assert.equal(await sidebar.getByRole("tab", { name: "当前任务", exact: true }).getAttribute("aria-selected"), "true",
      "a result arriving during real ordinary work must not take over the visible task view")
    await call("ordinaryWorking", false)
    await call("revealResult", "settled")
    await sidebar.getByRole("tab", { name: "结果", exact: true, selected: true }).waitFor()
    assert.equal((await calls()).slice(beforeModsOff).length, 0)
    writeFileSync(join(output, "report.json"), JSON.stringify({
      passed: true, checks: ["ordinary send requires no preset choice", "task is the default view",
        "manual presets remain advanced and preserve the draft", "native nonce approval stays directly available",
        "results and next actions precede collapsed execution details", "verified native resume and cancel",
        "plugin results remain mounted and diagnostics start collapsed",
        "ordinary task entry remains available with Mods off without Mods IPC",
        "real ordinary work protects the task view until it settles"], calls: await calls(), errors
    }, null, 2))
    console.log(`PASS task sidebar: direct chat, focused progress, approval, result, recovery, stop; ${output}`)
  } catch (error) {
    writeFileSync(join(output, "failure.html"), await page.content())
    await page.screenshot({ path: join(output, "failure.png"), fullPage: true })
    throw error
  } finally { await browser.close() }
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
