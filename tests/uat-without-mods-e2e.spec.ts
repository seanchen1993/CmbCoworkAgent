/** Build first, then run with tsx. All model requests stay on localhost. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { _electron, type ElectronApplication } from "playwright"

const root = resolve(__dirname, "..")
const requireLocal = createRequire(join(root, "package.json"))
const binary = requireLocal("electron") as string
const isolated = mkdtempSync(join(tmpdir(), "cmb-without-mods-"))
const dataRoot = join(isolated, "data")
const workspace = join(isolated, "workspace")
mkdirSync(dataRoot, { recursive: true })
mkdirSync(workspace, { recursive: true })
writeFileSync(join(workspace, "evidence.txt"), "NO_MODS_TOOL_EVIDENCE")
writeFileSync(join(dataRoot, "settings.json"), JSON.stringify({ modsGlobalEnabled: true }))
writeFileSync(
  join(dataRoot, "userinfo-models.json"),
  JSON.stringify({ sapId: "localhost-fixture", userName: "Local fixture" })
)

async function main(): Promise<void> {
  let calls = 0
  let toolRead = false
  const serverErrors: string[] = []
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions")
      let text = ""
      for await (const chunk of request) text += chunk
      const body = JSON.parse(text)
      calls++
      const messages = body.messages as Array<{ role: string; content?: unknown }>
      const readRequested = JSON.stringify(messages).includes("NO_MODS_READ")
      const toolMessage = messages.find((message) => message.role === "tool")
      if (toolMessage) {
        assert.match(JSON.stringify(toolMessage.content), /NO_MODS_TOOL_EVIDENCE/)
        toolRead = true
      }
      const callTool = readRequested && !toolMessage
      const delta = callTool
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "read-evidence",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ file_path: join(workspace, "evidence.txt") })
                }
              }
            ]
          }
        : { role: "assistant", content: "NO_MODS_OK" }
      assert.equal(body.stream, true)
      response.writeHead(200, { "content-type": "text/event-stream" })
      const send = (value: unknown, finish: string | null): void => {
        response.write(
          `data: ${JSON.stringify({ id: `local-${calls}`, object: "chat.completion.chunk", model: "local", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`
        )
      }
      send(delta, null)
      send({}, callTool ? "tool_calls" : "stop")
      response.end("data: [DONE]\n\n")
    } catch (error) {
      serverErrors.push(String(error))
      response.writeHead(500).end(JSON.stringify({ error: { message: String(error) } }))
    }
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address() as { port: number }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value && /^(path|systemroot|windir|comspec|pathext|temp|tmp)$/i.test(key)
    )
  ) as Record<string, string>
  for (const key of ["USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    env[key] = join(isolated, key)
    mkdirSync(env[key], { recursive: true })
  }
  Object.assign(env, {
    CMB_COWORK_AGENT_HOME: dataRoot,
    CMB_TASK_CARDS_MOCK: "1",
    CMB_E2E_DISABLE_GPU: "1",
    CMB_E2E_ELECTRON_BIN: binary,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost"
  })
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({
      executablePath:
        process.platform === "win32" ? join(root, "tests/support/electron-launcher.cmd") : binary,
      args: [join(root, "out/main/index.js"), `--user-data-dir=${join(isolated, "electron")}`],
      cwd: root,
      env,
      timeout: 60_000
    })
    app.process().stdout?.on("data", (data) => {
      requireLocal("node:fs").appendFileSync(join(isolated, "electron.log"), data)
    })
    app.process().stderr?.on("data", (data) => {
      requireLocal("node:fs").appendFileSync(join(isolated, "electron.log"), data)
    })
    await app.context().route(/^https?:/, (route) => route.abort())
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean(window.api?.threads))
    await app
      .evaluate(({ BrowserWindow, ipcMain }) => {
        ipcMain.removeHandler("open-login-page")
        ipcMain.handle("open-login-page", () => undefined)
        for (const window of BrowserWindow.getAllWindows()) window.hide()
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })
          ._invokeHandlers
        return [...handlers.keys()].filter((key) => key.startsWith("mods:"))
      })
      .then((handlers) => assert.deepEqual(handlers, []))
    await page.evaluate("globalThis.__name = (value) => value")
    await page.evaluate(
      ({ baseUrl }) => {
        if ("mods" in window.api) throw new Error("Mods preload API is still exposed")
        return window.api.models.setCustomConfig({
          id: "without-mods-local",
          name: "Local fixture",
          baseUrl,
          model: "local",
          apiKey: "local-only",
          maxTokens: 64000,
          maxOutputTokens: 1024
        })
      },
      { baseUrl: `http://127.0.0.1:${address.port}/v1` }
    )
    await page.evaluate(async () => {
      await window.api.models.setDefault("custom:without-mods-local")
      await window.api.routing.setMode("pinned")
    })
    for (let index = 0; index < 101; index++) {
      const history = await page.evaluate(
        async ({ workspace, index }) => {
          const api = window.api
          const thread = await api.threads.create({
            title: `Without Mods ${index}`,
            workspacePath: workspace,
            model: "custom:without-mods-local"
          })
          await new Promise<void>((done, reject) => {
            const timeout = setTimeout(() => reject(new Error(`Turn ${index} timed out`)), 30_000)
            const cleanup = api.agent.invoke(
              thread.thread_id,
              index === 0
                ? "NO_MODS_READ: Read evidence.txt then reply NO_MODS_OK"
                : "Reply NO_MODS_OK",
              (event) => {
                if (event.type !== "done" && event.type !== "error") return
                clearTimeout(timeout)
                cleanup()
                if (event.type === "error") reject(new Error(JSON.stringify(event)))
                else done()
              },
              "custom:without-mods-local",
              "normal"
            )
          })
          return JSON.stringify(await api.threads.getHistory(thread.thread_id))
        },
        { workspace, index }
      )
      assert.match(history, /NO_MODS_OK/, `Turn ${index} persists its reply`)
      if ((index + 1) % 10 === 0) console.log(`PASS ${index + 1} independent threads`)
    }
    assert.ok(toolRead, "A real native tool call completed")
    assert.ok(calls >= 102, "All 101 runtimes reached the local model")
    assert.deepEqual(serverErrors, [])
    assert.equal(existsSync(join(dataRoot, "mods-control.db")), false)
    await page.getByRole("button", { name: "自定义设置", exact: true }).click()
    await page.getByRole("button", { name: "返回应用", exact: true }).waitFor()
    assert.equal(await page.getByText("Function Mods", { exact: true }).count(), 0)
    await page.screenshot({ path: join(isolated, "settings-without-mods.png") })
    console.log(
      `PASS 101 threads, native tool execution, legacy switch ignored (${calls} model calls)`
    )
    console.log(`Artifacts: ${isolated}`)
  } finally {
    await app?.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
}

main().catch((error) => {
  console.error(error)
  console.error(`Artifacts: ${isolated}`)
  process.exitCode = 1
})
