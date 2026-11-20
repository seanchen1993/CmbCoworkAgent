/** Local SSE disconnect after a real command, through foreground and managed delivery.
 * Run after npm run build: node --import tsx tests/stream-retry-e2e.spec.ts
 */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { _electron, type ElectronApplication, type Page } from "playwright"

interface RetryApi {
  models: {
    setCustomConfig(config: Record<string, unknown>): Promise<void>
    setDefault(id: string): Promise<void>
  }
  routing: { setMode(mode: string): Promise<void> }
  sandbox: { setYoloMode(enabled: boolean): Promise<void> }
  threads: {
    create(metadata: Record<string, unknown>): Promise<{ thread_id: string; title: string }>
    getMessages(id: string): Promise<Array<{ id: string; role: string; content: unknown }>>
  }
}
const root = resolve(import.meta.dirname, "..")
const output = join(root, "output/stream-retry-e2e", String(Date.now()))
const workspace = join(output, "workspace")
mkdirSync(workspace, { recursive: true })
const localRequire = createRequire(import.meta.url)
const binary = localRequire("electron") as string
const errors: string[] = []
const checks: string[] = []
function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const fixtures = ["FOREGROUND", "MANAGED"].map((name) => ({
  name,
  calls: 0,
  failed: false,
  retry: false,
  begin: gate(),
  disconnect: gate(),
  resume: gate(),
  finish: gate(),
  failedText: `${name}_FAILED_FRAGMENT`,
  answer: `${name}_SUCCESS_FILE_DELIVERED`,
  file: join(workspace, `${name}.txt`)
}))
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timeout: ${label}`)
}

async function main() {
  // Load the production managed delivery in Electron without adding a test IPC
  // surface to the app. Only the delivery selection is substituted; the invoke
  // handler, runtime, retry loop, checkpoint, SQLite and React stay production.
  const deliveryBundle = join(output, "managed-delivery.cjs")
  await build({
    entryPoints: [join(root, "src/main/agent/managed-transport-delivery.ts")],
    outfile: deliveryBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"]
  })
  const server = createServer((request, response) => {
    void (async () => {
      let text = ""
      for await (const chunk of request) text += chunk
      const body = JSON.parse(text)
      const wire = JSON.stringify(body.messages)
      const fixture = fixtures.find((candidate) => wire.includes(`RETRY_${candidate.name}`))
      assert.ok(fixture, "request belongs to local retry fixture")
      fixture.calls++
      response.writeHead(200, { "content-type": "text/event-stream" })
      const send = (delta: unknown, finish_reason: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({ id: `${fixture.name}-reused-provider`, object: "chat.completion.chunk", model: "retry-local", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        )
      if (fixture.calls === 1) {
        assert.ok(
          body.tools.some(
            (tool: { function: { name: string } }) => tool.function.name === "execute"
          )
        )
        const script = `require('fs').appendFileSync('${fixture.file.replaceAll("\\", "/")}', 'EXECUTED_ONCE\\n')`
        send({
          role: "assistant",
          content: "Preparing file",
          tool_calls: [
            {
              index: 0,
              id: `${fixture.name}-command`,
              type: "function",
              function: {
                name: "execute",
                arguments: JSON.stringify({ command: `node -e "${script}"` })
              }
            }
          ]
        })
        send({}, "tool_calls")
        response.end("data: [DONE]\n\n")
        return
      }
      await fixture.begin.promise
      if (fixture.calls === 2) {
        send({
          role: "assistant",
          content: fixture.failedText,
          reasoning_content: "failed reasoning"
        })
        fixture.failed = true
        await fixture.disconnect.promise
        response.destroy()
        return
      }
      fixture.retry = true
      await fixture.resume.promise
      send({ role: "assistant", content: fixture.answer, reasoning_content: "new reasoning" })
      await fixture.finish.promise
      send({}, "stop")
      response.end("data: [DONE]\n\n")
    })().catch((error) => {
      errors.push(String(error))
      response.destroy()
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = (server.address() as { port: number }).port
  const env = { ...process.env } as Record<string, string>
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
  const histories: Array<{ id: string; title: string; answer: string; failed: string }> = []
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
      return host === "localhost" || host === "127.0.0.1" ? route.continue() : route.abort()
    })
    page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => {
      const sender = BrowserWindow.getAllWindows()[0].webContents
      const send = sender.send.bind(sender)
      ;(globalThis as unknown as { retryFrames: unknown[] }).retryFrames = []
      sender.send = (channel, ...args) => {
        if (channel.startsWith("agent:stream:") || channel.startsWith("scheduler:stream:")) {
          ;(globalThis as unknown as { retryFrames: unknown[] }).retryFrames.push({
            channel,
            event: args[0]
          })
        }
        return send(channel, ...args)
      }
    })
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
    await page.getByText("新任务", { exact: true }).first().waitFor()
  }
  try {
    await launch()
    const control = await page!.evaluate(
      async ({ port, workspace }) => {
        const api = (window as unknown as { api: RetryApi }).api
        await api.models.setCustomConfig({
          id: "retry-local",
          name: "Local retry",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "deepseek-retry-local",
          apiKey: "local-only",
          enableThinking: true,
          maxTokens: 64000,
          maxOutputTokens: 4096
        })
        await api.models.setDefault("custom:retry-local")
        await api.routing.setMode("pinned")
        await api.sandbox.setYoloMode(true)
        return api.threads.create({
          title: "重试测试对照页",
          workspacePath: workspace,
          agentMode: "normal",
          model: "custom:retry-local"
        })
      },
      { port, workspace }
    )
    for (const fixture of fixtures) {
      const thread = await page!.evaluate(
        async ({ name, workspace }) => {
          return (window as unknown as { api: RetryApi }).api.threads.create({
            title: `断流回归 ${name}`,
            workspacePath: workspace,
            agentMode: "normal",
            model: "custom:retry-local"
          })
        },
        { name: fixture.name, workspace }
      )
      await page!.reload({ waitUntil: "domcontentloaded" })
      await page!.getByText(thread.title, { exact: true }).first().click()
      const chat = page!.locator(`[data-chat-thread-id="${thread.thread_id}"]`)
      await chat.waitFor()
      if (fixture.name === "FOREGROUND") {
        const composer = page!.locator("textarea.composer-textarea")
        await composer.fill(`RETRY_${fixture.name}: create the file and deliver it`)
        await composer.locator("xpath=ancestor::form").locator('button[type="submit"]').click()
      } else {
        await app!.evaluate(
          ({ BrowserWindow, ipcMain }, { bundle, id, prompt }) => {
            const loadModule = process.getBuiltinModule("module").createRequire(bundle)
            const delivery = loadModule(bundle).createManagedTransportAgentRunDelivery()
            const sender = BrowserWindow.getAllWindows()[0].webContents
            const original = BrowserWindow.fromWebContents
            BrowserWindow.fromWebContents = () => delivery.window
            try {
              ipcMain.emit(
                "agent:invoke",
                { sender },
                {
                  threadId: id,
                  message: prompt,
                  userMessageId: "managed-user",
                  modelId: "custom:retry-local",
                  agentMode: "normal"
                }
              )
            } finally {
              BrowserWindow.fromWebContents = original
            }
          },
          {
            bundle: deliveryBundle,
            id: thread.thread_id,
            prompt: `RETRY_${fixture.name}: create the file and deliver it`
          }
        )
      }
      fixture.begin.release()
      await until(() => fixture.failed, `${fixture.name} partial SSE`)
      await until(
        async () => (await chat.innerText()).includes(fixture.failedText),
        "partial visible"
      )
      await new Promise((resolve) => setTimeout(resolve, 1600))
      const getMessages = () =>
        page!.evaluate(
          (id) => (window as unknown as { api: RetryApi }).api.threads.getMessages(id),
          thread.thread_id
        )
      assert.ok(
        JSON.stringify(await getMessages()).includes(fixture.failedText),
        "failed attempt actually flushed"
      )
      fixture.disconnect.release()
      await until(() => fixture.retry, "checkpoint resume request")
      await until(
        async () => !(await chat.innerText()).includes(fixture.failedText),
        "failed attempt removed during retry"
      )
      assert.ok(
        !JSON.stringify(await getMessages()).includes(fixture.failedText),
        "failed attempt removed from SQLite during retry"
      )
      await page!.screenshot({ path: join(output, `${fixture.name}-retry.png`) })
      fixture.resume.release()
      await until(
        async () => (await chat.innerText()).includes(fixture.answer),
        "successful replacement visible"
      )
      assert.ok(
        !(await chat.innerText()).includes(fixture.failedText),
        "no stale scheduler prefix on reused ID"
      )
      fixture.finish.release()
      await until(
        async () => !(await page!.getByRole("button", { name: "停止生成", exact: true }).count()),
        "turn completed"
      )
      const stored = await getMessages()
      assert.ok(!JSON.stringify(stored).includes(fixture.failedText))
      assert.ok(
        stored.some((message: { role: string }) => message.role === "tool"),
        "completed command result retained"
      )
      assert.equal(fixture.calls, 3, "one command request, failed answer, successful resume")
      assert.equal(
        readFileSync(fixture.file, "utf8"),
        "EXECUTED_ONCE\n",
        "command executed exactly once"
      )
      await page!.getByText(control.title, { exact: true }).first().click()
      await page!.getByText(thread.title, { exact: true }).first().click()
      await until(async () => (await chat.innerText()).includes(fixture.answer), "reopened answer")
      assert.ok(!(await chat.innerText()).includes(fixture.failedText))
      await page!.screenshot({ path: join(output, `${fixture.name}-complete.png`) })
      histories.push({
        id: thread.thread_id,
        title: thread.title,
        answer: fixture.answer,
        failed: fixture.failedText
      })
      checks.push(
        `${fixture.name}: 1.6s flushed partial removed during retry, same provider ID resumes cleanly, command runs once, file delivered, reopening clean`
      )
    }
    await app!.close()
    app = undefined
    await launch()
    for (const history of histories) {
      await page!.getByText(history.title, { exact: true }).first().click()
      const chat = page!.locator(`[data-chat-thread-id="${history.id}"]`)
      await until(async () => (await chat.innerText()).includes(history.answer), "restart answer")
      assert.ok(!(await chat.innerText()).includes(history.failed))
    }
    checks.push("both histories survive full Electron restart without failed fragments")
    assert.deepEqual(errors, [])
    writeFileSync(
      join(output, "result.json"),
      JSON.stringify({ checks, errors, histories }, null, 2)
    )
    console.log(JSON.stringify({ output, checks, errors }, null, 2))
  } catch (error) {
    if (app)
      writeFileSync(
        join(output, "frames.json"),
        JSON.stringify(
          await app.evaluate(
            () => (globalThis as unknown as { retryFrames: unknown[] }).retryFrames
          ),
          null,
          2
        )
      )
    await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {})
    writeFileSync(
      join(output, "failure.json"),
      JSON.stringify({ error: String(error), checks, errors }, null, 2)
    )
    throw error
  } finally {
    fixtures.forEach((fixture) => {
      fixture.begin.release()
      fixture.disconnect.release()
      fixture.resume.release()
      fixture.finish.release()
    })
    await app?.close().catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
