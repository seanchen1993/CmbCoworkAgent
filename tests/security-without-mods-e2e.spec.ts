/** Real Electron HTTP gateway and native agent runtime; model requests stay on localhost. */
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
const isolated = mkdtempSync(join(tmpdir(), "cmb-security-without-mods-"))
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
  const portProbe = createServer()
  await new Promise<void>((done) => portProbe.listen(0, "127.0.0.1", done))
  const gatewayPort = (portProbe.address() as { port: number }).port
  await new Promise<void>((done) => portProbe.close(() => done()))
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`
  const headers = { authorization: "Bearer localhost-fixture", "content-type": "application/json" }
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
    CMB_API_ENABLED: "1",
    CMB_API_HOST: "127.0.0.1",
    CMB_API_PORT: String(gatewayPort),
    CMB_API_TOKEN: "localhost-fixture",
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
    const unauthorized = await fetch(`${gatewayUrl}/v1/threads/not-authorized`)
    assert.equal(unauthorized.status, 401)
    const invalidWorkspace = await fetch(`${gatewayUrl}/v1/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspacePath: join(isolated, "missing") })
    })
    assert.equal(invalidWorkspace.status, 400)
    assert.equal((await invalidWorkspace.json()).error, "invalid_workspace_path")
    for (let index = 0; index < 101; index++) {
      const create = await fetch(`${gatewayUrl}/v1/threads`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: `Without Mods ${index}`,
          workspacePath: workspace,
          model: "custom:without-mods-local",
          agentMode: "normal"
        })
      })
      assert.equal(create.status, 201, await create.clone().text())
      const thread = (await create.json()) as { thread_id: string }
      const path = `${gatewayUrl}/v1/threads/${encodeURIComponent(thread.thread_id)}`
      const raw = index === 1
      const response = await fetch(`${path}/messages${raw ? "?format=raw" : ""}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          message:
            index === 0
              ? "NO_MODS_READ: Read evidence.txt then reply NO_MODS_OK"
              : "Reply NO_MODS_OK",
          modelId: "custom:without-mods-local"
        }),
        signal: AbortSignal.timeout(30_000)
      })
      assert.equal(response.status, 200)
      const stream = await response.text()
      assert.match(stream, /NO_MODS_OK/, `Turn ${index} returns an SSE reply`)
      assert.doesNotMatch(stream, /MODS_RUNTIME_CAPACITY/)
      if (raw) assert.match(stream, /"type":"done"/)
      else assert.match(stream, /data: \[DONE\]/)
      const history = await fetch(`${path}/messages`, { headers })
      assert.equal(history.status, 200)
      assert.match(await history.text(), /NO_MODS_OK/, `Turn ${index} persists its reply`)
      const status = await fetch(path, { headers })
      assert.equal(status.status, 200)
      assert.ok((await status.json()).runtime, "Thread runtime remains remotely observable")
      if ((index + 1) % 10 === 0) console.log(`PASS ${index + 1} independent threads`)
    }
    assert.ok(toolRead, "A real native tool call completed")
    assert.ok(calls >= 102, "All 101 runtimes reached the local model")
    assert.deepEqual(serverErrors, [])
    assert.equal(existsSync(join(dataRoot, "mods-control.db")), false)
    await page.getByRole("button", { name: "自定义", exact: true }).click()
    await page.getByText("基础功能", { exact: true }).waitFor()
    assert.equal(await page.getByText("Function Mods", { exact: true }).count(), 0)
    await page.screenshot({ path: join(isolated, "settings-without-mods.png") })
    console.log(
      `PASS HTTP/SSE: 101 threads, native tool, bearer auth, invalid workspace, legacy switch (${calls} model calls)`
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
