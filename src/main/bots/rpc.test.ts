import { BotDomainError } from "../../shared/bot-types"
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { createConnection } from "node:net"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { BotDocumentReader } from "./document-reader"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import { BOT_FILE_CHUNK_BYTES } from "../../shared/bot-files"
import { BotHost } from "./host"
import { BotWebhookServer } from "./webhook-server"
import { avatarImage } from "./image-fixtures"
import { BotRpcServer, encodeBotFrame } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { fetchBotMessagePage } from "../../renderer/src/lib/bot-message-fetch"
import type { NativeDesktopBroker } from "./native-desktop-broker"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(restart?: (server: BotRpcServer) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "cmb-bot-rpc-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = new BotStore(join(root, "state.sqlite")),
    host = new BotHost(
      store,
      undefined,
      4,
      undefined,
      new BotArtifacts(
        join(root, "objects"),
        store,
        new BotDocumentReader({
          entry: resolve("src/main/bots/document-worker-entry.ts"),
          execArgv: ["--import", "tsx"]
        })
      ),
      undefined,
      undefined,
      new BotDocumentReader({
        entry: resolve("src/main/bots/document-worker-entry.ts"),
        execArgv: ["--import", "tsx"]
      })
    )
  cleanup.push(() => store.close())
  const token = randomBytes(32).toString("hex")
  const path =
    process.platform === "win32"
      ? `\\\\.\\pipe\\test-bot-${token.slice(0, 16)}`
      : join(root, "s.sock")
  const server = new BotRpcServer(host, token, restart ? () => restart(server) : undefined)
  await server.listen(path)
  cleanup.push(() => server.close())
  const descriptor = { version: 1, pid: process.pid, hostId: host.id, socketPath: path, token }
  const client = new BotTransportClient(descriptor)
  cleanup.push(() => client.close())
  return { client, descriptor, store, host, server }
}
describe("authenticated Bot transport", () => {
  it("scopes optional introduction answers, preserves the exact receipt and does not dispatch an ignored question", async () => {
    const { client, store, host } = await fixture()
    const created = store.createBot({
      nonce: "opening",
      name: "核对助手",
      introduction: { language: "zh-CN" }
    })
    const task = store.claim("intro-host")!
    store.introductionQuestions.stage(task.lease, "choice", {
      questions: [{ id: "work", header: "工作", question: "先核对哪类材料？", options: [] }]
    })
    store.finish(task.lease, "succeeded", "你好！")
    const message = store
      .messages(created.conversationId)
      .find((item) => item.introductionQuestion)!
    const request = {
      runId: task.run.id,
      messageId: message.id,
      revision: 1,
      nonce: "ignore-once",
      dataEpoch: store.dataEpoch(),
      answer: '{"status":"cancelled","answers":{}}'
    }
    const tick = vi.spyOn(host, "tick")
    await expect(
      client.call("answerIntroductionQuestion", { ...request, dataEpoch: "other" })
    ).rejects.toMatchObject({ code: "data_epoch" })
    await expect(
      client.call("answerIntroductionQuestion", { ...request, messageId: task.run.messageId })
    ).rejects.toMatchObject({ code: "reply_unavailable" })
    const receipt = await client.call("answerIntroductionQuestion", request)
    expect(receipt.question).toMatchObject({ status: "skipped", revision: 2 })
    expect(receipt.send).toBeNull()
    expect(await client.call("answerIntroductionQuestion", request)).toEqual(receipt)
    expect(tick).not.toHaveBeenCalled()
    expect(store.messages(created.conversationId)).toHaveLength(2)
    expect((await client.call("status")).capabilities).toContain("bot-introduction-question-v1")
  })
  it.each(["nativeComputerSelect", "nativeComputerObserve"] as const)(
    "rejects %s before dispatch when the requesting client does not hold control",
    async (method) => {
      const { client, host, store } = await fixture()
      const { bot } = store.createBot({ nonce: "native-ownership", name: "Native owner" })
      const selectWindow = vi.fn(),
        observe = vi.fn()
      host.nativeComputer = {
        assertHumanClient: () => {
          throw new BotDomainError("computer_owned_elsewhere", "Another client holds control")
        },
        selectWindow,
        observe
      } as unknown as NativeDesktopBroker
      const target = {
        backend: "windows-native" as const,
        hostId: host.id,
        dataEpoch: store.dataEpoch(),
        botId: bot.id,
        generation: "83ce9e3f-0210-42bb-a9cd-656392f7a2aa",
        controlEpoch: 1,
        control: "human" as const,
        viewId: "e9f72cd7-4633-45b0-a006-c70f2308e54f"
      }
      const request =
        method === "nativeComputerSelect"
          ? client.call(method, { target, viewId: target.viewId })
          : client.call(method, target)
      await expect(request).rejects.toMatchObject({ code: "computer_owned_elsewhere" })
      expect(selectWindow).not.toHaveBeenCalled()
      expect(observe).not.toHaveBeenCalled()
    }
  )

  it("preserves safe diagnostic IDs across real RPC and serves revision-fenced error trays", async () => {
    const { client, host, store } = await fixture()
    host.reportFailure(
      {
        source: "memory",
        title: "整理失败",
        episodeId: "rpc-notice",
        dataEpoch: store.dataEpoch()
      },
      new BotDomainError("model_failed", "token=PRIVATE_CREDENTIAL", {
        code: "model_failed",
        status: 429,
        requestId: "rpc-provider",
        callId: "rpc-model-call"
      })
    )
    const snapshot = await client.call("getErrorTrays")
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]?.diagnostic).toMatchObject({
      status: 429,
      requestId: "rpc-provider",
      callId: "rpc-model-call"
    })
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_CREDENTIAL")
    const item = snapshot.items[0]!
    expect(
      (
        await client.call("dismissErrorTray", {
          hostId: snapshot.hostId,
          dataEpoch: snapshot.dataEpoch,
          id: item.id,
          revision: item.revision
        })
      ).items
    ).toEqual([])
    expect((await client.call("snapshot")).errorTrays?.items).toEqual([])
    const denied = vi.spyOn(store, "listBots").mockImplementation(() => {
      throw new BotDomainError("model_failed", "request rejected", {
        code: "model_failed",
        status: 429,
        requestId: "rpc-provider",
        callId: "rpc-model-call"
      })
    })
    const error = await client.call("snapshot").catch((failure: unknown) => failure)
    expect(error).toMatchObject({
      code: "model_failed",
      diagnostic: {
        requestId: "rpc-provider",
        callId: "rpc-model-call",
        correlationId: expect.any(String)
      }
    })
    denied.mockRestore()
  })
  it("rejects new RPC mutations after filesystem ownership fails without committing them", async () => {
    const { client, store, host } = await fixture()
    let lost = false
    const owner = {
      assertCurrent: () => {},
      checkCurrent: async () => {
        if (lost) throw new Error("filesystem owner changed")
      }
    }
    host.bindOwnership(owner)
    await client.call("create", { nonce: "before-owner-loss", name: "Accepted" })
    lost = true
    await expect(
      client.call("create", { nonce: "after-owner-loss", name: "Must not commit" })
    ).rejects.toMatchObject({ code: "host_ownership_lost" })
    expect(store.listBots().map((bot) => bot.name)).toEqual(["Accepted"])
    await expect(client.call("snapshot")).rejects.toMatchObject({ code: "host_ownership_lost" })
  })

  it("includes requests awaiting ownership checks in the existing eight-request RPC bound", async () => {
    const { client, store, host } = await fixture()
    let complete!: () => void
    const check = vi.fn(() => new Promise<void>((resolve) => (complete = resolve)))
    host.bindOwnership({ assertCurrent: () => {}, checkCurrent: check })
    const pending = Array.from({ length: 8 }, (_, index) =>
      client.call("create", { nonce: `ownership-wait-${index}`, name: `Bot ${index}` })
    )
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1))
    expect(store.listBots()).toEqual([])
    complete()
    expect(await Promise.all(pending)).toHaveLength(8)
    expect(store.listBots()).toHaveLength(8)
  })

  it("drains ownership checks and rejects their mutations after shutdown starts", async () => {
    const { client, store, host, server } = await fixture()
    await client.call("status")
    let release!: () => void
    const check = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
    host.bindOwnership({ assertCurrent: () => {}, checkCurrent: check })
    const request = client
      .call("create", { nonce: "shutdown-ownership", name: "Must not commit" })
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1))
    const ownership = host.checkOwnership()
    let closed = false
    const closing = server.close()
    void closing.then(() => (closed = true))
    const sameClosing = server.close() === closing
    const disconnected = await request
    const closedBeforeOwnership = closed
    release()
    await ownership
    await closing
    expect(disconnected).toMatchObject({ code: "host_disconnected" })
    expect.soft(sameClosing).toBe(true)
    expect.soft(closedBeforeOwnership).toBe(false)
    expect(store.listBots()).toEqual([])
  })

  it.each(["commit", "reject"] as const)(
    "drains an API already awaiting its connector before %s without replaying accepted work",
    async (outcome) => {
      const { client, host, store, server } = await fixture()
      const owner = await client.call("create", { nonce: "shutdown-owner", name: "Owner" })
      let release!: () => void
      const settled = new Promise<void>((resolve) => (release = resolve))
      const catalog = vi.spyOn(host, "connectors").mockImplementation(async () => {
        await settled
        if (outcome === "reject") throw new Error("Fixture connector failed")
        return [{ id: "project-notes", name: "项目资料", source: "connector" as const }]
      })
      const input = {
        nonce: "shutdown-send",
        conversationId: owner.conversationId,
        text: "Read the project notes",
        references: [{ kind: "connector" as const, id: "project-notes" }]
      }
      const request = client.call("send", input).catch((error: unknown) => error)
      await vi.waitFor(() => expect(catalog).toHaveBeenCalledTimes(1))
      let closed = false
      const closing = server.close()
      void closing.then(() => (closed = true))
      const sameClosing = server.close() === closing
      const disconnected = await request
      const closedBeforeConnector = closed
      release()
      await closing
      // Also observe the original connector on the baseline server, which can
      // finish closing before its admitted API. Its real Store write stays intact.
      await (catalog.mock.results[0].value as ReturnType<BotHost["connectors"]>).catch(() => {})
      expect(disconnected).toMatchObject({ code: "host_disconnected" })
      expect.soft(sameClosing).toBe(true)
      expect.soft(closedBeforeConnector).toBe(false)
      if (outcome === "commit") {
        const messages = store.messages(owner.conversationId),
          events = store.events(),
          receipt = store.send(input)
        expect(receipt.messageId).toBe(messages[0]?.id)
        expect(receipt.runIds).toHaveLength(1)
        expect(store.snapshot().runs).toHaveLength(1)
        expect(store.events()).toEqual(events)
      } else {
        expect(store.messages(owner.conversationId)).toEqual([])
        expect(store.snapshot().runs).toEqual([])
      }
      expect(catalog).toHaveBeenCalledTimes(1)
      catalog.mockRestore()
    }
  )

  it("drains file cleanup after its deletion receipt has already committed", async () => {
    const { client, host, store, server } = await fixture()
    const owner = await client.call("create", { nonce: "shutdown-file-owner", name: "Owner" })
    const file = await client.call("upload", {
      nonce: "shutdown-file",
      conversationId: owner.conversationId,
      name: "notes.txt",
      mime: "text/plain",
      base64: Buffer.from("Project notes").toString("base64")
    })
    const input = {
      nonce: "shutdown-file-delete",
      conversationId: owner.conversationId,
      id: file.id,
      sha256: file.sha256
    }
    let release!: () => void
    const settled = new Promise<void>((resolve) => (release = resolve)),
      collect = host.files!.collectDeleted.bind(host.files)
    const cleanupFiles = vi.spyOn(host.files!, "collectDeleted").mockImplementation(async () => {
      await settled
      await collect()
    })
    const request = client.call("deleteFile", input).catch((error: unknown) => error)
    await vi.waitFor(() => expect(cleanupFiles).toHaveBeenCalledTimes(1))
    const accepted = store.deleteArtifact(input),
      events = store.events()
    expect(store.artifacts(owner.conversationId)).toEqual([])
    let closed = false
    const closing = server.close()
    void closing.then(() => (closed = true))
    const disconnected = await request,
      closedBeforeCleanup = closed
    release()
    await closing
    await (cleanupFiles.mock.results[0].value as Promise<void>)
    expect(disconnected).toMatchObject({ code: "host_disconnected" })
    expect.soft(closedBeforeCleanup).toBe(false)
    expect(store.deleteArtifact(input)).toEqual(accepted)
    expect(store.events()).toEqual(events)
    expect(cleanupFiles).toHaveBeenCalledTimes(1)
    cleanupFiles.mockRestore()
  })

  it("aborts a disconnected client's decoder while draining its admitted avatar API", async () => {
    const { client, host, store, server } = await fixture()
    const { bot } = await client.call("create", { nonce: "shutdown-avatar-owner", name: "Owner" })
    let signal!: AbortSignal
    const decoder = vi.spyOn(host.mediaReader, "avatar").mockImplementation(
      (_base64, client) =>
        new Promise<string>((_resolve, reject) => {
          signal = client
          client.addEventListener("abort", () => reject(client.reason), { once: true })
        })
    )
    const request = client
      .call("changeAvatar", {
        nonce: "shutdown-avatar",
        botId: bot.id,
        revision: bot.revision,
        pngBase64: await avatarImage()
      })
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(decoder).toHaveBeenCalledTimes(1))
    await server.close()
    expect(await request).toMatchObject({ code: "host_disconnected" })
    expect(signal.aborted).toBe(true)
    expect(store.getBot(bot.id).revision).toBe(bot.revision)
    expect(
      store.db.exec("SELECT COUNT(*) FROM bot_receipts WHERE nonce='shutdown-avatar'")[0]?.values
    ).toEqual([[0]])
    decoder.mockRestore()
  })

  it("joins restart cleanup after its own response without draining itself forever", async () => {
    let restarts = 0
    const { client, host, server } = await fixture(async (listener) => {
      await listener.close()
      restarts++
    })
    expect(await client.restartIfIdle(host.id)).toEqual({ accepted: true, reason: null })
    await vi.waitFor(() => expect(restarts).toBe(1))
    await server.close()
    expect(restarts).toBe(1)
  })

  it("deletes a private skill through authenticated RPC with replayable CAS and rejected foreign inputs", async () => {
    const { client, store } = await fixture()
    const { bot } = await client.call("create", { nonce: "private-owner", name: "Owner" })
    const { bot: other } = await client.call("create", { nonce: "private-other", name: "Other" })
    const skill = await client.call("saveSkill", {
      botId: bot.id,
      name: "Workflow",
      instructions: "Read evidence",
      enabled: true
    })
    const input = { nonce: "delete-private", botId: bot.id, skillId: skill.id, version: 1 }
    expect((await client.call("status")).capabilities).toContain("private-skill-deletion")
    await expect(client.call("deleteSkill", { ...input, botId: other.id })).rejects.toThrow("属于")
    await expect(client.call("deleteSkill", { ...input, version: 2 })).rejects.toThrow("版本")
    const receipt = await client.call("deleteSkill", input)
    expect(await client.call("deleteSkill", input)).toEqual(receipt)
    expect(await client.call("skills", bot.id)).toEqual([])
    expect(store.skillVersion(bot.id, skill.id, 1).deletedAt).toBe(receipt.deletedAt)
    await expect(client.call("deleteSkill", { ...input, version: 2 })).rejects.toThrow("同一请求")
  })
  it("reports oversized history pages without disconnecting and reads every large body through adaptive paging", async () => {
    const { client, store, server } = await fixture()
    const { conversationId } = await client.call("create", {
      nonce: "large-body-bot",
      name: "History"
    })
    const body = "中".repeat(40_000)
    const ids = Array.from(
      { length: 120 },
      (_, index) =>
        store.send({ nonce: `large-body-${index}`, conversationId, text: `${index}:${body}` })
          .messageId
    )
    let reconnects = 0
    server.server.on("connection", () => reconnects++)
    await expect(client.call("messages", { conversationId, limit: 100 })).rejects.toMatchObject({
      code: "response_too_large"
    })
    const limits: number[] = []
    const read = (input: Parameters<typeof fetchBotMessagePage>[1]) => {
      limits.push(input.limit!)
      return client.call("messages", input)
    }
    const latest = await fetchBotMessagePage(read, { conversationId })
    expect(limits).toEqual([100, 50])
    expect(latest.messages).toHaveLength(50)
    let backward = latest.messages
    let before = backward[0].sequence
    for (;;) {
      const page = await fetchBotMessagePage(read, { conversationId, before })
      backward = [...page.messages, ...backward]
      if (page.messages.length < page.limit) break
      before = page.messages[0].sequence
    }
    expect(backward.map((message) => message.id)).toEqual(ids)
    expect(backward.map((message) => message.text)).toEqual(
      ids.map((_, index) => `${index}:${body}`)
    )
    const forward: string[] = []
    let after = 0
    for (;;) {
      const page = await fetchBotMessagePage(read, { conversationId, after })
      forward.push(...page.messages.map((message) => message.id))
      if (page.messages.length < page.limit) break
      after = page.messages.at(-1)!.sequence
    }
    expect(forward).toEqual(ids)
    expect((await client.call("status")).runtimeReady).toBe(false)
    expect(reconnects).toBe(0)
  })
  it("replays a recovery acknowledgement over a reconnected client and rejects changed decisions", async () => {
    const { client, descriptor, store } = await fixture()
    expect((await client.call("status")).capabilities).toContain("recovery-receipts")
    const { conversationId } = await client.call("create", {
      nonce: "recover-bot",
      name: "Recovery"
    })
    await client.call("send", { nonce: "recover-task", conversationId, text: "Verify" })
    const claimed = store.claim("interrupted-host")!
    expect(claimed).toBeTruthy()
    store.fenceOwner("interrupted-host", "Fixture interruption")
    const run = store.getRun(claimed.run.id)
    const input = {
      id: run.id,
      revision: run.revision,
      nonce: "recovery-command",
      dataEpoch: "initial",
      decision: "cancel" as const,
      note: "No external actions started",
      effects: []
    }
    const receipt = await client.call("recover", input)
    const events = store.events()
    client.close()
    const next = new BotTransportClient(descriptor)
    cleanup.push(() => next.close())
    expect(await next.call("recover", input)).toEqual(receipt)
    expect(store.events()).toEqual(events)
    await expect(next.call("recover", { ...input, decision: "resume" })).rejects.toMatchObject({
      code: "nonce_conflict"
    })
    await expect(next.call("recover", { ...input, dataEpoch: "old-data" })).rejects.toMatchObject({
      code: "data_epoch"
    })
    await expect(next.call("recover", { ...input, dataEpoch: undefined })).rejects.toMatchObject({
      code: "invalid_input"
    })
  })
  it("validates and replays scoped output budgets through the authenticated connection", async () => {
    const { client } = await fixture()
    expect((await client.call("status")).capabilities).toContain("usage-budgets")
    const { bot } = await client.call("create", { nonce: "budget-bot", name: "Budget" })
    const current = await client.call("usageBudget", { botId: bot.id })
    const input = {
      botId: bot.id,
      nonce: "save-budget",
      revision: current.revision,
      dataEpoch: current.dataEpoch,
      outputLimit: 100
    }
    const saved = await client.call("changeUsageBudget", input)
    expect(await client.call("changeUsageBudget", input)).toEqual(saved)
    expect(await client.call("usageBudget", { botId: bot.id })).toMatchObject({
      outputLimit: 100,
      revision: 1,
      available: 100
    })
    expect((await client.call("usageBudget", { botId: null })).outputLimit).toBeNull()
    await expect(
      client.call("changeUsageBudget", { ...input, nonce: "stale" })
    ).rejects.toMatchObject({ code: "revision_conflict" })
    await expect(
      client.call("usageBudget", { botId: bot.id, userId: "other" } as never)
    ).rejects.toMatchObject({ code: "invalid_input" })
    await expect(
      client.call("changeUsageBudget", { ...input, outputLimit: -1 })
    ).rejects.toMatchObject({ code: "invalid_input" })
  })
  it("queues bursts through one real connection without losing or repeating accepted sends", async () => {
    const { client, host, store } = await fixture()
    let active = 0,
      peak = 0
    const catalog = vi.spyOn(host, "connectors").mockImplementation(async () => {
      active++
      peak = Math.max(peak, active)
      try {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return [{ id: "project-notes", name: "项目资料", source: "connector" as const }]
      } finally {
        active--
      }
    })
    const a = await client.call("create", { nonce: "burst-owner", name: "Owner" })
    const inputs = Array.from({ length: 17 }, (_, index) => ({
      nonce: `burst-${index}`,
      conversationId: a.conversationId,
      text: `工作 ${index}`,
      references: [{ kind: "connector" as const, id: "project-notes" }]
    }))
    const receipts = await Promise.allSettled(inputs.map((input) => client.call("send", input)))
    // Let the fixture's admitted work settle even when the old client disconnects.
    await vi.waitFor(() => expect(active).toBe(0))
    expect(receipts.every((receipt) => receipt.status === "fulfilled")).toBe(true)
    expect(peak).toBeLessThanOrEqual(8)
    expect(store.messages(a.conversationId)).toHaveLength(17)
    expect(store.snapshot().runs).toHaveLength(17)
    const first = receipts[0]
    if (first.status !== "fulfilled") throw first.reason
    expect(await client.call("send", inputs[0])).toEqual(first.value)
    expect(catalog).toHaveBeenCalledTimes(17)
    expect(store.messages(a.conversationId)).toHaveLength(17)
    expect((await client.call("status")).hostId).toBe(host.id)
  })
  it("replays a connector reference send without requiring the live catalog or dispatching twice", async () => {
    const { client, host, store } = await fixture()
    const catalog = vi
      .spyOn(host, "connectors")
      .mockResolvedValue([{ id: "project-notes", name: "项目资料", source: "connector" }])
    const a = await client.call("create", { nonce: "owner", name: "Owner" })
    const input = {
      nonce: "connector-send",
      conversationId: a.conversationId,
      text: "核对资料",
      references: [{ kind: "connector" as const, id: "project-notes" }]
    }
    const sent = await client.call("send", input)
    catalog.mockRejectedValue(new Error("catalog unavailable"))
    expect(await client.call("send", input)).toEqual(sent)
    expect(catalog).toHaveBeenCalledTimes(1)
    await expect(client.call("send", { ...input, text: "不同的要求" })).rejects.toMatchObject({
      code: "nonce_conflict"
    })
    expect(catalog).toHaveBeenCalledTimes(1)
    await expect(client.call("send", { ...input, nonce: "new-send" })).rejects.toThrow(
      "catalog unavailable"
    )
    expect(store.messages(a.conversationId)).toHaveLength(1)
    expect(store.snapshot().runs).toHaveLength(1)
  })
  it("carries typed object references through authenticated transport and rejects client-supplied labels", async () => {
    const { client } = await fixture()
    const a = await client.call("create", { nonce: "ref-a", name: "A" })
    const b = await client.call("create", { nonce: "ref-b", name: "B" })
    expect((await client.call("status")).capabilities).toContain("entity-references")
    expect(
      await client.call("referenceCandidates", {
        conversationId: a.conversationId,
        query: "B",
        kind: "bot"
      })
    ).toMatchObject([{ kind: "bot", id: b.bot.id, name: "B" }])
    const input = {
      nonce: "ref-send",
      conversationId: a.conversationId,
      text: "核对",
      references: [{ kind: "bot" as const, id: b.bot.id }]
    }
    const sent = await client.call("send", input)
    expect(
      (await client.call("message", { conversationId: a.conversationId, id: sent.messageId }))
        .entityReferences
    ).toMatchObject([{ kind: "bot", id: b.bot.id, name: "B" }])
    expect(await client.call("send", input)).toEqual(sent)
    await expect(
      client.call("send", {
        ...input,
        nonce: "forged",
        references: [{ ...input.references[0], name: "伪造" }]
      } as never)
    ).rejects.toMatchObject({ code: "invalid_input" })
  })
  it("replays an acknowledged profile save through the authenticated transport", async () => {
    const { client } = await fixture()
    expect((await client.call("status")).capabilities).toContain("bot-update-receipts")
    const { bot } = await client.call("create", { nonce: "profile-owner", name: "Owner" })
    const input = { id: bot.id, revision: bot.revision, nonce: "profile-update", name: "Updated" }
    const saved = await client.call("update", input)
    expect(await client.call("update", input)).toEqual(saved)
    expect((await client.call("snapshot")).bots[0].revision).toBe(saved.revision)
    await expect(client.call("update", { ...input, name: "Conflict" })).rejects.toMatchObject({
      code: "nonce_conflict"
    })
  })
  it("validates and persists per-Bot desktop notification changes through the authenticated API", async () => {
    const { client } = await fixture()
    const { bot } = await client.call("create", { nonce: "notify-owner", name: "Owner" })
    const { dataEpoch } = await client.call("snapshot")
    const input = {
      botId: bot.id,
      dataEpoch: dataEpoch!,
      revision: 0,
      enabled: false,
      nonce: "mute"
    }
    const muted = await client.call("changeNotifications", input)
    expect(await client.call("changeNotifications", input)).toEqual(muted)
    expect((await client.call("snapshot")).notificationSettings).toEqual([muted])
    expect((await client.call("status")).capabilities).toContain("notifications")
    await expect(
      client.call("changeNotifications", { ...input, allow: true } as never)
    ).rejects.toMatchObject({ code: "invalid_input" })
    await expect(
      client.call("changeNotifications", { ...input, nonce: "stale" })
    ).rejects.toMatchObject({ code: "revision_conflict" })
  })
  it("validates independent review settings and replays only the original human update", async () => {
    const { client } = await fixture()
    const { bot } = await client.call("create", { nonce: "review-bot", name: "Review" })
    const initial = await client.call("autoReviewSettings", bot.id)
    expect(initial.isEnabled).toBe(false)
    const change = {
      ...initial,
      nonce: "enable",
      isEnabled: true,
      blockInstructions: ["发布前先确认"]
    }
    const updated = await client.call("changeAutoReview", change)
    expect(await client.call("changeAutoReview", change)).toEqual(updated)
    for (const extra of [{ decision: "allow" }, { allowInstructions: ["x".repeat(1001)] }])
      await expect(
        client.call("changeAutoReview", { ...updated, nonce: "forged", ...extra } as never)
      ).rejects.toMatchObject({ code: "invalid_input" })
    await expect(
      client.call("changeAutoReview", { ...change, nonce: "stale" })
    ).rejects.toMatchObject({ code: "revision_conflict" })
    expect((await client.call("status")).capabilities).toContain("auto-review")
  })
  it("exposes exact approval rule changes and rejects forged rule creation or another Bot's rule", async () => {
    const { client, store } = await fixture()
    const a = await client.call("create", { nonce: "a", name: "A" })
    const b = await client.call("create", { nonce: "b", name: "B" })
    store.send({ nonce: "task", conversationId: a.conversationId, text: "Test" })
    const { lease } = store.claim("test-host")!
    const action = {
      shell: {
        command: "npm test",
        cwd: "/project",
        timeoutSeconds: 60,
        sandbox: "none",
        definition: {
          kind: "package_script",
          path: "package.json",
          sha256: "c".repeat(64),
          definition: "node test.cjs"
        }
      }
    }
    const request = store.requestInteraction(lease, {
      kind: "approval",
      prompt: JSON.stringify(action),
      action,
      ruleScope: "a".repeat(64)
    })
    await client.call("answer", {
      id: request.id,
      revision: request.revision,
      answer: "approve",
      remember: true
    })
    const rules = await client.call("approvalRules", a.bot.id)
    const change = {
      botId: a.bot.id,
      ruleId: rules.rules[0].id,
      revision: rules.revision,
      dataEpoch: rules.dataEpoch,
      nonce: "change",
      behavior: "ask" as const
    }
    await expect(
      client.call("changeApprovalRule", { ...change, scope: "forged" } as never)
    ).rejects.toMatchObject({ code: "invalid_input" })
    await expect(
      client.call("changeApprovalRule", { ...change, botId: b.bot.id, revision: 0 })
    ).rejects.toMatchObject({ code: "not_found" })
    const changed = await client.call("changeApprovalRule", change)
    expect(changed.rules[0].behavior).toBe("ask")
    expect(await client.call("changeApprovalRule", change)).toEqual(changed)
    expect((await client.call("status")).capabilities).toContain("approval-rules")
  })
  it("saves and reads normalized avatars over the authenticated transport without embedding images in snapshots", async () => {
    const { client } = await fixture()
    const { bot } = await client.call("create", { nonce: "avatar", name: "Owner" })
    const input = { nonce: "image", botId: bot.id, revision: 1, pngBase64: await avatarImage() }
    await expect(
      client.call("changeAvatar", { ...input, path: "/private/avatar" } as never)
    ).rejects.toMatchObject({ code: "invalid_input" })
    const changed = await client.call("changeAvatar", input)
    expect(await client.call("changeAvatar", input)).toEqual(changed)
    expect(await client.call("avatar", { botId: bot.id, hash: changed.hash! })).toBeTruthy()
    expect(await client.call("avatar", { botId: bot.id, hash: "f".repeat(64) })).toBeNull()
    await expect(
      client.call("avatar", { botId: "missing", hash: changed.hash! })
    ).rejects.toMatchObject({ code: "not_found" })
    expect((await client.call("snapshot")).bots[0].avatarHash).toBe(changed.hash)
    expect(JSON.stringify(await client.call("snapshot"))).not.toContain(input.pngBase64)
    expect((await client.call("status")).capabilities).toContain("avatar-images")
  })
  it("manages routine-scoped webhook keys without publishing them through status, history or receipts", async () => {
    const { client, store, host } = await fixture()
    host.webhooks = new BotWebhookServer(store, () => {})
    cleanup.push(() => host.webhooks!.close())
    await host.webhooks.start()
    const { bot } = await client.call("create", { nonce: "webhook-owner", name: "Owner" })
    const { bot: other } = await client.call("create", { nonce: "webhook-other", name: "Other" })
    const routine = await client.call("saveRoutine", {
      botId: bot.id,
      name: "Event",
      prompt: "Check event",
      timezone: "UTC",
      enabled: true,
      schedule: { kind: "event", topic: "check" }
    })
    const [triggered] = store.emitEvent({
      nonce: "review-origin",
      topic: "check",
      payload: "Untrusted trigger data"
    }).runIds
    expect(store.autoReview.task(triggered)).toMatchObject({
      messages: [{ text: "Check event" }],
      routine: { origin: "human", trigger: "event", eventData: "Untrusted trigger data" }
    })
    const address = { botId: bot.id, routineId: routine.id }
    const input = { ...address, nonce: "key", operation: "rotate" as const, revision: 0 }
    await expect(
      client.call("changeWebhook", { ...input, publicPort: 8080 } as never)
    ).rejects.toMatchObject({ code: "invalid_input" })
    await expect(client.call("webhook", { ...address, botId: other.id })).rejects.toMatchObject({
      code: "not_found"
    })
    const created = await client.call("changeWebhook", input)
    expect(created.key).toMatch(/^[a-f0-9]{64}$/)
    expect(await client.call("changeWebhook", input)).toEqual({ state: created.state, key: null })
    const view = await client.call("webhook", address)
    expect(view.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/routines\//)
    expect(
      JSON.stringify([
        await client.call("status"),
        await client.call("snapshot"),
        await client.call("events", 0),
        view
      ])
    ).not.toContain(created.key)
    expect((await client.call("status")).capabilities).toContain("webhooks")
    await client.call("changeWebhook", {
      ...input,
      nonce: "revoke",
      operation: "revoke",
      revision: 1
    })
    expect(store.webhooks.authorize(routine.id, `Bearer ${created.key}`)).toBeNull()
  })
  it("bounds asynchronous task reads and rejects cursors from another Bot", async () => {
    const { client, store } = await fixture()
    const { bot } = await client.call("create", { nonce: "async-owner", name: "Owner" })
    const cursor = store.snapshot().cursor
    expect(await client.call("asyncTasks", { botId: bot.id })).toEqual({ items: [], next: null })
    await expect(client.call("asyncTasks", { botId: bot.id, limit: 1000 })).rejects.toMatchObject({
      code: "invalid_input"
    })
    await expect(
      client.call("asyncTasks", {
        botId: bot.id,
        before: { botId: "foreign", at: 0, key: "child:1" }
      })
    ).rejects.toMatchObject({ code: "task_cursor_scope" })
    await expect(
      client.call("asyncTasks", { botId: bot.id, includeSecrets: true } as never)
    ).rejects.toMatchObject({ code: "invalid_input" })
    expect(store.snapshot().cursor).toBe(cursor)
    expect((await client.call("status")).capabilities).toContain("async-tasks")
  })
  it("keeps shared trial evidence scoped to the executing Bot and exposes a compact verified catalog", async () => {
    const { client, store } = await fixture()
    const { bot } = await client.call("create", { nonce: "trial-owner", name: "Owner" })
    const { bot: other } = await client.call("create", { nonce: "trial-other", name: "Other" })
    const skill = await client.call("saveSkill", {
      botId: bot.id,
      name: "Check",
      instructions: "PRIVATE_SOURCE_STEPS",
      enabled: true
    })
    const shared = await client.call("publishSkill", {
      nonce: "publish",
      botId: bot.id,
      skillId: skill.id,
      version: 1,
      libraryRevision: 0
    })
    const input = {
      nonce: "trial",
      botId: other.id,
      skillId: shared.id,
      version: 1,
      inputs: "42",
      criteria: "matches 42"
    }
    await expect(client.call("availableSkills", "missing")).rejects.toThrow()
    await expect(
      client.call("trialSkill", { ...input, permissions: ["shell"] } as never)
    ).rejects.toMatchObject({ code: "invalid_input" })
    const trial = await client.call("trialSkill", input)
    const claim = store.claim("reviewer")!
    store.finish(claim.lease, "succeeded", "actual 42")
    await client.call("reviewSkillTrial", {
      id: trial.id,
      verdict: "passed",
      note: "manually checked"
    })
    const catalog = await client.call("availableSkills", other.id)
    expect(catalog.find((item) => item.id === shared.id)).toMatchObject({
      botId: other.id,
      verified: true,
      scope: "user"
    })
    expect(JSON.stringify(catalog)).not.toContain("PRIVATE_SOURCE_STEPS")
    expect(
      (await client.call("availableSkills", bot.id)).find((item) => item.id === shared.id)?.verified
    ).toBe(false)
    await client.call("withdrawSkill", { nonce: "withdraw", id: shared.id, revision: 1 })
    expect(await client.call("trialSkill", input)).toEqual(trial)
    expect((await client.call("status")).capabilities).toContain("skill-trials")
  })
  it("imports only explicit quoted text without source credentials or task dispatch", async () => {
    const { client } = await fixture()
    const { bot, conversationId } = await client.call("create", {
      nonce: "context-owner",
      name: "Context"
    })
    const input = {
      nonce: "import-context",
      botId: bot.id,
      draft: {
        source: { threadId: "old-thread", title: "Old task" },
        messages: [
          { id: "old-user-message", role: "user" as const, text: "Selected project background" }
        ]
      }
    }
    await expect(
      client.call("importThreadContext", {
        ...input,
        draft: { ...input.draft, credentials: "not-allowed" }
      } as never)
    ).rejects.toMatchObject({ code: "invalid_input" })
    const receipt = await client.call("importThreadContext", input)
    expect(await client.call("importThreadContext", input)).toEqual(receipt)
    expect(await client.call("messages", { conversationId })).toHaveLength(1)
    expect((await client.call("snapshot")).runs).toHaveLength(0)
    expect(
      (await client.call("message", { conversationId, id: receipt.messageId })).importedContext
        ?.threadId
    ).toBe("old-thread")
    expect((await client.call("status")).capabilities).toContain("context-import")
  })
  it("validates routine skill ownership and verification at the Host boundary", async () => {
    const { client, store } = await fixture()
    const { bot } = await client.call("create", { nonce: "binding-owner", name: "Owner" })
    const { bot: other } = await client.call("create", { nonce: "binding-other", name: "Other" })
    const skill = await client.call("saveSkill", {
      botId: bot.id,
      name: "Check",
      instructions: "Check evidence",
      enabled: true
    })
    const input = {
      nonce: "bind",
      botId: bot.id,
      name: "Check daily",
      prompt: "Check using the reviewed skill",
      enabled: true,
      timezone: "UTC",
      schedule: { kind: "event" as const, topic: "check" },
      skills: [{ botId: bot.id, id: skill.id, version: 1 }]
    }
    await expect(client.call("saveRoutine", input)).rejects.toMatchObject({
      code: "skill_unverified"
    })
    await expect(
      client.call("saveRoutine", { ...input, skills: [{ ...input.skills[0], botId: other.id }] })
    ).rejects.toMatchObject({ code: "skill_scope" })
    await expect(
      client.call("saveRoutine", { ...input, skills: [{ ...input.skills[0], id: "../escape" }] })
    ).rejects.toMatchObject({ code: "invalid_input" })
    const trial = await client.call("trialSkill", {
      nonce: "trial-bind",
      botId: bot.id,
      skillId: skill.id,
      version: 1,
      inputs: "fixture",
      criteria: "evidence is correct"
    })
    const claim = store.claim("reviewer")!
    store.finish(claim.lease, "succeeded", "verified evidence")
    await client.call("reviewSkillTrial", {
      id: trial.id,
      verdict: "passed",
      note: "manually checked"
    })
    const bound = await client.call("saveRoutine", input)
    expect(bound.skillReferences?.[0]).toMatchObject({ id: skill.id, version: 1, name: "Check" })
    await client.call("saveSkill", { ...skill, instructions: "new steps" })
    expect(await client.call("saveRoutine", input)).toEqual(bound)
    await expect(
      client.call("runRoutine", { id: bound.id, nonce: "new-run" })
    ).rejects.toMatchObject({ code: "skill_changed" })
    expect((await client.call("status")).capabilities).toContain("routine-skills")
  })
  it("saves a routine with a durable request identity and validates revision and nonce boundaries", async () => {
    const { client } = await fixture()
    const { bot } = await client.call("create", { nonce: "routine-editor-owner", name: "巡检" })
    const input = {
      nonce: "routine-editor-create",
      botId: bot.id,
      name: "日检",
      prompt: "检查项目",
      enabled: true,
      timezone: "UTC",
      schedule: { kind: "cron" as const, expression: "0 9 * * *" }
    }
    const routine = await client.call("saveRoutine", input)
    expect(await client.call("saveRoutine", input)).toEqual(routine)
    expect(await client.call("routines", bot.id)).toHaveLength(1)
    await expect(client.call("saveRoutine", { ...input, name: "不同内容" })).rejects.toMatchObject({
      code: "nonce_conflict"
    })
    await expect(
      client.call("saveRoutine", { ...input, nonce: "../invalid" })
    ).rejects.toMatchObject({ code: "invalid_input" })
    await expect(
      client.call("saveRoutine", { ...input, nonce: "edit", id: routine.id, revision: 0 })
    ).rejects.toMatchObject({ code: "invalid_input" })
    expect((await client.call("status")).capabilities).toContain("routine-editor")
  })
  it("publishes only a reviewed private skill version and validates library mutation input", async () => {
    const { client } = await fixture()
    const { bot } = await client.call("create", { nonce: "library-owner", name: "Owner" })
    const skill = await client.call("saveSkill", {
      botId: bot.id,
      name: "Review",
      instructions: "Check results",
      enabled: true
    })
    const input = {
      nonce: "publish",
      botId: bot.id,
      skillId: skill.id,
      version: skill.version,
      libraryRevision: 0
    }
    const saved = await client.call("publishSkill", input)
    expect(await client.call("publishSkill", input)).toEqual(saved)
    expect(await client.call("skillLibrary")).toEqual([saved])
    await expect(
      client.call("publishSkill", { ...input, instructions: "unreviewed replacement" } as never)
    ).rejects.toThrow()
    await expect(
      client.call("withdrawSkill", { nonce: "wrong", id: saved.id, revision: 99 })
    ).rejects.toThrow("共享版本")
    const withdraw = { nonce: "withdraw", id: saved.id, revision: saved.revision }
    expect(await client.call("withdrawSkill", withdraw)).toEqual({ id: saved.id })
    expect(await client.call("withdrawSkill", withdraw)).toEqual({ id: saved.id })
    expect(await client.call("skillLibrary")).toEqual([])
  })
  it("validates shared memory scopes and preserves mutation receipts across transport retries", async () => {
    const { client } = await fixture()
    const { bot } = await client.call("create", { nonce: "shared-memory", name: "Memory" })
    const address = { botId: bot.id, botRevision: bot.revision, scope: "user" as const }
    const input = { ...address, nonce: "shared-save", text: "Shared preference" }
    const saved = await client.call("saveSharedMemory", input)
    expect(await client.call("saveSharedMemory", input)).toEqual(saved)
    expect(await client.call("sharedMemories", address)).toEqual([saved])
    await expect(
      client.call("saveSharedMemory", { ...input, userId: "another-user" } as never)
    ).rejects.toThrow()
    await expect(client.call("sharedMemories", { ...address, scope: "project" })).rejects.toThrow(
      "项目目录"
    )
    const remove = { ...address, nonce: "shared-delete", id: saved.id, revision: saved.revision }
    expect(await client.call("deleteSharedMemory", remove)).toEqual({ id: saved.id })
    expect(await client.call("deleteSharedMemory", remove)).toEqual({ id: saved.id })
    expect(await client.call("sharedMemories", address)).toEqual([])
  })

  it("validates memory policy changes through authenticated transport and prevents stale settings writes", async () => {
    const { client } = await fixture()
    const { bot } = await client.call("create", { nonce: "memory", name: "Memory" })
    expect(await client.call("memoryPolicy", bot.id)).toMatchObject({ enabled: true, revision: 0 })
    await expect(
      client.call("setMemoryPolicy", {
        botId: bot.id,
        revision: 0,
        enabled: "yes" as unknown as boolean
      })
    ).rejects.toThrow()
    await expect(client.call("memoryPolicy", "../outside")).rejects.toThrow()
    expect(
      await client.call("setMemoryPolicy", { botId: bot.id, revision: 0, enabled: false })
    ).toMatchObject({ enabled: false, revision: 1 })
    await expect(
      client.call("setMemoryPolicy", { botId: bot.id, revision: 0, enabled: true })
    ).rejects.toThrow("已变化")
  })
  it("retries memory through the authenticated API with one durable receipt and strict scope", async () => {
    const { client, store } = await fixture()
    const { bot } = await client.call("create", { nonce: "memory-retry", name: "Memory" })
    const input = { botId: bot.id, revision: 0, dataEpoch: "initial", nonce: "retry" }
    const result = await client.call("retryMemory", input)
    expect(result).toMatchObject({ revision: 1, failed: 0, pending: 0 })
    expect(await client.call("retryMemory", input)).toEqual(result)
    expect(store.memory.policy(bot.id).revision).toBe(1)
    await expect(client.call("retryMemory", { ...input, nonce: "stale" })).rejects.toMatchObject({
      code: "revision_conflict"
    })
    await expect(
      client.call("retryMemory", { ...input, dataEpoch: "previous" })
    ).rejects.toMatchObject({ code: "data_epoch" })
    await expect(
      client.call("retryMemory", { ...input, evidenceIds: ["foreign"] } as never)
    ).rejects.toThrow()
  })
  it("validates pinned movement through the authenticated transport", async () => {
    const { client } = await fixture()
    const a = (await client.call("create", { nonce: "a", name: "A" })).bot
    const b = (await client.call("create", { nonce: "b", name: "B" })).bot
    await client.call("update", { id: a.id, revision: a.revision, pinned: true })
    await client.call("update", { id: b.id, revision: b.revision, pinned: true })
    const order = (await client.call("snapshot")).pinnedOrder!
    const input = {
      nonce: "move",
      revision: order.revision,
      movedId: b.id,
      targetId: a.id,
      position: "before" as const
    }
    await expect(
      client.call("reorderPinned", { ...input, position: "unsafe" as "before" })
    ).rejects.toThrow("不受支持")
    await expect(client.call("reorderPinned", { ...input, movedId: "../foreign" })).rejects.toThrow(
      "标识"
    )
    await expect(client.call("reorderPinned", { ...input, movedId: "foreign" })).rejects.toThrow(
      "仍在置顶"
    )
    expect((await client.call("reorderPinned", input)).ids).toEqual([b.id, a.id])
    expect((await client.call("snapshot")).pinnedOrder?.ids).toEqual([b.id, a.id])
    expect((await client.call("status")).capabilities).toContain("pinned-order")
  })
  it("reads a scoped task timeline and exact approval through authenticated RPC", async () => {
    const { client, store } = await fixture()
    const a = await client.call("create", { nonce: "a", name: "A" })
    const b = await client.call("create", { nonce: "b", name: "B" })
    const sent = await client.call("send", {
      nonce: "send",
      conversationId: a.conversationId,
      text: "执行检查"
    })
    const { lease } = store.claim("host")!
    const action = { command: "check project" }
    const approval = store.requestInteraction(lease, {
      kind: "approval",
      action,
      prompt: JSON.stringify(action)
    })
    await client.call("answer", { id: approval.id, revision: approval.revision, answer: "approve" })
    store.beginEffect(lease, { id: "check-effect", action, approvalId: approval.id })
    const address = { runId: sent.runIds[0], conversationId: a.conversationId }
    expect((await client.call("runHistory", address)).items[0].label).toBe("已批准，开始操作")
    expect(
      (await client.call("effectDetail", { ...address, effectId: "check-effect" })).approval?.id
    ).toBe(approval.id)
    await expect(
      client.call("runHistory", { ...address, conversationId: b.conversationId })
    ).rejects.toThrow("不属于")
    await expect(
      client.call("effectDetail", { ...address, effectId: "../outside" })
    ).rejects.toThrow("标识")
    await expect(
      client.call("effectDetail", { ...address, effectId: "check-effect", offset: -1 })
    ).rejects.toThrow()
    expect((await client.call("status")).capabilities).toContain("run-history")
    expect((await client.call("status")).capabilities).toContain("interaction-history")
    expect(
      await client.call("interactionDetail", { ...address, interactionId: approval.id })
    ).toMatchObject({ interaction: { answer: "approve" }, effects: [{ id: "check-effect" }] })
    await expect(
      client.call("interactionDetail", {
        ...address,
        conversationId: b.conversationId,
        interactionId: approval.id
      })
    ).rejects.toThrow("不属于")
    await expect(
      client.call("interactionDetail", { ...address, interactionId: "../outside" })
    ).rejects.toThrow("标识")
  })
  it("deletes the exact routine revision and acknowledges the same deletion after a lost response", async () => {
    const { client } = await fixture()
    const { bot } = await client.call("create", { nonce: "routine-owner", name: "例程" })
    const foreign = await client.call("create", { nonce: "foreign", name: "其他" })
    const routine = await client.call("saveRoutine", {
      botId: bot.id,
      name: "检查",
      prompt: "项目检查",
      timezone: "UTC",
      enabled: true,
      schedule: { kind: "event", topic: "project.changed" }
    })
    const input = {
      nonce: "delete-routine",
      botId: bot.id,
      id: routine.id,
      revision: routine.revision
    }
    const occurrence = await client.call("runRoutine", { id: routine.id, nonce: "history" })
    const historyInput = { botId: bot.id, routineId: routine.id }
    expect((await client.call("routineHistory", historyInput)).items).toMatchObject([
      { id: occurrence.id, status: "queued", trigger: "manual" }
    ])
    await expect(
      client.call("routineHistory", { ...historyInput, botId: foreign.bot.id })
    ).rejects.toThrow("不属于")
    await expect(client.call("deleteRoutine", { ...input, botId: foreign.bot.id })).rejects.toThrow(
      "不属于"
    )
    await expect(client.call("deleteRoutine", { ...input, revision: 0 })).rejects.toThrow(
      "例程版本"
    )
    const receipt = await client.call("deleteRoutine", input)
    expect(await client.call("deleteRoutine", input)).toEqual(receipt)
    expect(await client.call("routines", bot.id)).toEqual([])
    expect((await client.call("routineHistory", historyInput)).items[0].status).toBe("cancelled")
    expect((await client.call("status")).capabilities).toContain("routine-management")
  })
  it("searches durable visible messages through authenticated RPC and rejects forged cursors", async () => {
    const { client } = await fixture()
    const { conversationId } = await client.call("create", { nonce: "search", name: "Search" })
    const sent = await client.call("send", {
      nonce: "search-message",
      conversationId,
      text: "durable_search_needle"
    })
    expect((await client.call("status")).capabilities).toContain("content-search")
    expect(
      await client.call("search", { query: "durable_search_needle", kind: "message" })
    ).toMatchObject({ matches: [{ id: sent.messageId, conversationId }], cursor: null })
    await expect(
      client.call("search", { query: "needle", kind: "message", cursor: "forged" })
    ).rejects.toThrow("条件已变化")
  })
  it("serves scoped previews through the authenticated protocol and rejects cross-conversation reads", async () => {
    const { client } = await fixture()
    const { conversationId } = await client.call("create", { nonce: "preview", name: "Preview" })
    const other = await client.call("create", { nonce: "preview-other", name: "Other" })
    await client.call("upload", {
      nonce: "html",
      conversationId,
      name: "report.html",
      mime: "text/html",
      base64: Buffer.from("<h1>成果</h1>").toString("base64")
    })
    const request = { id: "html", conversationId, requestId: "request", offset: 0 }
    expect(await client.call("filePreview", request)).toMatchObject({
      kind: "html",
      page: { text: "<h1>成果</h1>" }
    })
    await expect(
      client.call("filePreview", { ...request, conversationId: other.conversationId })
    ).rejects.toThrow("不属于")
    await client.call("cancelFilePreview", { conversationId, requestId: "request" })
  })
  it("uploads and downloads a file larger than a transport frame using resumable bounded chunks", async () => {
    const { client } = await fixture()
    const { conversationId } = await client.call("create", { nonce: "files", name: "Files" })
    const bytes = Buffer.alloc(9 * 1024 * 1024, 83)
    const request = {
      nonce: "large-upload",
      conversationId,
      name: "large.txt",
      mime: "text/plain",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    }
    expect(await client.call("beginUpload", request)).toMatchObject({ offset: 0, artifact: null })
    const first = {
      id: request.nonce,
      offset: 0,
      base64: bytes.subarray(0, BOT_FILE_CHUNK_BYTES).toString("base64")
    }
    await client.call("uploadChunk", first)
    expect((await client.call("uploadChunk", first)).offset).toBe(BOT_FILE_CHUNK_BYTES)
    const resumed = await client.call("beginUpload", request)
    for (let offset = resumed.offset; offset < bytes.length; offset += BOT_FILE_CHUNK_BYTES)
      await client.call("uploadChunk", {
        id: request.nonce,
        offset,
        base64: bytes.subarray(offset, offset + BOT_FILE_CHUNK_BYTES).toString("base64")
      })
    const artifact = await client.call("finishUpload", request.nonce)
    expect(await client.call("finishUpload", request.nonce)).toEqual(artifact)
    const hash = createHash("sha256")
    for (let offset = 0; offset < bytes.length; offset += BOT_FILE_CHUNK_BYTES) {
      const chunk = await client.call("fileChunk", { id: artifact.id, offset })
      expect(chunk.artifact).toEqual(artifact)
      expect(encodeBotFrame(chunk).length).toBeLessThan(800_000)
      hash.update(Buffer.from(chunk.base64, "base64"))
    }
    expect(hash.digest("hex")).toBe(request.sha256)
    await expect(
      client.call("beginUpload", { ...request, sha256: "b".repeat(64) })
    ).rejects.toThrow("不同内容")
    await expect(client.call("uploadChunk", { ...first, id: "../outside" })).rejects.toThrow()
    await expect(client.call("fileChunk", { id: artifact.id, offset: -1 })).rejects.toThrow()
  }, 20_000)
  it("deletes a scoped file through authenticated RPC and cannot revive its upload nonce", async () => {
    const { client } = await fixture()
    const { conversationId } = await client.call("create", { nonce: "owner", name: "Owner" })
    const other = await client.call("create", { nonce: "other", name: "Other" })
    const upload = {
      nonce: "upload",
      conversationId,
      name: "evidence.txt",
      mime: "text/plain",
      base64: Buffer.from("evidence").toString("base64")
    }
    const artifact = await client.call("upload", upload)
    expect(artifact.origin).toBe("upload")
    const input = { nonce: "delete", conversationId, id: artifact.id, sha256: artifact.sha256 }
    await expect(
      client.call("deleteFile", { ...input, conversationId: other.conversationId })
    ).rejects.toThrow("不属于")
    const deleted = await client.call("deleteFile", input)
    expect(await client.call("deleteFile", input)).toEqual(deleted)
    expect(await client.call("artifacts", conversationId)).toEqual([])
    await expect(
      client.call("filePreview", {
        conversationId,
        id: artifact.id,
        requestId: "deleted",
        offset: 0
      })
    ).rejects.toThrow("已删除")
    await expect(client.call("upload", upload)).rejects.toThrow("已删除")
  })
  it("clones once and protects read watermarks through the authenticated API", async () => {
    const { client } = await fixture()
    const source = await client.call("create", { nonce: "source", name: "Source" })
    const input = { nonce: "clone", id: source.bot.id, revision: 1 }
    const copied = await client.call("clone", input)
    expect(await client.call("clone", input)).toEqual(copied)
    const marked = await client.call("setReadState", {
      conversationId: copied.conversationId,
      revision: 0,
      throughSequence: 0,
      unread: true
    })
    expect(marked.manuallyUnread).toBe(true)
    await expect(
      client.call("setReadState", {
        conversationId: copied.conversationId,
        revision: 0,
        throughSequence: 0,
        unread: false
      })
    ).rejects.toThrow("读取位置已变化")
    await expect(
      client.call("clone", { ...input, nonce: "missing", id: "missing" })
    ).rejects.toThrow("不存在")
    await expect(
      client.call("messages", { conversationId: copied.conversationId, before: 2, after: 1 })
    ).rejects.toThrow("同时")
  })
  it("round trips real state and reports a missing execution adapter accurately", async () => {
    const { client } = await fixture()
    expect((await client.call("status")).runtimeReady).toBe(false)
    const created = await client.call("create", { nonce: "c", name: "中文 Bot" })
    const sent = await client.call("send", {
      nonce: "m",
      conversationId: created.conversationId,
      text: "完整保存中文消息"
    })
    expect((await client.call("snapshot")).runs[0].id).toBe(sent.runIds[0])
    expect(
      (await client.call("messages", { conversationId: created.conversationId }))[0].text
    ).toBe("完整保存中文消息")
    await expect(client.call("create", { nonce: "bad", name: "" })).rejects.toThrow("名称格式")
  })

  it("edits group details through authenticated RPC and rejects invalid members and direct chats", async () => {
    const { client } = await fixture()
    const a = await client.call("create", { nonce: "a", name: "A" }),
      b = await client.call("create", { nonce: "b", name: "B" })
    const group = await client.call("createGroup", {
      nonce: "g",
      name: "组",
      members: [a.bot.id, b.bot.id]
    })
    const changed = await client.call("updateGroup", {
      id: group.id,
      revision: group.revision,
      name: "评审",
      description: "准备技术评审",
      members: group.members
    })
    expect(changed.description).toBe("准备技术评审")
    await expect(
      client.call("updateGroup", { ...changed, description: "", members: [a.bot.id, "missing"] })
    ).rejects.toThrow("不存在")
    await expect(
      client.call("updateGroup", {
        id: a.conversationId,
        revision: 1,
        name: "非法",
        description: "",
        members: group.members
      })
    ).rejects.toThrow("只能编辑群聊")
  })

  it("rejects another token before exposing state", async () => {
    const { descriptor } = await fixture()
    const bad = new BotTransportClient({ ...descriptor, token: "0".repeat(64) })
    cleanup.push(() => bad.close())
    await expect(bad.call("snapshot")).rejects.toThrow("连接已断开")
  })

  it("rejects unframed/oversized inputs and never exposes internal execution authority", async () => {
    const { descriptor, client } = await fixture()
    await expect((client.call as (method: string) => Promise<unknown>)("claim")).rejects.toThrow(
      "未知 Bot 操作"
    )
    const socket = createConnection(descriptor.socketPath)
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
    socket.on("error", () => {})
    const header = Buffer.alloc(4)
    header.writeUInt32BE(100 * 1024 * 1024)
    socket.write(header)
    await closed
  })

  it("accepts a handshake split across byte boundaries", async () => {
    const { descriptor } = await fixture()
    const socket = createConnection(descriptor.socketPath)
    cleanup.push(() => {
      socket.destroy()
    })
    const response = new Promise<Buffer>((resolve) => socket.once("data", resolve))
    const frame = encodeBotFrame({ id: "hello", version: 1, token: descriptor.token })
    for (let i = 0; i < frame.length; i++) socket.write(frame.subarray(i, i + 1))
    expect(JSON.parse((await response).subarray(4).toString()).ok).toBe(true)
  })
})
