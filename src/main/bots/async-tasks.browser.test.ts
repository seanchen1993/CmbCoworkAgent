import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { expect, it } from "vitest"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { createBotAPI } from "./rpc"
import { BotWorkflowStore } from "./workflow-store"
import type { BotAsyncTasksRequest } from "../../shared/bot-async-tasks"
import type { BotWorkflowControl } from "../../shared/bot-workflow-control"
import type { BotShellJobStop } from "../../shared/bot-shell-jobs"

it.skipIf(process.env.CMB_ASYNC_TASKS_UI_TEST !== "1")(
  "pages real durable tasks, controls the exact branch child and fences failed or late reads",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-async-tasks-ui-"))
    const output = resolve("output/bot-async-tasks")
    await mkdir(output, { recursive: true })
    const store = new BotStore(join(root, "bots.sqlite"))
    const owner = store.createBot({ nonce: "owner", name: "研发助手" })
    const other = store.createBot({ nonce: "other", name: "其他项目" })
    const original = store.send({
      nonce: "root",
      conversationId: owner.conversationId,
      text: "项目背景"
    })
    store.cancel(original.runIds[0])
    store.send({
      nonce: "branch",
      conversationId: owner.conversationId,
      threadRootId: original.messageId,
      text: "并行验证"
    })
    const parent = store.claim("fixture-host", 120_000)!
    const workflow = BotWorkflowStore.open(store, parent.lease, "workflow", {
      script: 'export const meta={name:"验证项目",description:"核验并行任务"};return "ok"',
      maxConcurrency: 4,
      defaultModelId: "fixture",
      agentProfiles: [],
      authority: {}
    })
    const children = Array.from({ length: 25 }, (_, index) => {
      const input = {
        prompt: "核对项目证据",
        agentIndex: index,
        toolStreamKey: `${"a".repeat(64)}_c${index}`,
        durableCallKey: `${"a".repeat(64)}_n${index}`,
        label: `检查项 ${index}`,
        phase: "验证",
        shellAccess: "read_only" as const
      }
      const child =
        index === 0
          ? store.workflowChildren.claim(workflow, parent.lease, input).run
          : store.workflowChildren.reserve(workflow, parent.lease, input)
      store.db.run("UPDATE bot_runs SET created_at=? WHERE id=?", [
        Date.now() - 60_000 + index * 1000,
        child.id
      ])
      return child
    })
    const api = createBotAPI(new BotHost(store))
    const browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
      args: ["--disable-updater-scheduler"]
    })
    const page = await browser.newPage({ viewport: { width: 1160, height: 900 } })
    page.setDefaultTimeout(10_000)
    let fail = false
    let lostControl = false
    let delay = false
    let release: (() => void) | undefined
    const controls: BotWorkflowControl[] = []
    const shellStops: BotShellJobStop[] = []
    try {
      const renderer = resolve("src/renderer/src")
      const css = await compile(
        (await readFile(join(renderer, "index.css"), "utf8")).replace(
          /^@import "@fontsource[^\n]+\n/gm,
          ""
        ),
        { base: renderer, onDependency: () => {} }
      )
      const scanner = new Scanner({
        sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
      })
      const bundle = await build({
        stdin: {
          contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotAsyncTasks}from'./src/renderer/src/components/bots/BotAsyncTasks';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');window.api={bots:new Proxy({},{get:(_,method)=>(input)=>window.apiCall(method,input)})};function Fixture(){const[open,setOpen]=useState(false);const[other,setOther]=useState(false);return <main className="p-8 text-foreground"><h1 className="text-xl font-medium">项目任务</h1><button onClick={()=>setOther(!other)}>切换 Bot</button><button onClick={()=>setOpen(true)}>打开后台任务</button>{open&&<BotAsyncTasks key={String(other)} bot={other?${JSON.stringify(other.bot)}:${JSON.stringify(owner.bot)}} close={()=>setOpen(false)}/>}</main>}createRoot(document.getElementById('root')).render(<Fixture/>);`,
          loader: "tsx",
          resolveDir: process.cwd()
        },
        bundle: true,
        platform: "browser",
        format: "iife",
        write: false,
        outfile: join(root, "ui.js"),
        jsx: "automatic",
        alias: { "@": renderer },
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }
      })
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      const allowed = new Set([
        "asyncTasks",
        "runHistory",
        "workflowControl",
        "shellJob",
        "stopShellJob"
      ])
      await page.exposeFunction("apiCall", async (method: string, input: unknown) => {
        if (!allowed.has(method)) throw new Error(`Unexpected UI method: ${method}`)
        if (method === "workflowControl") controls.push(input as BotWorkflowControl)
        if (method === "stopShellJob") shellStops.push(input as BotShellJobStop)
        const result = await (
          api[method as keyof typeof api] as (input: unknown) => Promise<unknown>
        )(input)
        if (method === "stopShellJob" && shellStops.length === 1)
          throw new Error("Fixture: shell stop reply lost")
        if (method === "workflowControl" && !lostControl) {
          lostControl = true
          throw new Error("Fixture: command acknowledgement lost")
        }
        if (method === "asyncTasks" && (input as BotAsyncTasksRequest).botId === owner.bot.id) {
          if (fail) {
            fail = false
            throw new Error("Fixture: task read interrupted")
          }
          if (delay) {
            delay = false
            await new Promise<void>((resolve) => {
              release = resolve
            })
          }
        }
        return result
      })
      await page.route("http://127.0.0.1:39195/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><head><meta charset="utf-8"><style>${css.build(scanner.scan())}</style></head><body><div id="root"></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text.replaceAll("</script", "<\\/script")}</script></body></html>`
        })
      )
      await page.goto("http://127.0.0.1:39195")
      await page.getByRole("button", { name: "打开后台任务", exact: true }).click()
      const rows = page.getByRole("list", { name: "后台任务列表" }).getByRole("button")
      await expect.poll(() => rows.count()).toBe(20)
      await page.screenshot({ path: join(output, "tasks-light.png"), animations: "disabled" })
      await page.getByRole("button", { name: "下一页", exact: true }).click()
      await expect.poll(() => rows.count()).toBe(5)
      await rows.filter({ has: page.getByText("检查项 0", { exact: true }) }).click()
      await page.getByRole("button", { name: "补充要求", exact: true }).click()
      await page.getByLabel("给此子任务补充要求").fill("请补充失败用例的证据")
      await page.getByRole("button", { name: "发送补充要求", exact: true }).click()
      await page.getByRole("alert").filter({ hasText: "command acknowledgement lost" }).waitFor()
      await page.reload()
      await page.getByRole("button", { name: "打开后台任务", exact: true }).click()
      await page.getByRole("button", { name: "下一页", exact: true }).click()
      await rows.filter({ has: page.getByText("检查项 0", { exact: true }) }).click()
      expect(await page.getByLabel("给此子任务补充要求").inputValue()).toBe("请补充失败用例的证据")
      expect(await page.getByLabel("给此子任务补充要求").isDisabled()).toBe(true)
      await page.getByRole("button", { name: "重试原请求", exact: true }).click()
      await page
        .getByText("补充要求已送达此子任务，将在下一次执行前处理。", { exact: true })
        .waitFor()
      expect(controls[0]).toMatchObject({
        runId: children[0].id,
        conversationId: owner.conversationId,
        threadRootId: original.messageId,
        operation: "message"
      })
      expect(controls[1]).toEqual(controls[0])
      expect(
        (
          await api.messages({
            conversationId: owner.conversationId,
            threadRootId: original.messageId
          })
        ).filter((message) => message.text.includes("请补充失败用例的证据"))
      ).toHaveLength(1)
      await page.getByRole("button", { name: "返回后台任务", exact: true }).click()
      await rows.filter({ has: page.getByText("检查项 1", { exact: true }) }).click()
      await page.getByRole("button", { name: "停止子任务", exact: true }).click()
      await page.getByRole("button", { name: "确认停止", exact: true }).click()
      await page.getByText("子任务已停止。", { exact: true }).waitFor()
      expect(store.getRun(children[1].id).status).toBe("cancelled")
      expect(store.getRun(children[0].id).status).toBe("running")
      expect(store.getRun(children[2].id).status).toBe("queued")
      await page.getByRole("button", { name: "返回后台任务", exact: true }).click()
      await expect.poll(() => rows.count()).toBe(4)
      fail = true
      await page.getByRole("button", { name: "刷新", exact: true }).click()
      await page.getByRole("alert").filter({ hasText: "保留上次读取的任务" }).waitFor()
      expect(await rows.count()).toBe(4)
      await page.evaluate("window.fixtureTheme('codex-dark')")
      await page.screenshot({
        path: join(output, "tasks-interrupted-dark.png"),
        animations: "disabled"
      })
      delay = true
      await page.getByRole("button", { name: "刷新", exact: true }).click()
      await expect.poll(() => !!release).toBe(true)
      await page.keyboard.press("Escape")
      await page.getByRole("button", { name: "切换 Bot", exact: true }).click()
      await page.getByRole("button", { name: "打开后台任务", exact: true }).click()
      await page.getByText("当前没有后台任务", { exact: true }).waitFor()
      release!()
      await page.getByRole("button", { name: "刷新", exact: true }).click()
      await page.getByText("当前没有后台任务", { exact: true }).waitFor()
      expect(await rows.count()).toBe(0)
      expect(
        await page.getByRole("heading", { name: "后台任务 · 其他项目", exact: true }).count()
      ).toBe(1)
      await page.keyboard.press("Escape")
      await page.getByRole("button", { name: "切换 Bot", exact: true }).click()
      const action = { shell: { command: "node verify-background.cjs", background: true } }
      const approval = store.requestInteraction(parent.lease, {
        kind: "approval",
        prompt: JSON.stringify(action),
        action
      })
      store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
      const jobId = store.toolOnce(parent.lease, "shell-ui", action, () => {
        store.beginEffect(parent.lease, { id: "shell-ui-effect", action, approvalId: approval.id })
        return store.shellJobs.reserve(
          parent.lease,
          "shell-ui",
          "shell-ui-effect",
          "node verify-background.cjs"
        )
      })
      store.shellJobs.start(parent.lease, jobId)
      const outputText = `构建开始\n${"building…\n".repeat(1800)}\nSECOND_PAGE_EVIDENCE`
      store.shellJobs.progress(parent.lease, jobId, { output: outputText, truncated: false })
      await page.getByRole("button", { name: "打开后台任务", exact: true }).click()
      await rows.filter({ hasText: "node verify-background.cjs" }).click()
      await page.getByLabel("命令输出").filter({ hasText: "构建开始" }).waitFor()
      await page.screenshot({ path: join(output, "shell-live-dark.png"), animations: "disabled" })
      await page.getByRole("button", { name: "下一页", exact: true }).click()
      await page.getByLabel("命令输出").filter({ hasText: "SECOND_PAGE_EVIDENCE" }).waitFor()
      await page.getByRole("button", { name: "停止命令", exact: true }).click()
      await page.getByRole("alert").filter({ hasText: "shell stop reply lost" }).waitFor()
      await page.reload()
      await page.getByRole("button", { name: "打开后台任务", exact: true }).click()
      await rows.filter({ hasText: "node verify-background.cjs" }).click()
      await page.getByRole("button", { name: "确认停止结果", exact: true }).click()
      await expect.poll(() => shellStops.length).toBe(2)
      expect(shellStops[1]).toEqual(shellStops[0])
      expect(store.shellJobs.get(parent.run.id, jobId).status).toBe("cancelling")
      store.shellJobs.finish(parent.lease, jobId, {
        output: outputText,
        exitCode: null,
        truncated: false
      })
      await page.getByRole("status").filter({ hasText: "结果待核对" }).waitFor()
      await page.screenshot({
        path: join(output, "shell-interrupted-light.png"),
        animations: "disabled"
      })
      await page.keyboard.press("Escape")
      await page.getByRole("button", { name: "切换 Bot", exact: true }).click()
      store.bindLeaseGuard("fixture-host", () => {})
      store.send({
        nonce: "service-turn",
        conversationId: other.conversationId,
        text: "启动开发服务"
      })
      const serviceRun = store.claim("fixture-host", 120_000)!
      const serviceAction = {
        shell: {
          command: "node dev-server.cjs",
          background: true,
          keepAlive: true,
          timeoutSeconds: 7200
        }
      }
      const serviceApproval = store.requestInteraction(serviceRun.lease, {
        kind: "approval",
        prompt: JSON.stringify(serviceAction),
        action: serviceAction
      })
      store.answerInteraction({
        id: serviceApproval.id,
        revision: serviceApproval.revision,
        answer: "approve"
      })
      const serviceLease = store.toolOnce(serviceRun.lease, "service-ui", serviceAction, () => {
        store.beginEffect(serviceRun.lease, {
          id: "service-ui-effect",
          action: serviceAction,
          approvalId: serviceApproval.id
        })
        const id = store.shellJobs.reserve(
          serviceRun.lease,
          "service-ui",
          "service-ui-effect",
          "node dev-server.cjs"
        )
        return store.shellServices.attach(serviceRun.lease, id, 7200000)
      })
      store.shellJobs.start(serviceRun.lease, serviceLease.jobId)
      store.finish(serviceRun.lease, "succeeded", "服务已交给后台")
      store.shellServices.progress(serviceLease, {
        output: "Development server ready\nWatching for changes…",
        truncated: false
      })
      await page.getByRole("button", { name: "打开后台任务", exact: true }).click()
      await rows.filter({ hasText: "node dev-server.cjs" }).click()
      await page.getByRole("heading", { name: "后台服务", exact: true }).waitFor()
      await page.getByText("回复结束后继续运行", { exact: false }).waitFor()
      await page.getByLabel("命令输出").filter({ hasText: "Watching for changes" }).waitFor()
      await page.screenshot({
        path: join(output, "service-after-reply-light.png"),
        animations: "disabled"
      })
      await page.getByRole("button", { name: "停止命令", exact: true }).click()
      await expect
        .poll(() => store.shellJobs.get(serviceRun.run.id, serviceLease.jobId).status)
        .toBe("cancelling")
      store.shellServices.finish(serviceLease, {
        output: "Stopped; review any generated files.",
        truncated: false,
        exitCode: null
      })
      await page.getByRole("status").filter({ hasText: "结果待核对" }).waitFor()
      const review = store.getRun(serviceRun.run.id)
      store.recover({
        id: review.id,
        revision: review.revision,
        decision: "cancel",
        note: "确认进程已停止，文件已核对",
        effects: [{ id: "service-ui-effect", outcome: "succeeded", note: "已检查实际生成文件" }]
      })
      await page.getByRole("status").filter({ hasText: "人工已核对" }).waitFor()
      expect(
        store.shellJobs.read({
          runId: serviceRun.run.id,
          conversationId: other.conversationId,
          jobId: serviceLease.jobId
        }).reviewed
      ).toBe(true)
      expect(errors).toEqual([])
      expect(store.db.exec("PRAGMA foreign_key_check")[0]?.values ?? []).toEqual([])
    } catch (error) {
      await page.screenshot({ path: join(output, "failure.png"), animations: "disabled" })
      throw error
    } finally {
      release?.()
      await browser.close()
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000
)
