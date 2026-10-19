import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { _electron } from "playwright"
import type { ServiceRequestView, ServiceTaskView } from "../../src/shared/bot/service-conversation"
async function main() {
  const dir = await mkdtemp(join(tmpdir(), "m02-service-ui-")),
    binary = createRequire(import.meta.url)("electron") as string
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    const bundle = await build({
      entryPoints: [resolve("tests/support/service-conversation-fixture.tsx")],
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      outdir: dir,
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
      alias: { "@": resolve("src/renderer/src") }
    })
    await writeFile(
      join(dir, "index.html"),
      '<meta charset="UTF-8"><style>body{font:14px system-ui;margin:0;color:#222}#root{height:900px}button,select,textarea{font:inherit}svg{max-width:30px}button{padding:5px}button:disabled{opacity:.4}</style><div id="root"></div>'
    )
    await writeFile(
      join(dir, "main.cjs"),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(dir, "profile"))});app.whenReady().then(()=>new BrowserWindow({show:false,width:1200,height:950,webPreferences:{backgroundThrottling:false}}).loadFile(${JSON.stringify(join(dir, "index.html"))}));`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({
      executablePath: binary,
      args: [join(dir, "main.cjs")],
      env,
      timeout: 30000
    })
    const page = await app.firstWindow(),
      errors: string[] = []
    page.setDefaultTimeout(15000)
    await page.waitForURL(/index\.html$/)
    page.on("pageerror", (error) => {
      errors.push(error.message)
      console.error("UI_ERROR", error.message)
    })
    let selectedModel: string | null = null,
      nodeEnabled = false,
      scope = "conversation-A",
      opens = 0,
      sends = 0,
      cancels = 0
    let delayRead = false,
      delayedRead: (() => void) | null = null,
      delaySend = false,
      delayedSend: (() => void) | null = null
    const records: ServiceRequestView[] = Array.from({ length: 41 }, (_, i) => ({
      requestId: "request-" + (i + 1),
      taskRef: "task-1",
      text: "材料-" + (i + 1),
      status: "succeeded",
      notice: null,
      runId: "run-" + (i + 1),
      result: {
        runId: "run-" + (i + 1),
        attemptId: "attempt-" + (i + 1),
        outcome: "succeeded",
        text: "结果-" + (i + 1),
        settledAt: "2026-10-19T01:00:00.000Z"
      },
      createdAt: "2026-10-19T01:00:00.000Z"
    }))
    const taskRecords = new Map<string, ServiceRequestView[]>([
      ["task-1", records],
      [
        "task-2",
        [
          {
            ...records[0],
            requestId: "other-request",
            taskRef: "task-2",
            text: "另外任务内容",
            result: null
          }
        ]
      ]
    ])
    const createdRequests: ServiceRequestView[] = []
    let tasks: ServiceTaskView[] = [
      { taskRef: "task-1", taskNumber: "TASK-1", title: "历史需求", status: "succeeded" },
      { taskRef: "task-2", taskNumber: "TASK-2", title: "另一任务", status: "succeeded" }
    ]
    await page.exposeFunction("serviceFixtureCall", async (method: string, input?: any) => {
      if (method === "open") {
        opens++
        return {
          conversationId: scope,
          expertName: "需求服务专家",
          connected: true,
          nodeEnabled,
          selectedModel: selectedModel ? { ref: selectedModel, name: "Fixture模型" } : null,
          models: [{ ref: "custom:fixture", name: "Fixture模型" }]
        }
      }
      if (method === "selectModel") {
        selectedModel = input.modelRef
        return {
          conversationId: scope,
          expertName: "需求服务专家",
          connected: true,
          nodeEnabled,
          selectedModel: { ref: selectedModel, name: "Fixture模型" },
          models: [{ ref: "custom:fixture", name: "Fixture模型" }]
        }
      }
      if (method === "updates")
        return [...taskRecords.values()]
          .flat()
          .filter((r) => input.requestIds.includes(r.requestId))
      if (method === "tasks") return { items: tasks, nextCursor: null }
      if (method === "read") {
        if (input.taskRef === "task-1") {
          if (delayRead) {
            delayRead = false
            await new Promise<void>((resolve) => (delayedRead = resolve))
          }
          return input.cursor
            ? { items: records.slice(0, 1), nextCursor: null }
            : { items: records.slice(-40), nextCursor: "older" }
        }
        return { items: taskRecords.get(input.taskRef) ?? [], nextCursor: null }
      }
      if (method === "send") {
        sends++
        assert.deepEqual(Object.keys(input).sort(), [
          "conversationId",
          "requestId",
          "taskRef",
          "text"
        ])
        const ref = input.taskRef ?? "new-task-" + sends
        const value: ServiceRequestView = {
          ...records[0],
          requestId: input.requestId,
          taskRef: ref,
          text: input.text,
          status: input.taskRef ? "next_round" : "running",
          notice: input.taskRef ? "已保存，将在前一轮结束后分析" : null,
          result: null
        }
        if (!taskRecords.has(ref)) {
          taskRecords.set(ref, [])
          tasks.unshift({
            taskRef: ref,
            taskNumber: "TASK-" + (sends + 2),
            title: input.text,
            status: value.status
          })
        }
        taskRecords.get(ref)!.push(value)
        createdRequests.push(value)
        tasks.find((t) => t.taskRef === ref)!.status = value.status
        if (delaySend) {
          delaySend = false
          await new Promise<void>((resolve) => (delayedSend = resolve))
        }
        return value
      }
      if (method === "cancel") {
        cancels++
        const entry = createdRequests.find((r) => r.requestId === input.requestId)!
        assert.ok(entry)
        entry.status = "cancelled"
        entry.notice = "请求已停止"
        return
      }
      throw Error("Unexpected API " + method)
    })
    await page.addScriptTag({
      content:
        "window.api={serviceConversation:{open:()=>window.serviceFixtureCall('open'),selectModel:v=>window.serviceFixtureCall('selectModel',v),tasks:v=>window.serviceFixtureCall('tasks',v),read:v=>window.serviceFixtureCall('read',v),updates:v=>window.serviceFixtureCall('updates',v),send:v=>window.serviceFixtureCall('send',v),cancel:v=>window.serviceFixtureCall('cancel',v),subscribeInvalidation:fn=>{window.serviceInvalidate=fn;return()=>{window.serviceInvalidate=null}}},bots:new Proxy({}, {get:()=>()=>{throw Error('LOCAL_BOT_API_MUST_NOT_BE_CALLED')}})}"
    })
    const assets = resolve("out/renderer/assets")
    for (const name of (await readdir(assets)).filter((name) =>
      /^(index|BotsWorkspace)-.*\.css$/.test(name)
    ))
      await page.addStyleTag({ content: await readFile(join(assets, name), "utf8") })
    const css = bundle.outputFiles.find((f) => f.path.endsWith(".css"))
    if (css) await page.addStyleTag({ content: css.text })
    await page.addScriptTag({
      content:
        bundle.outputFiles.find((f) => f.path.endsWith(".js"))?.text ?? bundle.outputFiles[0].text
    })
    await page.getByText("需求服务专家", { exact: true }).waitFor()
    await page.getByText("本机未启用", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "启用本机", exact: true }).count(), 1)
    await page.getByLabel("服务分析模型").selectOption("custom:fixture")
    await page.getByRole("button", { name: /历史需求/ }).click()
    await page.getByText("材料-41", { exact: true }).waitFor()
    assert.equal(await page.getByText("材料-1", { exact: true }).count(), 0)
    await page.getByRole("button", { name: "查看更多记录", exact: true }).click()
    await page.getByText("材料-1", { exact: true }).waitFor()
    await page.getByRole("button", { name: "刷新服务会话", exact: true }).click()
    await page.getByText("材料-1", { exact: true }).waitFor()
    assert.equal(await page.locator(".service-expert-exchange").count(), 41)
    const before = opens
    await page.waitForTimeout(2250)
    assert.equal(opens, before, "terminal view must stop periodic polling")
    delayRead = true
    await page.getByRole("button", { name: "刷新服务会话", exact: true }).click()
    while (!delayedRead) await new Promise((r) => setTimeout(r, 10))
    await page.getByRole("button", { name: /另一任务/ }).click()
    delayedRead!()
    delayedRead = null
    await page.getByText("另外任务内容", { exact: true }).waitFor()
    assert.equal(await page.getByText("材料-41", { exact: true }).count(), 0)
    nodeEnabled = true
    await page.getByRole("button", { name: "新任务", exact: true }).click()
    await page.getByLabel("服务任务文本").fill("整理新的需求")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await page.getByText("执行中", { exact: true }).waitFor()
    assert.equal(createdRequests.length, 1)
    await page.getByLabel("服务任务文本").fill("采用补充规则")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await page.getByText("下一轮分析采用", { exact: true }).waitFor()
    assert.equal(createdRequests[1].taskRef, createdRequests[0].taskRef)
    await page
      .getByRole("button", { name: "停止请求 " + createdRequests[0].requestId, exact: true })
      .click()
    await page.getByText("请求已停止", { exact: true }).waitFor()
    assert.equal(cancels, 1)
    createdRequests[1].status = "succeeded"
    createdRequests[1].notice = null
    createdRequests[1].result = {
      ...records[0].result!,
      runId: "normal-run",
      text: "正常服务分析结果"
    }
    tasks.find((t) => t.taskRef === createdRequests[1].taskRef)!.status = "succeeded"
    await page.getByRole("button", { name: "刷新服务会话", exact: true }).click()
    await page.getByText("正常服务分析结果", { exact: true }).waitFor()
    await page.screenshot({ path: "/tmp/m02-service-conversation.png", fullPage: true })
    const completedTask = createdRequests[1].taskRef
    await page.evaluate(() => {
      ;(window as any).remountService()
    })
    await page.getByRole("button", { name: /整理新的需求/ }).click()
    await page.getByText("正常服务分析结果", { exact: true }).waitFor()
    assert.equal(sends, 2)
    assert.equal(createdRequests[1].taskRef, completedTask)
    await page.getByRole("button", { name: /另一任务/ }).click()
    await page.getByText("另外任务内容", { exact: true }).waitFor()
    delaySend = true
    await page.getByLabel("服务任务文本").fill("下一轮补充")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    while (!delayedSend) await new Promise((r) => setTimeout(r, 10))
    scope = "conversation-B"
    tasks = []
    await page.evaluate(() => {
      ;(window as any).serviceInvalidate(true)
    })
    const duringSwitch = opens
    await page.waitForTimeout(150)
    assert.equal(opens, duringSwitch, "context mutation suspends reads")
    await page.evaluate(() => {
      ;(window as any).serviceInvalidate(false)
    })
    delayedSend!()
    delayedSend = null
    await page.getByText("交办一件新工作，或从右侧选择任务继续补充。", { exact: true }).waitFor()
    assert.equal(await page.getByText("另外任务内容", { exact: true }).count(), 0)
    assert.equal(await page.getByText("下一轮补充", { exact: true }).count(), 0)
    assert.equal(await page.getByLabel("服务任务文本").inputValue(), "")
    assert.equal(sends, 3)
    assert.equal(cancels, 1)
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        stage: "m02-service-ui",
        history: 41,
        lateReadIgnored: true,
        lateSendIgnored: true,
        terminalPollingStopped: true,
        localBotCalls: 0,
        normalSend: true,
        supplementSameTask: true,
        cancelExactRequest: true,
        remountDoesNotSend: true
      })
    )
  } finally {
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
