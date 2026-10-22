import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost, type BotRunLease } from "./host"
import { BotImChannelService, type BotImGatewayClient } from "../services/im/bot-channel-service"
import { botImScopeId } from "./im-gateway-store"
import { assertBotImEvent, type BotImBinding, type BotImEvent } from "../../shared/bots/im-channel"
import type { BotTask } from "../../shared/bots/contracts"
import { buildBotPrompt } from "./prompt"
import { parseBotMockSource } from "./mock-channel-validation"

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
    signal: AbortSignal
  ) => ReturnType<BotRunLease["execute"]>
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
  const host: LocalBotHost = new LocalBotHost(
    store,
    {
      onAvailable: () => () => {},
      acquire: (_bot, task) => ({
        release() {},
        execute: async (signal) => {
          calls.push(task)
          host.mockExecution(task)
          return execute
            ? execute(task, host, signal)
            : { state: "completed", result: `reply:${task.message}` }
        }
      })
    },
    2,
    (error) => errors.push(error)
  )
  const remote = new Map<string, BotImBinding>()
  let sequence = 0
  const client = {
    getStatus: () => ({ principalId: "owner" }) as ReturnType<BotImGatewayClient["getStatus"]>,
    supportsBotChannel: () => true,
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
      const binding: BotImBinding = {
        id: `binding-${++sequence}`,
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
    (error) => errors.push(error)
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
  return { db, store, bot, host, calls, errors, service, client, binding, event, remote }
}

describe("authenticated IM on the existing Bot host", () => {
  it("isolates DM/group/private audiences and admits each received event only once", async () => {
    const f = fixture(),
      dm = await f.binding("dm"),
      group = await f.binding()
    const input = f.event(group)
    assertBotImEvent(input)
    await f.service.receive(input)
    await f.service.receive({ ...input, event: { ...input.event, redelivered: true } })
    await f.service.receive(f.event(dm, "dm"))
    await eventually(() => f.calls.length === 2 && f.client.submitReply.mock.calls.length === 2)
    expect(new Set(f.calls.map((task) => task.threadId)).size).toBe(2)
    expect(f.calls.every((task) => task.mockSource?.transport === "im")).toBe(true)
    expect(f.calls.every((task) => task.threadId !== f.bot.threadId)).toBe(true)
    expect(() => parseBotMockSource(f.calls[0].mockSource)).toThrow("真实 IM")
    expect(buildBotPrompt(f.bot, f.calls[0], "/unused")).toContain("authenticated IM")
    expect(buildBotPrompt(f.bot, f.calls[0], "/unused")).not.toContain("simulated")
    expect(f.client.submitReply.mock.calls.map(([reply]) => reply.conversationKey).sort()).toEqual(
      [dm.conversationKey, group.conversationKey].sort()
    )
    expect(f.store.mock.bindings(f.bot.id).items).toHaveLength(0)
    expect(f.errors).toEqual([])
  })

  it("creates a task, revises the same task, confirms, and continues through real host tools", async () => {
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
    await f.service.receive(f.event(b, "create", "create"))
    await eventually(
      () => f.calls.length === 2 && f.store.recentTasks().every((t) => t.state === "completed")
    )
    await f.service.receive(f.event(b, "revise", "revise"))
    await eventually(
      () => f.calls.length === 4 && f.store.recentTasks().every((t) => t.state === "completed")
    )
    await f.service.receive(f.event(b, "complete", "complete"))
    await eventually(() => f.host.getWork(f.bot.id, workId).state === "completed")
    await f.service.receive(f.event(b, "continue", "continue"))
    await eventually(() => f.host.getWork(f.bot.id, workId).state === "active")
    expect(f.host.listWorks(f.bot.id).items).toHaveLength(1)
    expect(f.calls.filter((t) => t.workId).map((t) => t.workId)).toEqual([workId, workId])
    expect(f.host.getWork(f.bot.id, workId).source?.transport).toBe("im")
    expect(f.errors).toEqual([])
  })

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
