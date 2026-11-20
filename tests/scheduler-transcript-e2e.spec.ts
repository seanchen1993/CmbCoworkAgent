/** Real scheduler IPC, LangGraph runtime, read_file, SQLite and React. Only the
 * model HTTP endpoint is controlled. Run after build with Node 22 and tsx.
 */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { _electron, type ElectronApplication, type Page } from "playwright"
import type { Message, ScheduledTaskUpsert, Thread } from "../src/main/types"

interface FixtureApi {
  models: {
    setCustomConfig(config: Record<string, unknown>): Promise<void>
    setDefault(id: string): Promise<void>
  }
  routing: { setMode(mode: string): Promise<void> }
  scheduledTasks: {
    create(task: ScheduledTaskUpsert): Promise<{ id: string }>
    runNow(id: string): Promise<void>
    isRunning(id: string): Promise<boolean>
  }
  threads: {
    list(): Promise<Thread[]>
    create(metadata: Record<string, unknown>): Promise<Thread>
    appendMessages(id: string, messages: unknown[]): Promise<void>
    getMessages(id: string): Promise<Message[]>
    bootstrapLegacyCheckpointTranscript(id: string): Promise<unknown>
  }
}
declare global {
  interface Window {
    schedulerTestApi?: FixtureApi
  }
}

const root = resolve(import.meta.dirname, "..")
const output = resolve(root, "output/scheduler-transcript-e2e", String(Date.now()))
const workspace = join(output, "workspace")
mkdirSync(workspace, { recursive: true })
writeFileSync(join(workspace, "evidence.txt"), "SCHEDULER_TOOL_EVIDENCE\n")
const require = createRequire(import.meta.url)
const binary = require("electron") as string
const errors: string[] = []
const results: string[] = []
const histories: Array<{ threadId: string; title: string; answer: string; reasoning: string }> = []
function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
type Fixture = ReturnType<typeof makeFixture>
function makeFixture(name: string) {
  return {
    name,
    output: gate(),
    done: gate(),
    requested: false,
    emitted: false,
    calls: 0,
    answer: `${name}_ANSWER_` + "哈哈".repeat(96),
    reasoning: `${name}_REASONING_` + "思考".repeat(24)
  }
}
const fixtures = [
  makeFixture("SCHEDULE_COMPLETE"),
  makeFixture("SCHEDULE_CANCEL"),
  makeFixture("SCHEDULE_UNOPENED")
]
const ordinary = makeFixture("ORDINARY_CONTROL")

async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 45_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timeout: ${label}`)
}

async function main() {
  const server = createServer((request, response) => {
    void (async () => {
      let text = ""
      for await (const chunk of request) text += chunk
      const body = JSON.parse(text)
      const wire = JSON.stringify(body.messages)
      const fixture = [...fixtures, ordinary].find((candidate) => wire.includes(candidate.name))
      if (!fixture) throw new Error("Unexpected model request")
      fixture.calls++
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      const send = (delta: unknown, finish_reason: string | null = null) => {
        if (!response.destroyed)
          response.write(
            `data: ${JSON.stringify({
              id: `${fixture.name}-provider`,
              object: "chat.completion.chunk",
              model: "scheduler-local",
              choices: [{ index: 0, delta, finish_reason }]
            })}\n\n`
          )
      }
      if (fixture !== ordinary && fixture.calls === 1) {
        assert.ok(
          body.tools.some(
            (tool: { function: { name: string } }) => tool.function.name === "read_file"
          )
        )
        send({
          role: "assistant",
          content: `${fixture.name}_CHECK`,
          tool_calls: [
            {
              index: 0,
              id: `${fixture.name}-call`,
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ file_path: join(workspace, "evidence.txt") })
              }
            }
          ]
        })
        send({}, "tool_calls")
        response.end("data: [DONE]\n\n")
        return
      }
      if (fixture !== ordinary) assert.ok(wire.includes("SCHEDULER_TOOL_EVIDENCE"))
      fixture.requested = true
      await fixture.output.promise
      send({
        role: "assistant",
        content: `${fixture.name}_ANSWER_`,
        reasoning_content: `${fixture.name}_REASONING_`
      })
      for (let index = 0; index < 96; index++) {
        send({ content: "哈哈", ...(index < 24 ? { reasoning_content: "思考" } : {}) })
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      fixture.emitted = true
      await fixture.done.promise
      send({}, "stop")
      response.end("data: [DONE]\n\n")
    })().catch((error) => {
      errors.push(String(error))
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = (server.address() as { port: number }).port
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  )
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  for (const key of ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
    env[key] = join(output, key)
    mkdirSync(env[key], { recursive: true })
  }
  Object.assign(env, {
    CMB_COWORK_AGENT_HOME: join(output, "profile"),
    CMB_TASK_CARDS_MOCK: "1",
    CMB_E2E_DISABLE_GPU: "1",
    CMB_E2E_ELECTRON_BIN: binary,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    NODE_USE_ENV_PROXY: "1"
  })
  let app: ElectronApplication | undefined
  let page: Page | undefined
  async function launch() {
    app = await _electron.launch({
      executablePath:
        process.platform === "win32" ? join(root, "tests/support/electron-launcher.cmd") : binary,
      args: [
        join(root, "out/main/index.js"),
        `--user-data-dir=${join(output, "electron-profile")}`
      ],
      cwd: root,
      env,
      timeout: 60_000
    })
    app.process().stdout?.on("data", (data) => appendFileSync(join(output, "electron.log"), data))
    app.process().stderr?.on("data", (data) => appendFileSync(join(output, "electron.log"), data))
    await app.context().route(/^https?:/, (route) => {
      const host = new URL(route.request().url()).hostname
      return host === "127.0.0.1" || host === "localhost" ? route.continue() : route.abort()
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(30_000)
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
    await page.getByText("新任务", { exact: true }).first().waitFor()
    await page.evaluate(() => {
      window.schedulerTestApi = (window as unknown as { api: FixtureApi }).api
    })
  }
  async function assertVisible(threadId: string, fixture: Fixture) {
    const chat = page!.locator(`[data-chat-thread-id="${threadId}"]`)
    await until(
      async () => (await chat.innerText()).includes(fixture.answer),
      `${fixture.name} visible answer`
    )
    await until(async () => {
      const row = chat.locator("[data-chat-message-row]").filter({ hasText: fixture.answer }).last()
      const button = row.getByRole("button", { name: "思考", exact: true })
      if (!(await button.count())) return false
      if ((await button.getAttribute("aria-expanded")) !== "true") await button.click()
      return (await row.innerText()).includes(fixture.reasoning)
    }, `${fixture.name} visible reasoning`)
  }
  try {
    await launch()
    const control = await page!.evaluate(
      async ({ baseUrl, workspace }) => {
        const api = window.schedulerTestApi!
        await api.models.setCustomConfig({
          id: "scheduler-local",
          name: "Local scheduler",
          baseUrl,
          model: "deepseek-scheduler-local",
          enableThinking: true,
          apiKey: "local-only",
          maxTokens: 64000,
          maxOutputTokens: 4096
        })
        await api.models.setDefault("custom:scheduler-local")
        await api.routing.setMode("pinned")
        return api.threads.create({
          title: "普通会话对照",
          workspacePath: workspace,
          agentMode: "normal",
          model: "custom:scheduler-local"
        })
      },
      { baseUrl: `http://127.0.0.1:${port}/v1`, workspace }
    )
    await page!.reload({ waitUntil: "domcontentloaded" })
    await page!.evaluate(() => {
      window.schedulerTestApi = (window as unknown as { api: FixtureApi }).api
    })
    for (const fixture of fixtures) {
      const task = await page!.evaluate(
        async ({ name, workspace }) => {
          const api = window.schedulerTestApi!
          const task = await api.scheduledTasks.create({
            name,
            description: "local E2E",
            prompt: name,
            frequency: "manual",
            taskType: "action",
            modelId: "custom:scheduler-local",
            workDir: workspace,
            enabled: true
          })
          await api.scheduledTasks.runNow(task.id)
          return task
        },
        { name: fixture.name, workspace }
      )
      await until(() => fixture.requested, `${fixture.name} read_file completed`)
      const thread = await page!.evaluate(async (taskId) => {
        const threads = await window.schedulerTestApi!.threads.list()
        return threads.find((thread) => {
          const metadata =
            typeof thread.metadata === "string" ? JSON.parse(thread.metadata) : thread.metadata
          return metadata?.scheduledTaskId === taskId
        })!
      }, task.id)
      assert.ok(thread?.thread_id)
      const threadId = thread.thread_id
      const title = thread.title!.replace(/^\[定时\]\s*/, "")
      if (fixture.name !== "SCHEDULE_UNOPENED") {
        await page!.getByText(title, { exact: true }).first().click()
        await page!.locator(`[data-chat-thread-id="${threadId}"]`).waitFor()
        await page!.evaluate(
          (id) => window.schedulerTestApi!.threads.bootstrapLegacyCheckpointTranscript(id),
          threadId
        )
      }
      fixture.output.release()
      await until(() => fixture.emitted, `${fixture.name} output streamed`)
      if (fixture.name !== "SCHEDULE_UNOPENED") await assertVisible(threadId, fixture)
      if (fixture.name === "SCHEDULE_CANCEL") {
        await page!.getByRole("button", { name: "停止生成", exact: true }).click()
      } else if (fixture.name === "SCHEDULE_COMPLETE") {
        // Keep a foreground request open while the background scheduled run
        // completes. Its done must neither cancel nor replace the other chat.
        await page!.getByText(control.title!, { exact: true }).first().click()
        const composer = page!.locator("textarea.composer-textarea")
        await composer.fill(ordinary.name)
        await composer.locator("xpath=ancestor::form").locator('button[type="submit"]').click()
        ordinary.output.release()
        await until(() => ordinary.emitted, "ordinary foreground output")
        fixture.done.release()
        await until(
          () =>
            page!.evaluate(
              (id) =>
                window.schedulerTestApi!.scheduledTasks.isRunning(id).then((running) => !running),
              task.id
            ),
          "scheduled completion while ordinary runs"
        )
        await assertVisible(control.thread_id, ordinary)
        assert.ok(await page!.getByRole("button", { name: "停止生成", exact: true }).isVisible())
        ordinary.done.release()
        await until(
          async () => !(await page!.getByRole("button", { name: "停止生成", exact: true }).count()),
          "ordinary completion"
        )
        await assertVisible(control.thread_id, ordinary)
        results.push(
          "ordinary foreground request and output survive concurrent scheduled completion"
        )
      } else fixture.done.release()
      await until(
        () =>
          page!.evaluate(
            (id) =>
              window.schedulerTestApi!.scheduledTasks.isRunning(id).then((running) => !running),
            task.id
          ),
        `${fixture.name} settled`
      )
      fixture.done.release()
      const stored = await page!.evaluate(
        (id) => window.schedulerTestApi!.threads.getMessages(id),
        threadId
      )
      const final = stored.find((message) => message.content === fixture.answer)
      assert.equal(final?.reasoning, fixture.reasoning)
      assert.equal(stored.filter((message) => message.role === "user").length, 1)
      assert.ok(
        stored.some(
          (message) =>
            message.role === "tool" && String(message.content).includes("SCHEDULER_TOOL_EVIDENCE")
        )
      )
      assert.equal(new Set(stored.map((message) => message.id)).size, stored.length)
      for (let iteration = 0; iteration < 4; iteration++) {
        await page!.getByText(control.title!, { exact: true }).first().click()
        await page!.getByText(title, { exact: true }).first().click()
        await assertVisible(threadId, fixture)
      }
      await page!.screenshot({ path: join(output, `${fixture.name}.png`) })
      histories.push({ threadId, title, answer: fixture.answer, reasoning: fixture.reasoning })
      results.push(
        `${fixture.name}: real task/tool output survives terminal event, SQLite read and repeated navigation`
      )
    }
    await app!.close()
    app = undefined
    await launch()
    for (const history of histories) {
      await page!.getByText(history.title, { exact: true }).first().click()
      await assertVisible(history.threadId, { ...makeFixture(history.title), ...history })
    }
    results.push(
      "completed, cancelled and unopened task transcripts survive a full Electron restart"
    )
    assert.deepEqual(errors, [])
    writeFileSync(
      join(output, "result.json"),
      JSON.stringify({ results, errors, histories }, null, 2)
    )
    console.log(JSON.stringify({ output, results, errors }, null, 2))
  } catch (error) {
    if (page) await page.screenshot({ path: join(output, "failure.png") }).catch(() => {})
    writeFileSync(
      join(output, "failure.json"),
      JSON.stringify({ error: String(error), results, errors }, null, 2)
    )
    throw error
  } finally {
    for (const fixture of [...fixtures, ordinary]) {
      fixture.output.release()
      fixture.done.release()
    }
    if (app) await app.close().catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
