import { afterEach, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { build } from "esbuild"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { CmbBotRuntime } from "./agent-runtime"
import { LocalBotComputerProvider } from "./computer-provider"
import { BotWorkflowProcess } from "./workflow-process"
import { writeBotModelSnapshot } from "./model-config"
import { testModelRequest, type TestModelRequest } from "./test-model-protocol"
import { computerTaskNativeFixture } from "./computer-task-native-fixture"
import { nativeTaskReservation } from "./native-task-scope"

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})
const call = (name: string, args: unknown, id: string) => ({
  content: "",
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
})
function result(body: TestModelRequest, id: string): string | undefined {
  const message = body.messages.find(
    (message) => message.role === "tool" && message.tool_call_id === id
  )
  if (typeof message?.content === "string") return message.content
  return Array.isArray(message?.content)
    ? message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
    : undefined
}

it("runs one real CmbRuntime main/child graph with shared native broker, manual effect approval and durable background delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "cmb-native-child-runtime-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv("CMB_COWORK_AGENT_HOME", join(root, "settings"))
  const requests: TestModelRequest[] = [],
    events: string[] = [],
    errors: unknown[] = []
  let parentContinued = false,
    childImage = false
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const body = testModelRequest.parse(JSON.parse(Buffer.concat(chunks).toString()))
      requests.push(body)
      const child = body.messages.some(
        (message) => message.role === "user" && message.content === "GUI_CHILD_ASSIGNMENT_ONLY"
      )
      let message: Record<string, unknown>
      if (child) {
        const offered = body.tools.map((tool) => tool.function.name)
        expect(offered).toContain("native_computer")
        expect(offered).toContain("request_computer_help")
        for (const denied of [
          "browser",
          "project_shell",
          "project_read",
          "execute",
          "workflow",
          "dispatch_task",
          "save_memory",
          "send_message",
          "request_secret"
        ])
          expect(offered).not.toContain(denied)
        expect(JSON.stringify(body.messages)).not.toContain("PRIVATE_PARENT_DUTIES")
        expect(JSON.stringify(body.messages)).not.toContain("PRIVATE_PARENT_MEMORY")
        if (!result(body, "child-windows"))
          message = call(
            "native_computer",
            { op: "windows", arguments_json: "{}" },
            "child-windows"
          )
        else if (!result(body, "child-select")) {
          const windows = JSON.parse(result(body, "child-windows")!)
          message = call(
            "native_computer",
            { op: "select_window", arguments_json: JSON.stringify({ viewId: windows[0].viewId }) },
            "child-select"
          )
        } else if (!result(body, "child-observe"))
          message = call(
            "native_computer",
            { op: "observe", arguments_json: "{}" },
            "child-observe"
          )
        else if (!result(body, "child-write")) {
          const observation = JSON.parse(result(body, "child-observe")!)
          message = call(
            "native_computer",
            {
              op: "set_value",
              arguments_json: JSON.stringify({
                elementId: observation.elements[0].id,
                value: "Owned child evidence"
              })
            },
            "child-write"
          )
        } else if (!result(body, "child-screen"))
          message = call(
            "native_computer",
            { op: "screenshot", arguments_json: "{}" },
            "child-screen"
          )
        else {
          childImage = body.messages.some(
            (message) =>
              message.role === "tool" &&
              message.tool_call_id === "child-screen" &&
              Array.isArray(message.content) &&
              message.content.some((part) => part.type === "image_url")
          )
          events.push("child-final")
          message = { content: "Shared desktop evidence" }
        }
      } else if (
        body.messages.some((message) =>
          String(message.content).includes("[Background workflow result")
        )
      ) {
        events.push("parent-receipt")
        message = { content: "Consolidated shared desktop result" }
      } else if (!result(body, "dispatch-native"))
        message = call(
          "dispatch_task",
          { prompt: "GUI_CHILD_ASSIGNMENT_ONLY", label: "Application task", taskType: "computer" },
          "dispatch-native"
        )
      else if (!result(body, "parent-catalog"))
        message = call("list_skills", { query: "", offset: 0 }, "parent-catalog")
      else {
        parentContinued = true
        events.push("parent-continued")
        message = { content: "Parent preliminary work" }
      }
      res.setHeader("Content-Type", "text/event-stream")
      const calls = (message.tool_calls as Record<string, unknown>[] | undefined)?.map(
        (call, index) => ({ ...call, index })
      )
      const delta = {
        role: "assistant",
        ...(calls ? { tool_calls: calls } : { content: message.content ?? "" })
      }
      for (const chunk of [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }] },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 } }
      ])
        res.write(
          `data: ${JSON.stringify({ id: `chatcmpl-${requests.length}`, object: "chat.completion.chunk", model: "gpt-test", created: 1, ...chunk })}\n\n`
        )
      res.end("data: [DONE]\n\n")
    } catch (error) {
      errors.push(error)
      res.statusCode = 500
      res.end("Controlled fixture failure")
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
  const modelFile = join(root, "host", "models.private")
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
  const store = new BotStore(join(root, "bots.sqlite"))
  cleanup.push(() => store.close())
  const browser = new LocalBotComputerProvider(join(root, "browser"))
  cleanup.push(() => browser.close())
  const files = new BotArtifacts(join(root, "files"), store),
    entry = join(root, "workflow.cjs")
  await build({
    entryPoints: ["src/main/bots/workflow-worker-entry.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: entry,
    logLevel: "silent",
    preserveSymlinks: true
  })
  const workflow = new BotWorkflowProcess({ entry }),
    runtime = new CmbBotRuntime(modelFile, browser, { files, workflow })
  cleanup.push(() => runtime.functionSessions.close())
  const { bot, conversationId } = store.createBot({
    nonce: "bot",
    name: "Developer",
    instructions: "PRIVATE_PARENT_DUTIES"
  })
  store.saveMemory({ botId: bot.id, text: "PRIVATE_PARENT_MEMORY" })
  const native = await computerTaskNativeFixture(bot.id)
  cleanup.push(() => native.broker.close())
  runtime.bindNativeComputer(native.broker)
  const oldTarget = native.broker.target(bot.id)
  store.send({
    nonce: "task",
    conversationId,
    text: "Delegate the application task and continue the catalog review"
  })
  const parent = store.claim("host", 60_000)!,
    controller = new AbortController()
  const running = runtime.execute({
    ...parent,
    store,
    bot,
    messages: store.messagesForRun(parent.run.id),
    signal: controller.signal
  })
  // Join original graph cancellation before closing its database and ports.
  cleanup.push(async () => {
    controller.abort()
    await Promise.allSettled([running])
  })
  let card: ReturnType<BotStore["snapshot"]>["interactions"][number] | undefined
  for (let i = 0; i < 250; i++) {
    card = store
      .snapshot()
      .interactions.find((item) => item.kind === "approval" && item.status === "pending")
    if (parentContinued && card) break
    if (errors.length) break
    await delay(20)
  }
  expect(errors).toEqual([])
  expect(parentContinued).toBe(true)
  expect(card).toBeDefined()
  const child = store.workflowChildren.list(parent.run.id)[0]
  expect(child.status).toBe("waiting_input")
  expect(nativeTaskReservation(store, bot.id)).toBe(child.id)
  expect(card!.runId).toBe(child.id)
  expect(native.requests.filter((request) => request.operation === "set_value")).toHaveLength(0)
  expect(native.broker.target(bot.id).taskRunId).toBeUndefined()
  expect(native.broker.target(bot.id).generation).not.toBe(oldTarget.generation)
  store.answerInteraction({ id: card!.id, revision: card!.revision, answer: "approve" })
  events.push("human-approved")
  expect(await running).toBe("Consolidated shared desktop result")
  expect(errors).toEqual([])
  expect(childImage).toBe(true)
  expect(native.element.value).toBe("Owned child evidence")
  expect(native.requests.filter((request) => request.operation === "set_value")).toHaveLength(1)
  expect(native.requests.filter((request) => request.operation === "invalidate")).toHaveLength(2)
  expect(
    native.requests.every(
      (request) => request.scope.botId === bot.id && request.scope.taskRunId === undefined
    )
  ).toBe(true)
  expect(native.launches()).toBe(1)
  expect(store.workflowChildren.list(parent.run.id)).toHaveLength(1)
  expect(store.getRun(child.id).status).toBe("succeeded")
  expect(nativeTaskReservation(store, bot.id)).toBeUndefined()
  expect(
    store.db.exec("SELECT status FROM bot_effects WHERE run_id=?", [child.id])[0].values
  ).toEqual([["succeeded"]])
  expect(
    store.db.exec("SELECT COUNT(*) FROM bot_background_workflows WHERE receipt IS NOT NULL")[0]
      .values
  ).toEqual([[1]])
  expect(events.indexOf("parent-continued")).toBeLessThan(events.indexOf("human-approved"))
  expect(events.indexOf("human-approved")).toBeLessThan(events.indexOf("child-final"))
  expect(events.indexOf("child-final")).toBeLessThan(events.indexOf("parent-receipt"))
  expect(store.finish(parent.lease, "succeeded", "Consolidated shared desktop result").status).toBe(
    "succeeded"
  )
}, 30_000)
