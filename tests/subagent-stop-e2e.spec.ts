/** Deterministic task lifecycle through Electron and a local SSE model.
 * Run after npm run build: node --import tsx tests/subagent-stop-e2e.spec.ts
 */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { _electron, type ElectronApplication } from "playwright"

interface HookPayload {
  session_id: string
  agent_id?: string
  subagent?: { id: string; name?: string; status: string }
  tool_input?: { agent_type?: string; tool_call_id?: string; task_description?: string }
}
interface AgentEvent {
  type: string
  error?: string
  [key: string]: unknown
}
interface TestApi {
  models: {
    setCustomConfig(config: Record<string, unknown>): Promise<void>
    setDefault(id: string): Promise<void>
  }
  routing: { setMode(mode: string): Promise<void> }
  hooks: { create(config: Record<string, unknown>): Promise<{ id: string }> }
  threads: {
    create(metadata: Record<string, unknown>): Promise<{ thread_id: string }>
    getMessages(
      id: string
    ): Promise<Array<{ role: string; tool_call_id?: string; content: unknown }>>
  }
  agent: {
    invoke(id: string, prompt: string, callback: (event: AgentEvent) => void): () => void
  }
}

async function main() {
  const root = resolve(import.meta.dirname, "..")
  const output = join(root, "output/subagent-stop-e2e", String(Date.now()))
  const workspace = join(output, "workspace")
  mkdirSync(workspace, { recursive: true })
  const binary = createRequire(import.meta.url)("electron") as string
  const captured: Array<{ route: string; body: HookPayload }> = []
  const requests: Array<{ scenario: string; role: string }> = []
  const errors: string[] = []
  const results: unknown[] = []
  const disconnected = new Set<string>()
  let haltEnabled = false
  const server = createServer((req, res) => {
    void (async () => {
      let text = ""
      for await (const chunk of req) text += chunk
      if (req.url?.startsWith("/hook/")) {
        captured.push({ route: req.url, body: JSON.parse(text) as HookPayload })
        if (req.url === "/hook/halt" && haltEnabled) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify(
            req.url === "/hook/halt" && haltEnabled
              ? { continue: false, stopReason: "SUBAGENT_HOOK_HALT" }
              : {}
          )
        )
        return
      }
      const body = JSON.parse(text) as {
        messages: Array<{ role: string; content: unknown; tool_call_id?: string }>
      }
      const userIndex = body.messages.findLastIndex((m) => m.role === "user")
      const userText = JSON.stringify(body.messages[userIndex])
      const scenario = /(?:PARENT|CHILD)_PROBE_(\w+)/.exec(userText)?.[1]
      assert.ok(scenario, "request belongs to isolated fixture")
      const child = userText.includes("CHILD_PROBE_")
      const done = body.messages.slice(userIndex + 1).some((m) => m.role === "tool")
      requests.push({ scenario, role: child ? "child" : done ? "parent-final" : "parent" })
      const send = (delta: unknown, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: `response-${requests.length}`, object: "chat.completion.chunk", model: "deepseek-hook-local", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        )
      res.writeHead(200, { "content-type": "text/event-stream" })
      if (done && scenario === "retry" && !disconnected.has(scenario)) {
        disconnected.add(scenario)
        send({ role: "assistant", content: "FAILED_ATTEMPT" })
        await new Promise((resolve) => setTimeout(resolve, 1500))
        res.destroy()
        return
      }
      const delta = child
        ? { content: "CHILD_COMPLETED" }
        : done
          ? { content: `PARENT_COMPLETED_${scenario}` }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: `task-${scenario}`,
                  type: "function",
                  function: {
                    name: "task",
                    arguments: JSON.stringify({
                      subagent_type: "general-purpose",
                      description: `CHILD_PROBE_${scenario}: respond with CHILD_COMPLETED`
                    })
                  }
                }
              ]
            }
      send({ role: "assistant", ...delta })
      send({}, child || done ? "stop" : "tool_calls")
      res.end("data: [DONE]\n\n")
    })().catch((error) => {
      errors.push(String(error))
      res.destroy()
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
  try {
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
    await app
      .context()
      .route(/^https?:/, (route) =>
        ["127.0.0.1", "localhost"].includes(new URL(route.request().url()).hostname)
          ? route.continue()
          : route.abort()
      )
    const page = await app.firstWindow()
    await page.getByText("新任务", { exact: true }).first().waitFor()
    const thread = await page.evaluate(
      async ({ port, workspace }) => {
        const api = (window as unknown as { api: TestApi }).api
        await api.models.setCustomConfig({
          id: "hook-local",
          name: "Hook local",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "deepseek-hook-local",
          apiKey: "local-only",
          maxTokens: 64000,
          maxOutputTokens: 4096
        })
        await api.models.setDefault("custom:hook-local")
        await api.routing.setMode("pinned")
        for (const [event, matcher, route] of [
          ["SessionStart", "*", "control"],
          ["SubagentStart", "general-purpose", "start-name"],
          ["SubagentStart", "*", "start-all"],
          ["SubagentStart", "unrelated", "start-must-not-match"],
          ["SubagentStop", "*", "stop-all"],
          ["SubagentStop", "general-purpose", "stop-name"],
          ["SubagentStop", "unrelated", "must-not-match"],
          ["SubagentStop", "general-purpose", "halt"]
        ]) {
          await api.hooks.create({
            event,
            matcher,
            type: "http",
            url: `http://127.0.0.1:${port}/hook/${route}`,
            enabled: true,
            timeout: 5000
          })
        }
        return api.threads.create({
          title: "Subagent hooks",
          workspacePath: workspace,
          agentMode: "normal",
          model: "custom:hook-local"
        })
      },
      { port, workspace }
    )
    // Reusing this thread also proves completed tasks are not replayed in later turns.
    for (const scenario of ["normal", "retry", "halt"]) {
      haltEnabled = scenario === "halt"
      const before = captured.length
      const terminal = await page.evaluate(
        async ({ id, scenario }) => {
          const api = (window as unknown as { api: TestApi }).api
          return new Promise<AgentEvent>((resolve) => {
            const timer = setTimeout(() => {
              cleanup()
              resolve({ type: "timeout" })
            }, 90_000)
            const cleanup = api.agent.invoke(
              id,
              `PARENT_PROBE_${scenario}: delegate a task`,
              (event) => {
                if (["done", "error"].includes(event.type)) {
                  clearTimeout(timer)
                  cleanup()
                  resolve(event)
                }
              }
            )
          })
        },
        { id: thread.thread_id, scenario }
      )
      assert.equal(terminal.type, "done", JSON.stringify(terminal))
      const observed = captured.slice(before)
      for (const route of ["start-name", "start-all", "stop-all", "stop-name", "halt"]) {
        const matching = observed.filter((c) => c.route === `/hook/${route}`)
        assert.equal(matching.length, 1, `${scenario}: ${route} fires exactly once`)
        assert.equal(matching[0].body.agent_id, `task-${scenario}`)
        assert.equal(matching[0].body.subagent?.name, "general-purpose")
        if (route.startsWith("start-")) {
          assert.equal(matching[0].body.subagent?.status, "started")
          assert.equal(matching[0].body.tool_input?.agent_type, "general-purpose")
          assert.equal(matching[0].body.tool_input?.tool_call_id, `task-${scenario}`)
          assert.ok(
            matching[0].body.tool_input?.task_description?.includes(`CHILD_PROBE_${scenario}`)
          )
        } else {
          assert.equal(matching[0].body.subagent?.status, "completed")
        }
      }
      assert.ok(!observed.some((c) => c.route === "/hook/must-not-match"))
      assert.ok(!observed.some((c) => c.route === "/hook/start-must-not-match"))
      assert.equal(requests.filter((r) => r.scenario === scenario && r.role === "child").length, 1)
      const finalCalls = requests.filter(
        (r) => r.scenario === scenario && r.role === "parent-final"
      )
      // The graph may prefetch the next model request before the consumer
      // observes values. A halt must prevent its answer from being delivered.
      if (scenario !== "halt") assert.equal(finalCalls.length, scenario === "retry" ? 2 : 1)
      const history = await page.evaluate(
        async (id) => (window as unknown as { api: TestApi }).api.threads.getMessages(id),
        thread.thread_id
      )
      const toolResult = history.find(
        (message) => message.role === "tool" && message.tool_call_id === `task-${scenario}`
      )
      assert.ok(toolResult, `${scenario}: completed task result remains persisted`)
      assert.ok(JSON.stringify(toolResult.content).includes("CHILD_COMPLETED"))
      assert.ok(!JSON.stringify(history).includes("FAILED_ATTEMPT"))
      if (scenario === "halt") {
        assert.ok(!JSON.stringify(history).includes("PARENT_COMPLETED_halt"))
      }
      results.push({
        scenario,
        terminal,
        hooks: observed.map((c) => c.route),
        finalCalls: finalCalls.length
      })
      console.log(`PASS SubagentStart/SubagentStop ${scenario}`)
    }
    assert.ok(captured.some((c) => c.route === "/hook/control"))
    assert.deepEqual(errors, [])
  } finally {
    writeFileSync(
      join(output, "result.json"),
      JSON.stringify({ captured, requests, results, errors }, null, 2)
    )
    console.log(`Evidence: ${output}`)
    await app?.close()
    server.closeAllConnections()
    server.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
