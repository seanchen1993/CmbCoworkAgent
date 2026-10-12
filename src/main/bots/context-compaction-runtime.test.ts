import { afterEach, expect, it } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { BotStore } from "./store"
import { bindTestLocalProjectAuthority } from "./test-local-project-permission"
import { BotCheckpointSaver } from "./checkpointer"
import { CmbBotRuntime } from "./agent-runtime"
import { LocalBotComputerProvider } from "./computer-provider"
import { BotArtifacts } from "./artifacts"
import { writeBotModelSnapshot } from "./model-config"
import { testModelRequest, type TestModelRequest } from "./test-model-protocol"

const cleanups: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const handoff = `## Goal\n- Finish the assigned review, preserving the current request.
## Constraints\n- Only approved actions are allowed.
## Completed\n- Reviewed the supplied project evidence.
## Current State\n- CONTEXT_HANDOFF_READY; continue with the remaining work.
## Blockers\n- None.
## Key Decisions\n- Preserve exact task and approval identities.
## Next Step\n- Return the requested review result.
## Critical Evidence\n- The source evidence was summarized; do not invent further verification.`
const largeRequest = `Review this evidence and return the result.\n${"source-evidence-724 ".repeat(1900)}`
const isSummary = (body: TestModelRequest) => !body.tools.length
const call = (id: string, name: string, args: unknown) => ({
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
})

async function fixture(
  respond: (body: TestModelRequest) => Record<string, unknown>,
  options: {
    task?: string
    pause?: (body: TestModelRequest) => Promise<void>
    project?: boolean
    outputTokens?: number
  } = {}
) {
  const requests: TestModelRequest[] = []
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = []
    for await (const part of request) parts.push(part)
    const body = testModelRequest.parse(JSON.parse(Buffer.concat(parts).toString()))
    requests.push(body)
    const message = respond(body)
    const id = `context-${requests.length}`
    response.setHeader("Content-Type", "text/event-stream")
    const delta = (value: unknown, finish: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: 1,
          model: "test-context-model",
          choices: [{ index: 0, delta: value, finish_reason: finish }]
        })}\n\n`
      )
    delta({ role: "assistant" })
    await options.pause?.(body)
    if (response.destroyed) return
    if (message.tool_calls) {
      delta({
        tool_calls: (message.tool_calls as Record<string, unknown>[]).map((value, index) => ({
          ...value,
          index
        }))
      })
    } else delta({ content: String(message.content ?? "") })
    delta({}, message.tool_calls ? "tool_calls" : "stop")
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  const directory = await mkdtemp(join(tmpdir(), "bot-context-budget-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const workspace = join(directory, "project")
  await mkdir(workspace)
  const file = join(directory, "host", "models.private")
  await writeBotModelSnapshot(file, {
    version: 1,
    defaultRef: "test",
    models: [
      {
        ref: "test",
        id: "test",
        name: "Context fixture",
        model: "test-context-model",
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        apiKey: "test-only",
        // The current ordinary Bot tools require about 14k fixed input tokens.
        // Keep the positive fixture's 18k output reservation and enough input
        // room for its handoff; the original large evidence still forces compaction.
        maxTokens: 36_000,
        // Leave room for the real system prompt + tool schemas after summarizing.
        // The insufficient-budget case below deliberately does not leave that room.
        maxOutputTokens: options.outputTokens ?? (options.project ? 12_000 : 18_000)
      }
    ]
  })
  const store = new BotStore(join(directory, "bots.sqlite"))
  cleanups.push(() => store.close())
  cleanups.push(bindTestLocalProjectAuthority(store, directory))
  const computer = new LocalBotComputerProvider(join(directory, "browser"))
  cleanups.push(() => computer.close())
  const artifacts = new BotArtifacts(join(directory, "objects"), store)
  const { bot, conversationId } = store.createBot({
    nonce: "bot",
    name: "Context fixture",
    ...(options.project ? { workspacePath: workspace } : {})
  })
  const {
    runIds: [runId]
  } = store.send({ nonce: "task", conversationId, text: options.task ?? largeRequest })
  const start = (owner: string) => {
    const claimed = store.claim(owner, 300_000)!
    expect(claimed.run.id).toBe(runId)
    const controller = new AbortController()
    const runtime = new CmbBotRuntime(file, computer, { files: artifacts })
    const completion = runtime.execute({
      ...claimed,
      store,
      bot,
      messages: store.messagesForRun(runId),
      signal: controller.signal
    })
    // Attach a handler immediately: tests may revoke a lease while awaiting an HTTP observation.
    const settled = completion.then(
      (result) => ({ result }),
      (error) => ({ error })
    )
    cleanups.push(async () => {
      controller.abort()
      await settled
    })
    return { ...claimed, controller, completion, settled }
  }
  return { store, requests, workspace, runId, conversationId, start }
}

async function until(condition: () => boolean) {
  const deadline = Date.now() + 12_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Context graph did not reach the expected boundary")
    await delay(20)
  }
}

it("reserves configured output before the first Bot model request through the real graph", async () => {
  const f = await fixture((body) => ({ content: isSummary(body) ? handoff : "REVIEW_COMPLETE" }))
  const run = f.start("first")
  expect(await run.completion).toBe("REVIEW_COMPLETE")
  expect(isSummary(f.requests[0])).toBe(true)
  const agent = f.requests.filter((body) => !isSummary(body))
  expect(agent).toHaveLength(1)
  expect(JSON.stringify(agent[0].messages)).toContain("CONTEXT_HANDOFF_READY")
  expect(JSON.stringify(agent[0].messages)).not.toContain("source-evidence-724 ".repeat(100))
  expect(agent[0].max_tokens).toBe(18_000)
  // Bot file tools cannot read the graph's default virtual filesystem.
  expect(JSON.stringify(agent[0].messages)).not.toContain("saved to /conversation_history/")
  expect(f.store.getRun(f.runId).checkpoint).not.toBeNull()
})

it("shows context preparation while the summarizer is pending and records completion without exposing its handoff", async () => {
  let release!: () => void
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture((body) => ({ content: isSummary(body) ? handoff : "REVIEW_COMPLETE" }), {
    pause: (body) => (isSummary(body) ? paused : Promise.resolve())
  })
  const progress = () =>
    f.store.events().filter((event) => event.entityId === f.runId && event.kind === "run.activity")
  const run = f.start("visible-summary")
  try {
    await until(() => f.requests.length > 0)
    expect(progress().at(-1)?.payload).toMatchObject({
      kind: "thinking",
      description: "正在整理上下文"
    })
  } finally {
    release()
  }
  expect(await run.completion).toBe("REVIEW_COMPLETE")
  expect(progress()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        payload: { kind: "thinking", description: "正在核对上下文摘要" }
      })
    ])
  )
  expect(JSON.stringify(progress())).not.toContain("CONTEXT_HANDOFF_READY")
})

it("rechecks an oversized handoff against the Bot input reservation before invoking the agent", async () => {
  let summaries = 0
  const f = await fixture((body) => ({
    content: isSummary(body)
      ? ++summaries === 1
        ? `${handoff}\n${"oversized-handoff ".repeat(3000)}`
        : handoff
      : "REVIEW_COMPLETE"
  }))
  expect(await f.start("oversized").completion).toBe("REVIEW_COMPLETE")
  expect(summaries).toBeGreaterThanOrEqual(2)
  const agent = f.requests.filter((body) => !isSummary(body))
  expect(agent).toHaveLength(1)
  expect(JSON.stringify(agent[0].messages)).not.toContain("oversized-handoff")
})

it("rejects a short summary when fixed prompt and tools still exceed the reserved input budget", async () => {
  const f = await fixture(() => ({ content: handoff }), { outputTokens: 24_000 })
  await expect(f.start("insufficient-input").completion).rejects.toThrow(/input budget/)
  expect(f.requests.filter((body) => !isSummary(body))).toEqual([])
  expect(f.store.messages(f.conversationId).some((message) => message.sender === "bot")).toBe(false)
})

it("retrieves original tool evidence omitted by a compacted model context", async () => {
  let steps = 0
  const f = await fixture(
    (body) => {
      if (isSummary(body)) return { content: handoff }
      if (++steps <= 3)
        return call(`evidence-${steps}`, "project_read", {
          path: `evidence-${steps}.txt`,
          limit: 32_000
        })
      if (steps === 4)
        return call("recover-evidence", "read_task_history", { message: 2, limit: 256 })
      return { content: "ORIGINAL_EVIDENCE_RECOVERED" }
    },
    { project: true, task: "Review the three files; retrieve original evidence after compaction." }
  )
  for (let i = 1; i <= 3; i++)
    await writeFile(
      join(f.workspace, `evidence-${i}.txt`),
      `ORIGINAL_EVIDENCE_${i}\n${"bounded-project-evidence ".repeat(700)}`
    )
  expect(await f.start("recover-evidence").completion).toBe("ORIGINAL_EVIDENCE_RECOVERED")
  const agent = f.requests.filter((body) => !isSummary(body))
  expect(JSON.stringify(agent[3].messages)).toContain("CONTEXT_HANDOFF_READY")
  expect(JSON.stringify(agent[3].messages)).not.toContain("ORIGINAL_EVIDENCE_1")
  expect(JSON.stringify(agent[3].messages)).not.toContain("saved to /conversation_history/")
  const result = agent
    .at(-1)!
    .messages.find((message) => message.tool_call_id === "recover-evidence")
  const page = JSON.parse(String(result?.content))
  expect(page.text).toContain("ORIGINAL_EVIDENCE_1")
  expect(page.text.length).toBe(256)
  expect(page.nextOffset).toBe(256)
  expect(steps).toBe(5)
})

it("cancels a pending summary without invoking the agent or publishing a final result", async () => {
  let release!: () => void
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture((body) => ({ content: isSummary(body) ? handoff : "MUST_NOT_RUN" }), {
    pause: (body) => (isSummary(body) ? paused : Promise.resolve())
  })
  const run = f.start("cancel")
  try {
    await until(() => f.requests.length > 0)
    expect(isSummary(f.requests[0])).toBe(true)
    f.store.cancel(f.runId)
    const cancelledCursor = f.store.events().at(-1)!.cursor
    run.controller.abort(new Error("cancelled by test"))
    await expect(run.completion).rejects.toThrow()
    expect(
      f.store.events(cancelledCursor).filter((event) => event.kind === "run.activity")
    ).toEqual([])
    expect(f.requests).toHaveLength(1)
    expect(f.store.messages(f.conversationId).some((message) => message.sender === "bot")).toBe(
      false
    )
  } finally {
    release()
  }
})

it("compacts large project results when transient truncation cannot fit the reserved input budget", async () => {
  let steps = 0
  const f = await fixture(
    (body) => {
      if (isSummary(body)) return { content: handoff }
      if (++steps <= 3)
        return call(`read-${steps}`, "project_read", {
          path: `evidence-${steps}.txt`,
          limit: 32_000
        })
      return { content: "LARGE_RESULTS_REVIEWED" }
    },
    { project: true, task: "Read the three evidence files and return the review." }
  )
  for (let i = 1; i <= 3; i++)
    await writeFile(
      join(f.workspace, `evidence-${i}.txt`),
      `EVIDENCE_${i}\n${"bounded-project-evidence ".repeat(700)}`
    )
  const run = f.start("large-tools")
  expect(await run.completion).toBe("LARGE_RESULTS_REVIEWED")
  expect(steps).toBe(4)
  expect(f.requests.some(isSummary)).toBe(true)
  const final = f.requests.filter((body) => !isSummary(body)).at(-1)!
  expect(JSON.stringify(final.messages)).toContain("CONTEXT_HANDOFF_READY")
  expect(
    final.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.tool_call_id)
  ).toEqual(["read-3"])
  expect(JSON.stringify(final.messages)).not.toContain("EVIDENCE_1")
  expect(JSON.stringify(final.messages)).not.toContain("EVIDENCE_2")
  const saved = await new BotCheckpointSaver(f.store, run.lease, f.runId).getTuple({
    configurable: { thread_id: f.runId }
  })
  expect(JSON.stringify(saved?.checkpoint.channel_values)).toContain(
    "bounded-project-evidence ".repeat(700)
  )
})

it("resumes a compacted checkpoint with the original effect receipt and a fresh pending approval", async () => {
  let steps = 0
  const f = await fixture(
    (body) => {
      if (isSummary(body)) return { content: handoff }
      if (++steps <= 2)
        return call(`edit-${steps}`, "project_edit", {
          path: `change-${steps}.txt`,
          expected_sha256: null,
          content: `APPROVED_CHANGE_${steps}`
        })
      if (steps === 3)
        return call("read-after-restart", "read_task_history", {
          message: 0,
          offset: 3000,
          limit: 128
        })
      return { content: "BOTH_APPROVED_CHANGES_COMPLETE" }
    },
    { project: true, task: `Review this evidence.\n${"source-evidence-724 ".repeat(3100)}` }
  )
  const first = f.start("before-restart")
  const pending = () => f.store.snapshot().interactions.find((item) => item.status === "pending")
  await until(() => Boolean(pending()))
  const approved = pending()!
  f.store.answerInteraction({ id: approved.id, revision: approved.revision, answer: "approve" })
  await until(() => Boolean(pending()))
  const interrupted = pending()!
  const completed = f.store.effects(f.runId).filter((effect) => effect.status === "succeeded")
  expect(completed).toHaveLength(1)
  expect(f.requests.filter(isSummary)).toHaveLength(1)
  f.store.fenceOwner(first.lease.owner, "Simulated executor replacement after checkpoint")
  first.controller.abort(new Error("executor replaced"))
  await expect(first.completion).rejects.toThrow()
  const suspended = f.store.getRun(f.runId)
  expect(suspended.checkpoint).not.toBeNull()
  expect(suspended.status).toBe("needs_review")
  f.store.recover({
    id: f.runId,
    revision: suspended.revision,
    decision: "resume",
    note: "Confirmed pending edit did not execute",
    effects: []
  })
  const resumed = f.start("after-restart")
  await until(() => Boolean(pending()))
  const next = pending()!
  expect(next.id).not.toBe(interrupted.id)
  expect(JSON.parse(next.prompt).project.path).toBe("change-2.txt")
  expect(f.store.effects(f.runId).filter((effect) => effect.status === "succeeded")).toEqual(
    completed
  )
  f.store.answerInteraction({ id: next.id, revision: next.revision, answer: "approve" })
  expect(await resumed.completion).toBe("BOTH_APPROVED_CHANGES_COMPLETE")
  expect(f.requests.filter(isSummary)).toHaveLength(1)
  expect(steps).toBe(4)
  const recovered = f.requests
    .at(-1)!
    .messages.find((message) => message.tool_call_id === "read-after-restart")
  expect(String(recovered?.content)).toContain("source-evidence-724")
  expect(f.store.effects(f.runId).filter((effect) => effect.status === "succeeded")).toHaveLength(2)
  expect(
    f.store
      .events()
      .filter((event) => event.entityId === f.runId && event.kind === "run.checkpoint").length
  ).toBeGreaterThan(4)
  expect(
    f.store.db.exec("SELECT COUNT(*) FROM bot_graph_checkpoints WHERE thread_id=?", [f.runId])[0]
      .values[0][0]
  ).toBeLessThanOrEqual(4)
})
