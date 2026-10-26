/** Real App → IPC → Bot runtime → model request → memory store, using an isolated local model. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { _electron } from "playwright"
import { botTestAppOutput } from "./support/bot-test-app"
import { waitForBotAppState } from "./support/bot-app-state"
import type { BotMemory } from "../src/shared/bots/contracts"
import type {} from "../src/preload/index.d.ts"

type ModelToolCall = { id: string; function: { name: string } }
interface ModelRequest {
  messages?: Array<{
    role: string
    content?: string
    tool_calls?: ModelToolCall[]
    tool_call_id?: string
  }>
  tools?: Array<{ function: { name: string } }>
  stream?: boolean
}

async function main() {
  const out = botTestAppOutput()
  const dir = await mkdtemp(join(tmpdir(), "bot-memory-app-"))
  const calls: Array<{ user: string; tools: string[]; called?: string }> = []
  const errors: string[] = []
  const memoryTools = [
    "bot_memory_search",
    "bot_memory_list",
    "bot_memory_get",
    "bot_remember",
    "bot_forget"
  ]
  const server = createServer(async (req, res) => {
    try {
      let raw = ""
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw) as ModelRequest
      const messages = body.messages ?? []
      const userIndex = messages.findLastIndex((m) => m.role === "user")
      const user = String(messages[userIndex]?.content ?? "")
      const turn = messages.slice(userIndex + 1)
      const tools = (body.tools ?? []).map((t) => t.function?.name)
      const used = turn.flatMap((m) => (m.tool_calls ?? []).map((t) => t.function?.name))
      const receipt = <T = BotMemory & { removed?: boolean }>(name: string): T | undefined => {
        const call = turn
          .flatMap((m) => m.tool_calls ?? [])
          .findLast((t) => t.function?.name === name)
        const message = turn.find((m) => m.role === "tool" && m.tool_call_id === call?.id)
        return message ? (JSON.parse(message.content ?? "null") as T) : undefined
      }
      let reply = "测试就绪。"
      let call: { name: string; args: Record<string, unknown> } | undefined
      if (!body.tools?.length) reply = '{"operations":[],"memory_md":""}'
      else if (user.startsWith("MM_OFF")) {
        assert.ok(
          memoryTools.every((name) => !tools.includes(name)),
          "disabled Bot must not advertise memory tools"
        )
        reply = "当前未开启记忆。"
      } else if (user.startsWith("MM_")) {
        for (const name of memoryTools)
          assert.ok(tools.includes(name), `model request missing ${name}`)
        assert.ok(
          !tools.includes("memory_search"),
          "Bot override must not enable the ordinary memory store"
        )
        if (user.startsWith("MM_CREATE")) {
          if (!used.includes("bot_update_profile"))
            call = { name: "bot_update_profile", args: { instructions: "帮助整理文档。" } }
          else if (!used.includes("bot_remember"))
            call = {
              name: "bot_remember",
              args: { name: "测试回复偏好", content: "先给结论，再给细节。" }
            }
          else {
            assert.ok(receipt("bot_remember")?.id, "creation needs a real persisted receipt")
            reply = "已保存回复偏好。"
          }
        } else if (!used.includes("bot_memory_list")) {
          call = { name: "bot_memory_list", args: {} }
        } else if (!used.includes("bot_memory_get")) {
          const entry = receipt<Array<Pick<BotMemory, "id" | "name" | "version">>>(
            "bot_memory_list"
          )?.find((m) => m.name === "测试回复偏好")
          assert.ok(entry, "the previous turn's saved memory must be listed")
          call = { name: "bot_memory_get", args: { id: entry.id } }
        } else {
          const entry = receipt("bot_memory_get")
          assert.ok(entry?.version, "read must return the stored version")
          const operation = user.startsWith("MM_DELETE") ? "bot_forget" : "bot_remember"
          if (!used.includes(operation))
            call = {
              name: operation,
              args: {
                id: entry.id,
                expectedVersion: entry.version,
                ...(operation === "bot_remember"
                  ? { name: entry.name, content: "先给结论，再列三条要点。" }
                  : {})
              }
            }
          else {
            const result = receipt(operation)
            assert.ok(result?.id && (operation !== "bot_forget" || result.removed))
            reply = operation === "bot_forget" ? "已忘记该偏好。" : "已更新同一条偏好。"
          }
        }
      }
      calls.push({ user: user.slice(0, 120), tools, called: call?.name })
      const toolCalls = call
        ? [
            {
              id: `memory-${calls.length}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) }
            }
          ]
        : undefined
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        const send = (delta: unknown, finish_reason: string | null) =>
          res.write(
            `data: ${JSON.stringify({ id: `reply-${calls.length}`, object: "chat.completion.chunk", model: "memory-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
          )
        send(
          toolCalls
            ? { tool_calls: toolCalls.map((t) => ({ index: 0, ...t })) }
            : { content: reply },
          null
        )
        send({}, call ? "tool_calls" : "stop")
        res.end("data: [DONE]\n\n")
      } else {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            id: `reply-${calls.length}`,
            object: "chat.completion",
            model: "memory-fixture",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: call ? null : reply,
                  ...(toolCalls ? { tool_calls: toolCalls } : {})
                },
                finish_reason: call ? "tool_calls" : "stop"
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
          })
        )
      }
    } catch (error) {
      errors.push(String(error))
      res.writeHead(500).end("memory fixture failed")
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  const env: Record<string, string> = {}
  for (const key of ["PATH", "Path", "HOME", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"])
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
    CMB_COWORK_AGENT_HOME: join(dir, "agent-profile"),
    CMB_TASK_CARDS_MOCK: "1",
    CMB_COWORK_TRACE_STORAGE_MODE: "plaintext",
    CMB_E2E_DISABLE_GPU: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    NODE_USE_ENV_PROXY: "1"
  })
  try {
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)("electron"),
      args: [join(out, "main/index.js"), `--user-data-dir=${join(dir, "electron-profile")}`],
      cwd: resolve("."),
      env,
      timeout: 60000
    })
    for (const stream of [app.process().stdout, app.process().stderr])
      stream?.on("data", (chunk) => void writeFile(join(dir, "electron.log"), chunk, { flag: "a" }))
    await app
      .context()
      .route(/^https?:/, (route) =>
        new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()
      )
    const page = await app.firstWindow()
    await page.getByText("新任务", { exact: true }).first().waitFor({ timeout: 60000 })
    await page.evaluate(() => {
      ;(globalThis as typeof globalThis & { __name: (value: unknown) => unknown }).__name = (
        value: unknown
      ) => value
    })
    const bot = await page.evaluate(async (baseUrl) => {
      const api = window.api
      await api.memory.setEnabled(false)
      await api.models.setCustomConfig({
        id: "memory-fixture",
        name: "Memory fixture",
        baseUrl,
        model: "memory-fixture",
        apiKey: "synthetic-only",
        maxTokens: 64000,
        maxOutputTokens: 2048
      })
      await api.models.setDefault("custom:memory-fixture")
      return api.bots.create({
        name: "记忆链路测试",
        instructions: "帮助整理文档。已误写的临时测试信息。",
        color: "#168bea",
        modelRef: "custom:memory-fixture",
        memoryMode: "inherit"
      })
    }, `http://127.0.0.1:${address.port}/v1`)
    const idle = () =>
      waitForBotAppState(
        page,
        async () =>
          !(await window.api.bots.snapshot()).tasks.some((t) =>
            ["queued", "running", "waiting_user"].includes(t.state)
          )
      )
    await idle()
    const send = async (message: string) => {
      const task = await page.evaluate(
        ({ botId, message }) =>
          window.api.bots.send({ botId, message, requestId: crypto.randomUUID() }),
        { botId: bot.id, message }
      )
      await waitForBotAppState(
        page,
        async (id) =>
          (await window.api.bots.snapshot()).tasks.some(
            (t) => t.id === id && ["completed", "failed", "outcome_unknown"].includes(t.state)
          ),
        task.id
      )
      await idle()
      const row = await page.evaluate(
        async (id) => (await window.api.bots.snapshot()).tasks.find((t) => t.id === id),
        task.id
      )
      assert.ok(row)
      assert.equal(row.state, "completed", JSON.stringify(row))
    }
    await send("MM_OFF：查看当前记忆状态。")
    const savedBot = await page.evaluate(async (id) => {
      const api = window.api,
        b = (await api.bots.snapshot()).bots.find((b) => b.id === id)
      if (!b) throw new Error("Fixture Bot missing")
      return api.bots.update({ ...b, memoryMode: "enabled", expectedVersion: b.version })
    }, bot.id)
    assert.equal(savedBot.memoryMode, "enabled")
    await send("MM_CREATE：恢复职责为帮助整理文档，然后记住我偏好先给结论再给细节。")
    const restored = await page.evaluate(
      async (id) => (await window.api.bots.snapshot()).bots.find((b) => b.id === id),
      bot.id
    )
    assert.ok(restored)
    assert.equal(restored.instructions, "帮助整理文档。")
    assert.equal(restored.memoryMode, "enabled")
    const memories = () => page.evaluate((id) => window.api.bots.listMemory(id), bot.id)
    const first = await memories()
    assert.equal(first.length, 1)
    await send("MM_UPDATE：将回复偏好改为先给结论，再列三条要点。")
    const updated = await memories()
    assert.equal(updated.length, 1)
    assert.equal(updated[0].id, first[0].id)
    assert.notEqual(updated[0].version, first[0].version)
    assert.equal(updated[0].content.trim(), "先给结论，再列三条要点。")
    await send("MM_DELETE：忘记刚才保存的回复偏好。")
    assert.deepEqual(await memories(), [])
    assert.deepEqual(errors, [])
    console.log(
      "PASS: global off → Bot on, exact model tool inventory, profile rollback, create/update/delete in the same conversation"
    )
  } finally {
    await writeFile(join(dir, "model-tools.json"), JSON.stringify({ calls, errors }, null, 2))
    console.log("Memory App evidence:", dir)
    if (app) await app.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
