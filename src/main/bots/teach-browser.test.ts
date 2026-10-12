import { testModelRequest, type TestModelRequest } from "./test-model-protocol"
import type { Page } from "playwright"
import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { LocalBotComputerProvider } from "./computer-provider"
import { BotTeachService } from "./teach-service"
import { BotTeachVideo } from "./teach-video"
import { BotStore } from "./store"
import type { BotHumanInput } from "../../shared/bot-computer"
import { CmbBotRuntime } from "./agent-runtime"
import { BotHost } from "./host"
import { BotArtifacts } from "./artifacts"
import { writeBotModelSnapshot } from "./model-config"

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function until(test: () => boolean) {
  const deadline = Date.now() + 12000
  while (!test()) {
    if (Date.now() > deadline) throw new Error("Teach did not reach expected state")
    await delay(50)
  }
}
async function fixture(preserveEvidence = false) {
  const directory = await mkdtemp(join(tmpdir(), "cmb-teach-test-"))
  cleanup.push(() =>
    preserveEvidence ? Promise.resolve() : rm(directory, { recursive: true, force: true })
  )
  const modelRequests: TestModelRequest[] = []
  const stageObservations: { phase: string; runId: string; texts: string[] }[] = []
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/chat/completions") {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      const body = testModelRequest.parse(JSON.parse(Buffer.concat(chunks).toString()))
      modelRequests.push(body)
      const system = body.messages.find((message) => message.role === "system")?.content
      const session_id = JSON.stringify(system).match(/Assigned recording: ([\w-]+)/)![1]
      const toolResults = body.messages.filter((message) => message.role === "tool")
      const last = toolResults.at(-1)
      const parsed =
        last &&
        JSON.parse(
          typeof last.content === "string"
            ? last.content
            : (last.content?.find((part) => part.type === "text")?.text ?? "null")
        )
      const progressAllowed = body.tools.some((item) => item.function.name === "send_message")
      const progressReceipts = toolResults.filter((message) => {
        if (typeof message.content !== "string") return false
        const value = JSON.parse(message.content)
        return value.messageId !== undefined && value.runId !== undefined
      }).length
      const recording = teach.repository.get(session_id)
      if (progressAllowed)
        stageObservations.push({
          phase: recording.phase,
          runId: recording.learningRunId!,
          texts: store
            .messages(recording.conversationId, undefined, 100, undefined, recording.threadRootId)
            .filter(
              (message) => message.sender === "bot" && message.runId === recording.learningRunId
            )
            .map((message) => message.text)
        })
      const done = progressAllowed
        ? parsed?.messageId !== undefined && progressReceipts === 3
        : parsed?.instructions !== undefined
      let name: string, args: Record<string, unknown>
      if (progressAllowed && !last) {
        name = "send_message"
        args = { content: "收到，正在看录像。" }
      } else if (progressAllowed && parsed?.instructions !== undefined) {
        name = "send_message"
        args = { content: "已学会并保存为技能，尚未试跑。" }
      } else if (
        !last ||
        parsed.nextOffset != null ||
        (parsed.messageId !== undefined && progressReceipts === 1)
      ) {
        name = "read_demonstration"
        args = { session_id, offset: parsed?.nextOffset ?? 0 }
      } else if (progressAllowed && progressReceipts === 1) {
        name = "send_message"
        args = { content: "录像已看完，正在核对操作记录。" }
      } else {
        name = "save_taught_skill"
        args = {
          session_id,
          name: "整理订单",
          when_to_use: "用户要求整理指定订单时",
          inputs: ["订单编号"],
          steps: ["找到订单输入框，填写用户给出的编号", "点击整理并检查输出记录"],
          decisions: "如果没有匹配订单则向用户确认编号",
          how_to_check: "输出区的订单编号与输入一致",
          what_to_return: "整理后的订单记录",
          approval_boundaries: "外部提交前获得用户批准",
          failure_handling: "保留错误和现场，询问缺失信息后继续"
        }
      }
      const delta = done
        ? { role: "assistant", content: "已根据示范保存技能，尚未试跑。" }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `teach-call-${modelRequests.length}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) }
              }
            ]
          }
      response.setHeader("Content-Type", "text/event-stream")
      for (const [content, finish] of [
        [delta, null],
        [{}, done ? "stop" : "tool_calls"]
      ])
        response.write(
          `data: ${JSON.stringify({ id: `teach-model-${modelRequests.length}`, object: "chat.completion.chunk", created: 1, model: "fixture-vision", choices: [{ index: 0, delta: content, finish_reason: finish }] })}\n\n`
        )
      response.end("data: [DONE]\n\n")
      return
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    response.end(
      request.url === "/secret"
        ? '<input type="password" aria-label="Password">'
        : "<title>订单整理</title><input aria-label=\"Order\"><button onclick=\"document.querySelector('output').textContent=document.querySelector('input').value\">整理</button><output></output>"
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  const store = new BotStore(join(directory, "state.sqlite"))
  cleanup.push(() => store.close())
  const computer = new LocalBotComputerProvider(join(directory, "browser"))
  cleanup.push(() => computer.close())
  const teach = new BotTeachService(join(directory, "teach"), store, computer)
  cleanup.push(() => teach.close())
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "订单助手" })
  const broker = await computer.get(),
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  let target = await broker.ensure(bot.id)
  target = (await broker.act(target, { op: "navigate", url }, () => {})).target
  const input = async (value: Omit<BotHumanInput, "frameSeq">) => {
    const frame = await broker.frame(bot.id)
    await broker.humanInput(frame, { ...value, frameSeq: frame.frameSeq })
  }
  return {
    directory,
    store,
    computer,
    teach,
    bot,
    conversationId,
    broker,
    target,
    url,
    input,
    modelRequests,
    stageObservations
  }
}

describe.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")("native browser Teach", () => {
  it("sends actual recorded images through the Cmb model adapter and atomically saves the taught skill", async () => {
    const f = await fixture()
    const session = await f.teach.start({
      botId: f.bot.id,
      conversationId: f.conversationId,
      nonce: "start",
      target: f.target
    })
    await until(() => f.teach.repository.get(session.id).frameCount > 0)
    await f.input({ kind: "click", x: 65, y: 17 })
    await f.input({ kind: "text", text: "ORD-NEW" })
    await f.input({ kind: "click", x: 230, y: 17 })
    const saved = await f.teach.stop({ id: session.id, save: true })
    expect(saved.phase).toBe("learning")
    const modelFile = join(f.directory, "models.private")
    await writeBotModelSnapshot(modelFile, {
      version: 1,
      defaultRef: "vision",
      models: [
        {
          id: "vision",
          ref: "vision",
          name: "Vision fixture",
          model: "fixture-vision",
          baseUrl: `${f.url}/v1`,
          apiKey: "test-only",
          maxTokens: 32000
        }
      ]
    })
    const files = new BotArtifacts(join(f.directory, "objects"), f.store)
    const host = new BotHost(
      f.store,
      new CmbBotRuntime(modelFile, f.computer, { files, teach: f.teach })
    )
    cleanup.push(() => host.stop())
    host.start()
    await until(() => ["succeeded", "failed"].includes(f.store.getRun(saved.learningRunId!).status))
    expect(f.store.getRun(saved.learningRunId!)).toMatchObject({
      status: "succeeded",
      result: "已根据示范保存技能，尚未试跑。"
    })
    expect(f.teach.status(f.bot.id)?.phase).toBe("ready")
    expect(f.store.skills(f.bot.id)).toHaveLength(1)
    expect(f.store.skills(f.bot.id)[0]).toMatchObject({
      name: "整理订单",
      verified: false,
      enabled: true
    })
    expect(f.store.skills(f.bot.id)[0].instructions).toContain("用户给出的编号")
    expect(
      f.store
        .messages(f.conversationId)
        .filter((message) => message.sender === "bot")
        .map((message) => message.text)
    ).toEqual([
      "收到，正在看录像。",
      "录像已看完，正在核对操作记录。",
      "已学会并保存为技能，尚未试跑。",
      "已根据示范保存技能，尚未试跑。"
    ])
    expect(f.stageObservations).toContainEqual({
      phase: "learning",
      runId: saved.learningRunId,
      texts: ["收到，正在看录像。"]
    })
    expect(f.stageObservations).toContainEqual({
      phase: "ready",
      runId: saved.learningRunId,
      texts: [
        "收到，正在看录像。",
        "录像已看完，正在核对操作记录。",
        "已学会并保存为技能，尚未试跑。"
      ]
    })
    expect(f.store.db.exec("SELECT COUNT(*) FROM bot_runs")[0].values[0][0]).toBe(1)
    const reads = f.store.db.prepare(
      "SELECT COUNT(*) AS count FROM bot_teach_reads WHERE run_id=?",
      [saved.learningRunId!]
    )
    try {
      reads.step()
      expect(reads.getAsObject().count).toBe(saved.frameCount)
    } finally {
      reads.free()
    }
    expect(JSON.stringify(f.modelRequests)).toContain("data:image/jpeg;base64,")
    expect(f.modelRequests[0].tools.map((item) => item.function.name).sort()).toEqual([
      "ask_user",
      "read_demonstration",
      "read_task_history",
      "request_user_input",
      "save_taught_skill",
      "send_message"
    ])
    expect(JSON.stringify(f.modelRequests[0].messages[0].content)).toContain(
      "not permission to repeat"
    )
    expect(JSON.stringify(f.modelRequests[0].messages[0].content)).toContain(
      `Assigned recording: ${saved.id}`
    )
    expect(f.modelRequests[0].messages.filter((message) => message.role === "user")).toContainEqual(
      expect.objectContaining({
        content: "示范已保存，请把刚才的操作整理成可复用技能，并说明适用场景和验收方法。"
      })
    )
  }, 30000)
  it("learns from the selected group branch with no project or private-memory grant and leaves the original discussion intact", async () => {
    const f = await fixture(true)
    const other = f.store.createBot({ nonce: "other", name: "讨论成员" })
    const group = f.store.createGroup({
      nonce: "group",
      name: "项目群",
      members: [f.bot.id, other.bot.id]
    })
    const discussion = f.store.send({
      nonce: "discussion",
      conversationId: group.id,
      text: "继续原群讨论",
      recipients: [other.bot.id]
    })
    const held = f.store.claim("original-discussion-owner", 300_000)!
    expect(held.run.botId).toBe(other.bot.id)
    const originalCycle = JSON.stringify(f.store.db.exec("SELECT * FROM bot_group_cycles"))
    const project = join(f.directory, "private-project")
    await mkdir(project)
    await writeFile(join(project, "AGENTS.md"), "PRIVATE_PROJECT_INSTRUCTIONS_MUST_NOT_BE_READ")
    f.store.updateBot({ id: f.bot.id, revision: f.bot.revision, workspacePath: project })
    f.store.saveMemory({
      botId: f.bot.id,
      nonce: "private-memory",
      expectedDataEpoch: f.store.dataEpoch(),
      text: "PRIVATE_DIRECT_MEMORY_MUST_NOT_ENTER_GROUP_LEARNING"
    })
    const session = await f.teach.start({
      botId: f.bot.id,
      conversationId: group.id,
      conversationRevision: group.revision,
      expectedDataEpoch: f.store.dataEpoch(),
      threadRootId: discussion.messageId,
      nonce: "start",
      target: f.target
    })
    await until(() => f.teach.repository.get(session.id).frameCount > 0)
    await f.input({ kind: "click", x: 65, y: 17 })
    await f.input({ kind: "text", text: "ORD-NEW" })
    await f.input({ kind: "click", x: 230, y: 17 })
    const saved = await f.teach.stop({ id: session.id, save: true })
    expect(saved.phase).toBe("learning")
    expect(f.store.getRun(saved.learningRunId!)).toMatchObject({
      botId: f.bot.id,
      conversationId: group.id,
      threadRootId: discussion.messageId,
      lane: "user",
      source: "teach-learning"
    })
    expect(JSON.stringify(f.store.db.exec("SELECT * FROM bot_group_cycles"))).toBe(originalCycle)
    const modelFile = join(f.directory, "models.private")
    await writeBotModelSnapshot(modelFile, {
      version: 1,
      defaultRef: "vision",
      models: [
        {
          id: "vision",
          ref: "vision",
          name: "Vision fixture",
          model: "fixture-vision",
          baseUrl: `${f.url}/v1`,
          apiKey: "test-only",
          maxTokens: 32000
        }
      ]
    })
    const files = new BotArtifacts(join(f.directory, "objects"), f.store)
    const host = new BotHost(
      f.store,
      new CmbBotRuntime(modelFile, f.computer, { files, teach: f.teach })
    )
    cleanup.push(() => host.stop())
    host.start()
    await until(() => ["succeeded", "failed"].includes(f.store.getRun(saved.learningRunId!).status))
    expect(f.store.getRun(saved.learningRunId!)).toMatchObject({
      status: "succeeded",
      result: "已根据示范保存技能，尚未试跑。"
    })
    expect(f.teach.status(f.bot.id)?.phase).toBe("ready")
    expect(f.store.skills(f.bot.id)).toHaveLength(1)
    expect(f.store.skills(f.bot.id)[0]).toMatchObject({
      name: "整理订单",
      verified: false,
      enabled: true
    })
    expect(f.store.skills(f.bot.id)[0].instructions).toContain("用户给出的编号")
    expect(JSON.stringify(f.modelRequests)).toContain("data:image/jpeg;base64,")
    expect(f.modelRequests[0].tools.map((item) => item.function.name).sort()).toEqual([
      "ask_user",
      "read_demonstration",
      "read_task_history",
      "request_user_input",
      "save_taught_skill"
    ])
    expect(JSON.stringify(f.modelRequests[0].messages[0].content)).toContain(
      "not permission to repeat"
    )
    expect(JSON.stringify(f.modelRequests[0].messages[0].content)).toContain(
      `Assigned recording: ${saved.id}`
    )
    expect(f.modelRequests[0].messages.filter((message) => message.role === "user")).toContainEqual(
      expect.objectContaining({
        content: "示范已保存，请把刚才的操作整理成可复用技能，并说明适用场景和验收方法。"
      })
    )
    expect(JSON.stringify(f.modelRequests)).not.toContain(
      "PRIVATE_PROJECT_INSTRUCTIONS_MUST_NOT_BE_READ"
    )
    expect(JSON.stringify(f.modelRequests)).not.toContain(
      "PRIVATE_DIRECT_MEMORY_MUST_NOT_ENTER_GROUP_LEARNING"
    )
    expect(f.store.db.exec("SELECT * FROM bot_local_tool_requests")[0]?.values ?? []).toEqual([])
    expect(JSON.stringify(f.store.db.exec("SELECT * FROM bot_group_cycles"))).toBe(originalCycle)
    expect(f.store.getRun(held.run.id).status).toBe("running")
    expect(
      f.store
        .messages(group.id, undefined, 100, undefined, discussion.messageId)
        .some(
          (message) =>
            message.runId === saved.learningRunId &&
            message.text === "已根据示范保存技能，尚未试跑。"
        )
    ).toBe(true)
  }, 30000)
  it("refuses a late real video pause acknowledgement after the workspace epoch changes", async () => {
    const f = await fixture(true)
    const session = await f.teach.start({
      botId: f.bot.id,
      conversationId: f.conversationId,
      expectedDataEpoch: f.store.dataEpoch(),
      conversationRevision: f.store.getConversation(f.conversationId).revision,
      nonce: "start",
      target: f.target
    })
    await until(() => f.teach.repository.get(session.id).frameCount > 0)
    let entered!: () => void, release!: () => void
    const pausedVideo = new Promise<void>((resolve) => (entered = resolve)),
      held = new Promise<void>((resolve) => (release = resolve))
    const original = BotTeachVideo.prototype.pause
    let encoder: Page | undefined
    BotTeachVideo.prototype.pause = async function (paused) {
      encoder = Reflect.get(this, "page") as Page
      await original.call(this, paused)
      entered()
      await held
    }
    try {
      const request = f.teach.pause({ id: session.id, paused: true })
      const settled = request.then(
        (value) => ({ value }),
        (error) => ({ error })
      )
      await pausedVideo
      const before = f.teach.repository.get(session.id)
      f.store.db.run(
        "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','replacement','{}',?)",
        [f.store.now()]
      )
      release()
      const result = await settled
      expect(result).toMatchObject({ error: expect.objectContaining({ code: "data_epoch" }) })
      expect(f.teach.repository.get(session.id)).toEqual(before)
      await until(() => encoder?.isClosed() === true && f.broker.teachRecordingBot === undefined)
      await delay(250)
      expect(f.teach.repository.get(session.id)).toEqual(before)
      expect(f.broker.humanObserver).toBeUndefined()
    } finally {
      release()
      BotTeachVideo.prototype.pause = original
    }
  }, 30000)
  it("records real browser video and actions, queues learning once and preserves input ownership", async () => {
    const f = await fixture()
    const session = await f.teach.start({
      botId: f.bot.id,
      conversationId: f.conversationId,
      nonce: "start",
      target: f.target
    })
    expect(session.phase).toBe("recording")
    expect(
      (
        await f.teach.start({
          botId: f.bot.id,
          conversationId: f.conversationId,
          nonce: "start",
          target: f.target
        })
      ).id
    ).toBe(session.id)
    await until(() => f.teach.repository.get(session.id).frameCount > 0)
    await expect(f.broker.releaseControl(f.broker.target(f.bot.id))).rejects.toThrow("先保存")
    await expect(f.input({ kind: "click", x: 99999, y: 18 })).rejects.toThrow("横坐标")
    const uncertain = f.teach.repository
      .events(session.id)
      .filter((event) => event.details.outcome === "unconfirmed")
    expect(uncertain).toHaveLength(1)
    await f.input({ kind: "click", x: 70, y: 18 })
    await f.input({ kind: "text", text: "ORD-001" })
    await f.input({ kind: "click", x: 230, y: 18 })
    const saved = await f.teach.stop({ id: session.id, save: true })
    expect(saved.phase, saved.error ?? "").toBe("learning")
    expect(saved.video?.size).toBeGreaterThan(100)
    const video = await readFile(join(f.directory, "teach", session.id, "video.webm"))
    expect(video.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    const playback = await f.broker.teachEncoderPage()
    try {
      await playback.setContent("<video muted></video>")
      const dimensions = await playback.evaluate(
        async (source) => {
          const element = document.querySelector("video")!
          element.src = source
          await new Promise<void>((resolve, reject) => {
            element.onloadeddata = () => resolve()
            element.onerror = () => reject(new Error("video decode failed"))
          })
          return { width: element.videoWidth, height: element.videoHeight }
        },
        `data:video/webm;base64,${video.toString("base64")}`
      )
      expect(dimensions).toEqual({ width: 1280, height: 800 })
    } finally {
      await playback.close()
    }
    expect((await f.teach.stop({ id: session.id, save: true })).learningRunId).toBe(
      saved.learningRunId
    )
    expect(f.store.snapshot().runs).toHaveLength(1)
    const claim = f.store.claim("host")!
    const observed = await f.teach.readFrames(session.id, 0, claim.lease)
    expect(observed.frames[0].image).toMatch(/^data:image\/jpeg;base64,/)
    expect(
      f.teach.repository.events(session.id).some((event) => event.details.text === "ORD-001")
    ).toBe(true)
    await f.broker.releaseControl(f.broker.target(f.bot.id))
  }, 30000)

  it("pauses all capture channels for credentials and discards without queuing a task", async () => {
    const f = await fixture()
    const session = await f.teach.start({
      botId: f.bot.id,
      conversationId: f.conversationId,
      nonce: "start",
      target: f.target
    })
    await until(() => f.teach.repository.get(session.id).frameCount > 0)
    await f.input({ kind: "navigate", url: `${f.url}/secret` })
    expect(f.teach.repository.get(session.id).phase).toBe("paused")
    const before = f.teach.repository.get(session.id).frameCount
    await f.input({ kind: "click", x: 60, y: 16 })
    await f.input({ kind: "text", text: "NEVER_CAPTURE_THIS_SECRET" })
    await delay(450)
    expect(f.teach.repository.get(session.id).frameCount).toBe(before)
    expect(JSON.stringify(f.teach.repository.events(session.id))).not.toContain("NEVER_CAPTURE")
    const discarded = await f.teach.stop({ id: session.id, save: false })
    expect(discarded.phase).toBe("discarded")
    expect(f.store.snapshot().runs).toHaveLength(0)
    await expect(
      readFile(join(f.directory, "teach", session.id, "video.pending"))
    ).rejects.toThrow()
  }, 30000)
})
