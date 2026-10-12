/** Real history component and Bot API, with disposable persisted child task fixtures. */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { BotHost } from "../src/main/bots/host"
import { createBotAPI } from "../src/main/bots/rpc"
import { BotWorkflowStore } from "../src/main/bots/workflow-store"
import { BotWorktrees } from "../src/main/bots/worktrees"

async function main() {
  const root = await mkdtemp(join(tmpdir(), "bot-workflow-ui-")),
    output = resolve("output/bot-workflow")
  await mkdir(output, { recursive: true })
  const store = new BotStore(join(root, "bots.sqlite"))
  const project = join(root, "project"),
    host = join(root, "host")
  await mkdir(project)
  await mkdir(host)
  const git = async (cwd: string, ...args: string[]) =>
    promisify(execFile)("git", [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-C",
      cwd,
      ...args
    ])
  await git(project, "init", "-b", "main")
  await writeFile(
    join(project, "validate.ts"),
    "export const isValid = (input: string) => input.length > 0\n"
  )
  await git(project, "add", "validate.ts")
  await git(project, "commit", "-m", "initial")
  const entry = join(root, "worktree.cjs")
  await build({
    entryPoints: ["src/main/bots/worktree-worker-entry.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: entry,
    logLevel: "silent"
  })
  const worktrees = new BotWorktrees(join(host, "models.private"), { entry })
  const { bot, conversationId } = store.createBot({
    nonce: "bot",
    name: "项目助手",
    workspacePath: project
  })
  store.send({ nonce: "task", conversationId, text: "检查本次发布的代码、测试和接口兼容性。" })
  const parent = store.claim("ui", 300_000)!
  const workflow = BotWorkflowStore.open(store, parent.lease, "call", {
    script: 'export const meta={name:"发布评审",description:"并行检查"}; return "ready";',
    maxConcurrency: 3,
    defaultModelId: "fixture",
    agentProfiles: [],
    authority: {}
  })
  const labels = ["代码变更检查", "测试结果核对", "接口兼容性检查"]
  const children = labels.map((label, i) =>
    store.workflowChildren.claim(workflow, parent.lease, {
      prompt: label,
      label,
      agentIndex: i + 1,
      phase: "发布评审",
      ...(i !== 1 ? { isolation: "worktree" as const } : {}),
      toolStreamKey: `${"a".repeat(64)}_c${i}`,
      durableCallKey: `${"a".repeat(64)}_n${i}`
    })
  )
  await worktrees.execute(
    {
      store,
      bot,
      run: children[0].run,
      lease: children[0].lease!,
      messages: [],
      signal: new AbortController().signal
    },
    async (request) => {
      await writeFile(
        join(request.bot.workspacePath!, "validate.ts"),
        "export const isValid = (input: string | null) => Boolean(input?.length)\n"
      )
      await git(request.bot.workspacePath!, "add", "validate.ts")
      await git(request.bot.workspacePath!, "commit", "-m", "Handle null input")
      return "validated"
    }
  )
  const action = { path: "validate.ts", operation: "save" }
  const approval = store.requestInteraction(children[0].lease!, {
    kind: "approval",
    action,
    prompt: JSON.stringify(action)
  })
  store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  store.beginEffect(children[0].lease!, { id: "child-effect", action, approvalId: approval.id })
  store.settleEffect(children[0].lease!, "child-effect", "succeeded", "子任务已保存空值检查变更")
  store.workflowChildren.settle(children[0].lease!, "succeeded", {
    text: "已核对 12 个变更文件。\n\n结论：未发现接口破坏性变更；建议补充空值输入的测试。",
    structured: null,
    outputTokens: 180
  })
  store.requestInteraction(children[1].lease!, { kind: "question", prompt: "使用哪个测试环境？" })
  store.activity(children[2].lease!, "正在核对接口定义", "file")
  const api = createBotAPI(
      new BotHost(store, {
        worktrees,
        execute: async () => {
          throw new Error("UI fixture must not dispatch models")
        }
      })
    ),
    renderer = resolve("src/renderer/src")
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
      contents: `import React from 'react';import{createRoot}from'react-dom/client';import{BotRunHistory}from'./src/renderer/src/components/bots/BotRunHistory';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');window.api={bots:new Proxy({},{get:(_,method)=>(input)=>window.botCall(method,input)})};createRoot(document.getElementById('root')).render(<BotRunHistory address={${JSON.stringify({ conversationId, runId: parent.run.id })}} close={()=>{}}/>);`,
      resolveDir: process.cwd(),
      loader: "tsx"
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    tsconfig: "tsconfig.web.json",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent"
  })
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 850 } })
    const errors: string[] = []
    let loseFirstControlReply = true
    page.on("pageerror", (error) => errors.push(error.message))
    await page.exposeFunction("botCall", async (method: string, input: unknown) => {
      if (method === "runHistory")
        return api.runHistory(input as Parameters<typeof api.runHistory>[0])
      if (method === "effectDetail")
        return api.effectDetail(input as Parameters<typeof api.effectDetail>[0])
      if (method === "worktreeDetail")
        return api.worktreeDetail(input as Parameters<typeof api.worktreeDetail>[0])
      if (method === "worktreeMerge")
        return api.worktreeMerge(input as Parameters<typeof api.worktreeMerge>[0])
      if (method === "worktreeCleanup")
        return api.worktreeCleanup(input as Parameters<typeof api.worktreeCleanup>[0])
      if (method === "workflowControl") {
        const result = await api.workflowControl(input as Parameters<typeof api.workflowControl>[0])
        if (loseFirstControlReply) {
          loseFirstControlReply = false
          throw new Error("连接中断，结果待确认")
        }
        return result
      }
      throw new Error(`Unexpected UI method ${method}`)
    })
    await page.route("http://127.0.0.1:39177/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>'
      })
    )
    await page.goto("http://127.0.0.1:39177/")
    await page.addStyleTag({ content: css.build(scanner.scan()) })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const list = page.getByRole("region", { name: "工作流子任务" })
    await list.getByText("1 / 3 已完成", { exact: true }).waitFor()
    await list.getByText("等待处理", { exact: true }).waitFor()
    await page.screenshot({
      path: join(output, "workflow-tasks-light.png"),
      animations: "disabled"
    })
    await list.getByRole("button", { name: /代码变更检查/ }).click()
    await page
      .getByRole("region", { name: "子任务结果" })
      .getByText(/已核对 12 个变更文件/)
      .waitFor()
    assert.equal(await list.count(), 0)
    await page.getByRole("button", { name: "操作：已完成", exact: true }).click()
    await page
      .getByLabel("操作详情")
      .getByText("子任务已保存空值检查变更", { exact: true })
      .waitFor()
    await page.getByRole("button", { name: "返回父任务", exact: true }).click()
    await list.getByText("1 / 3 已完成", { exact: true }).waitFor()
    await list.getByRole("button", { name: /测试结果核对/ }).click()
    const controls = page.getByRole("region", { name: "子任务操作" })
    await controls.getByRole("button", { name: "补充要求", exact: true }).click()
    await controls
      .getByRole("textbox", { name: "给此子任务补充要求" })
      .fill("使用验收环境，只运行只读检查。")
    await controls.getByRole("button", { name: "发送补充要求", exact: true }).click()
    await controls.getByRole("alert").waitFor()
    await controls.getByRole("button", { name: "重试原请求", exact: true }).click()
    await controls
      .getByRole("status")
      .waitFor()
      .catch(async (error) => {
        throw new Error(
          `${error}\n${JSON.stringify(errors)}\n${await page.locator("body").innerText()}`
        )
      })
    assert.equal(
      store.messages(conversationId).filter((message) => message.text.includes("使用验收环境"))
        .length,
      1
    )
    assert.equal(store.steering.hasPending(children[1].run.id), true)
    assert.equal(store.steering.hasPending(children[2].run.id), false)
    await page.screenshot({
      path: join(output, "workflow-child-steer-light.png"),
      animations: "disabled"
    })
    await controls.getByRole("button", { name: "停止子任务", exact: true }).click()
    await controls.getByRole("button", { name: "取消", exact: true }).click()
    assert.equal(store.getRun(children[1].run.id).status, "waiting_input")
    await controls.getByRole("button", { name: "停止子任务", exact: true }).click()
    await controls.getByRole("button", { name: "确认停止", exact: true }).click()
    await controls.getByText("停止请求已送达", { exact: false }).waitFor()
    assert.equal(store.getRun(children[1].run.id).status, "cancelling")
    assert.equal(store.getRun(children[2].run.id).status, "running")
    await page.getByRole("button", { name: "返回父任务", exact: true }).click()
    let discardedDirectory = ""
    await worktrees.execute(
      {
        store,
        bot,
        run: children[2].run,
        lease: children[2].lease!,
        messages: [],
        signal: new AbortController().signal
      },
      async (request) => {
        discardedDirectory = request.bot.workspacePath!
        await writeFile(join(discardedDirectory, "scratch.txt"), "Temporary findings")
        return "done"
      }
    )
    store.workflowChildren.settle(children[2].lease!, "succeeded", {
      text: "接口兼容性检查通过。",
      structured: null,
      outputTokens: 90
    })
    await list.getByText("2 / 3 已完成", { exact: true }).waitFor()
    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(value: string): void }).fixtureTheme("codex-dark")
    )
    await list.getByRole("button", { name: /代码变更检查/ }).click()
    await page.getByRole("region", { name: "子任务结果" }).waitFor()
    await page.getByRole("button", { name: "查看变更", exact: true }).click()
    await page.getByText("变更预览", { exact: true }).waitFor()
    await page.getByText("Boolean(input?.length)", { exact: false }).waitFor()
    await page.screenshot({
      path: join(output, "workflow-worktree-dark.png"),
      animations: "disabled"
    })
    await page.getByRole("button", { name: "全屏查看", exact: true }).click()
    const fullscreen = page.getByRole("dialog", { name: "代码差异", exact: true })
    await fullscreen.waitFor()
    await page.screenshot({
      path: join(output, "workflow-worktree-fullscreen-dark.png"),
      animations: "disabled"
    })
    const bounds = (await fullscreen.boundingBox())!
    assert(
      bounds.width > 1100 && bounds.height > 780,
      "Diff should fill the viewport outside its parent dialog"
    )
    await fullscreen.getByRole("button", { name: "退出全屏", exact: true }).click()
    await page.getByRole("button", { name: "合并到源分支", exact: true }).click()
    await page.getByRole("button", { name: "确认合并", exact: true }).click()
    await page
      .getByText("变更已合并到源分支。", { exact: true })
      .waitFor()
      .catch(async (error) => {
        throw new Error(
          `${error}\n${JSON.stringify(errors)}\n${await page.locator("body").innerText()}`
        )
      })
    assert.match(await readFile(join(project, "validate.ts"), "utf8"), /string \| null/)
    await page.screenshot({
      path: join(output, "workflow-worktree-merged-dark.png"),
      animations: "disabled"
    })
    await page.getByRole("button", { name: "返回父任务", exact: true }).click()
    await list.getByRole("button", { name: /接口兼容性检查/ }).click()
    await page.getByRole("button", { name: "查看变更", exact: true }).click()
    await page.getByText("Temporary findings", { exact: true }).waitFor()
    await page.screenshot({
      path: join(output, "workflow-uncommitted-dark.png"),
      animations: "disabled"
    })
    await page.getByRole("button", { name: "丢弃工作区", exact: true }).click()
    await page.getByRole("button", { name: "取消", exact: true }).click()
    assert.equal(
      await readFile(join(discardedDirectory, "scratch.txt"), "utf8"),
      "Temporary findings"
    )
    await page.getByRole("button", { name: "丢弃工作区", exact: true }).click()
    await page.screenshot({
      path: join(output, "workflow-worktree-discard-dark.png"),
      animations: "disabled"
    })
    await page.getByRole("button", { name: "确认删除工作区", exact: true }).click()
    await page.getByText("工作区已丢弃。", { exact: true }).last().waitFor()
    await assert.rejects(readFile(join(discardedDirectory, "scratch.txt")))
    assert.match(await readFile(join(project, "validate.ts"), "utf8"), /string \| null/)
    await page.getByRole("button", { name: "返回父任务", exact: true }).click()
    const queued = store.workflowChildren.reserve(workflow, parent.lease, {
      prompt: "Queued review",
      label: "排队中的检查",
      agentIndex: 4,
      phase: "发布评审",
      toolStreamKey: `${"b".repeat(64)}_c0`,
      durableCallKey: `${"b".repeat(64)}_n0`
    })
    await list.getByRole("button", { name: /排队中的检查/ }).click()
    const queuedControls = page.getByRole("region", { name: "子任务操作" })
    await queuedControls.getByRole("button", { name: "停止子任务", exact: true }).waitFor()
    assert.equal(
      await queuedControls.getByRole("button", { name: "补充要求", exact: true }).count(),
      0
    )
    await page.screenshot({
      path: join(output, "workflow-queued-dark.png"),
      animations: "disabled"
    })
    await queuedControls.getByRole("button", { name: "停止子任务", exact: true }).click()
    await queuedControls.getByRole("button", { name: "确认停止", exact: true }).click()
    await queuedControls.getByText("子任务已停止。", { exact: true }).waitFor()
    assert.equal(store.getRun(queued.id).status, "cancelled")
    assert.equal(store.getRun(queued.id).fence, 0)
    assert.deepEqual(errors, [])
    assert.equal(store.getRun(children[1].run.id).status, "cancelling")
    assert.equal(store.getRun(parent.run.id).botId, bot.id)
    console.log(
      "Bot workflow history UI passed: live child statuses, scoped result navigation and light/dark views"
    )
  } finally {
    await browser.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
