/** Isolated Electron / IPC / SQLite / real skill hooks; only model decisions are scripted on localhost. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _electron } from "playwright"
import { waitForBotAppState } from "./support/bot-app-state"
import { botTestAppOutput } from "./support/bot-test-app"
import { installSlashSkillFixture, slashSkillSelection } from "./support/bot-slash-skill-fixture"

type Call = { name: string; args: Record<string, unknown> }
function answer(response: ServerResponse, stream: boolean, content: string, call?: Call) {
  const id = randomUUID()
  const finish_reason = call ? "tool_calls" : "stop"
  const toolCall = call && { id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }
  const body = toolCall ? { tool_calls: [{ ...toolCall, index: 0 }] } : { content }
  if (stream) {
    response.writeHead(200, { "content-type": "text/event-stream" })
    for (const choice of [{ delta: body, finish_reason: null }, { delta: {}, finish_reason }])
      response.write("data: " + JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, ...choice }] }) + "\n\n")
    response.end("data: [DONE]\n\n")
  } else {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ id, object: "chat.completion",
      choices: [{ index: 0, finish_reason, message: { role: "assistant", ...body } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }))
  }
}

async function main() {
  const out = botTestAppOutput()
  const root = await mkdtemp(join(tmpdir(), "bot-scheduled-skill-"))
  const workspace = join(root, "报告项目")
  await mkdir(workspace)
  await installSlashSkillFixture(root)
  const skill = slashSkillSelection(workspace)
  const marker = "SKILL_PRD_OK"
  const workerReply = "定时需求检查已完成，需求范围已写入 prd.md。"
  const secondReply = "已沿用原任务，复查了第一版需求文档。"
  const reminder = "到点检查工时"
  const pingReply = "在，后台检查还在进行。"
  const gate = Promise.withResolvers<void>()
  let workerEntered = false
  let workId = ""
  let dispatchCalls = 0
  const errors: string[] = []
  const server = createServer(async (req, res) => {
    try {
      let raw = ""
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      const messages = body.messages ?? []
      const asText = (content: unknown) => typeof content === "string" ? content : JSON.stringify(content)
      const index = messages.findLastIndex((m: any) => m.role === "user" && !asText(m.content).trimStart().startsWith("<bot_reply_reminder>"))
      const user = asText(messages[index]?.content ?? "")
      const receipts = messages.slice(index + 1).filter((m: any) => m.role === "tool")
      const used = messages.slice(index + 1).flatMap((m: any) => (m.tool_calls ?? []).map((c: any) => c.function.name))
      let content = "已就绪。"
      let call: Call | undefined
      if (body.tool_choice?.function?.name === "bot_skill_dispatch") {
        dispatchCalls++
        assert.ok(user.includes("定时整理需求"))
        call = { name: "bot_skill_dispatch", args: { title: "定时需求检查", workspace: { kind: "directory", path: workspace },
          schedule: { frequency: "once", afterSeconds: 5, message: "定时写初稿，按选中的技能撰写 prd.md。" } } }
      } else if (user.includes("host_work_result") || user.includes('<bot_runtime_context event="task_result">')) {
        content = user.includes(secondReply) ? secondReply : workerReply
      } else if (user.includes("例行任务：") && user.includes("定时写初稿")) {
        assert.ok(user.includes(skill.name))
        if (!used.includes("read_file")) {
          workerEntered = true
          await gate.promise
          call = { name: "read_file", args: { file_path: skill.path } }
        } else if (!used.includes("write_file")) {
          assert.ok(receipts.some((r: any) => asText(r.content).includes(marker)), "worker read the installed SKILL.md")
          call = { name: "write_file", args: { file_path: "prd.md", content: "# PRD\n" + marker + "\n需求范围：借书\n" } }
        } else content = workerReply
      } else if (user.includes("例行任务：") && user.includes("定时复查原稿")) {
        assert.ok(messages.some((m: any) => m.role === "assistant" && asText(m.content).includes(workerReply)), "original worker history")
        if (!used.includes("read_file")) call = { name: "read_file", args: { file_path: "prd.md" } }
        else {
          assert.ok(receipts.some((r: any) => asText(r.content).includes(marker)), "original workspace file")
          content = secondReply
        }
      } else if (user.includes("安排固定提醒") || user.includes("安排继续原任务")) {
        const fixed = user.includes("安排固定提醒")
        if (!used.includes("bot_schedule")) call = { name: "bot_schedule", args: {
          action: "save", requestKey: fixed ? "fixed" : "repeat-work", name: fixed ? "工时提醒" : "原任务复查",
          afterSeconds: 3, message: fixed ? reminder : "定时复查原稿", ...(fixed ? { kind: "fixed_reminder" } : { workId })
        } }
        else {
          assert.ok(receipts.every((r: any) => !r.is_error && asText(r.content).includes("nextRunAt")))
          content = "日程已安排。"
        }
      } else if (user.includes("主对话还在吗")) content = pingReply
      answer(res, body.stream, content, call)
    } catch (error) {
      errors.push(String(error))
      res.writeHead(500).end("local fixture failed")
    }
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const binary = createRequire(import.meta.url)("electron") as string
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    const env = Object.fromEntries(["PATH", "HOME", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"].filter(k => process.env[k]).map(k => [k, process.env[k]!]))
    app = await _electron.launch({ executablePath: binary, args: [join(out, "main/index.js"), "--user-data-dir=" + join(root, "electron")],
      env: { ...env, CMB_COWORK_AGENT_HOME: join(root, "profile"), CMB_E2E_DISABLE_GPU: "1", CMB_TASK_CARDS_MOCK: "1",
        CMB_COWORK_TRACE_STORAGE_MODE: "plaintext", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "127.0.0.1,localhost", NODE_USE_ENV_PROXY: "1" } })
    app.process().stdout?.resume()
    app.process().stderr?.resume()
    await app.context().route(/^https?:/, route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort())
    const page = await app.firstWindow()
    await page.getByText("新任务", { exact: true }).first().waitFor()
    const bot = await page.evaluate(async baseUrl => {
      ;(globalThis as any).__name = (value: unknown) => value
      const api = (window as any).api
      await api.models.setCustomConfig({ id: "routine-local", name: "Local fixture", baseUrl, model: "routine-local", apiKey: "fixture", maxTokens: 64000, maxOutputTokens: 2048 })
      await api.models.setDefault("custom:routine-local")
      await api.sandbox.setYoloMode(true)
      return api.bots.create({ name: "例行测试", instructions: "按要求执行日程。", color: "#168bea", modelRef: "custom:routine-local" })
    }, `http://127.0.0.1:${address.port}/v1`)
    const send = (message: string, explicitSkill?: typeof skill) =>
      page.evaluate(input => (window as any).api.bots.send(input), { botId: bot.id, requestId: randomUUID(), message, explicitSkill })
    const idle = () => waitForBotAppState(page, async () => !(await (window as any).api.bots.snapshot()).tasks.some((t: any) => ["queued", "running", "waiting_user"].includes(t.state)))
    const hasReply = (text: string) => waitForBotAppState(page, async ({ id, text }) =>
      (await (window as any).api.threads.getMessages(id)).some((m: any) => m.role === "assistant" && String(m.content).includes(text)), { id: bot.threadId, text })
    await idle()
    await send("定时整理需求，五秒后按所选技能在指定项目写 prd.md", skill)
    await hasReply("已安排「定时需求检查」")
    const snapshot = () => page.evaluate(() => (window as any).api.bots.snapshot())
    const saved = (await snapshot()).schedules[0]
    assert.deepEqual(saved.explicitSkill, skill)
    assert.ok(saved.workId && saved.dedicatedWork)
    assert.equal(dispatchCalls, 1)
    assert.ok(!(await snapshot()).tasks.some((t: any) => t.origin.kind === "schedule"), "saving did not start a worker")
    await waitForBotAppState(page, async () => (await (window as any).api.bots.snapshot()).tasks.some((t: any) => t.origin.kind === "schedule" && t.state === "running"))
    const start = performance.now()
    await send("主对话还在吗")
    await hasReply(pingReply)
    const pingMs = Math.round(performance.now() - start)
    await send("安排固定提醒，三秒后提醒我到点检查工时")
    await hasReply(reminder)
    assert.ok(workerEntered)
    assert.ok((await snapshot()).tasks.some((t: any) => t.workId === saved.workId && t.state === "running"))
    gate.resolve()
    await hasReply(workerReply)
    await idle()
    assert.match(await readFile(join(workspace, "prd.md"), "utf8"), /SKILL_PRD_OK/)
    workId = saved.workId
    await send("安排继续原任务，三秒后复查刚才那份报告")
    await hasReply(secondReply)
    await idle()
    const state = await snapshot()
    const occurrences = state.tasks.filter((t: any) => t.origin.kind === "schedule")
    const worker = occurrences.filter((t: any) => t.workId)
    assert.equal(occurrences.length, 3)
    assert.equal(worker.length, 2)
    assert.ok(worker.every((t: any) => t.state === "completed" && t.workId === workId && t.threadId === worker[0].threadId))
    assert.notEqual(worker[0].threadId, bot.threadId)
    const events = (await readFile(join(root, "skill-lifecycle.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
    assert.ok(["PreSkillUse", "PostSkillUse"].every(event => events.some(e => e.event === event && e.sessionId === worker[0].threadId && e.trigger === "skill_select")))
    assert.ok(!events.some(e => e.sessionId === bot.threadId))
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ fixedReminders: 1, workerOccurrences: worker.length, distinctWorkIds: new Set(worker.map((t: any) => t.workId)).size,
      skillRouteModelCalls: dispatchCalls, mainReplyWhileWorkerHeldMs: pingMs, resultReturnedToMain: true, hookEvents: events.map(e => e.event) }))
  } finally {
    gate.resolve()
    await app?.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
    if (errors.length) console.error(errors)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
