import { afterEach, expect, it } from "vitest"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { BotTeachService } from "./teach-service"
import { LocalBotComputerProvider } from "./computer-provider"
import { CmbBotRuntime } from "./agent-runtime"
import { BotHost } from "./host"
import { writeBotModelSnapshot } from "./model-config"
import { testModelRequest, type TestModelRequest } from "./test-model-protocol"
import { avatarImage } from "./image-fixtures"
import { BOT_TEACH_LEARNING_PROMPT } from "./teach-tools"
import { BOT_MAX_COMPLETION_REPAIRS } from "./completion-repair"

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
const call = (id: string, name: string, args: unknown) => ({
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
})
async function fixture(
  respond: (body: TestModelRequest) => Record<string, unknown> | Promise<Record<string, unknown>>
) {
  const requests: TestModelRequest[] = []
  const providerErrors: unknown[] = []
  cleanup.push(() => expect(providerErrors).toEqual([]))
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const body = testModelRequest.parse(JSON.parse(Buffer.concat(chunks).toString()))
    requests.push(body)
    let message: Record<string, unknown>
    try {
      message = await respond(body)
    } catch (error) {
      providerErrors.push(error)
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { message: "Fixture assertion failed" } }))
      return
    }
    const calls = (message.tool_calls as Record<string, unknown>[] | undefined)?.map(
      (c, index) => ({
        ...c,
        index
      })
    )
    res.setHeader("Content-Type", "text/event-stream")
    const id = `chatcmpl-${requests.length}`
    for (const [delta, finish] of [
      [
        { role: "assistant", ...(calls ? { tool_calls: calls } : { content: message.content }) },
        null
      ],
      [{}, calls ? "tool_calls" : "stop"]
    ])
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "test-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      )
    res.end("data: [DONE]\n\n")
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  )
  const directory = await mkdtemp(join(tmpdir(), "bot-completion-runtime-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const modelFile = join(directory, "models.private")
  const address = server.address() as { port: number }
  await writeBotModelSnapshot(modelFile, {
    version: 1,
    defaultRef: "test",
    models: [
      {
        ref: "test",
        id: "test",
        name: "Test",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "fixture-only"
      }
    ]
  })
  const store = new BotStore(join(directory, "bots.sqlite"))
  cleanup.push(() => store.close())
  const computer = new LocalBotComputerProvider(join(directory, "browser"))
  cleanup.push(() => computer.close())
  const files = new BotArtifacts(join(directory, "objects"), store)
  await files.recover()
  cleanup.push(() => files.close())
  const teach = new BotTeachService(join(directory, "teach"), store, computer)
  cleanup.push(() => teach.close())
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "Worker" })
  const createHost = () => {
    const host = new BotHost(store, new CmbBotRuntime(modelFile, computer, { teach, files }))
    cleanup.push(() => host.stop())
    return host
  }
  const host = createHost()
  async function recording() {
    let session = teach.repository.create({ nonce: "recording", botId: bot.id, conversationId })
    await mkdir(join(directory, "teach", session.id), { recursive: true })
    const bytes = Buffer.from(await avatarImage(), "base64")
    for (let index = 0; index < 5; index++) {
      await writeFile(join(directory, "teach", session.id, `${index}.jpg`), bytes)
      teach.repository.addFrame(session.id, {
        at: index * 100,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        url: "http://example.test/fixture",
        title: "Synthetic demonstration"
      })
    }
    session = teach.repository.get(session.id)
    session = teach.repository.update(session.id, session.revision, "finalizing")
    teach.repository.update(session.id, session.revision, "queued")
    return teach.repository.queue(session.id)
  }
  return {
    store,
    bot,
    conversationId,
    files,
    teach,
    computer,
    host,
    createHost,
    requests,
    recording
  }
}
async function terminal(store: BotStore, runId: string) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const run = store.getRun(runId)
    if (["succeeded", "failed", "needs_review", "cancelled"].includes(run.status)) return run
    await delay(20)
  }
  throw new Error(`Task did not settle: ${JSON.stringify(store.getRun(runId))}`)
}

it.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")(
  "resumes the original graph after human review of a rejected select fill without repeating that call",
  async () => {
    let phase = 0
    const f = await fixture((body) => {
      phase++
      if (phase === 1)
        return call("bad-select-fill", "browser", {
          op: "fill",
          arguments_json: '{"ref":"e1","value":"west"}'
        })
      if (phase === 2) {
        const result = body.messages.find(
          (message) => message.role === "tool" && message.tool_call_id === "bad-select-fill"
        )
        expect(String(result?.content)).toContain("Human review confirmed")
        expect(String(result?.content)).toContain("NOT been repeated")
        return call("fresh-select-observation", "browser", { op: "snapshot", arguments_json: "{}" })
      }
      if (phase === 3)
        return call("new-select-operation", "browser", {
          op: "select_option",
          arguments_json: '{"ref":"e1","values":["west"]}'
        })
      if (phase === 4)
        return call("verify-new-selection", "browser", { op: "snapshot", arguments_json: "{}" })
      const result = body.messages.find(
        (message) => message.role === "tool" && message.tool_call_id === "verify-new-selection"
      )
      expect(JSON.parse(String(result?.content)).data).toContain('"value":"west","label":"West"')
      return { content: "The current page selection is West. The failed fill was not repeated." }
    })
    const broker = await f.computer.get()
    const initial = await broker.ensure(f.bot.id)
    const human = await broker.takeControl(initial)
    await broker.teachObserve(f.bot.id, (page) =>
      page.setContent(
        '<select aria-label="Region"><option value="">Choose</option><option value="west">West</option></select>'
      )
    )
    const target = await broker.releaseControl(human)
    await broker.act(target, { op: "snapshot" }, () => {})
    const sent = f.store.send({
      nonce: "reviewed-select-task",
      conversationId: f.conversationId,
      text: "Select West on the current synthetic page, verify the actual selection, and report the result."
    })
    const runId = sent.runIds[0]
    const approvePending = () => {
      const pending = f.store
        .snapshot()
        .interactions.filter(
          (item) => item.runId === runId && item.kind === "approval" && item.status === "pending"
        )
      for (const item of pending) {
        const action = JSON.parse(f.store.getInteraction(item.id).prompt) as {
          browser?: { op?: string }
          botId?: string
        }
        expect(["fill", "select_option"]).toContain(action.browser?.op)
        expect(action.botId).toBe(f.bot.id)
        f.store.answerInteraction({ id: item.id, revision: item.revision, answer: "approve" })
      }
    }
    const settle = async () => {
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        approvePending()
        const current = f.store.getRun(runId)
        if (["succeeded", "failed", "needs_review", "cancelled"].includes(current.status))
          return current
        await delay(20)
      }
      throw new Error("Original graph recovery did not settle")
    }
    f.host.start()
    const paused = await settle()
    expect(paused.status).toBe("needs_review")
    expect(paused.checkpoint).not.toBeNull()
    await f.host.stop()
    const unknown = f.store.effects(runId).filter((effect) => effect.status === "unknown")
    expect(unknown).toHaveLength(1)
    expect(unknown[0].id).toBe(`browser:${runId}:bad-select-fill`)
    f.store.recover({
      id: runId,
      revision: f.store.getRun(runId).revision,
      decision: "resume",
      note: "Continue the original goal after observing the current page.",
      effects: [
        {
          id: unknown[0].id,
          outcome: "failed",
          note: "The select fill was rejected before input; the form remains unchanged."
        }
      ]
    })
    f.createHost().start()
    expect(await settle()).toMatchObject({ id: runId, status: "succeeded" })
    expect(phase).toBe(5)
    expect(f.store.effects(runId)).toMatchObject([
      { id: `browser:${runId}:bad-select-fill`, status: "failed" },
      { id: `browser:${runId}:new-select-operation`, status: "succeeded" }
    ])
    const final = await broker.act(broker.target(f.bot.id), { op: "snapshot" }, () => {})
    expect(final.data).toContain('selected=[{"value":"west","label":"West"}]')
  },
  45_000
)

it("continues a premature learning acknowledgement in the same graph through every image page and a real saved skill", async () => {
  let phase = 0
  const f = await fixture((body) => {
    phase++
    if (phase === 1) return { content: "I will learn the demonstration." }
    if (phase === 2) {
      expect(JSON.stringify(body.messages)).toContain(
        "An acknowledgement does not complete learning"
      )
      const system = body.messages
        .filter((m) => m.role === "system")
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : m.content?.map((part) => part.text ?? "").join("\n")
        )
        .join("\n")
      expect(system).toContain(BOT_TEACH_LEARNING_PROMPT)
      expect(system).toContain("Shell execution, browser actions, project edits")
      expect(body.tools.map((t) => t.function.name)).not.toContain("browser")
      expect(body.tools.map((t) => t.function.name)).not.toContain("shell")
      expect(body.tools.map((t) => t.function.name)).not.toContain("project_edit")
      return call("read-first", "read_demonstration", { offset: 0 })
    }
    if (phase === 3) return call("read-last", "read_demonstration", { offset: 4 })
    if (phase === 4)
      return call("save", "save_taught_skill", {
        name: "Synthetic workflow",
        when_to_use: "When this observed workflow is requested",
        inputs: ["New period"],
        steps: ["Observe the current page and follow the recorded workflow"],
        decisions: "Ask when a recorded interval is missing",
        how_to_check: "Compare actual visible output with the requested inputs",
        what_to_return: "Actual output and verification status",
        approval_boundaries: "Existing approvals remain required",
        failure_handling: "Preserve the actual failure; do not retry uncertain actions"
      })
    return { content: "The skill is saved; a trial on new inputs has not been performed." }
  })
  const session = await f.recording()
  f.host.start()
  expect(await terminal(f.store, session.learningRunId!)).toMatchObject({ status: "succeeded" })
  expect(f.teach.repository.get(session.id)).toMatchObject({ phase: "ready" })
  expect(f.store.skills(f.bot.id)).toHaveLength(1)
  expect(f.store.skills(f.bot.id)[0].verified).toBe(false)
  expect(f.store.db.exec("SELECT count(*) FROM bot_teach_reads")[0].values[0][0]).toBe(5)
  expect(phase).toBe(5)
})

it("bounds repeated acknowledgements without falsely diagnosing vision or publishing a skill", async () => {
  const f = await fixture(() => ({ content: "I am starting to learn." }))
  const session = await f.recording()
  f.host.start()
  const run = await terminal(f.store, session.learningRunId!)
  expect(run).toMatchObject({ status: "failed", error: expect.stringContaining("仍未保存技能") })
  expect(run.error).not.toContain("图像理解")
  expect(f.requests).toHaveLength(BOT_MAX_COMPLETION_REPAIRS + 1)
  expect(f.store.skills(f.bot.id)).toEqual([])
  expect(f.teach.repository.get(session.id).skillId).toBeNull()
})

it("retains the repair budget and original learning run through a Host shutdown and checkpoint continuation", async () => {
  let phase = 0,
    release!: () => void,
    reached!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    reached = resolve
  })
  const f = await fixture(async () => {
    if (++phase === 2) {
      reached()
      await held
    }
    return { content: "I am starting to learn." }
  })
  cleanup.push(release)
  const session = await f.recording()
  const runId = session.learningRunId!
  f.host.start()
  await waiting
  await f.host.stop()
  const paused = f.store.getRun(runId)
  expect(paused).toMatchObject({ status: "needs_review", checkpoint: expect.any(String) })
  release()
  f.store.recover({
    id: runId,
    revision: paused.revision,
    decision: "resume",
    note: "Continue reading this recording; no external actions were performed.",
    effects: []
  })
  f.createHost().start()
  expect(await terminal(f.store, runId)).toMatchObject({
    status: "failed",
    error: expect.stringContaining("仍未保存技能")
  })
  expect(phase).toBe(BOT_MAX_COMPLETION_REPAIRS + 2)
  expect(
    f.store.db.exec("SELECT count(*) FROM bot_receipts WHERE nonce LIKE ?", [
      `tool:${runId}:completion-repair:%`
    ])[0].values[0][0]
  ).toBe(BOT_MAX_COMPLETION_REPAIRS)
  expect(f.teach.repository.get(session.id).learningRunId).toBe(runId)
  expect(f.store.skills(f.bot.id)).toEqual([])
}, 30_000)

it.each(["existing", "generate"])(
  "revalidates an unchanged published file after accepted human steering (%s)",
  async (mode) => {
    let phase = 0,
      reviews = 0,
      originalId = "",
      release!: () => void,
      reached!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      reached = resolve
    })
    const f = await fixture(async (body) => {
      if (body.tools.some((tool) => tool.function.name === "delivery_evidence_verdict")) {
        reviews++
        return call(`review-${reviews}`, "delivery_evidence_verdict", {
          decision: "pass",
          finding: "The original rows and requested selection agree."
        })
      }
      phase++
      if (phase === 4 && mode === "existing")
        return call("deliver-current-original", "deliver_file", { file_id: originalId })
      if (phase === 1 || phase === 4)
        return call(`deliver-${phase}`, "deliver_file", {
          name: "result.csv",
          content: "id,amount\nQ,3\n"
        })
      if (phase === 2) {
        originalId = JSON.parse(
          String(body.messages.findLast((m) => m.role === "tool")!.content)
        ).id
        reached()
        await held
      }
      if (phase === 3) return { content: "All files are delivered." }
      return {
        content: "The unchanged original has been checked against the current requirements."
      }
    })
    cleanup.push(release)
    const original = await f.files.publish(
      {
        id: "source",
        conversationId: f.conversationId,
        runId: null,
        name: "records.csv",
        mime: "text/csv"
      },
      Buffer.from("id,version,amount\nQ,1,9\nQ,2,3\n")
    )
    const sent = f.store.send({
      nonce: "task",
      conversationId: f.conversationId,
      text: "Choose the largest numeric version for each id and produce result.csv.",
      attachments: [original.id]
    })
    f.host.start()
    await waiting
    const oldTask = f.store.deliveryEvidence.task(sent.runIds[0])!.key
    f.store.send({
      nonce: "steer",
      conversationId: f.conversationId,
      steerRunId: sent.runIds[0],
      text: "Keep the amount's original sign; recheck all required files."
    })
    release()
    const result = await terminal(f.store, sent.runIds[0])
    expect(result).toMatchObject({ status: "succeeded" })
    expect(f.store.deliveryEvidence.task(result.id)!.key).not.toBe(oldTask)
    expect(reviews).toBe(2)
    expect(
      f.requests.some((r) => JSON.stringify(r.messages).includes("Delivery is incomplete"))
    ).toBe(true)
    const outputs = f.store.artifacts(f.conversationId).filter((a) => a.name === "result.csv")
    expect(outputs).toHaveLength(mode === "existing" ? 1 : 2)
    expect(outputs.map((artifact) => artifact.id)).toContain(originalId)
    for (const artifact of outputs)
      expect((await f.files.read(artifact.id)).bytes.toString()).toBe("id,amount\nQ,3\n")
    expect(f.store.effects(result.id)).toEqual([])
  }
)
