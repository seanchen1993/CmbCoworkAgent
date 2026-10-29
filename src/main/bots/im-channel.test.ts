import type { BotWorkHistoryPort } from "../../shared/bots/work-history"
import { botMemoryContext } from "../../shared/bots/memory-scope"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import type { BotWorkWorkspacePort } from "../../shared/bots/work"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost, type BotRunLease } from "./host"
import { BotImChannelService, type BotImGatewayClient } from "../services/im/bot-channel-service"
import { BotImGatewayStore, botImScopeId } from "./im-gateway-store"
import {
  assertBotImBinding,
  assertBotImEvent,
  type BotImBinding,
  type BotImEvent
} from "../../shared/bots/im-channel"
import type { BotTask } from "../../shared/bots/contracts"
import { buildBotPrompt } from "./prompt"
import { parseBotMockSource } from "./mock-channel-validation"
import { canSteerBotTask } from "./continuation"

const interactionCommand = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock("../services/im/bot-interaction-command", () => ({
  handleBotImInteractionCommand: interactionCommand
}))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})
const eventually = async (condition: () => boolean) => {
  const until = Date.now() + 4500
  while (!condition()) {
    if (Date.now() > until) throw new Error("condition timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}
function fixture(
  execute?: (
    task: BotTask,
    host: LocalBotHost,
    signal: AbortSignal,
    waiting: (value: boolean) => void
  ) => ReturnType<BotRunLease["execute"]>,
  externalBindingId?: string,
  available: () => boolean = () => true,
  workspaces?: BotWorkWorkspacePort,
  workHistory?: BotWorkHistoryPort,
  concurrency = 2
) {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:")),
    store = new BotStore(db)
  const bot = store.create({
    name: "IM Bot",
    instructions: "Write text",
    color: "#123456",
    modelRef: null
  })
  const calls: BotTask[] = [],
    errors: unknown[] = []
  const cancelBackground = vi.fn(async (_threadId: string) => {})
  const host: LocalBotHost = new LocalBotHost(
    store,
    {
      workspaces,
      workHistory,
      cancelBackground,
      onAvailable: () => () => {},
      acquire: (_bot, task) =>
        available()
          ? {
              release() {},
              execute: async (signal, waiting) => {
                calls.push(task)
                if (task.mockSource) host.mockExecution(task)
                return execute
                  ? execute(task, host, signal, waiting)
                  : { state: "completed", result: `reply:${task.message}` }
              }
            }
          : null
    },
    concurrency,
    (error) => errors.push(error)
  )
  const remote = new Map<string, BotImBinding>()
  let sequence = 0
  const client = {
    getStatus: () => ({ principalId: "owner" }) as ReturnType<BotImGatewayClient["getStatus"]>,
    supportsBotChannel: () => true,
    supportsMarkdownReplies: vi.fn(() => false),
    botBindingCommand: vi.fn<BotImGatewayClient["botBindingCommand"]>(async (command) => {
      if (command.action === "list") return { items: [...remote.values()], before: null }
      if (command.action === "revoke") {
        const result = {
          ...remote.get(command.bindingId)!,
          version: command.expectedVersion + 1,
          state: "revoked" as const
        }
        remote.set(result.id, result)
        return result
      }
      sequence++
      const binding: BotImBinding = {
        id: externalBindingId ?? `binding-${sequence}`,
        botId: command.botId,
        kind: command.kind,
        label: command.label,
        version: 1,
        state: "pending",
        conversationKey: null,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        instruction: "/绑定Bot abcdefghijklmnopqrstuvwx"
      }
      remote.set(binding.id, binding)
      return binding
    }),
    sendAcknowledgement: vi.fn<BotImGatewayClient["sendAcknowledgement"]>(async () => {}),
    acquireBotPermit: vi.fn<BotImGatewayClient["acquireBotPermit"]>(async () => ({
      status: "granted",
      expiresAt: new Date(Date.now() + 90000).toISOString(),
      leaseId: "lease"
    })),
    renewBotPermit: vi.fn<BotImGatewayClient["renewBotPermit"]>(async () => ({
      status: "granted",
      expiresAt: new Date(Date.now() + 90000).toISOString(),
      leaseId: "lease"
    })),
    submitReply: vi.fn<BotImGatewayClient["submitReply"]>(async () => ({ state: "accepted" }))
  } satisfies BotImGatewayClient
  const service = new BotImChannelService(
    client,
    "realm",
    () => host,
    (error) => errors.push(error),
    () => false
  )
  service.start()
  cleanups.push(async () => {
    service.stop()
    await host.stop()
    db.close()
  })
  const binding = async (kind: "dm" | "group" = "group") => {
    const value = await service.create(bot.id, kind, `create-${sequence}`)
    const active: BotImBinding = { ...value, state: "active", conversationKey: `convo-${value.id}` }
    delete active.instruction
    remote.set(value.id, active)
    await service.list(bot.id)
    return active
  }
  const event = (binding: BotImBinding, id = "event", text = "Hello"): BotImEvent => ({
    route: {
      bindingId: binding.id,
      botId: bot.id,
      kind: binding.kind,
      label: binding.label,
      version: binding.version,
      senderId: "member-a"
    },
    event: {
      schemaVersion: 1,
      eventId: id,
      platformMessageId: `platform-${id}`,
      principalId: "owner",
      conversationKey: binding.conversationKey!,
      conversationSeq: 1,
      message: { type: "text", text },
      occurredAt: new Date().toISOString(),
      redelivered: false,
      lease: { id: "lease", expiresAt: new Date(Date.now() + 90000).toISOString() }
    }
  })
  return {
    db,
    store,
    bot,
    host,
    calls,
    errors,
    service,
    client,
    binding,
    event,
    remote,
    cancelBackground
  }
}

describe("authenticated IM on the existing Bot host", () => {
  it("runs two IM groups and private chat concurrently while preserving approvals, thread order and reply routes", async () => {
    const finish = new Map<string, () => void>()
    const waiting = new Map<string, (value: boolean) => void>()
    const f = fixture(
      async (task, _host, signal, onWaiting) => {
        waiting.set(task.id, onWaiting)
        await new Promise<void>((resolve) => {
          finish.set(task.id, resolve)
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
        return { state: "completed", result: `result:${task.message}` }
      },
      undefined,
      undefined,
      undefined,
      undefined,
      Number.POSITIVE_INFINITY
    )
    const a = await f.binding(),
      b = await f.binding(),
      dm = await f.binding("dm")
    try {
      await f.service.receive(f.event(a, "a-1", "A first"))
      await eventually(() => f.calls.length === 1)
      const first = f.calls[0]
      waiting.get(first.id)!(true)
      await f.service.receive(f.event(a, "a-2", "A second"))
      await f.service.receive(f.event(b, "b-1", "B first"))
      const own = f.host.send({
        botId: f.bot.id,
        requestId: "local-private",
        message: "Local private"
      })
      await eventually(() => f.calls.length === 3)
      await f.service.receive(f.event(dm, "dm-1", "IM private"))
      const pending = f.store.recentTasks()
      const second = pending.find((t) => t.message === "A second")!
      const other = pending.find((t) => t.message === "B first")!
      const imPrivate = pending.find((t) => t.message === "IM private")!
      expect(f.store.getTask(first.id).state).toBe("waiting_user")
      expect(f.store.getTask(second.id).state).toBe("queued")
      expect(f.store.getTask(other.id).state).toBe("running")
      expect(f.store.getTask(own.id).state).toBe("running")
      expect(f.store.getTask(imPrivate.id).state).toBe("queued")
      expect(imPrivate.threadId).toBe(own.threadId)
      expect(new Set([first.threadId, other.threadId, own.threadId]).size).toBe(3)
      expect(botMemoryContext(first)).not.toEqual(botMemoryContext(other))
      // Exercise the renderer's actual snapshot, not full store rows: the group
      // stop control needs the IM source even when message bodies are projected.
      const snapshot = f.host.snapshot()
      const conversation = snapshot.imConversations!.find((item) => item.bindingId === a.id)!
      const visibleGroupTasks = snapshot.tasks.filter(
        (task) =>
          task.mockSource?.transport === "im" &&
          task.mockSource.bindingId === conversation.id &&
          task.botId === f.bot.id &&
          !task.workId &&
          ["queued", "running", "waiting_user"].includes(task.state)
      )
      expect(visibleGroupTasks.map((task) => task.id).sort()).toEqual([first.id, second.id].sort())
      expect(snapshot.tasks.find((task) => task.id === other.id)?.mockSource).toEqual(
        other.mockSource
      )
      expect(snapshot.tasks.find((task) => task.id === own.id)?.mockSource).toBeUndefined()
      f.host.stopImConversation(f.bot.id, botImScopeId("realm", "owner", a.id))
      await eventually(() => f.store.getTask(first.id).state === "cancelled")
      expect(f.store.getTask(second.id).state).toBe("cancelled")
      expect(f.store.getTask(other.id).state).toBe("running")
      expect(f.store.getTask(own.id).state).toBe("running")
      finish.get(other.id)!()
      finish.get(own.id)!()
      await eventually(() => f.calls.some((t) => t.id === imPrivate.id))
      finish.get(imPrivate.id)!()
      await eventually(() => f.store.getTask(imPrivate.id).state === "completed")
      await vi.waitFor(
        () =>
          expect(
            f.client.submitReply.mock.calls.some(([r]) => r.message.content === "result:IM private")
          ).toBe(true),
        { timeout: 10000 }
      )
      const replies = f.client.submitReply.mock.calls.map(([r]) => r)
      for (const [text, binding] of [
        ["result:B first", b],
        ["result:Local private", dm],
        ["result:IM private", dm]
      ] as const) {
        expect(replies).toContainEqual(
          expect.objectContaining({
            conversationKey: binding.conversationKey,
            message: expect.objectContaining({ content: text })
          })
        )
      }
      expect(
        replies
          .filter((r) => r.message.content === "已停止")
          .every((r) => r.conversationKey === a.conversationKey)
      ).toBe(true)
      expect(f.calls.filter((t) => t.id === second.id)).toHaveLength(0)
      expect(f.errors).toEqual([])
    } finally {
      for (const resolve of finish.values()) resolve()
    }
  }, 15000)
  it("publishes one opening before completion, exposes the group execution thread and cancels only that group", async () => {
    const f = fixture(async (task, host, signal) => {
      host.imChannel.openingReply(task.id, "我先检查当前目录。")
      host.imChannel.openingReply(task.id, "重复快照不应再次发送")
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      )
      return { state: "completed" }
    })
    const group = await f.binding()
    await f.service.receive(f.event(group, "opening"))
    await eventually(() => f.calls.length === 1)
    await eventually(() =>
      f.client.submitReply.mock.calls.some(([reply]) => reply.message.content.includes("我先检查"))
    )
    expect(f.store.getTask(f.calls[0].id).state).toBe("running")
    const history = f.service.history(f.bot.id, group.id)
    expect(history.items.filter((entry) => entry.kind === "bot")).toHaveLength(1)
    expect(f.host.snapshot().imConversations).toEqual([
      expect.objectContaining({ bindingId: group.id, threadId: f.calls[0].threadId })
    ])
    const privateTask = f.host.send({
      botId: f.bot.id,
      requestId: "private-after-group",
      message: "Private"
    })
    expect(f.store.getTask(privateTask.id).state).toBe("queued")
    await eventually(() => f.calls.some((task) => task.id === privateTask.id))
    expect(f.store.getTask(f.calls[0].id).state).toBe("running")
    expect(f.store.getTask(privateTask.id).state).toBe("running")
    f.host.stopImConversation(f.bot.id, botImScopeId("realm", "owner", group.id))
    await eventually(() => f.store.getTask(f.calls[0].id).state === "cancelled")
    await eventually(() => f.calls.some((task) => task.id === privateTask.id))
    expect(f.store.getTask(privateTask.id).state).toBe("running")
    f.host.cancel(privateTask.id)
  })
  it("stops queued group turns with a reply, excludes private and independent work, and validates ownership", async () => {
    const f = fixture(undefined, undefined, () => false)
    const a = await f.binding(),
      b = await f.binding()
    await f.service.receive(f.event(a, "queued-a"))
    await f.service.receive(f.event(b, "queued-b"))
    const localA = botImScopeId("realm", "owner", a.id)
    const pending = f.store.recentTasks()
    const creator = pending.find((task) => task.mockSource?.bindingId === localA)!
    const otherGroup = pending.find((task) => task.id !== creator.id)!
    f.store.transition(creator.id, "running")
    const work = f.store.createWork(
      { botId: f.bot.id, operationId: "independent", title: "Separate work", goal: "Keep working" },
      { taskId: creator.id, callId: "create", key: "create" }
    )
    f.store.settle(creator.id, "completed", null, "Work admitted")
    await f.service.receive(f.event(a, "queued-stop"))
    const own = f.store
      .recentTasks()
      .find(
        (task) => task.mockSource?.bindingId === localA && task.id !== creator.id && !task.workId
      )!
    const privateTask = f.host.send({
      botId: f.bot.id,
      requestId: "private-queued",
      message: "private"
    })
    const otherBot = f.store.create({
      name: "Other",
      instructions: "",
      color: "#123456",
      modelRef: null
    })
    expect(() => f.host.stopImConversation(otherBot.id, localA)).toThrow("不存在")
    f.host.stopImConversation(f.bot.id, localA)
    expect(f.store.getTask(own.id).state).toBe("cancelled")
    expect(f.store.getTask(otherGroup.id).state).toBe("queued")
    expect(f.store.getTask(privateTask.id).state).toBe("queued")
    expect(f.store.getTask(work.task.id).state).toBe("queued")
    const replies = f.service
      .history(f.bot.id, a.id)
      .items.filter(
        (entry) => entry.kind === "bot" && entry.replyToMessageId === own.mockSource!.messageId
      )
    expect(replies).toEqual([expect.objectContaining({ text: "已停止" })])
    f.host.stopImConversation(f.bot.id, localA)
    expect(
      f.service
        .history(f.bot.id, a.id)
        .items.filter(
          (entry) => entry.kind === "bot" && entry.replyToMessageId === own.mockSource!.messageId
        )
    ).toHaveLength(1)
  })
  it.each(["dm", "group"] as const)(
    "delivers an opening and the final result once in %s",
    async (kind) => {
      const f = fixture(async (task, host) => {
        host.imChannel.openingReply(task.id, "我先查看相关文件。")
        host.imChannel.openingReply(task.id, "Repeated snapshot")
        return { state: "completed", result: "已整理完成。" }
      })
      const binding = await f.binding(kind)
      await f.service.receive(f.event(binding, "opening-final"))
      await eventually(() => f.client.submitReply.mock.calls.length === 2)
      expect(f.client.submitReply.mock.calls.map(([reply]) => reply.message.content)).toEqual([
        "我先查看相关文件。",
        "已整理完成。"
      ])
      expect(
        f.client.submitReply.mock.calls.every(
          ([reply]) => reply.conversationKey === binding.conversationKey
        )
      ).toBe(true)
      const task = f.store.getTask(f.calls[0].id)
      f.host.imChannel.openingReply(task.id, "Late replay")
      f.host.imChannel.settle(task, "completed", "Final replay")
      expect(
        f.service.history(f.bot.id, binding.id).items.filter((entry) => entry.kind === "bot")
      ).toHaveLength(2)
    }
  )
  it("migrates existing reply receipts and preserves separate opening/final idempotency", async () => {
    const f = fixture()
    const binding = await f.binding()
    await f.service.receive(f.event(binding, "old"))
    await eventually(
      () => f.calls.length === 1 && f.store.getTask(f.calls[0].id).state === "completed"
    )
    const before = f.service.history(f.bot.id, binding.id).items
    // Recreate the released schema to exercise an actual upgrade with retained receipts.
    f.db.run(`DROP INDEX bot_im_outbox_pending; DROP INDEX bot_im_outbox_page;
      ALTER TABLE bot_im_outbox RENAME TO upgraded_outbox;
      CREATE TABLE bot_im_outbox (
        id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,binding_id TEXT NOT NULL,grant_version INTEGER NOT NULL,
        conversation_id TEXT NOT NULL,reply_to_message_id TEXT NOT NULL,source_task_id TEXT UNIQUE NOT NULL,
        work_id TEXT,text TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
      INSERT INTO bot_im_outbox SELECT id,bot_id,binding_id,grant_version,conversation_id,reply_to_message_id,source_task_id,work_id,text,state,created_at FROM upgraded_outbox;
      DROP TABLE upgraded_outbox;`)
    const reopened = new BotStore(f.db)
    expect(reopened.im.history(f.bot.id, botImScopeId("realm", "owner", binding.id)).items).toEqual(
      before
    )
    const task = reopened.getTask(f.calls[0].id)
    reopened.im.settle(task, "completed", "should not replace final")
    expect(reopened.im.history(f.bot.id, botImScopeId("realm", "owner", binding.id)).items).toEqual(
      before
    )
  })

  it("removes inactive configurations durably without deleting group history or task records", async () => {
    const f = fixture(),
      binding = await f.binding()
    await f.service.receive(f.event(binding, "retained", "保留这段群聊记录"))
    await eventually(
      () => f.calls.length === 1 && f.store.getTask(f.calls[0].id).state === "completed"
    )
    const taskId = f.calls[0].id
    expect(() => f.service.remove(f.bot.id, binding.id)).toThrow("只能删除")
    const revoked = await f.service.revoke(f.bot.id, binding.id, binding.version)
    f.service.remove(f.bot.id, binding.id)
    f.service.remove(f.bot.id, binding.id) // Idempotent retries.
    expect((await f.service.list(f.bot.id)).items).toEqual([])
    expect(f.remote.get(binding.id)?.state).toBe("revoked")
    expect(f.service.history(f.bot.id, binding.id).items.map((entry) => entry.text)).toContain(
      "保留这段群聊记录"
    )
    expect(f.store.getTask(taskId).state).toBe("completed")
    expect(f.host.snapshot().imConversations).toEqual([
      expect.objectContaining({ bindingId: binding.id, state: "revoked" })
    ])
    const reopened = new BotImGatewayStore(f.db)
    expect(reopened.visibleBindings("realm", "owner", [revoked])).toEqual([])
    expect(reopened.visibleBindings("other-realm", "owner", [revoked])).toEqual([revoked])
    expect(reopened.visibleBindings("realm", "other-owner", [revoked])).toEqual([revoked])
  })
  it("only removes terminal records owned by the selected Bot and preserves pagination", async () => {
    const f = fixture()
    const pending = await f.service.create(f.bot.id, "group", "pending")
    expect(() => f.service.remove(f.bot.id, pending.id)).toThrow("只能删除")
    const expired: BotImBinding = { ...pending, state: "expired" }
    f.remote.set(expired.id, expired)
    await f.service.list(f.bot.id)
    const other = f.store.create({
      name: "Other",
      instructions: "",
      color: "#123456",
      modelRef: null
    })
    expect(() => f.service.remove(other.id, expired.id)).toThrow("不属于")
    expect(() => f.service.remove(f.bot.id, "missing")).toThrow("不属于")
    f.service.remove(f.bot.id, expired.id)
    f.client.botBindingCommand.mockResolvedValueOnce({ items: [expired], before: "123" })
    expect(await f.service.list(f.bot.id)).toEqual({ items: [], before: "123" })
    // A late authoritative activation cannot become invisible after an expired snapshot was removed.
    f.remote.set(expired.id, {
      ...expired,
      state: "active",
      version: 1,
      conversationKey: "late-active"
    })
    expect((await f.service.list(f.bot.id)).items).toEqual([
      expect.objectContaining({ state: "active" })
    ])
  })

  it("allows App attachments and same-group task history while rejecting another group's history", async () => {
    const works = new Map<string, string>()
    const query = vi.fn(async (work) => ({
      work: { id: work.id, title: work.title, goal: work.goal },
      entries: [],
      nextCursor: null,
      scanned: 0,
      truncated: false,
      coverage: "exhausted" as const
    }))
    const f = fixture(
      async (task, host) => {
        if (task.origin.kind === "mock" && task.message === "create") {
          const created = await host.createWork(
            {
              botId: task.botId,
              operationId: "create",
              title: "Scoped work",
              goal: "do this work"
            },
            { taskId: task.id, callId: "create", key: "create" }
          )
          works.set(task.mockSource!.bindingId, created.work.id)
        }
        if (task.message === "read") {
          const own = works.get(task.mockSource!.bindingId)!
          const foreign = [...works.values()].find((id) => id !== own)!
          await host.workHistory(task.id, { workId: own })
          await expect(host.workHistory(task.id, { workId: foreign })).rejects.toThrow("私有历史")
        }
        return { state: "completed", result: "done" }
      },
      undefined,
      undefined,
      undefined,
      { query, resolve: vi.fn() }
    )
    const a = await f.binding(),
      b = await f.binding()
    await f.service.receive(f.event(a, "a-create", "create"))
    await eventually(() => works.size === 1)
    await f.service.receive(f.event(b, "b-create", "create"))
    await eventually(() => works.size === 2)
    await f.service.receive(f.event(a, "read", "read"))
    await eventually(
      () =>
        query.mock.calls.length === 1 &&
        f.calls.some((t) => t.message === "read" && f.store.getTask(t.id).state === "completed")
    )
    const workId = [...works.values()][0]
    const attachment = '<user_attachment path="/tmp/report.md">report.md</user_attachment> 分析附件'
    const local = f.store.enqueue({
      botId: f.bot.id,
      workId,
      requestId: "app-attachment",
      message: attachment
    })
    f.host.resume()
    await eventually(() => f.store.getTask(local.id).state === "completed")
    expect(local.mockSource!.bindingId).toBe([...works.keys()][0])
    expect(f.calls.find((t) => t.id === local.id)?.message).toBe(attachment)
    expect(f.errors).toEqual([])
  })

  it("returns asynchronous Bot collaboration to its original IM group without touching private threads", async () => {
    let peerId = ""
    const f = fixture(async (task, host) => {
      if (task.origin.kind === "mock") {
        host.delegate(task.id, peerId, "Review the assigned work", "peer", [])
        return { state: "completed", result: "已交办" }
      }
      if (task.origin.kind === "bot" && task.origin.expectsReply)
        return { state: "completed", result: "peer-result" }
      return { state: "completed", result: "group-final" }
    })
    peerId = f.store.create({ name: "Peer", instructions: "", color: "#123456", modelRef: null }).id
    const binding = await f.binding()
    await f.service.receive(f.event(binding, "collaboration"))
    await eventually(() => f.calls.some((t) => t.origin.kind === "bot" && !t.origin.expectsReply))
    await eventually(() =>
      f.client.submitReply.mock.calls.some(([reply]) =>
        reply.message.content.includes("group-final")
      )
    )
    const root = f.calls[0],
      child = f.calls.find((t) => t.botId === peerId)!,
      reply = f.calls.at(-1)!
    expect(child.threadId).not.toBe(f.store.getBot(peerId).threadId)
    expect(botMemoryContext(child)).toEqual({ groupId: root.mockSource!.bindingId })
    expect(reply.threadId).toBe(root.threadId)
    expect(reply.mockSource).toEqual(root.mockSource)
    expect(f.store.im.execution(child, false)?.source.bindingId).toBe(root.mockSource!.bindingId)
    expect(
      f.client.submitReply.mock.calls.every(([r]) => r.conversationKey === binding.conversationKey)
    ).toBe(true)
    expect(f.errors).toEqual([])
  })

  it("keeps completed group turns stoppable while their own background commands remain active", async () => {
    const f = fixture(async (task, host) => {
      host.commandLifecycle(task.id).accepted({
        id: `command-${task.id}`,
        threadId: task.threadId,
        command: "sleep 30",
        cwd: "/tmp",
        startedAt: Date.now()
      })
      return { state: "completed", result: "已在后台执行" }
    })
    const a = await f.binding()
    const b = await f.binding()
    await f.service.receive(f.event(a, "background-a"))
    await f.service.receive(f.event(b, "background-b"))
    await eventually(
      () => f.calls.length === 2 && f.store.recentTasks().every((t) => t.state === "completed")
    )
    const snapshot = f.host.snapshot()
    const own = snapshot.imConversations!.find((item) => item.bindingId === a.id)!
    const other = snapshot.imConversations!.find((item) => item.bindingId === b.id)!
    expect(snapshot.backgroundThreads).toEqual(
      expect.arrayContaining([own.threadId, other.threadId])
    )
    f.host.stopImConversation(f.bot.id, own.id)
    expect(f.cancelBackground.mock.calls).toEqual([[own.threadId]])
    const row = f.db.prepare("SELECT thread_id,suppressed FROM bot_commands ORDER BY thread_id")
    try {
      const suppressed: Record<string, unknown> = {}
      while (row.step()) {
        const value = row.getAsObject()
        suppressed[String(value.thread_id)] = value.suppressed
      }
      expect(suppressed).toEqual({ [own.threadId!]: 1, [other.threadId!]: 0 })
    } finally {
      row.free()
    }
  })

  it("keeps workflow and detached command callbacks in the IM group after ingress completion", async () => {
    const f = fixture(async (task, host) => {
      if (task.origin.kind === "mock")
        host.commandLifecycle(task.id).accepted({
          id: "im-command",
          threadId: task.threadId,
          command: "git status",
          cwd: "/tmp",
          startedAt: Date.now()
        })
      return {
        state: "completed",
        result: task.origin.kind === "mock" ? "started" : "callback-result"
      }
    })
    const binding = await f.binding()
    await f.service.receive(f.event(binding, "background"))
    await eventually(
      () => f.calls.length === 1 && f.store.getTask(f.calls[0].id).state === "completed"
    )
    const root = f.calls[0]
    f.host.commandLifecycle(root.id).settled({
      id: "im-command",
      threadId: root.threadId,
      exitCode: 0,
      output: "clean",
      cancelled: false,
      truncated: false
    })
    await eventually(() => f.calls.length >= 2)
    f.host.enqueueNotification(
      root.botId,
      root.threadId,
      "workflow",
      "wf-im",
      "workflow done",
      undefined,
      new Date().toISOString()
    )
    await eventually(() => f.calls.length === 3)
    await eventually(() => f.store.getTask(f.calls[2].id).state === "completed")
    expect(
      f.calls.every(
        (t) =>
          t.threadId === root.threadId && t.mockSource?.bindingId === root.mockSource!.bindingId
      )
    ).toBe(true)
    expect(f.errors).toEqual([])
  })

  it("persists a group routine's audience and stops it when the binding is revoked", async () => {
    let scheduleId = ""
    const f = fixture(async (task) => {
      if (task.origin.kind === "mock") {
        const schedule = f.store.saveSchedule(
          task.botId,
          {
            name: "Group reminder",
            message: "only this group",
            frequency: "interval",
            intervalMinutes: 5,
            enabled: true
          },
          new Date().toISOString(),
          undefined,
          task.id
        )
        scheduleId = schedule.id
      }
      return { state: "completed", result: "routine-result" }
    })
    const binding = await f.binding()
    await f.service.receive(f.event(binding, "routine"))
    await eventually(
      () => Boolean(scheduleId) && f.store.getTask(f.calls[0].id).state === "completed"
    )
    const schedule = f.store.schedules().find((s) => s.id === scheduleId)!
    expect(schedule.audienceKey).toBe(f.calls[0].mockSource!.audienceKey)
    f.store.fireSchedule(schedule, new Date(Date.now() + 300000).toISOString())
    f.host.resume()
    await eventually(
      () => f.calls.length === 2 && f.store.getTask(f.calls[1].id).state === "completed"
    )
    expect(f.calls[1].threadId).toBe(f.calls[0].threadId)
    expect(f.calls[1].origin.kind).toBe("schedule")
    const local = f.calls[0].mockSource!
    f.store.im.revoke(f.bot.id, local.bindingId, local.grantVersion)
    f.store.fireSchedule(f.store.schedules()[0], new Date().toISOString())
    expect(f.store.schedules()[0].enabled).toBe(false)
    expect(f.calls).toHaveLength(2)
    expect(f.errors).toEqual([])
  })

  it("creates a group Git task in the selected directory and retains it for follow-up", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bot-im-git-"))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim()
    git("init", "--quiet")
    await writeFile(join(directory, "README.md"), "local IM test")
    git("add", "README.md")
    git(
      "-c",
      "user.name=Bot Test",
      "-c",
      "user.email=bot-test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "IM workspace test"
    )
    const head = git("rev-parse", "HEAD")
    let workId = ""
    const results: string[] = []
    const resolve = vi.fn(async () => ({ kind: "directory" as const, path: directory }))
    const f = fixture(
      async (task, host) => {
        if (task.workId) {
          const work = host.getWork(task.botId, task.workId)
          results.push(
            execFileSync("git", ["log", "-1", "--format=%H"], {
              cwd: work.workspace!.path,
              encoding: "utf8"
            }).trim()
          )
          return { state: "completed", result: results.at(-1) }
        }
        const source = { taskId: task.id, callId: task.id, key: task.id }
        if (!workId) {
          const created = await host.createWork(
            {
              botId: task.botId,
              operationId: task.id,
              title: "Git review",
              goal: "Read latest commit",
              workspace: { kind: "directory", path: directory }
            },
            source
          )
          workId = created.work.id
        } else host.sendWork(source, workId, "Read latest commit again")
        return { state: "completed", result: "dispatched" }
      },
      undefined,
      () => true,
      { resolve, projects: async () => ({ items: [], nextCursor: null }) }
    )
    const binding = await f.binding("group")
    await f.service.receive(f.event(binding, "git-request", "创建任务查看指定目录的最新提交"))
    await eventually(() => results.length === 1).catch((error) => {
      throw new Error(
        JSON.stringify(
          f.store.recentTasks().map((t) => ({ state: t.state, error: t.error, workId: t.workId }))
        ) + String(error)
      )
    })
    await f.service.receive(f.event(binding, "git-follow-up", "继续检查这个任务"))
    await eventually(() => results.length === 2)
    expect(results).toEqual([head, head])
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(f.host.getWork(f.bot.id, workId).workspace?.path).toBe(directory)
    expect(f.host.listWorks(f.bot.id).items).toEqual([])
    const group = f.host.snapshot().imConversations![0]
    expect(f.host.imConversationWorks(f.bot.id, group.id).items.map((w) => w.id)).toEqual([workId])
    expect(f.host.browserScope(`im-${group.id}--${f.bot.id}`)).toBe(`im-${group.id}--${f.bot.id}`)
    expect(f.host.browserScope(`work-${workId}--${f.bot.id}`)).toBe(`work-${workId}--${f.bot.id}`)
    expect(() => f.host.browserScope(`im-unknown--${f.bot.id}`)).toThrow()
    expect(f.errors).toEqual([])
  })
  it("routes an IM answer around a waiting Bot run and deduplicates redelivery", async () => {
    interactionCommand.mockClear()
    const f = fixture(async (_task, _host, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      )
      return { state: "failed" }
    })
    const binding = await f.binding()
    await f.service.receive(f.event(binding, "question", "帮我安排会议"))
    await eventually(() => f.calls.length === 1)
    const answer = f.event(binding, "answer", "/回答 A1B2C3 1")
    await f.service.receive(answer)
    await f.service.receive(answer)
    expect(interactionCommand).toHaveBeenCalledTimes(1)
    expect(interactionCommand).toHaveBeenCalledWith(
      answer,
      "owner",
      botImScopeId("realm", "owner", "answer")
    )
    expect(f.calls).toHaveLength(1)
    expect(f.client.sendAcknowledgement).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "answer", type: "completed" })
    )
    expect(f.errors).toEqual([])
  })
  it.each(["dm", "group"] as const)(
    "sends Markdown for %s without changing segment identity on explicit downgrade",
    async (kind) => {
      const f = fixture(),
        binding = await f.binding(kind)
      f.client.supportsMarkdownReplies.mockReturnValue(true)
      const rejection = Object.assign(new Error("old node"), { reasonCode: "INVALID_PAYLOAD" })
      f.client.submitReply.mockRejectedValueOnce(rejection)
      await f.service.receive(f.event(binding, "markdown", "**加粗** 与表格"))
      await eventually(() => f.client.submitReply.mock.calls.length === 2)
      const [markdown, fallback] = f.client.submitReply.mock.calls.map(([reply]) => reply)
      expect(markdown.message.type).toBe("markdown")
      expect(fallback).toEqual({ ...markdown, message: { ...markdown.message, type: "text" } })
      expect(fallback.conversationKey).toBe(binding.conversationKey)
      expect(f.calls).toHaveLength(1)
    }
  )
  it("exposes retained groups separately from private previews and keeps read boundaries scoped", async () => {
    const f = fixture(),
      a = await f.binding(),
      b = await f.binding()
    f.remote.set(a.id, { ...a, peerLabel: "项目协作群" })
    await f.service.list(f.bot.id)
    await f.service.receive(f.event(a, "group-a", "A 群的消息"))
    await f.service.receive(f.event(b, "group-b", "B 群的消息"))
    await eventually(
      () =>
        f.calls.length === 2 &&
        f.calls.every((task) => f.store.getTask(task.id).state === "completed")
    )
    const groups = f.host.snapshot().imConversations!
    expect(groups).toHaveLength(2)
    const first = groups.find((item) => item.bindingId === a.id)!
    const second = groups.find((item) => item.bindingId === b.id)!
    expect(first.title).toBe("项目协作群")
    expect(first.activity.preview).toBe("reply:A 群的消息")
    expect(first.activity.unread).toBe(true)
    expect(
      f.store.activities().find((item) => item.kind === "bot" && item.id === f.bot.id)?.preview ??
        ""
    ).not.toContain("群的消息")
    f.host.markRead("im", first.id, first.activity.version)
    expect(
      f.host.snapshot().imConversations!.find((item) => item.id === first.id)?.activity.unread
    ).toBe(false)
    expect(
      f.host.snapshot().imConversations!.find((item) => item.id === second.id)?.activity.unread
    ).toBe(true)
    await f.service.receive(f.event(a, "later", "新的消息"))
    await eventually(
      () => f.calls.length === 3 && f.store.getTask(f.calls[2].id).state === "completed"
    )
    f.host.markRead("im", first.id, first.activity.version)
    expect(
      f.host.snapshot().imConversations!.find((item) => item.id === first.id)?.activity.unread
    ).toBe(true)
    await f.service.revoke(f.bot.id, a.id, a.version)
    f.service.disconnected()
    const retained = f.host.snapshot().imConversations!.find((item) => item.id === first.id)!
    expect(retained.state).toBe("revoked")
    expect(retained.connected).toBe(false)
    expect(
      f.host.imConversationHistory(f.bot.id, first.id).items.map((entry) => entry.text)
    ).toContain("A 群的消息")
    expect(
      f.host
        .imConversationHistory(f.bot.id, first.id)
        .items.some((entry) => entry.text.includes("B 群"))
    ).toBe(false)
    const other = f.store.create({
      name: "Other",
      color: "#123456",
      instructions: "",
      modelRef: null
    })
    expect(() => f.host.imConversationHistory(other.id, first.id)).toThrow("不存在")
    expect(() => f.host.imConversationWorks(other.id, first.id)).toThrow("不存在")
    expect(() => f.host.markRead("im", "unknown", 1)).toThrow("不存在")
  })

  it("upgrades old group previews without replaying messages or rewriting history", async () => {
    const f = fixture(),
      binding = await f.binding()
    await f.service.receive(f.event(binding, "old", "旧群消息"))
    await eventually(
      () => f.calls.length === 1 && f.store.getTask(f.calls[0].id).state === "completed"
    )
    const group = f.host.snapshot().imConversations![0]
    const before = f.host.imConversationHistory(f.bot.id, group.id).items
    f.db.run("DELETE FROM bot_activity WHERE kind='im'")
    f.db.run("INSERT OR REPLACE INTO bot_activity VALUES('bot',?,9,9,4,?,'reply:旧群消息')", [
      f.bot.id,
      Date.now()
    ])
    const restored = new BotStore(f.db)
    expect(restored.imGateway.groupConversations()[0].activity.preview).toBe("reply:旧群消息")
    expect(restored.activities().find((item) => item.id === f.bot.id)?.preview).toBe("")
    expect(restored.imConversationHistory(f.bot.id, group.id).items).toEqual(before)
    const version = restored.imGateway.groupConversations()[0].activity.version
    const restarted = new BotStore(f.db)
    expect(restarted.imGateway.groupConversations()[0].activity.version).toBe(version)
    expect(f.calls).toHaveLength(1)
  })

  it("scopes group work lists and unread clocks without changing private or simulated works", async () => {
    const f = fixture(async (task, host) => {
      if (!task.workId)
        await host.createWork(
          { botId: task.botId, operationId: task.id, title: task.message, goal: "Write notice" },
          { taskId: task.id, callId: task.id, key: task.id }
        )
      return { state: "completed", result: `done:${task.message}` }
    })
    const a = await f.binding(),
      b = await f.binding()
    await f.service.receive(f.event(a, "a", "A 群任务"))
    await f.service.receive(f.event(b, "b", "B 群任务"))
    await eventually(
      () =>
        f.calls.length === 4 && f.store.recentTasks().every((task) => task.state === "completed")
    )
    const groups = f.host.snapshot().imConversations!
    const first = groups.find((item) => item.bindingId === a.id)!
    const second = groups.find((item) => item.bindingId === b.id)!
    const aWorks = f.host.imConversationWorks(f.bot.id, first.id)
    expect(aWorks.items.map((work) => work.title)).toEqual(["A 群任务"])
    expect(f.host.imConversationWorks(f.bot.id, second.id).items.map((work) => work.title)).toEqual(
      ["B 群任务"]
    )
    expect(f.host.imConversationWorks(f.bot.id, first.id, undefined, "B 群").items).toEqual([])
    expect(aWorks.items[0].activity?.unread).toBe(true)
    expect(f.store.workActivities()).toEqual([])
    const clock = f.db.exec("SELECT version FROM bot_activity WHERE kind='work-bot'")[0]
      .values[0][0] as number
    f.host.markWorksRead(f.bot.id, clock)
    expect(f.host.imConversationWorks(f.bot.id, first.id).items[0].activity?.unread).toBe(true)
    f.host.markRead("work", aWorks.items[0].id, aWorks.items[0].activity!.version)
    expect(f.host.imConversationWorks(f.bot.id, first.id).items[0].activity?.unread).toBe(false)
    expect(f.host.imConversationWorks(f.bot.id, second.id).items[0].activity?.unread).toBe(true)
    expect(f.errors).toEqual([])
  })

  it.each(["dm", "group"] as const)(
    "runs a wire-valid opaque sender once in %s and preserves its frozen source",
    async (kind) => {
      const f = fixture(undefined, "binding:synthetic"),
        binding = await f.binding(kind),
        input = f.event(binding)
      input.route.senderId = "employee:42"
      assertBotImBinding(binding)
      assertBotImEvent(input)
      await f.service.receive(input)
      await f.service.receive({ ...input, event: { ...input.event, redelivered: true } })
      const eventId = botImScopeId("realm", "owner", input.event.eventId)
      await eventually(() => f.store.imGateway.event(eventId)?.state === "completed")
      await f.service.receive({ ...input, event: { ...input.event, redelivered: true } })
      expect(f.calls).toHaveLength(1)
      const saved = f.store.getTask(f.calls[0].id),
        senderId = botImScopeId("realm", "owner", "employee:42")
      expect(saved.mockSource).toMatchObject({ senderId, transport: "im" })
      expect(f.store.im.execution(saved, false)?.source).toEqual(saved.mockSource)
      expect(f.store.imGateway.event(eventId)?.payload.route.senderId).toBe("employee:42")
      expect(f.service.history(f.bot.id, binding.id).items).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "user", senderId })])
      )
      expect(saved.threadId === f.bot.threadId).toBe(kind === "dm")
      expect(f.client.acquireBotPermit).toHaveBeenCalledTimes(1)
      expect(f.client.sendAcknowledgement.mock.calls.at(-1)?.[0]).toMatchObject({
        type: "completed"
      })
      expect(f.errors).toEqual([])
    }
  )

  it("isolates the same external sender across realms and authenticated principals", async () => {
    const f = fixture(),
      binding = await f.binding(),
      input = f.event(binding),
      services: BotImChannelService[] = []
    input.route.senderId = "employee:42"
    try {
      await f.service.receive(input)
      for (const [realm, principal] of [
        ["other-realm", "owner"],
        ["realm", "other-owner"]
      ]) {
        const client = {
          ...f.client,
          getStatus: () =>
            ({ principalId: principal }) as ReturnType<BotImGatewayClient["getStatus"]>
        }
        const service = new BotImChannelService(client, realm, () => f.host)
        services.push(service)
        await service.list(f.bot.id)
        await service.receive({ ...input, event: { ...input.event, principalId: principal } })
      }
      await eventually(() => f.calls.length === 3)
      expect(new Set(f.calls.map((task) => task.mockSource?.senderId))).toEqual(
        new Set([
          botImScopeId("realm", "owner", input.route.senderId),
          botImScopeId("other-realm", "owner", input.route.senderId),
          botImScopeId("realm", "other-owner", input.route.senderId)
        ])
      )
      expect(new Set(f.calls.map((task) => task.mockSource?.bindingId)).size).toBe(3)
      expect(f.errors).toEqual([])
    } finally {
      services.forEach((service) => service.stop())
    }
  })

  it("keeps existing unscoped sender sources readable and redelivery idempotent", async () => {
    const f = fixture(),
      binding = await f.binding(),
      input = f.event(binding),
      ingress = f.store.imGateway.receive("realm", "owner", input)
    f.store.imGateway.settle(ingress.id, "active", undefined, Date.now() + 90000)
    // Reproduce the persisted source made by the previous adapter, without rewriting it.
    const accepted = f.host.acceptImEvent({
      bindingId: ingress.bindingId,
      eventId: ingress.id,
      messageId: botImScopeId("realm", "owner", input.event.platformMessageId),
      senderId: input.route.senderId,
      text: input.event.message.text,
      mentionsBotIds: [f.bot.id]
    })
    f.store.imGateway.settle(ingress.id, "active", accepted.taskId!)
    await f.service.receive({ ...input, event: { ...input.event, redelivered: true } })
    await eventually(() => f.store.imGateway.event(ingress.id)?.state === "completed")
    expect(f.calls).toHaveLength(1)
    const saved = f.store.getTask(accepted.taskId!)
    expect(saved.mockSource?.senderId).toBe("member-a")
    expect(f.store.im.execution(saved, false)?.source).toEqual(saved.mockSource)
    expect(f.errors).toEqual([])
  })

  it.each(["completed", "failed", "outcome_unknown"] as const)(
    "preserves the actual %s execution outcome in the gateway acknowledgement without replay",
    async (state) => {
      const f = fixture(async () => ({ state, result: "execution result" }))
      const binding = await f.binding(),
        input = f.event(binding)
      await f.service.receive(input)
      await eventually(() =>
        f.client.sendAcknowledgement.mock.calls.some(
          ([ack]) => ack.type === "completed" || ack.type === "failed"
        )
      )
      const ack = f.client.sendAcknowledgement.mock.calls.at(-1)![0]
      expect(ack).toMatchObject(
        state === "completed"
          ? { type: "completed" }
          : {
              type: "failed",
              retryable: false,
              reasonCode:
                state === "outcome_unknown" ? "EVENT_OUTCOME_UNKNOWN" : "BOT_EXECUTION_FAILED"
            }
      )
      expect(f.store.imGateway.event(botImScopeId("realm", "owner", "event"))?.state).toBe(
        state === "outcome_unknown" ? "unknown" : state === "completed" ? "completed" : "failed"
      )
      await f.service.receive({ ...input, event: { ...input.event, redelivered: true } })
      expect(f.calls).toHaveLength(1)
      expect(f.errors).toEqual([])
    }
  )
  it("shares owner DM with the main thread, isolates groups, and deduplicates received events", async () => {
    const f = fixture(),
      dm = await f.binding("dm"),
      group = await f.binding()
    // Upgraded bindings may already have an initialized, separate channel history.
    f.db.run("UPDATE bot_im_conversations SET initialized=1")
    const input = f.event(group)
    assertBotImEvent(input)
    await f.service.receive(input)
    await f.service.receive({ ...input, event: { ...input.event, redelivered: true } })
    await f.service.receive(f.event(dm, "dm"))
    await eventually(() => f.calls.length === 2 && f.client.submitReply.mock.calls.length === 2)
    expect(new Set(f.calls.map((task) => task.threadId)).size).toBe(2)
    expect(f.calls.every((task) => task.mockSource?.transport === "im")).toBe(true)
    expect(f.calls[0].threadId).not.toBe(f.bot.threadId)
    expect(f.calls[0].mockSource?.personal).toBeUndefined()
    expect(f.calls[1]).toMatchObject({
      threadId: f.bot.threadId,
      mockSource: { personal: true, audienceKey: "desktop" }
    })
    expect(f.store.im.execution(f.calls[1], false)?.threadInitialized).toBe(false)
    expect(() => parseBotMockSource(f.calls[0].mockSource)).toThrow("真实 IM")
    expect(buildBotPrompt(f.bot, f.calls[0], "/unused")).toContain("authenticated IM")
    expect(buildBotPrompt(f.bot, f.calls[0], "/unused")).not.toContain("simulated")
    expect(f.client.submitReply.mock.calls.map(([reply]) => reply.conversationKey).sort()).toEqual(
      [dm.conversationKey, group.conversationKey].sort()
    )
    expect(f.store.mock.bindings(f.bot.id).items).toHaveLength(0)
    expect(f.errors).toEqual([])
  })

  it("mirrors only new main-thread replies to the owner's DM, never to groups", async () => {
    const f = fixture()
    f.host.send({ botId: f.bot.id, requestId: "before", message: "before binding" })
    await eventually(() => f.store.recentTasks()[0]?.state === "completed")
    const dm = await f.binding("dm"),
      group = await f.binding()
    f.host.send({ botId: f.bot.id, requestId: "after", message: "from App" })
    await eventually(() => f.client.submitReply.mock.calls.length === 1)
    expect(f.calls.map((t) => t.threadId)).toEqual([f.bot.threadId, f.bot.threadId])
    expect(f.client.submitReply.mock.calls[0][0].conversationKey).toBe(dm.conversationKey)
    expect(f.service.history(f.bot.id, dm.id).items.map((i) => i.text)).toEqual(["reply:from App"])
    expect(f.service.history(f.bot.id, group.id).items).toEqual([])
    expect(f.host.snapshot().personalIm).toEqual([{ botId: f.bot.id, connected: true }])
    expect(f.errors).toEqual([])
  })

  it("shares personal tasks across DM and App, reports results once, and keeps group tasks separate", async () => {
    let workId = ""
    const f = fixture(async (task, host) => {
      if (task.origin.kind === "work_result")
        return { state: "completed", result: `report:${JSON.parse(task.message).result}` }
      if (task.workId) return { state: "completed", result: `notice:${task.message}` }
      const source = { taskId: task.id, callId: task.id, key: task.id }
      if (task.message === "create") {
        workId = (
          await host.createWork(
            { botId: task.botId, operationId: task.id, title: "通知", goal: "Sunday" },
            source
          )
        ).work.id
      } else if (task.message === "revise") {
        expect(host.workTargets(task.id).items.map((w) => w.id)).toContain(workId)
        host.sendWork(source, workId, task.mockSource ? "from DM" : "from App")
      } else if (task.message === "group") {
        expect(host.workTargets(task.id).items.map((w) => w.id)).not.toContain(workId)
        expect(() => host.sendWork(source, workId, "group edit")).toThrow()
      } else if (task.message === "complete") {
        await host.changeWorkFromTool(
          source,
          workId,
          host.getWork(task.botId, workId).version,
          "complete"
        )
      }
      return { state: "completed", result: `handled:${task.message}` }
    })
    const dm = await f.binding("dm"),
      group = await f.binding()
    await f.service.receive(f.event(dm, "create", "create"))
    await eventually(
      () => f.calls.length === 3 && f.store.recentTasks().every((t) => t.state === "completed")
    )
    const work = f.host.getWork(f.bot.id, workId)
    expect(work).toMatchObject({
      audienceKey: "desktop",
      parentThreadId: f.bot.threadId,
      state: "active"
    })
    expect(work.source).toBeUndefined()
    f.host.send({ botId: f.bot.id, requestId: "desktop-edit", message: "revise" })
    await eventually(
      () => f.calls.length === 6 && f.store.recentTasks().every((t) => t.state === "completed")
    )
    await f.service.receive(f.event(dm, "dm-edit", "revise"))
    await eventually(
      () => f.calls.length === 9 && f.store.recentTasks().every((t) => t.state === "completed")
    )
    await f.service.receive(f.event(group, "group", "group"))
    await f.service.receive(f.event(dm, "complete", "complete"))
    await eventually(() => f.host.getWork(f.bot.id, workId).state === "completed")
    const runs = f.calls.filter((t) => t.workId)
    expect(runs.map((t) => t.workId)).toEqual([workId, workId, workId])
    expect(runs.map((t) => t.threadId)).toEqual([work.threadId, work.threadId, work.threadId])
    expect(runs.map((t) => Boolean(t.mockSource?.personal))).toEqual([true, false, true])
    expect(f.calls.filter((t) => t.origin.kind === "work_result")).toHaveLength(3)
    const replies = f.service.history(f.bot.id, dm.id).items.filter((i) => i.kind === "bot")
    expect(replies.filter((i) => i.text.startsWith("notice:"))).toHaveLength(0)
    expect(replies.filter((i) => i.text.startsWith("report:"))).toHaveLength(3)
    expect(replies.every((i) => i.text !== "handled:group")).toBe(true)
    expect(f.errors).toEqual([])
  })

  it("queues DM and App turns on the same thread without steering across capability boundaries", async () => {
    let finish: (() => void) | undefined
    const f = fixture(async (task) => {
      if (task.message === "App first")
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      return { state: "completed", result: "Done" }
    })
    const dm = await f.binding("dm")
    f.host.send({ botId: f.bot.id, requestId: "first", message: "App first" })
    await eventually(() => f.calls.length === 1)
    await f.service.receive(f.event(dm, "second", "DM second"))
    const remote = f.store.recentTasks().find((t) => t.mockSource)!
    expect(remote).toMatchObject({ state: "queued", threadId: f.bot.threadId })
    expect(canSteerBotTask(f.calls[0], remote)).toBe(false)
    expect(canSteerBotTask(remote, { ...f.calls[0], origin: { kind: "user" } })).toBe(false)
    finish!()
    await eventually(
      () => f.calls.length === 2 && f.store.recentTasks().every((t) => t.state === "completed")
    )
    expect(f.errors).toEqual([])
  })

  it("keeps an offline App reply durable and blocks it if the binding is revoked", async () => {
    const f = fixture(),
      dm = await f.binding("dm")
    f.service.disconnected()
    f.host.send({ botId: f.bot.id, requestId: "offline", message: "offline" })
    await eventually(() => f.store.recentTasks()[0]?.state === "completed")
    expect(f.host.snapshot().personalIm).toEqual([{ botId: f.bot.id, connected: false }])
    expect(f.service.history(f.bot.id, dm.id).items[0]).toMatchObject({
      text: "reply:offline",
      state: "pending"
    })
    expect(f.store.im.beginDelivery()).toBeNull()
    await f.service.revoke(f.bot.id, dm.id, dm.version)
    expect(f.service.history(f.bot.id, dm.id).items[0].state).toBe("blocked")
    expect(f.host.snapshot().personalIm).toEqual([])
    expect(f.client.submitReply).not.toHaveBeenCalled()
    expect(f.errors).toEqual([])
  })

  it("does not push an in-flight App reply to a newly bound destination", async () => {
    const f = fixture(),
      task = f.store.enqueue({ botId: f.bot.id, requestId: "old", message: "old request" })
    f.db.run("UPDATE bot_tasks SET created_at=1 WHERE id=?", [task.id])
    f.store.transition(task.id, "running")
    const dm = await f.binding("dm")
    f.store.settle(task.id, "completed", null, "old reply")
    expect(f.service.history(f.bot.id, dm.id).items).toEqual([])
  })

  it("notifies the owner once when a desktop main turn is interrupted by restart", async () => {
    const f = fixture(),
      dm = await f.binding("dm")
    f.service.disconnected()
    const task = f.store.enqueue({
      botId: f.bot.id,
      requestId: "restart-main",
      message: "App work"
    })
    f.store.transition(task.id, "running")
    const reopened = new BotStore(f.db)
    reopened.recover()
    const replies = reopened.im.history(f.bot.id, botImScopeId("realm", "owner", dm.id)).items
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ kind: "bot", state: "pending" })
    expect(replies[0].text).toContain("应用已重启")
    reopened.recover()
    expect(reopened.im.history(f.bot.id, botImScopeId("realm", "owner", dm.id)).items).toHaveLength(
      1
    )
    expect(f.calls).toHaveLength(0)
  })

  it.each(["dm", "group"] as const)(
    "settles an admitted queued %s turn after restart without reacquiring its old permit",
    async (kind) => {
      const f = fixture(undefined, undefined, () => false)
      const binding = await f.binding(kind)
      await f.service.receive(f.event(binding, "busy", "IM first"))
      const busy = f.store.getTask(
        f.store.imGateway.event(botImScopeId("realm", "owner", "busy"))!.taskId!
      )
      f.store.transition(busy.id, "running")
      const input = f.event(binding, "restart-queued", "IM second")
      await f.service.receive(input)
      const eventId = botImScopeId("realm", "owner", input.event.eventId),
        taskId = f.store.imGateway.event(eventId)!.taskId!,
        task = f.store.getTask(taskId)
      expect(task.state).toBe("queued")
      expect(task.threadId === f.bot.threadId).toBe(kind === "dm")
      expect(f.store.nextQueued([])).toBeNull()
      expect(f.calls).toHaveLength(0)
      // Rebuild before graceful shutdown: a process crash does not run service.stop(),
      // which intentionally cancels live permits instead of leaving a restart queue.
      const reopened = new BotStore(f.db)
      f.service.stop()
      await f.host.stop()
      reopened.recover()
      reopened.im.setOnline(f.bot.id, task.mockSource!.bindingId, true)
      while (reopened.im.recoverInterruptedBatch()) {}
      expect(reopened.imGateway.event(eventId)).toMatchObject({ state: "unknown", expiresAt: 0 })
      expect(reopened.getTask(taskId)).toMatchObject({ state: "interrupted" })
      expect(reopened.pendingTasksForThread(task.threadId)).toEqual([])
      expect(
        reopened.im
          .history(f.bot.id, task.mockSource!.bindingId)
          .items.filter(
            (item) =>
              item.kind === "bot" &&
              item.replyToMessageId === task.mockSource!.messageId &&
              item.text.includes("不会自动重复执行")
          )
      ).toHaveLength(1)
      const reply = reopened.im.beginDelivery()!
      expect(reply.sourceTaskId === taskId || reply.sourceTaskId === busy.id).toBe(true)
      const rows = f.db.exec("SELECT source_task_id FROM bot_im_outbox")[0].values
      expect(rows.filter(([id]) => id === taskId)).toHaveLength(1)
      reopened.recover()
      while (reopened.im.recoverInterruptedBatch()) {}
      expect(
        f.db
          .exec("SELECT source_task_id FROM bot_im_outbox")[0]
          .values.filter(([id]) => id === taskId)
      ).toHaveLength(1)
      expect(reopened.nextQueued([])).toBeNull()
      const acquire = vi.fn(() => null),
        host = new LocalBotHost(reopened, { onAvailable: () => () => {}, acquire }),
        service = new BotImChannelService(f.client, "realm", () => host)
      try {
        await service.receive({ ...input, event: { ...input.event, redelivered: true } })
        expect(f.client.sendAcknowledgement.mock.calls.at(-1)?.[0]).toMatchObject({
          type: "failed",
          eventId: input.event.eventId
        })
        expect(acquire).not.toHaveBeenCalled()
      } finally {
        service.stop()
        await host.stop()
      }
      expect(f.client.acquireBotPermit).toHaveBeenCalledTimes(2)
      expect(f.calls).toHaveLength(0)
      expect(f.errors).toEqual([])
    }
  )

  it.each(["dm", "group"] as const)(
    "records a queued %s work interruption once through its existing result channel",
    async (kind) => {
      const f = fixture(),
        binding = await f.binding(kind)
      // Keep the host idle while constructing the same admitted source and child a turn creates.
      f.service.stop()
      await f.host.stop()
      const input = f.event(binding, "restart-work", "Create work"),
        event = f.store.imGateway.receive("realm", "owner", input)
      f.store.im.setOnline(f.bot.id, event.bindingId, true)
      f.store.imGateway.settle(event.id, "active", undefined, Date.now() + 90000)
      const receipt = f.store.im.inject({
        simulation: true,
        bindingId: event.bindingId,
        eventId: event.id,
        messageId: botImScopeId("realm", "owner", input.event.platformMessageId),
        senderId: botImScopeId("realm", "owner", input.route.senderId),
        text: input.event.message.text,
        mentionsBotIds: [f.bot.id]
      })
      f.store.imGateway.settle(event.id, "active", receipt.taskId!)
      f.store.transition(receipt.taskId!, "running")
      const work = f.store.createWork(
        { botId: f.bot.id, operationId: "restart-work", title: "Synthetic", goal: "Finish work" },
        { taskId: receipt.taskId!, callId: "create", key: "create" }
      )
      f.store.settle(receipt.taskId!, "completed", null, "Work admitted")
      expect(work.task.state).toBe("queued")
      expect(f.store.nextQueued([])?.id).toBe(work.task.id)

      const reopened = new BotStore(f.db)
      reopened.recover()
      while (reopened.im.recoverInterruptedBatch()) {}
      expect(reopened.getTask(work.task.id).state).toBe("interrupted")
      expect(reopened.pendingTasksForThread(work.work.threadId)).toEqual([])
      if (kind === "dm") {
        const outbox = f.db.exec("SELECT task_id,message FROM bot_reply_outbox")[0].values
        expect(outbox).toHaveLength(1)
        expect(outbox[0][0]).toBe(work.task.id)
        expect(JSON.parse(String(outbox[0][1]))).toMatchObject({
          executionState: "interrupted",
          pendingExecution: false
        })
        reopened.flushReplies()
        const reports = reopened
          .recentTasks()
          .filter(
            (task) =>
              task.origin.kind === "work_result" && task.origin.executionTaskId === work.task.id
          )
        expect(reports).toHaveLength(1)
        reopened.recover()
        while (reopened.im.recoverInterruptedBatch()) {}
        reopened.flushReplies()
        expect(
          reopened
            .recentTasks()
            .filter(
              (task) =>
                task.origin.kind === "work_result" && task.origin.executionTaskId === work.task.id
            )
        ).toHaveLength(1)
        expect(
          f.db
            .exec("SELECT source_task_id FROM bot_im_outbox")[0]
            .values.filter(([id]) => id === work.task.id)
        ).toHaveLength(0)
      } else {
        expect(
          f.db
            .exec("SELECT source_task_id FROM bot_im_outbox")[0]
            .values.filter(([id]) => id === work.task.id)
        ).toHaveLength(1)
        reopened.recover()
        while (reopened.im.recoverInterruptedBatch()) {}
        expect(
          f.db
            .exec("SELECT source_task_id FROM bot_im_outbox")[0]
            .values.filter(([id]) => id === work.task.id)
        ).toHaveLength(1)
      }
      expect(f.calls).toHaveLength(0)
      expect(f.errors).toEqual([])
    }
  )

  it("preserves queued App, mock and separately authorized local IM work on restart", async () => {
    const f = fixture(),
      binding = await f.binding("group")
    f.service.stop()
    await f.host.stop()
    const input = f.event(binding, "local-work", "Create work"),
      event = f.store.imGateway.receive("realm", "owner", input)
    f.store.im.setOnline(f.bot.id, event.bindingId, true)
    f.store.imGateway.settle(event.id, "active", undefined, Date.now() + 90000)
    const receipt = f.store.im.inject({
      simulation: true,
      bindingId: event.bindingId,
      eventId: event.id,
      messageId: input.event.platformMessageId,
      senderId: input.route.senderId,
      text: input.event.message.text,
      mentionsBotIds: [f.bot.id]
    })
    f.store.imGateway.settle(event.id, "active", receipt.taskId!)
    f.store.transition(receipt.taskId!, "running")
    const work = f.store.createWork(
      { botId: f.bot.id, operationId: "local-work", title: "Synthetic", goal: "Finish work" },
      { taskId: receipt.taskId!, callId: "create", key: "create" }
    )
    f.store.settle(receipt.taskId!, "completed", null, "Work admitted")
    f.store.transition(work.task.id, "running")
    f.store.settle(work.task.id, "completed", null, "First part done")
    const local = f.store.enqueue({
      botId: f.bot.id,
      workId: work.work.id,
      requestId: "local-followup",
      message: "Continue here"
    })
    f.store.transition(local.id, "running")
    const localChild = f.store.sendWork(
      { taskId: local.id, callId: "local-edit", key: "local-edit" },
      work.work.id,
      "Continue the local request"
    )
    f.store.settle(local.id, "completed", null, "Followup admitted")
    const localQueued = f.store.enqueue({
      botId: f.bot.id,
      workId: work.work.id,
      requestId: "local-queued",
      message: "Keep queued"
    })
    const app = f.store.enqueue({
        botId: f.bot.id,
        requestId: "app-queued",
        message: "App queued"
      }),
      checkpoint = f.store.enqueue(
        { botId: f.bot.id, requestId: "checkpoint", message: "Original long task checkpoint" },
        { kind: "schedule", scheduleId: "synthetic-schedule" }
      )
    f.store.transition(checkpoint.id, "running")
    f.store.deferTask(checkpoint.id, "synthetic-checkpoint")
    const mockBinding = f.store.mock.create({
        simulation: true,
        botId: f.bot.id,
        operationId: "mock",
        kind: "dm",
        channelKey: "mock",
        label: "Synthetic",
        allowedSenderIds: ["alice"]
      }),
      mock = f.store.mock.inject({
        simulation: true,
        bindingId: mockBinding.id,
        eventId: "mock-event",
        messageId: "mock-message",
        senderId: "alice",
        text: "Mock queued",
        mentionsBotIds: []
      })
    const localIds = [localChild.id, localQueued.id]
    expect(
      f.db.exec("SELECT task_id FROM bot_im_local_execution")[0].values.map(([id]) => id)
    ).toEqual(expect.arrayContaining(localIds))

    const reopened = new BotStore(f.db)
    reopened.recover()
    reopened.im.setOnline(f.bot.id, event.bindingId, true)
    while (reopened.im.recoverInterruptedBatch()) {}
    while (reopened.mock.recoverInterruptedBatch()) {}
    for (const id of [app.id, mock.taskId!, ...localIds])
      expect(reopened.getTask(id).state).toBe("queued")
    for (const id of localIds)
      expect(reopened.im.execution(reopened.getTask(id))?.source.transport).toBe("im")
    expect(reopened.getTask(checkpoint.id).state).toBe("interrupted")
    expect(reopened.imGateway.event(event.id)?.state).toBe("unknown")
    const executed: string[] = [],
      host = new LocalBotHost(reopened, {
        onAvailable: () => () => {},
        acquire: (_bot, task) => ({
          release() {},
          execute: async () => {
            executed.push(task.id)
            if (task.mockSource) reopened.external(task.mockSource).execution(task)
            return { state: "completed", result: "Synthetic completed" }
          }
        })
      })
    try {
      for (const id of [app.id, mock.taskId!, ...localIds]) {
        await eventually(() => reopened.getTask(id).state === "completed")
        expect(executed.filter((taskId) => taskId === id)).toHaveLength(1)
      }
      expect(executed).not.toContain(checkpoint.id)
      expect(executed).not.toContain(receipt.taskId)
      expect(executed).not.toContain(work.task.id)
    } finally {
      await host.stop()
    }
    expect(f.calls).toHaveLength(0)
    expect(f.client.acquireBotPermit).not.toHaveBeenCalled()
    expect(f.errors).toEqual([])
  })

  it("reports a queued personal work cancellation to the App after its IM binding is revoked", async () => {
    const f = fixture(),
      dm = await f.binding("dm"),
      input = f.event(dm, "revoke-queued-work", "create")
    const event = f.store.imGateway.receive("realm", "owner", input)
    f.store.imGateway.settle(event.id, "active", undefined, Date.now() + 90000)
    const parent = f.store.im.inject({
      simulation: true,
      bindingId: event.bindingId,
      eventId: event.id,
      messageId: input.event.platformMessageId,
      senderId: input.route.senderId,
      text: "create",
      mentionsBotIds: [f.bot.id]
    })
    f.store.imGateway.settle(event.id, "active", parent.taskId!)
    f.store.transition(parent.taskId!, "running")
    const work = f.store.createWork(
      { botId: f.bot.id, operationId: "cancel-work", title: "通知", goal: "notice" },
      { taskId: parent.taskId!, callId: "create", key: "create" }
    )
    await f.service.revoke(f.bot.id, dm.id, dm.version)
    expect(f.store.getTask(work.task.id).state).toBe("cancelled")
    f.store.flushReplies()
    const reports = f.store
      .recentTasks()
      .filter(
        (task) => task.origin.kind === "work_result" && task.origin.executionTaskId === work.task.id
      )
    expect(reports).toHaveLength(1)
    expect(JSON.parse(reports[0].message)).toMatchObject({ executionState: "cancelled" })
    expect(f.client.submitReply).not.toHaveBeenCalled()
  })

  it("keeps the same outbox identity on recovery and mirrors one physical reply for steered App inputs", async () => {
    const f = fixture(),
      dm = await f.binding("dm")
    const first = f.store.enqueue({ botId: f.bot.id, requestId: "one", message: "one" })
    f.store.transition(first.id, "running")
    const second = f.store.enqueue({ botId: f.bot.id, requestId: "two", message: "two" })
    f.store.injectIntoRun(second.id, first.id)
    f.store.settleRun(first.id, [second.id], "completed", null, "combined reply")
    expect(f.service.history(f.bot.id, dm.id).items).toHaveLength(1)
    const queued = f.store.im.beginDelivery()!
    expect(queued.text).toBe("combined reply")
    const reopened = new BotStore(f.db)
    reopened.recover()
    expect(reopened.im.beginDelivery()).toBeNull()
    reopened.im.setOnline(f.bot.id, queued.bindingId, true)
    const retry = reopened.im.beginDelivery()!
    expect(retry.id).toBe(queued.id)
    reopened.im.delivered(retry.id, "accepted")
    reopened.settle(first.id, "completed", null, "duplicate settlement")
    expect(reopened.im.beginDelivery()).toBeNull()
    expect(f.calls).toHaveLength(0)
  })

  it("rejects an owner identity/realm switch and personal proofs on group or mock bindings", async () => {
    const f = fixture(),
      dm = await f.binding("dm"),
      group = await f.binding()
    expect(() =>
      f.store.imGateway.register("realm", "someone-else", { ...dm, id: "other" })
    ).toThrow("另一登录身份")
    expect(() =>
      f.store.imGateway.register("other-realm", "owner", { ...dm, id: "other" })
    ).toThrow("另一登录身份")
    await f.service.receive(f.event(group))
    await eventually(() => f.calls.length === 1)
    const forged = { ...f.calls[0].mockSource!, personal: true as const, audienceKey: "desktop" }
    expect(() => f.store.im.validateSource(forged, f.bot.id)).toThrow("未经身份验证")
    expect(() => parseBotMockSource(forged)).toThrow("真实 IM")
    expect(f.errors).toEqual([])
  })

  it.each(["member-a", "employee:42"])(
    "creates, revises and continues work with frozen sender %s",
    async (sender) => {
      let workId = ""
      const f = fixture(async (task, host) => {
        if (task.workId) return { state: "completed", result: `notice:${task.message}` }
        const source = { taskId: task.id, callId: task.id, key: task.id }
        if (task.message === "create") {
          workId = (
            await host.createWork(
              { botId: task.botId, operationId: task.id, title: "周末通知", goal: "Write notice" },
              source
            )
          ).work.id
        } else if (task.message === "revise") host.sendWork(source, workId, "Change to Sunday")
        else if (task.message === "complete" || task.message === "continue")
          await host.changeWorkFromTool(
            source,
            workId,
            host.getWork(task.botId, workId).version,
            task.message
          )
        return { state: "completed", result: `handled:${task.message}` }
      })
      const b = await f.binding()
      const event = (id: string) => {
        const input = f.event(b, id, id)
        input.route.senderId = sender
        return input
      }
      await f.service.receive(event("create"))
      await eventually(
        () => f.calls.length === 2 && f.store.recentTasks().every((t) => t.state === "completed")
      )
      await f.service.receive(event("revise"))
      await eventually(
        () => f.calls.length === 4 && f.store.recentTasks().every((t) => t.state === "completed")
      )
      await f.service.receive(event("complete"))
      await eventually(() => f.host.getWork(f.bot.id, workId).state === "completed")
      await f.service.receive(event("continue"))
      await eventually(() => f.host.getWork(f.bot.id, workId).state === "active")
      expect(f.host.listWorks(f.bot.id).items).toHaveLength(0)
      expect(
        f.host
          .imConversationWorks(f.bot.id, f.host.getWork(f.bot.id, workId).source!.bindingId)
          .items.map((item) => item.id)
      ).toEqual([workId])
      expect(f.calls.filter((t) => t.workId).map((t) => t.workId)).toEqual([workId, workId])
      expect(f.host.getWork(f.bot.id, workId).source?.transport).toBe("im")
      expect(f.host.getWork(f.bot.id, workId).source?.senderId).toBe(
        botImScopeId("realm", "owner", sender)
      )
      for (const task of f.calls.filter((task) => task.mockSource)) {
        const saved = f.store.getTask(task.id)
        expect(saved.mockSource?.senderId).toBe(botImScopeId("realm", "owner", sender))
        expect(f.store.im.validateSource(saved.mockSource!, f.bot.id, false)).toEqual(
          saved.mockSource
        )
      }
      expect(f.errors).toEqual([])
    }
  )

  it("rejects forged routes and changed duplicate contents before running the model", async () => {
    const f = fixture(),
      b = await f.binding(),
      input = f.event(b)
    await f.service.receive({ ...input, route: { ...input.route, bindingId: "other" } })
    expect(f.calls).toHaveLength(0)
    await f.service.receive(input)
    await eventually(() => f.calls.length === 1)
    await f.service.receive({
      ...input,
      event: { ...input.event, message: { type: "text", text: "Changed" } }
    })
    expect(f.calls).toHaveLength(1)
    expect(
      f.client.sendAcknowledgement.mock.calls.filter(([ack]) => ack.type === "failed")
    ).toHaveLength(2)
  })

  it("does not create a model turn without a granted execution permit", async () => {
    const f = fixture(),
      b = await f.binding()
    f.client.acquireBotPermit.mockResolvedValueOnce({
      status: "denied",
      reasonCode: "LEASE_REVOKED"
    })
    const input = f.event(b)
    await f.service.receive(input)
    await f.service.receive(input)
    expect(f.calls).toHaveLength(0)
    expect(f.store.recentTasks()).toHaveLength(0)
    expect(f.client.acquireBotPermit).toHaveBeenCalledTimes(1)
    expect(f.store.imGateway.event(botImScopeId("realm", "owner", "event"))?.state).toBe("unknown")
  })

  it.each(["list", "periodic sync"] as const)(
    "wakes an idle Host's authorized local IM work after reconnect by %s",
    async (reconnect) => {
      let available = false
      const f = fixture(undefined, undefined, () => available),
        binding = await f.binding(),
        input = f.event(binding, "reconnect-work", "Create work")
      await f.service.receive(input)
      const event = f.store.imGateway.event(botImScopeId("realm", "owner", input.event.eventId))!
      f.store.transition(event.taskId!, "running")
      const work = f.store.createWork(
        { botId: f.bot.id, operationId: "reconnect-work", title: "Synthetic", goal: "Text work" },
        { taskId: event.taskId!, callId: "create", key: "create" }
      )
      f.store.settle(event.taskId!, "completed", null, "Work admitted")
      f.store.transition(work.task.id, "running")
      f.store.settle(work.task.id, "completed", null, "Initial part done")
      f.service.disconnected()
      const continuation = f.host.send({
        botId: f.bot.id,
        workId: work.work.id,
        requestId: "reconnect-local-followup",
        message: "Continue this work"
      })
      available = true
      // Drain the send wake while offline. Reconnect must wake this already-idle Host itself.
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(f.store.getTask(continuation.id).state).toBe("queued")
      expect(f.store.im.get(f.bot.id, event.bindingId).online).toBe(false)
      expect(f.calls).toEqual([])
      expect(f.db.exec("SELECT task_id FROM bot_im_local_execution")[0].values).toContainEqual([
        continuation.id
      ])
      expect(f.store.imGateway.event(event.id)?.state).toBe("unknown")
      if (reconnect === "list") await f.service.list(f.bot.id)
      // The other branch uses the service's existing timer, not an unrelated Host action.
      await eventually(() => f.store.getTask(continuation.id).state === "completed")
      expect(f.calls.map((task) => task.id)).toEqual([continuation.id])
      expect(f.store.im.get(f.bot.id, event.bindingId).online).toBe(true)
      expect(f.store.imGateway.event(event.id)?.state).toBe("unknown")
      expect(f.client.acquireBotPermit).toHaveBeenCalledTimes(1)
      expect(f.errors).toEqual([])
    }
  )

  it.each(["unknown", "expired", "revoked"] as const)(
    "does not replay an external queued event with %s authority on reconnect",
    async (authority) => {
      let available = false
      const f = fixture(undefined, undefined, () => available),
        binding = await f.binding(),
        input = f.event(binding, `reconnect-${authority}`)
      await f.service.receive(input)
      const event = f.store.imGateway.event(botImScopeId("realm", "owner", input.event.eventId))!
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(f.store.getTask(event.taskId!).state).toBe("queued")
      if (authority === "unknown") await f.service.leaseRevoked(input.event.eventId)
      else if (authority === "expired")
        f.db.run("UPDATE bot_im_ingress SET expires_at=0 WHERE id=?", [event.id])
      else await f.service.revoke(f.bot.id, binding.id, binding.version)
      f.store.im.setAllOffline()
      available = true
      await f.service.list(f.bot.id)
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(f.calls).toEqual([])
      expect(f.store.getTask(event.taskId!).state).not.toBe("running")
      expect(f.client.acquireBotPermit).toHaveBeenCalledTimes(1)
      expect(
        f.db.exec("SELECT task_id FROM bot_im_local_execution").flatMap((r) => r.values)
      ).toEqual([])
      expect(f.errors).toEqual([])
    }
  )

  it("does not notify or repump unchanged active IM registrations", async () => {
    const available = vi.fn(() => false),
      f = fixture(undefined, undefined, available),
      binding = await f.binding()
    await f.service.receive(f.event(binding, "unchanged-registration"))
    await new Promise((resolve) => setTimeout(resolve, 25))
    const attempts = available.mock.calls.length,
      changed = vi.fn(),
      unsubscribe = f.host.subscribe(changed)
    try {
      await f.service.list(f.bot.id)
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(available).toHaveBeenCalledTimes(attempts)
      expect(changed).not.toHaveBeenCalled()
      f.store.im.setAllOffline()
      await f.service.list(f.bot.id)
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(available.mock.calls.length).toBeGreaterThan(attempts)
      expect(changed).toHaveBeenCalledTimes(1)
      await f.service.revoke(f.bot.id, binding.id, binding.version)
      expect(() =>
        f.host.setImOnline(f.bot.id, botImScopeId("realm", "owner", binding.id), true)
      ).toThrow("绑定已撤销")
      expect(f.calls).toEqual([])
      expect(f.errors).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  it("keeps ordinary App and mock scheduling independent of IM reconnect", async () => {
    const f = fixture(),
      binding = await f.binding()
    f.service.disconnected()
    const app = f.host.send({
      botId: f.bot.id,
      requestId: "ordinary-app-offline",
      message: "An ordinary local task"
    })
    const mock = f.host.createMockBinding({
      simulation: true,
      botId: f.bot.id,
      operationId: "ordinary-mock-offline",
      kind: "dm",
      channelKey: "mock-reconnect-control",
      label: "Synthetic mock",
      allowedSenderIds: ["alice"]
    })
    const accepted = f.host.injectMockEvent({
      simulation: true,
      bindingId: mock.id,
      eventId: "ordinary-mock-event",
      messageId: "ordinary-mock-message",
      senderId: "alice",
      text: "An ordinary mock task",
      mentionsBotIds: []
    })
    await eventually(() =>
      [app.id, accepted.taskId!].every((id) => f.store.getTask(id).state === "completed")
    )
    const imBindingId = botImScopeId("realm", "owner", binding.id)
    expect(f.store.im.get(f.bot.id, imBindingId).online).toBe(false)
    expect(new Set(f.calls.map((task) => task.id))).toEqual(new Set([app.id, accepted.taskId!]))
    expect(f.client.acquireBotPermit).not.toHaveBeenCalled()
    expect(f.errors).toEqual([])
  })

  it("stops running work on disconnect and never resumes it on a duplicate delivery", async () => {
    const f = fixture(
        async (_task, _host, signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => resolve({ state: "failed", error: "aborted" }), {
              once: true
            })
          })
      ),
      b = await f.binding(),
      input = f.event(b)
    await f.service.receive(input)
    await eventually(() => f.calls.length === 1)
    f.service.disconnected()
    await eventually(() => f.store.recentTasks().every((t) => t.state !== "running"))
    await f.service.list(f.bot.id)
    await f.service.receive({ ...input, event: { ...input.event, redelivered: true } })
    expect(f.calls).toHaveLength(1)
    expect(f.store.imGateway.event(botImScopeId("realm", "owner", "event"))?.state).toBe("unknown")
  })

  it("checks the live permit again before tools and blocks pending replies after revoke", async () => {
    const f = fixture(
        async (_task, _host, signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => resolve({ state: "failed", error: "aborted" }), {
              once: true
            })
          })
      ),
      b = await f.binding()
    await f.service.receive(f.event(b))
    await eventually(() => f.calls.length === 1)
    f.db.run("UPDATE bot_im_ingress SET expires_at=0")
    expect(() => f.host.workToolSource(f.calls[0].id)).toThrow("执行许可")
    await f.service.revoke(f.bot.id, b.id, 1)
    await eventually(() => f.store.recentTasks().every((t) => t.state !== "running"))
    expect(f.store.im.beginDelivery()).toBeNull()
    const history = f.service.history(f.bot.id, b.id)
    expect(history.items.filter((i) => i.kind === "bot").every((i) => i.state === "blocked")).toBe(
      true
    )
    expect(f.client.submitReply).not.toHaveBeenCalled()
  })

  it("does not let a delayed create result downgrade a consumed binding", async () => {
    const f = fixture(),
      b = await f.binding()
    f.store.imGateway.register("realm", "owner", { ...b, state: "pending", conversationKey: null })
    const id = botImScopeId("realm", "owner", b.id)
    expect(f.store.imGateway.binding(id)?.binding.state).toBe("active")
    await f.service.revoke(f.bot.id, b.id, 1)
    f.store.imGateway.register("realm", "owner", b)
    expect(f.store.imGateway.binding(id)?.binding.state).toBe("revoked")
  })

  it("keeps completed events terminal when a late lease revocation arrives", async () => {
    const f = fixture(),
      b = await f.binding(),
      input = f.event(b)
    await f.service.receive(input)
    const id = botImScopeId("realm", "owner", "event")
    await eventually(() => f.store.imGateway.event(id)?.state === "completed")
    expect(await f.service.leaseRevoked("event")).toBe(true)
    await f.service.receive({ ...input, event: { ...input.event, redelivered: true } })
    expect(f.store.imGateway.event(id)?.state).toBe("completed")
    expect(f.calls).toHaveLength(1)
    expect(f.client.sendAcknowledgement.mock.calls.at(-1)?.[0].type).toBe("completed")
  })

  it("retains an uncertain platform result without retrying or claiming delivery", async () => {
    const f = fixture(),
      b = await f.binding()
    f.client.submitReply.mockResolvedValue({ state: "platform_unknown" })
    await f.service.receive(f.event(b))
    await eventually(() =>
      f.service
        .history(f.bot.id, b.id)
        .items.some((item) => item.kind === "bot" && item.state === "unknown")
    )
    expect(f.store.im.beginDelivery()).toBeNull()
    expect(f.client.submitReply).toHaveBeenCalledTimes(1)
  })
})
