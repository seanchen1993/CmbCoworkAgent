/** Opt-in native App + an existing real model. Only temporary synthetic files/conversations. */
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { _electron } from "playwright"
import { selectedBotRoutingModel } from "./support/bot-routing-model"
import { botTestAppOutput } from "./support/bot-test-app"
import { waitForBotAppState } from "./support/bot-app-state"
import { splitBotInlineReasoning } from "../src/shared/bots/inline-reasoning"
import { extractVisibleText } from "../src/main/agent/turn-completion-integrity"
import { OPENING_REPLY_REMINDER } from "../src/main/agent/opening-reply-reminder"
import type {} from "../src/preload/index.d.ts"

async function main() {
  const model = await selectedBotRoutingModel()
  const out = botTestAppOutput()
  const dir = await mkdtemp(join(tmpdir(), "bot-opening-real-"))
  const profile = join(dir, "profile"),
    workspace = join(dir, "sample-inputs")
  let activeCase = "setup"
  const wireRequests: Array<{ test: string; priorToolCalls: number; reminder: boolean }> = []
  // A transparent relay records only control evidence. The real model sees the
  // original body, and its credential stays in this process rather than the App profile.
  const relay = createServer(async (req, res) => {
    try {
      let raw = ""
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      const messages = body.messages ?? []
      const lastUser = messages.findLastIndex((m: any) => m.role === "user")
      wireRequests.push({
        test: activeCase,
        priorToolCalls: messages
          .slice(lastUser + 1)
          .reduce((n: number, m: any) => n + (m.tool_calls?.length ?? 0), 0),
        reminder: messages.some(
          (m: any) =>
            m.role === "system" && JSON.stringify(m.content).includes(OPENING_REPLY_REMINDER)
        )
      })
      const upstream = await fetch(model.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + model.apiKey },
        body: raw,
        signal: AbortSignal.timeout(120000)
      })
      assert.ok(upstream.body, "empty upstream response")
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json"
      })
      await pipeline(Readable.fromWeb(upstream.body as any), res)
    } catch {
      if (!res.headersSent) res.writeHead(502)
      res.end("real-model relay failed")
    }
  })
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve))
  const address = relay.address()
  assert.ok(address && typeof address !== "string")
  await mkdir(workspace, { recursive: true })
  await writeFile(
    join(workspace, "team-a.csv"),
    "编号,分类,金额\nD001,交通,36.50\nD002,餐费,82.00\nD003,交通,17.50\n"
  )
  await writeFile(
    join(workspace, "team-b.csv"),
    "编号,分类,金额\nD002,餐费,82.00\nD004,住宿,220.00\nD005,交通,28.00\n"
  )
  const env: Record<string, string> = {}
  for (const key of [
    "HOME",
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY"
  ])
    if (process.env[key]) env[key] = process.env[key]!
  for (const key of [
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "TEMP",
    "TMP"
  ]) {
    env[key] = join(dir, key)
    await mkdir(env[key], { recursive: true })
  }
  Object.assign(env, {
    CMB_COWORK_AGENT_HOME: profile,
    CMB_TASK_CARDS_MOCK: "1",
    CMB_E2E_DISABLE_GPU: "1",
    CMB_COWORK_TRACE_STORAGE_MODE: "plaintext"
  })
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  const redact = (text: string) => text.replaceAll(model.apiKey, "[redacted]")
  const evidence: unknown[] = []
  try {
    console.log("stage: launch", { model: model.model, artifacts: dir })
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)("electron"),
      args: [join(out, "main/index.js"), `--user-data-dir=${join(dir, "electron")}`],
      cwd: resolve("."),
      env,
      timeout: 60000
    })
    for (const stream of [app.process().stdout, app.process().stderr])
      stream?.on(
        "data",
        (chunk) => void writeFile(join(dir, "app.log"), redact(chunk.toString()), { flag: "a" })
      )
    const page = await app.firstWindow()
    page.setDefaultTimeout(30000)
    await page.getByText("新任务", { exact: true }).first().waitFor()
    await page.evaluate(() => {
      ;(globalThis as any).__name = (value: unknown) => value
    })
    const bot = await page.evaluate(
      async (config) => {
        await window.api.models.setCustomConfig(config)
        await window.api.models.setDefault(`custom:${config.id}`)
        return window.api.bots.create({
          name: "首回复实测",
          instructions: "协助核对本地资料、整理文档，按用户要求完成工作。",
          color: "#168bea",
          modelRef: null,
          memoryMode: "disabled"
        })
      },
      {
        ...model,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "test-relay-no-upstream-secret"
      }
    )
    await waitForBotAppState(
      page,
      async () =>
        !(await window.api.bots.snapshot()).tasks.some((t) =>
          ["queued", "running", "waiting_user"].includes(t.state)
        ),
      undefined,
      { timeout: 240000 }
    )
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940))
    await page.getByText("Bots", { exact: true }).first().click()
    await page.getByText("首回复实测", { exact: true }).first().click()
    const chat = page.locator(`[data-chat-thread-id="${bot.threadId}"]`)
    await chat.waitFor()

    const send = async (name: string, prompt: string, needsTools: boolean) => {
      activeCase = name
      const before = await page.evaluate(
        async (id) => ({
          messages: (await window.api.threads.getMessages(id)).map((m) => m.id),
          tasks: (await window.api.bots.snapshot()).tasks.map((t) => t.id)
        }),
        bot.threadId
      )
      const started = Date.now()
      await chat.locator('textarea, [role="textbox"][contenteditable="true"]').last().fill(prompt)
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done()))
          )
      )
      await chat.locator('button[type="submit"]').last().click()
      let visibleWhileRunning = false
      let firstVisibleMs: number | undefined
      let finished = false
      while (Date.now() - started < 240000) {
        const state = await page.evaluate(
          async ({ botId, threadId, prior }) => ({
            messages: (await window.api.threads.getMessages(threadId)).filter(
              (m) => !prior.messages.includes(m.id)
            ),
            task: (await window.api.bots.snapshot()).tasks.find(
              (t) => t.botId === botId && t.origin.kind === "user" && !prior.tasks.includes(t.id)
            )
          }),
          { botId: bot.id, threadId: bot.threadId, prior: before }
        )
        if (!visibleWhileRunning) {
          const first = state.messages.find(
            (m) =>
              m.role === "assistant" &&
              splitBotInlineReasoning(extractVisibleText(m.content)).body.trim()
          )
          if (first) {
            const text = splitBotInlineReasoning(extractVisibleText(first.content)).body.trim()
            const visible = await chat
              .locator(`[data-chat-message-id="${first.id}"] [data-message-bubble]`)
              .filter({ hasText: text.slice(0, 12) })
              .isVisible()
            if (visible) {
              firstVisibleMs ??= Date.now() - started
              visibleWhileRunning = state.task?.state === "running"
              if (visibleWhileRunning) {
                await page.screenshot({
                  path: join(dir, `${name}-running.png`),
                  animations: "disabled"
                })
                console.log("stage: visible-while-running", {
                  name,
                  milliseconds: firstVisibleMs,
                  reply: text.slice(0, 180)
                })
              }
            }
          }
        }
        if (
          state.task &&
          ["completed", "failed", "cancelled", "outcome_unknown"].includes(state.task.state)
        ) {
          assert.equal(state.task.state, "completed", state.task.error ?? "task did not complete")
          finished = true
          break
        }
        // Only approve this isolated run's local file tools, never an external action.
        const approve = page.getByRole("button", { name: /^(允许|运行|全部批准并执行)$/ }).first()
        if (await approve.isVisible()) await approve.click()
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      assert.ok(finished, "real model turn timed out")
      const messages = await page.evaluate(
        async ({ id, prior }) =>
          (await window.api.threads.getMessages(id)).filter((m) => !prior.includes(m.id)),
        { id: bot.threadId, prior: before.messages }
      )
      await writeFile(join(dir, `${name}-messages.json`), redact(JSON.stringify(messages, null, 2)))
      const assistant = messages.filter((m) => m.role === "assistant")
      const toolIndex = assistant.findIndex((m) => (m.tool_calls?.length ?? 0) > 0)
      const firstTextIndex = assistant.findIndex((m) =>
        splitBotInlineReasoning(extractVisibleText(m.content)).body.trim()
      )
      const tools = assistant.flatMap((m) => m.tool_calls ?? []).map((t: any) => t.name)
      const firstReply =
        firstTextIndex >= 0
          ? splitBotInlineReasoning(
              extractVisibleText(assistant[firstTextIndex].content)
            ).body.trim()
          : ""
      const result = {
        name,
        model: model.model,
        tools,
        firstReply,
        firstTextIndex,
        toolIndex,
        visibleWhileRunning,
        firstVisibleMs,
        elapsedMs: Date.now() - started,
        requests: wireRequests.filter((r) => r.test === name)
      }
      evidence.push(result)
      console.log("stage: turn-finished", result)
      await page.screenshot({ path: join(dir, `${name}-finished.png`), animations: "disabled" })
      assert.ok(
        !JSON.stringify(messages).includes(OPENING_REPLY_REMINDER),
        "internal reminder leaked into transcript"
      )
      assert.ok(firstReply)
      if (needsTools) {
        assert.ok(toolIndex >= 0, "substantive work must really call tools")
        if (firstTextIndex <= toolIndex)
          assert.ok(visibleWhileRunning, "user must see the update while work continues")
        else
          assert.ok(
            result.requests.some((r) => r.priorToolCalls >= 2 && r.reminder),
            "a missed opening must reach the real model's next request; report it separately from an opening reply"
          )
      } else assert.equal(tools.length, 0, "a simple question should not need tools")
      return assistant
        .map((m) => splitBotInlineReasoning(extractVisibleText(m.content)).body)
        .join("\n")
    }

    const request = `请核对 ${workspace} 里的 team-a.csv 和 team-b.csv，这两份都是虚构的报销清单。按编号去重，算出各分类金额与总额，列出重复编号及处理方法。把汇总写到同目录 summary.md，写完回读核对，再给我简短结果。本次在当前主对话完成，不创建独立任务；不访问其他目录或外部服务。`
    await send("01-reconcile", request, true)
    const summaryPath = join(workspace, "summary.md")
    const summary = await readFile(summaryPath, "utf8")
    assert.match(summary, /384/)
    assert.match(summary, /D002/)
    assert.match(summary, /82/)
    assert.match(summary, /220/)
    const answer = await send(
      "02-simple",
      "刚才去重后的总金额是多少？一句话即可，不用再读取文件。",
      false
    )
    assert.match(answer, /384/)
    await send(
      "03-revise",
      `请在 ${summaryPath} 末尾加上“核对完成：OPENING-7K2”，并回读确认。保留原有汇总内容，仍在本次主对话完成。`,
      true
    )
    const revised = await readFile(summaryPath, "utf8")
    assert.match(revised, /核对完成[：:]\s*OPENING-7K2/)
    assert.match(revised, /384/)
    console.log(
      "PASS: real default model, verified opening or observed reminder, local reads/write/re-read, simple answer, follow-up, verified files"
    )
  } catch (error) {
    if (app)
      await (await app.firstWindow())
        .screenshot({ path: join(dir, "failure.png"), animations: "disabled" })
        .catch(() => {})
    console.error(redact(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  } finally {
    await writeFile(join(dir, "evidence.json"), redact(JSON.stringify(evidence, null, 2)))
    await writeFile(join(dir, "model-requests.json"), JSON.stringify(wireRequests, null, 2))
    await app?.close().catch(() => {})
    await rm(join(profile, ".env"), { force: true })
    await new Promise<void>((resolve) => relay.close(() => resolve()))
    console.log("stage: closed; temporary credential removed", dir)
  }
}
void main()
