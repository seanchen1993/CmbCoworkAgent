import { afterEach, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BotStore } from "./store"
import { CmbBotRuntime } from "./agent-runtime"
import { LocalBotComputerProvider } from "./computer-provider"
import { BotHost } from "./host"
import { createBotAPI } from "./rpc"
import { writeBotModelSnapshot } from "./model-config"
import { testModelRequest, type TestModelRequest } from "./test-model-protocol"
import { readBotUserForm } from "../../shared/bot-user-form"
const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})
it("waits in the original CmbRuntime graph for a typed form and returns its accepted values without a second run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cmb-typed-form-runtime-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  vi.stubEnv("CMB_COWORK_AGENT_HOME", join(directory, "settings"))
  const requests: TestModelRequest[] = [],
    errors: unknown[] = []
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      const body = testModelRequest.parse(JSON.parse(Buffer.concat(chunks).toString()))
      requests.push(body)
      const result = body.messages.find(
        (message) => message.role === "tool" && message.tool_call_id === "form-input"
      )
      let message: Record<string, unknown>
      if (!result) {
        const description = body.tools.find((tool) => tool.function.name === "request_user_form")
          ?.function.description
        expect(description).toContain("never approval")
        expect(description).toContain("Never request passwords")
        message = {
          content: "",
          tool_calls: [
            {
              id: "form-input",
              type: "function",
              function: {
                name: "request_user_form",
                arguments: JSON.stringify({
                  title: "发布信息",
                  fields: [
                    { id: "branch", label: "分支", type: "text", required: true },
                    { id: "date", label: "日期", type: "date", required: true },
                    { id: "count", label: "数量", type: "number", required: true },
                    { id: "note", label: "补充说明", type: "textarea" }
                  ]
                })
              }
            }
          ]
        }
      } else {
        expect(JSON.parse(String(result.content))).toEqual({
          status: "submitted",
          values: {
            branch: "main",
            date: "2028-02-29",
            count: "0"
          }
        })
        message = { content: "FORM_VALUES_ACCEPTED" }
      }
      response.setHeader("Content-Type", "text/event-stream")
      const calls = (message.tool_calls as Record<string, unknown>[] | undefined)?.map(
        (call, index) => ({ index, ...call })
      )
      const delta = {
        role: "assistant",
        ...(calls ? { tool_calls: calls } : { content: message.content })
      }
      for (const chunk of [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }] },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 } }
      ])
        response.write(
          `data: ${JSON.stringify({ id: `form-${requests.length}`, object: "chat.completion.chunk", model: "gpt-test", created: 1, ...chunk })}\n\n`
        )
      response.end("data: [DONE]\n\n")
    } catch (error) {
      errors.push(error)
      response.statusCode = 500
      response.end("Controlled fixture failure")
    }
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  )
  const modelFile = join(directory, "host", "models.private")
  await writeBotModelSnapshot(modelFile, {
    version: 1,
    defaultRef: "test",
    models: [
      {
        ref: "test",
        id: "test",
        name: "Controlled model",
        model: "gpt-test",
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        apiKey: "test-only",
        maxTokens: 200_000
      }
    ],
    execution: { windowsSandbox: "none", resourceDirectory: resolve("resources") }
  })
  const store = new BotStore(join(directory, "bots.sqlite"))
  cleanup.push(() => store.close())
  const browser = new LocalBotComputerProvider(join(directory, "browser"))
  cleanup.push(() => browser.close())
  const runtime = new CmbBotRuntime(modelFile, browser)
  cleanup.push(() => runtime.functionSessions.close())
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "开发助手" })
  store.send({ nonce: "send", conversationId, text: "请收集发布信息" })
  const claimed = store.claim("host", 60_000)!,
    controller = new AbortController()
  const running = runtime.execute({
    ...claimed,
    store,
    bot,
    messages: store.messagesForRun(claimed.run.id),
    signal: controller.signal
  })
  cleanup.push(async () => {
    controller.abort()
    await Promise.allSettled([running])
  })
  for (
    let index = 0;
    index < 300 && store.snapshot().interactions.length === 0 && !errors.length;
    index++
  )
    await delay(20)
  expect(errors).toEqual([])
  const item = store.snapshot().interactions[0]
  expect(item).toBeDefined()
  expect(readBotUserForm(item.prompt)?.input.fields).toHaveLength(4)
  expect(store.getRun(claimed.run.id).status).toBe("waiting_input")
  await delay(350)
  expect(requests).toHaveLength(1)
  const api = createBotAPI(new BotHost(store))
  await expect(
    api.answer({
      id: item.id,
      revision: item.revision,
      expectedDataEpoch: "initial",
      answer: '{"status":"submitted","values":{"date":"2026-02-30"}}'
    })
  ).rejects.toThrow()
  expect(requests).toHaveLength(1)
  const input = {
    id: item.id,
    revision: item.revision,
    expectedDataEpoch: "initial",
    answer: JSON.stringify({
      status: "submitted",
      values: {
        branch: " main ",
        date: "2028-02-29",
        count: "0",
        note: " "
      }
    })
  }
  const receipt = await api.answer(input)
  expect(await api.answer(input)).toEqual(receipt)
  expect(await running).toBe("FORM_VALUES_ACCEPTED")
  store.finish(claimed.lease, "succeeded", "FORM_VALUES_ACCEPTED")
  expect(store.getRun(claimed.run.id).status).toBe("succeeded")
  expect(store.db.exec("SELECT COUNT(*) FROM bot_runs")[0].values).toEqual([[1]])
  expect(requests).toHaveLength(2)
  expect(errors).toEqual([])
}, 30_000)
