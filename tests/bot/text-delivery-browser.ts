import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { _electron } from "playwright"
import type { ServiceRequestView, ServiceTaskView } from "../../src/shared/bot/service-conversation"
async function main() {
  const dir = await mkdtemp(join(tmpdir(), "m03-delivery-ui-")),
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
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined) env[key] = value
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
    let sends = 0,
      reviews = 0,
      retries = 0,
      versionReads = 0,
      scope = "conversation-A"
    let failVersion = false,
      delayVersion = false,
      releaseVersion: (() => void) | undefined
    const records: ServiceRequestView[] = [],
      tasks: ServiceTaskView[] = []
    const summary: any = {
      taskId: "server-task",
      taskVersion: 1,
      taskStatus: "active",
      head: null,
      canReview: false
    }
    const versions: any[] = [],
      decisions = new Map<string, any>(),
      actions: any[] = []
    const createRequest = (id: string, text: string) => ({
      requestId: id,
      taskRef: "task-A",
      text,
      status: "running" as const,
      notice: null,
      runId: "run-" + id,
      result: null,
      createdAt: "2026-10-19T01:00:00.000Z"
    })
    const publish = (request: ServiceRequestView, number: number, text: string) => {
      request.status = "succeeded"
      request.notice = null
      request.publication = { state: "published", notice: null }
      request.result = {
        runId: request.runId!,
        attemptId: "attempt-" + number,
        outcome: "succeeded",
        text,
        settledAt: "2026-10-19T01:00:00.000Z"
      }
      versions.unshift({
        id: "v" + number,
        taskId: "server-task",
        number,
        text,
        sourceRunId: request.runId,
        createdAt: request.result.settledAt
      })
      summary.taskVersion++
      summary.taskStatus = "awaiting_business"
      summary.canReview = true
      summary.head = {
        versionId: "v" + number,
        number,
        status: "pending",
        revision: (summary.head?.revision ?? 0) + 1
      }
      tasks[0].status = "succeeded"
    }
    await page.exposeFunction("serviceFixtureCall", async (method: string, input?: any) => {
      if (method === "open" || method === "selectModel")
        return {
          conversationId: scope,
          expertName: "需求服务专家",
          connected: true,
          nodeEnabled: true,
          selectedModel: { ref: "custom:fixture", name: "Fixture模型" },
          models: [{ ref: "custom:fixture", name: "Fixture模型" }]
        }
      if (method === "tasks")
        return { items: scope === "conversation-A" ? tasks : [], nextCursor: null }
      if (method === "read" || method === "updates")
        return method === "read"
          ? { items: input.taskRef === "task-A" ? records : [], nextCursor: null }
          : records.filter((r) => input.requestIds.includes(r.requestId))
      if (method === "send") {
        sends++
        const request = createRequest(input.requestId, input.text)
        records.push(request)
        tasks.push({
          taskRef: "task-A",
          taskNumber: "TASK-1",
          title: input.text,
          status: "running",
          delivery: summary
        })
        return request
      }
      if (method === "delivery") {
        if (input.taskRef !== "task-A") return null
        const values = versions.filter((v) => !input.before || v.number < input.before)
        return {
          summary,
          versions: values.slice(0, 40).map(({ text, ...v }) => v),
          nextBefore: values.length > 40 ? values[39].number : null,
          actions
        }
      }
      if (method === "deliveryVersion") {
        versionReads++
        if (failVersion) {
          failVersion = false
          throw Error("DEPENDENCY_UNAVAILABLE")
        }
        const version = versions.find((v) => v.id === input.versionId)!,
          result = structuredClone({
            summary,
            version,
            decision: decisions.get(version.id) ?? null
          })
        if (delayVersion) {
          delayVersion = false
          await new Promise<void>((resolve) => {
            releaseVersion = resolve
          })
        }
        return result
      }
      if (method === "review") {
        reviews++
        assert.equal(input.versionId, summary.head.versionId)
        const decision = {
          principalId: "business",
          decision: input.decision,
          comment: input.comment,
          createdAt: "2026-10-19T01:01:00.000Z"
        }
        decisions.set(input.versionId, decision)
        summary.head.revision++
        summary.canReview = false
        summary.taskVersion++
        if (input.decision === "reject") {
          summary.head.status = "changes_requested"
          summary.taskStatus = "active"
          const request = createRequest("revision-1", input.comment)
          records.push(request)
          actions.unshift({
            id: "reject-action",
            kind: "reject",
            state: "done",
            notice: null,
            requestId: request.requestId
          })
        } else {
          summary.head.status = "completed"
          summary.taskStatus = "completed"
        }
        return
      }
      if (method === "retryRevision") {
        retries++
        records.at(-1)!.supersededBy = "revision-2"
        const request = createRequest("revision-2", "已保存的同一修改意见")
        records.push(request)
        actions.unshift({
          id: "retry-action",
          kind: "retry",
          state: "done",
          notice: null,
          requestId: request.requestId
        })
        return
      }
      throw Error("Unexpected API " + method)
    })
    await page.addScriptTag({
      content:
        "window.api={serviceConversation:Object.fromEntries(['open','selectModel','tasks','read','updates','send','cancel','delivery','deliveryVersion','publish','review','retryRevision'].map(name=>[name,v=>window.serviceFixtureCall(name,v)])),bots:new Proxy({}, {get:()=>()=>{throw Error('LOCAL_BOT_API_MUST_NOT_BE_CALLED')}})};window.api.serviceConversation.subscribeInvalidation=fn=>{window.serviceInvalidate=fn;return()=>window.serviceInvalidate=null}"
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
    await page.getByLabel("服务任务文本").fill("整理需求说明并保留规则")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await page.getByText("执行中", { exact: true }).waitFor()
    assert.equal(sends, 1)
    publish(records[0], 1, "# 需求说明 v1\n必须保留的原版规则 V1_SENTINEL")
    const refresh = async () => {
      await page.getByRole("button", { name: "刷新服务会话", exact: true }).click()
    }
    await refresh()
    await page.getByRole("button", { name: "确认完成", exact: true }).waitFor()
    await page.getByRole("button", { name: "提出修改", exact: true }).click()
    await page.getByLabel("修改意见").fill("增加本人权限和跨日边界 FEEDBACK_SENTINEL")
    await page.getByRole("button", { name: "保存意见并修改", exact: true }).click()
    await page.getByText("需求说明文本 · 修改中", { exact: true }).waitFor()
    assert.equal(reviews, 1)
    assert.equal(records.length, 2)
    assert.equal(sends, 1)
    records[1].status = "blocked"
    records[1].notice = "MODEL_CHANGED"
    await refresh()
    await page.getByRole("button", { name: "继续修改", exact: true }).click()
    assert.equal(retries, 1)
    assert.equal(records.length, 3)
    delayVersion = true
    publish(records[2], 2, "# 需求说明 v2\n原版规则已保留，权限与日期边界已修改 V2_SENTINEL")
    await refresh()
    while (!releaseVersion) await new Promise((r) => setTimeout(r, 10))
    assert.equal(
      await page.getByRole("button", { name: "确认完成", exact: true }).isDisabled(),
      true,
      "v2 cannot be confirmed before its body is displayed"
    )
    ;(releaseVersion as (() => void) | undefined)?.()
    releaseVersion = undefined
    await page.waitForFunction(
      () => (document.querySelector('[aria-label="成果版本"]') as HTMLSelectElement)?.value === "v2"
    )
    await page
      .getByText(/原版规则已保留，权限与日期边界已修改 V2_SENTINEL/)
      .first()
      .waitFor()
    await page.getByLabel("成果版本").selectOption("v1")
    await page.getByText(/退回修改 · business/).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "确认完成", exact: true }).isDisabled(),
      true
    )
    failVersion = true
    await page.getByLabel("成果版本").selectOption("v2")
    await page.locator(".service-delivery-card [role=alert]").waitFor()
    await page.getByRole("button", { name: "刷新成果", exact: true }).click()
    await page
      .locator(".service-delivery-card")
      .getByText(/V2_SENTINEL/)
      .waitFor()
    await page.getByRole("button", { name: "确认完成", exact: true }).click()
    await page.getByText(/此任务已确认完成/).waitFor()
    assert.equal(reviews, 2)
    assert.equal(sends, 1)
    assert.equal(await page.getByLabel("服务任务文本").isDisabled(), true)
    assert.equal(await page.getByRole("button", { name: "新任务", exact: true }).isEnabled(), true)
    await page.screenshot({ path: "/tmp/m03-delivery-review.png", fullPage: true })
    await page.getByRole("button", { name: "新任务", exact: true }).click()
    assert.equal(await page.getByLabel("服务任务文本").isEnabled(), true)
    await page.getByRole("button", { name: /整理需求说明并保留规则/ }).click()
    await page.getByText(/此任务已确认完成/).waitFor()
    await page.evaluate(() => (window as any).remountService())
    await page.getByRole("button", { name: /整理需求说明并保留规则/ }).click()
    await page.getByText(/此任务已确认完成/).waitFor()
    assert.equal(sends, 1)
    assert.equal(reviews, 2)
    const reads = versionReads
    await page.waitForTimeout(2200)
    assert.equal(versionReads, reads, "terminal review does not poll immutable body")
    // Forty-item metadata page preserves all expanded history on refresh.
    for (let i = 3; i <= 42; i++)
      versions.unshift({ ...versions[0], id: "v" + i, number: i, text: "历史成果-" + i })
    summary.head = { versionId: "v42", number: 42, status: "completed", revision: 100 }
    await page.evaluate(() => (window as any).remountService())
    await page.getByRole("button", { name: /整理需求说明并保留规则/ }).click()
    await page.waitForFunction(
      () => document.querySelectorAll('[aria-label="成果版本"] option').length >= 40
    )
    await page.getByRole("button", { name: "更多成果版本", exact: true }).click()
    await page.waitForFunction(
      () => document.querySelectorAll('[aria-label="成果版本"] option').length === 42
    )
    await page.getByRole("button", { name: "刷新成果", exact: true }).click()
    await page.waitForTimeout(50)
    assert.equal(await page.getByLabel("成果版本").locator("option").count(), 42)
    // A delayed historical body cannot repopulate another selected Task or scope.
    tasks.push({ taskRef: "task-B", taskNumber: "TASK-2", title: "另一任务", status: "succeeded" })
    await refresh()
    delayVersion = true
    await page.getByLabel("成果版本").selectOption("v1")
    while (!releaseVersion) await new Promise((r) => setTimeout(r, 10))
    await page.getByRole("button", { name: /另一任务/ }).click()
    ;(releaseVersion as (() => void) | undefined)?.()
    releaseVersion = undefined
    await page.waitForTimeout(100)
    assert.equal(await page.locator(".service-delivery-card").count(), 0)
    scope = "conversation-B"
    await page.evaluate(() => {
      ;(window as any).serviceInvalidate(true)
      ;(window as any).serviceInvalidate(false)
    })
    await page.waitForTimeout(100)
    assert.equal(await page.getByText(/V1_SENTINEL/).count(), 0)
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        stage: "m03-delivery-ui",
        sendV1RejectRetryV2Confirm: true,
        sends,
        reviews,
        retries,
        remountNoResend: true,
        history: 42,
        lateBodyIgnored: true,
        completedSidebarUsable: true,
        terminalBodyPollingStopped: true,
        localBotCalls: 0,
        screenshot: "/tmp/m03-delivery-review.png"
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
