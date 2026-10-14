import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { HumanMessage, BaseMessage } from "@langchain/core/messages"

async function main() {
  if (process.argv[2] === "--reopen") {
    const [directory, threadId, checkpointId, count] = process.argv.slice(3)
    const owned = resolve(directory)
    assert.equal(dirname(owned), resolve(tmpdir()))
    assert(basename(owned).startsWith("cmb-prompt-real-http-"))
    process.env.CMB_COWORK_AGENT_HOME = join(owned, "app")
    const database = await import("../../src/main/db")
    const runtime = await import("../../src/main/agent/runtime")
    const { readFlowPromptRuntimeProof } = await import("../../src/main/agent/flow-prompt-runtime")
    try {
      await database.initializeDatabase()
      const tuple = await (
        await runtime.getCheckpointer(threadId)
      ).getTuple({ configurable: { thread_id: threadId } })
      assert.equal(tuple?.checkpoint.id, checkpointId)
      assert.equal(
        (tuple?.checkpoint.channel_values.messages as BaseMessage[]).length,
        Number(count)
      )
      const persistedFacts = JSON.parse(await readFile(join(owned, "facts.json"), "utf8"))
      assert.equal(persistedFacts.modelCalls, 1)
      assert.equal(readFlowPromptRuntimeProof(persistedFacts, {}), undefined)
      console.log(
        "PASS fresh Node process: real SQLite checkpoint reopened; serialized facts do not forge runtime proof"
      )
    } finally {
      await runtime.closeRuntime()
      await database.closeDatabase()
    }
    return
  }
  const directory = await mkdtemp(join(tmpdir(), "cmb-prompt-real-http-"))
  process.env.CMB_COWORK_AGENT_HOME = join(directory, "app")
  // Imports occur after the isolated data root is installed. No user configuration is read.
  const storage = await import("../../src/main/storage")
  const database = await import("../../src/main/db")
  const runtimeModule = await import("../../src/main/agent/runtime")
  const { prepareStandardThreadRuntimeFactory } =
    await import("../../src/main/agent/standard-thread-turn")
  const { claimLocalThreadRunLease, releaseLocalThreadRunLease } =
    await import("../../src/main/agent/thread-run-lease")
  const { getModelConfigByRef } = await import("../../src/main/models/registry")
  const { CompletionBudget, withCompletionBudget } =
    await import("../../src/main/mods/v2/completion-budget")
  const { createPromptOnlyStructuredOutputTool } =
    await import("../../src/main/agent/workflow/subagent")
  const { describeFlowPromptRuntime, flowPromptResultSchema } =
    await import("../../src/main/agent/flow-prompt-runtime-contract")
  const { readFlowPromptRuntimeProof } = await import("../../src/main/agent/flow-prompt-runtime")
  const requests: Array<{ authorization: string | undefined; body: Record<string, unknown> }> = []
  let cancelController: AbortController | undefined
  const server = createServer(async (request, response) => {
    let text = ""
    for await (const chunk of request) text += chunk.toString()
    requests.push({ authorization: request.headers.authorization, body: JSON.parse(text) })
    response.setHeader("content-type", "text/event-stream")
    if (cancelController) {
      response.write(
        `data: ${JSON.stringify({
          id: "cancel",
          object: "chat.completion.chunk",
          choices: [
            { index: 0, delta: { role: "assistant", content: "pending" }, finish_reason: null }
          ]
        })}\n\n`
      )
      const abort = cancelController
      setTimeout(() => abort.abort(Error("fixture-abort")), 20)
      return
    }
    for (const frame of [
      {
        id: "actual-prompt",
        object: "chat.completion.chunk",
        model: "fixture",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "result",
                  type: "function",
                  function: {
                    name: "structured_output",
                    arguments: JSON.stringify({ passed: true, summary: "actual HTTP" })
                  }
                }
              ]
            },
            finish_reason: null
          }
        ]
      },
      {
        id: "actual-prompt",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
      },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }
    ])
      response.write(`data: ${JSON.stringify(frame)}\n\n`)
    response.end("data: [DONE]\n\n")
  })
  let reader: ReturnType<typeof readFlowPromptRuntimeProof>
  const threadId = `prompt__${randomUUID()}`,
    runId = randomUUID()
  try {
    await database.initializeDatabase()
    database.createThread(threadId, { workspacePath: directory })
    assert(claimLocalThreadRunLease({ threadId, owner: "mods", runId }).acquired)
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address() as { port: number }
    storage.upsertCustomModelConfig({
      id: "actual-prompt",
      name: "fixture",
      model: "fixture",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "test-only",
      maxTokens: 32000,
      maxOutputTokens: 1024,
      temperature: 0.2,
      topP: 1,
      topK: 0
    })
    const config = getModelConfigByRef("custom:actual-prompt")!
    const descriptor = describeFlowPromptRuntime({
      model: config,
      rolePrompt: "",
      mandatoryPolicyDigest: "f".repeat(64)
    })
    const invocation = Object.freeze({})
    const factory = prepareStandardThreadRuntimeFactory({
      source: "desktop",
      runLease: { owner: "mods", runId },
      baseOptions: {
        threadId,
        workspacePath: directory,
        abortSignal: new AbortController().signal,
        additionalTools: [
          createPromptOnlyStructuredOutputTool(flowPromptResultSchema(), invocation)
        ],
        flowPromptOnly: {
          profile: "prompt-only-v1",
          invocation,
          rolePrompt: "",
          expectedModelRef: config.ref,
          expectedModelDigest: descriptor.modelConfigurationDigest,
          mandatoryPolicyDigest: descriptor.mandatoryPolicyDigest,
          deadline: Date.now() + 10000,
          assertCurrent: () => {}
        }
      }
    })
    const runtime = await factory.create(config.ref)
    reader = readFlowPromptRuntimeProof(runtime, invocation)
    assert(reader)
    const budget = new CompletionBudget(6000, 10000)
    await withCompletionBudget(budget, async () => {
      for await (const frame of await runtime.stream(
        { messages: [new HumanMessage("actual HTTP task")] },
        {
          configurable: { thread_id: threadId },
          recursionLimit: 12,
          streamMode: ["values", "messages"]
        }
      ))
        void frame
    })
    const facts = await reader.seal()
    assert.equal(facts.modelCalls, 1)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].authorization, "Bearer test-only")
    assert.equal(budget.inputTokens, 100)
    assert.equal(budget.outputTokens, 20)
    const tools = requests[0].body.tools as Array<{ function: { name: string } }>
    assert.deepEqual(
      tools.map((tool) => tool.function.name),
      ["structured_output"]
    )
    assert.equal(requests[0].body.stream, true)
    const saved = await (
      await runtimeModule.getCheckpointer(threadId)
    ).getTuple({ configurable: { thread_id: threadId } })
    assert(saved)
    const messages = saved.checkpoint.channel_values.messages as BaseMessage[]
    assert(messages.some((message) => message.getType() === "tool"))
    await runtimeModule.closeCheckpointer(threadId)
    const reopened = await (
      await runtimeModule.getCheckpointer(threadId)
    ).getTuple({ configurable: { thread_id: threadId } })
    assert.equal(reopened?.checkpoint.id, saved.checkpoint.id)
    assert.equal(
      (reopened?.checkpoint.channel_values.messages as BaseMessage[]).length,
      messages.length
    )
    await runtimeModule.closeCheckpointer(threadId)
    await writeFile(join(directory, "facts.json"), JSON.stringify(facts), "utf8")
    const fresh = spawnSync(
      process.execPath,
      [
        process.argv[1],
        "--reopen",
        directory,
        threadId,
        saved.checkpoint.id,
        String(messages.length)
      ],
      { encoding: "utf8", timeout: 15000, windowsHide: true }
    )
    assert.equal(fresh.status, 0, fresh.stderr || fresh.stdout)
    assert.match(fresh.stdout, /PASS fresh Node process/)
    console.log(fresh.stdout.trim())
    const cancelThread = `prompt-cancel__${randomUUID()}`
    database.createThread(cancelThread, { workspacePath: directory })
    assert(claimLocalThreadRunLease({ threadId: cancelThread, owner: "mods", runId }).acquired)
    cancelController = new AbortController()
    const cancelInvocation = Object.freeze({})
    const cancelOptions = factory.optionsForModel(config.ref)
    const cancelFactory = prepareStandardThreadRuntimeFactory({
      source: "desktop",
      runLease: { owner: "mods", runId },
      baseOptions: {
        ...cancelOptions,
        threadId: cancelThread,
        abortSignal: cancelController.signal,
        additionalTools: [
          createPromptOnlyStructuredOutputTool(flowPromptResultSchema(), cancelInvocation)
        ],
        flowPromptOnly: { ...cancelOptions.flowPromptOnly!, invocation: cancelInvocation }
      }
    })
    const cancelRuntime = await cancelFactory.create(config.ref)
    const cancelProof = readFlowPromptRuntimeProof(cancelRuntime, cancelInvocation)!
    try {
      await assert.rejects(async () => {
        for await (const frame of await cancelRuntime.stream(
          { messages: [new HumanMessage("cancel this unfinished provider response")] },
          { configurable: { thread_id: cancelThread }, streamMode: ["values", "messages"] }
        ))
          void frame
      })
      await assert.rejects(() => cancelProof.seal())
      assert.equal(requests.length, 2)
      console.log(
        "PASS actual HTTP cancellation: aborted unfinished provider cannot seal runtime facts"
      )
    } finally {
      cancelProof.dispose()
      releaseLocalThreadRunLease(cancelThread, "mods", runId)
      await runtimeModule.closeCheckpointer(cancelThread)
    }
    console.log(
      "PASS actual HTTP: original provider auth + usage 100/20 + fixed tool + real SQLite reopen"
    )
  } finally {
    reader?.dispose()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    releaseLocalThreadRunLease(threadId, "mods", runId)
    await runtimeModule.closeRuntime()
    await database.closeDatabase()
    const owned = resolve(directory)
    assert.equal(dirname(owned), resolve(tmpdir()))
    assert(basename(owned).startsWith("cmb-prompt-real-http-"))
    await rm(owned, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
