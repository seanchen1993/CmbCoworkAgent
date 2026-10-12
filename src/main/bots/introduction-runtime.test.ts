import { afterEach, expect, it, vi } from "vitest"
import { HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BotCheckpointSaver } from "./checkpointer"
import { CmbBotRuntime } from "./agent-runtime"
import { LocalBotComputerProvider } from "./computer-provider"
import { writeBotModelSnapshot } from "./model-config"
import { testModelRequest, type TestModelRequest } from "./test-model-protocol"

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it.each([
  { model: "MiniMax-M2.7", enableThinking: true, interleavedThinking: true, offerQuestion: false },
  { model: "DeepSeek-V4", enableThinking: true, interleavedThinking: false, offerQuestion: false },
  { model: "gpt-4.1", enableThinking: false, interleavedThinking: false, offerQuestion: false },
  { model: "MiniMax-M2.7", enableThinking: true, interleavedThinking: true, offerQuestion: true }
])(
  "$model carries a nonempty Host cue in protocol user role while chat history remains user-free",
  async (settings) => {
    const directory = await mkdtemp(join(tmpdir(), "cmb-introduction-runtime-"))
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
        expect(body.tools?.map((entry) => entry.function.name)).toEqual([
          "offer_introduction_question"
        ])
        const users = body.messages.filter((message) => message.role === "user")
        const userText = users.map((message) =>
          typeof message.content === "string"
            ? message.content
            : (message.content ?? []).map((part) => part.text ?? "").join("")
        )
        // Mirror the live MiniMax 2013 contract: accepting an all-system request
        // here would hide the production failure behind an unrealistic fixture.
        if (!userText.some((text) => text.trim())) {
          response.statusCode = 400
          response.setHeader("Content-Type", "application/json")
          response.end(
            JSON.stringify({
              error: {
                message: "invalid params, chat content is empty (2013)",
                type: "invalid_request_error"
              }
            })
          )
          return
        }
        expect(users).toHaveLength(1)
        expect(userText[0]).toContain("[Host control cue: bot-introduction]")
        expect(userText[0]).toContain("not user-authored")
        expect(users[0]).not.toHaveProperty("cmb_host_control")
        expect(body.messages.some((message) => message.role === "system")).toBe(true)
        expect(Number(body.max_tokens ?? body.max_completion_tokens)).toBeLessThanOrEqual(8192)
        response.setHeader("Content-Type", "text/event-stream")
        if (settings.offerQuestion && requests.length === 1) {
          const argumentsText = JSON.stringify({
            questions: [
              {
                id: "project",
                header: "项目",
                question: "想先检查哪项工作？",
                options: [
                  { label: "代码质量", description: "先检查实现" },
                  { label: "测试结果", description: "先检查验证证据" }
                ]
              }
            ]
          })
          for (const chunk of [
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "intro-choice",
                        type: "function",
                        function: { name: "offer_introduction_question", arguments: argumentsText }
                      }
                    ]
                  },
                  finish_reason: null
                }
              ]
            },
            { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
            { choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }
          ])
            response.write(
              `data: ${JSON.stringify({ id: "intro-choice-answer", object: "chat.completion.chunk", model: settings.model, created: 1, ...chunk })}\n\n`
            )
          response.end("data: [DONE]\n\n")
          return
        }
        if (settings.offerQuestion)
          expect(
            body.messages.some(
              (message) => message.role === "tool" && message.tool_call_id === "intro-choice"
            )
          ).toBe(true)
        for (const chunk of [
          {
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  reasoning_content: "Private thinking, never a greeting"
                },
                finish_reason: null
              }
            ]
          },
          {
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "你好！你想先处理哪个项目？" },
                finish_reason: null
              }
            ]
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 100, completion_tokens: 18, total_tokens: 118 } }
        ])
          response.write(
            `data: ${JSON.stringify({ id: "introduction-answer", object: "chat.completion.chunk", model: settings.model, created: 1, ...chunk })}\n\n`
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
    const modelFile = join(directory, "models.private")
    await writeBotModelSnapshot(modelFile, {
      version: 1,
      defaultRef: "test",
      models: [
        {
          ref: "test",
          id: "test",
          name: "Controlled model",
          model: settings.model,
          baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
          apiKey: "test-only",
          maxTokens: 200_000,
          maxOutputTokens: 16_384,
          enableThinking: settings.enableThinking,
          interleavedThinking: settings.interleavedThinking
        }
      ]
    })
    const store = new BotStore(join(directory, "bots.sqlite"))
    cleanup.push(() => store.close())
    const browser = new LocalBotComputerProvider(join(directory, "browser"))
    cleanup.push(() => browser.close())
    const runtime = new CmbBotRuntime(modelFile, browser)
    const refresh = vi.spyOn(runtime, "refreshSkills")
    const { bot, conversationId } = store.createBot({
      nonce: "create",
      name: "研发助手",
      instructions: "帮助研发团队检查质量",
      introduction: { language: "zh-CN" }
    })
    const claimed = store.claim("host", 60_000)!
    const abort = new AbortController()
    const running = runtime.execute({
      ...claimed,
      bot,
      store,
      messages: store.messagesForRun(claimed.run.id),
      signal: abort.signal
    })
    cleanup.push(async () => {
      abort.abort()
      await Promise.allSettled([running])
    })
    const answer = await running
    expect(answer).toBe("你好！你想先处理哪个项目？")
    expect(store.getRun(claimed.run.id).output).not.toContain("Private thinking")
    expect(store.getRun(claimed.run.id).output).not.toContain("<think>")
    expect(errors).toEqual([])
    expect(requests).toHaveLength(settings.offerQuestion ? 2 : 1)
    expect(refresh).not.toHaveBeenCalled()
    expect(store.getRun(claimed.run.id).checkpoint).not.toBeNull()
    const checkpoint = await new BotCheckpointSaver(store, claimed.lease, claimed.run.id).getTuple({
      configurable: { thread_id: claimed.run.id }
    })
    const graphMessages = checkpoint!.checkpoint.channel_values.messages as BaseMessage[]
    const hostCues = graphMessages.filter((message) => HumanMessage.isInstance(message))
    expect(hostCues).toHaveLength(1)
    expect(hostCues[0]!.additional_kwargs.cmb_host_control).toEqual({
      kind: "bot-introduction",
      origin: "host",
      userAuthored: false,
      runId: claimed.run.id
    })
    expect(store.db.exec("SELECT sender FROM bot_messages")[0]!.values).toEqual([["system"]])
    expect(store.messages(conversationId)).toEqual([])
    expect(
      Number(store.db.exec("SELECT COUNT(*) FROM bot_workflow_model_calls")[0]!.values[0]![0])
    ).toBe(settings.offerQuestion ? 2 : 1)
    store.finish(claimed.lease, "succeeded", answer)
    expect(store.messages(conversationId).map((message) => [message.sender, message.text])).toEqual(
      settings.offerQuestion
        ? [
            ["bot", answer],
            ["bot", "想先检查哪项工作？"]
          ]
        : [["bot", answer]]
    )
    expect(store.snapshot().interactions).toEqual([])
    expect(store.messages(conversationId).at(-1)!.introductionQuestion?.status).toBe(
      settings.offerQuestion ? "pending" : undefined
    )
    expect(store.effects(claimed.run.id)).toEqual([])
  },
  30_000
)
