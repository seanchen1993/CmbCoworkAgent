import { beforeEach, describe, expect, it, vi } from "vitest"
import { DatabaseSync } from "node:sqlite"
import type { IpcMain } from "electron"
import { botContinuationMessageId } from "../bots/continuation"
import { parseGroup, parseSendBotMessage } from "../../shared/bots/validation"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "../bots/store"
import { LocalBotHost } from "../bots/host"
import { BotImChannelService, type BotImGatewayClient } from "../services/im/bot-channel-service"
import {
  assertBotImBinding,
  assertBotImEvent,
  type BotImBinding
} from "../../shared/bots/im-channel"
const fixture = vi.hoisted(() => ({
  getHost: vi.fn(),
  conversationLinks: { forBot: () => [], forThread: () => null },
  introduce: vi.fn(),
  getThread: vi.fn(),
  removeBot: vi.fn(),
  removeGroup: vi.fn(),
  removeBrowserGroup: vi.fn(),
  getBot: vi.fn((id: string) => ({ id, archived: id === "archived" })),
  subscribe: vi.fn(),
  share: vi.fn(),
  remove: vi.fn(),
  write: vi.fn(),
  listMemory: vi.fn(),
  create: vi.fn(),
  preview: vi.fn(),
  giveBack: vi.fn(),
  operateBrowser: vi.fn(),
  browserScope: vi.fn((id: string) => {
    if (id === "group-missing") throw new Error("群聊不存在")
    return id
  }),
  snapshot: vi.fn(() => ({ revision: 1 })),
  exchange: vi.fn(),
  exchangeHistory: vi.fn(),
  messageOrigins: vi.fn(),
  messageReply: vi.fn(),
  messageReactions: vi.fn(),
  setMessageReaction: vi.fn(),
  requestReceipts: vi.fn(),
  stopConversation: vi.fn(),
  markUnread: vi.fn(),
  markRead: vi.fn(),
  groupMessages: vi.fn(),
  listWorks: vi.fn(),
  workSummaries: vi.fn(),
  getWork: vi.fn(),
  createWork: vi.fn(),
  changeWork: vi.fn(),
  markWorksRead: vi.fn(),
  windowFor: vi.fn(() => ({})),
  mockBindings: vi.fn(),
  mockBinding: vi.fn(),
  createMockBinding: vi.fn(),
  injectMockEvent: vi.fn(),
  revokeMockBinding: vi.fn(),
  setMockOnline: vi.fn(),
  mockHistory: vi.fn()
}))
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: fixture.windowFor },
  powerMonitor: { on: vi.fn() }
}))
vi.mock("../bots/local-service", () => ({
  initializeBotNotificationDispatch: vi.fn(),
  getLocalBotHost: fixture.getHost,
  getBotMemoryService: () => ({
    removeBot: fixture.removeBot,
    share: fixture.share,
    write: fixture.write,
    list: fixture.listMemory,
    remove: fixture.remove
  }),
  getBotBrowserService: () => ({
    giveBack: fixture.giveBack,
    operateAsHuman: fixture.operateBrowser,
    preview: fixture.preview,
    removeBot: fixture.removeBot,
    removeGroup: fixture.removeBrowserGroup
  })
}))
vi.mock("../bots/conversation-link-service", () => ({
  resolveWorkConversation: vi.fn(),
  exposeWorkConversation: vi.fn(),
  linkExistingConversation: vi.fn(),
  unlinkWorkConversation: vi.fn(),
  unlinkDeletingWorkConversation: vi.fn()
}))
vi.mock("../db", () => ({ getThreadCore: fixture.getThread }))
vi.mock("../bots/runtime-adapter", () => ({ prepareBotThread: vi.fn() }))
vi.mock("./bot-files", () => ({ registerBotFileHandlers: vi.fn() }))
import { registerBotHandlers } from "./bots"

function register(
  deleteThread?: Parameters<typeof registerBotHandlers>[1],
  event: unknown = {},
  im?: Parameters<typeof registerBotHandlers>[2]
) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerBotHandlers(
    {
      handle: (channel, listener) => handlers.set(channel, listener)
    } as unknown as IpcMain,
    deleteThread,
    im
  )
  return (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args)
}
beforeEach(() => {
  vi.clearAllMocks()
  fixture.getHost.mockImplementation(() => fixture)
})
describe("Bot IPC boundaries", () => {
  it.each(["binding:synthetic", "b".repeat(128)])(
    "manages a wire-valid opaque binding %s through the actual IM service",
    async (bindingId) => {
      const db = new NativeSqliteAdapter(new DatabaseSync(":memory:")),
        store = new BotStore(db),
        host = new LocalBotHost(store, { acquire: () => null, onAvailable: () => () => {} }),
        bot = store.create({ name: "IM", instructions: "", color: "#123456", modelRef: null }),
        other = store.create({ name: "Other", instructions: "", color: "#123456", modelRef: null })
      let binding: BotImBinding = {
        id: bindingId,
        botId: bot.id,
        kind: "group",
        label: "Synthetic",
        version: 1,
        state: "active",
        conversationKey: "conversation:synthetic",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 90000).toISOString()
      }
      const client = {
        getStatus: () => ({ principalId: "owner" }) as ReturnType<BotImGatewayClient["getStatus"]>,
        supportsBotChannel: () => true,
        botBindingCommand: vi.fn<BotImGatewayClient["botBindingCommand"]>(async (command) => {
          if (command.action === "list") return { items: [binding], before: null }
          if (command.action !== "revoke") throw new Error("unexpected command")
          expect(command.bindingId).toBe(bindingId)
          binding = { ...binding, state: "revoked", version: command.expectedVersion + 1 }
          return binding
        }),
        sendAcknowledgement: vi.fn<BotImGatewayClient["sendAcknowledgement"]>(async () => {}),
        acquireBotPermit: vi.fn<BotImGatewayClient["acquireBotPermit"]>(async () => ({
          status: "granted",
          leaseId: "lease",
          expiresAt: new Date(Date.now() + 90000).toISOString()
        })),
        renewBotPermit: vi.fn<BotImGatewayClient["renewBotPermit"]>(),
        submitReply: vi.fn<BotImGatewayClient["submitReply"]>()
      } satisfies BotImGatewayClient
      const service = new BotImChannelService(client, "realm", () => host),
        manager = {
          setBotHostResolver: vi.fn(),
          botChannelStatus: () => ({ connected: true, available: true }),
          requireBotChannel: () => service
        },
        frame = {},
        event = { senderFrame: frame, sender: { mainFrame: frame } }
      fixture.getHost.mockReturnValue(host)
      try {
        assertBotImBinding(binding)
        const call = register(undefined, event, manager)
        expect(await call("bots:im:list", "local", bot.id)).toMatchObject({ items: [binding] })
        const input = {
          route: {
            bindingId,
            botId: bot.id,
            kind: binding.kind,
            label: binding.label,
            version: binding.version,
            senderId: "employee:42"
          },
          event: {
            schemaVersion: 1 as const,
            eventId: "event",
            platformMessageId: "message",
            principalId: "owner",
            conversationKey: binding.conversationKey!,
            conversationSeq: 1,
            message: { type: "text" as const, text: "Synthetic pending message" },
            occurredAt: new Date().toISOString(),
            lease: { id: "lease", expiresAt: new Date(Date.now() + 90000).toISOString() }
          }
        }
        assertBotImEvent(input)
        await service.receive(input)
        expect(call("bots:im:history", "local", bot.id, bindingId)).toMatchObject({
          items: [expect.objectContaining({ kind: "user", text: input.event.message.text })]
        })
        expect(() => call("bots:im:history", "local", other.id, bindingId)).toThrow("不属于")
        const localId = host.snapshot().imConversations![0].id
        call("bots:memory:list", "local", bot.id, localId)
        expect(fixture.listMemory).toHaveBeenLastCalledWith(bot.id, { groupId: localId })
        call("bots:memory:list", "local", bot.id)
        expect(fixture.listMemory).toHaveBeenLastCalledWith(bot.id, {})
        expect(() => call("bots:memory:list", "local", other.id, localId)).toThrow("不属于")
        expect(() =>
          call("bots:memory:write", "local", other.id, {
            name: "Fact",
            content: "No",
            scope: { kind: "group", groupId: localId }
          })
        ).toThrow("不属于")
        call("bots:memory:write", "local", bot.id, {
          name: "Fact",
          content: "Yes",
          scope: { kind: "group", groupId: localId }
        })
        expect(fixture.write).toHaveBeenLastCalledWith(bot.id, {
          name: "Fact",
          content: "Yes",
          scope: { kind: "group", groupId: localId }
        })
        expect(call("bots:im:conversation-history", "local", bot.id, localId)).toMatchObject({
          items: [expect.objectContaining({ text: input.event.message.text })]
        })
        expect(call("bots:im:conversation-works", "local", bot.id, localId)).toMatchObject({
          items: []
        })
        expect(() => call("bots:im:conversation-history", "local", other.id, localId)).toThrow(
          "不存在"
        )
        expect(() => call("bots:im:conversation-works", "remote", bot.id, localId)).toThrow("本机")
        expect(() => call("bots:im:conversation-history", "local", bot.id, localId, "bad")).toThrow(
          "游标"
        )
        expect(() =>
          register(undefined, { ...event, senderFrame: {} }, manager)(
            "bots:im:conversation-history",
            "local",
            bot.id,
            localId
          )
        ).toThrow("桌面")
        expect(() => call("bots:im:history", "remote", bot.id, bindingId)).toThrow("本机")
        expect(() => call("bots:im:history", "local", "bot:invalid", bindingId)).toThrow("标识")
        expect(() => call("bots:im:create", "local", bot.id, "group", "operation:invalid")).toThrow(
          "标识"
        )
        expect(() => call("bots:im:revoke", "local", bot.id, bindingId, 0)).toThrow("版本")
        expect(() => call("bots:im:history", "local", bot.id, bindingId, "x".repeat(1025))).toThrow(
          "游标"
        )
        expect(() =>
          register(undefined, { ...event, senderFrame: {} }, manager)(
            "bots:im:history",
            "local",
            bot.id,
            bindingId
          )
        ).toThrow("桌面")
        for (const invalid of [
          undefined,
          null,
          {},
          [],
          "",
          "../binding",
          "binding/path",
          "binding.id",
          "b".repeat(129),
          "binding\n"
        ]) {
          expect(() => call("bots:im:history", "local", bot.id, invalid)).toThrow("标识")
          expect(() => call("bots:im:revoke", "local", bot.id, invalid, 1)).toThrow("标识")
        }
        expect(client.botBindingCommand).toHaveBeenCalledTimes(1)
        expect(await call("bots:im:revoke", "local", bot.id, bindingId, 1)).toMatchObject({
          id: bindingId,
          version: 2,
          state: "revoked"
        })
        expect(store.recentTasks()).toEqual([expect.objectContaining({ state: "cancelled" })])
        expect(call("bots:im:history", "local", bot.id, bindingId)).toMatchObject({
          items: [expect.objectContaining({ kind: "user", state: "cancelled" })]
        })
        service.disconnected()
        expect(call("bots:im:conversation-history", "local", bot.id, localId)).toMatchObject({
          items: [expect.objectContaining({ kind: "user", state: "cancelled" })]
        })
      } finally {
        service.stop()
        await host.stop()
        db.close()
      }
    }
  )

  it("renames only an authoritative existing empty group through validation, Host and Store", async () => {
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    const store = new BotStore(db)
    const host = new LocalBotHost(store, { acquire: () => null, onAvailable: () => () => {} })
    fixture.getHost.mockReturnValue(host)
    try {
      const call = register()
      const bot = store.create({ name: "A", instructions: "", color: "#123456", modelRef: null })
      const active = call("bots:group:save", "local", {
        name: "Active",
        memberIds: [bot.id]
      }) as ReturnType<BotStore["saveGroup"]>
      const emptyInput = { name: "Empty", memberIds: [] }
      expect(() => parseGroup(emptyInput)).toThrow("1 至 8")
      expect(() => call("bots:group:save", "local", emptyInput)).toThrow("1 至 8")
      expect(() => store.saveGroup(emptyInput)).toThrow("1 至 8")
      expect(() =>
        call(
          "bots:group:save",
          "local",
          { ...emptyInput, allowEmptyMembers: true },
          { ...active, allowEmptyMembers: true }
        )
      ).toThrow("1 至 8")
      expect(store.getGroup(active.id)).toEqual(active)

      const renamed = call(
        "bots:group:save",
        "local",
        { ...active, name: "Normal rename" },
        active
      ) as typeof active
      expect(renamed).toMatchObject({
        name: "Normal rename",
        memberIds: [bot.id],
        version: active.version + 1
      })
      store.beginDeletion(bot.id, bot.version)
      store.finishDeletion(bot.id)
      const empty = store.getGroup(active.id)
      expect(empty.memberIds).toEqual([])
      const revision = store.revision()
      for (const input of [
        { ...emptyInput, memberIds: "not-an-array" },
        { ...emptyInput, memberIds: ["../invalid"] },
        { ...emptyInput, memberIds: ["same", "same"] },
        { ...emptyInput, memberIds: Array.from({ length: 9 }, (_, i) => `bot-${i}`) }
      ])
        expect(() => call("bots:group:save", "local", input, empty)).toThrow()
      expect(() =>
        call("bots:group:save", "local", emptyInput, { id: empty.id, version: 0 })
      ).toThrow("版本")
      expect(() => call("bots:group:save", "local", emptyInput, renamed)).toThrow("刷新")
      expect(() =>
        call("bots:group:save", "local", emptyInput, { id: "missing", version: 1 })
      ).toThrow("不存在")
      expect(() => call("bots:group:save", "remote", emptyInput, empty)).toThrow("本机")
      expect(store.revision()).toBe(revision)
      expect(store.getGroup(empty.id)).toEqual(empty)

      const saved = call(
        "bots:group:save",
        "local",
        { name: "Retained history", memberIds: [] },
        empty
      ) as typeof empty
      expect(saved).toMatchObject({
        id: empty.id,
        name: "Retained history",
        memberIds: [],
        version: empty.version + 1
      })
      const peer = store.create({ name: "B", instructions: "", color: "#123456", modelRef: null })
      expect(() =>
        call("bots:group:save", "local", { ...saved, memberIds: ["missing-bot"] }, saved)
      ).toThrow("不存在")
      const joined = call(
        "bots:group:save",
        "local",
        { ...saved, memberIds: [peer.id] },
        saved
      ) as typeof saved
      expect(joined.memberIds).toEqual([peer.id])
      expect(() => call("bots:group:save", "local", emptyInput, joined)).toThrow("1 至 8")
      store.beginDeletion(peer.id, peer.version)
      store.finishDeletion(peer.id)
      const emptyAgain = store.getGroup(saved.id)
      store.beginGroupDeletion(emptyAgain.id, emptyAgain.version)
      expect(() => call("bots:group:save", "local", emptyInput, emptyAgain)).toThrow("删除")
    } finally {
      await host.stop()
      db.close()
    }
  })

  it("validates scoped reaction identity, full catalog emoji and explicit idempotent state", () => {
    const call = register(),
      target = { kind: "bot", botId: "a", workId: "work-a" }
    call("bots:message-reactions", "local", target, ["native:assistant.1"])
    expect(fixture.messageReactions).toHaveBeenCalledWith(target, ["native:assistant.1"])
    call("bots:set-message-reaction", "local", target, "native:assistant.1", "❤", false)
    expect(fixture.setMessageReaction).toHaveBeenCalledWith(
      target,
      "native:assistant.1",
      "❤️",
      false
    )
    fixture.setMessageReaction.mockClear()
    for (const [scope, id, emoji, present] of [
      [{ ...target, groupId: "group" }, "m", "👍", true],
      [{ kind: "group", groupId: "g", threadId: "other" }, "m", "👍", true],
      [target, "trim ", "👍", true],
      [target, "m", "👍👍", true],
      [target, "m", "👍", "false"]
    ])
      expect(() => call("bots:set-message-reaction", "local", scope, id, emoji, present)).toThrow()
    expect(() => call("bots:message-reactions", "local", target, Array(101).fill("m"))).toThrow()
    expect(() => call("bots:set-message-reaction", "remote", target, "m", "👍", true)).toThrow(
      "本机"
    )
    expect(fixture.setMessageReaction).not.toHaveBeenCalled()
  })
  it("keeps simulation binding authority in a top-level local desktop window and rejects injected source/paths", () => {
    const frame = {},
      event = { senderFrame: frame, sender: { mainFrame: frame } }
    const call = register(undefined, event)
    const input = {
      simulation: true,
      botId: "a",
      operationId: "bind",
      kind: "dm",
      channelKey: "dm-a",
      label: "Personal",
      allowedSenderIds: ["alice"]
    }
    call("bots:mock:create", "local", input)
    expect(fixture.createMockBinding).toHaveBeenCalledWith(input)
    for (const extra of [
      { owner: true },
      { threadId: "private" },
      { source: { audienceKey: "desktop" } },
      { modelRef: "model" },
      { workspacePath: "/private" }
    ])
      expect(() => call("bots:mock:create", "local", { ...input, ...extra })).toThrow()
    const message = {
      simulation: true,
      bindingId: "b",
      eventId: "e",
      messageId: "m",
      senderId: "alice",
      text: "Hello",
      mentionsBotIds: []
    }
    call("bots:mock:inject", "local", message)
    expect(fixture.injectMockEvent).toHaveBeenCalledWith(message)
    for (const extra of [
      { origin: "user" },
      { mockSource: {} },
      { workId: "w" },
      { threadId: "private" },
      { credentials: "secret" }
    ])
      expect(() => call("bots:mock:inject", "local", { ...message, ...extra })).toThrow()
    expect(() =>
      call("bots:mock:inject", "local", {
        ...message,
        text: '<attachment filename="private">x</attachment>'
      })
    ).toThrow()
    expect(() =>
      register(undefined, { ...event, senderFrame: {} })("bots:mock:create", "local", input)
    ).toThrow("桌面")
    fixture.windowFor.mockReturnValueOnce(null as any)
    expect(() => call("bots:mock:create", "local", input)).toThrow("桌面")
    expect(() => call("bots:mock:create", "remote", input)).toThrow()
    expect(() => call("bots:mock:online", "local", "a", "b", "yes")).toThrow()
    expect(() => call("bots:mock:revoke", "local", "a", "b", 0)).toThrow()
    expect(() => call("bots:mock:history", "local", "a", "b", "x".repeat(1025))).toThrow()
  })
  it("accepts only bounded local work controls and never renderer authority or conversation paths", () => {
    const call = register(),
      input = { botId: "a", operationId: "create", title: "Draft", goal: "Prepare" }
    for (const invalid of [
      { ...input, threadId: "owner" },
      { ...input, sourceTaskId: "task" },
      { ...input, audienceKey: "desktop" },
      { ...input, workspacePath: "/private" },
      { ...input, contextMessageIds: ["m", "m"] },
      { ...input, contextMessageIds: Array.from({ length: 13 }, (_, i) => `m${i}`) }
    ])
      expect(() => call("bots:work:create", "local", invalid)).toThrow()
    expect(() => call("bots:work:create", "remote", input)).toThrow()
    expect(fixture.createWork).not.toHaveBeenCalled()
    call("bots:work:create", "local", input)
    expect(fixture.createWork).toHaveBeenCalledWith(input)
    for (const ids of ["work", Array(41).fill("w"), ["w", "w"], ["../w"]])
      expect(() => call("bots:work:summaries", "local", "a", ids)).toThrow()
    expect(() => call("bots:work:get", "local", "a", "../w")).toThrow()
    expect(() => call("bots:work:mark-all-read", "local", "a", 0)).toThrow()
    const lifecycle = {
      botId: "a",
      workId: "w",
      expectedVersion: 1,
      operationId: "done",
      action: "complete"
    }
    expect(() => call("bots:work:lifecycle", "local", { ...lifecycle, actor: "owner" })).toThrow()
    expect(() => call("bots:work:lifecycle", "local", { ...lifecycle, action: "replay" })).toThrow()
    call("bots:work:lifecycle", "local", lifecycle)
    expect(fixture.changeWork).toHaveBeenCalledWith("a", "w", 1, "done", "complete")
    call(
      "bots:request-receipts",
      "local",
      "a",
      [{ requestId: "r", messageHash: "a".repeat(64) }],
      "w"
    )
    expect(fixture.requestReceipts).toHaveBeenLastCalledWith("a", expect.any(Array), "w")
    expect(() => call("bots:stop-conversation", "local", "a", undefined, "../w")).toThrow()
    call("bots:stop-conversation", "local", "a", undefined, "w")
    expect(fixture.stopConversation).toHaveBeenLastCalledWith("a", undefined, "w")
  })
  it("validates private quote host and both identities before domain access", () => {
    const call = register()
    expect(() => call("bots:message-reply", "remote", "bot", "message")).toThrow()
    expect(() => call("bots:message-reply", "local", "../bot", "message")).toThrow()
    for (const message of ["", " message", "message\n", "message\u0085", "m".repeat(1025), {}])
      expect(() => call("bots:message-reply", "local", "bot", message)).toThrow()
    expect(() => call("bots:message-reply", "local", "bot", "message", "../work")).toThrow()
    expect(fixture.messageReply).not.toHaveBeenCalled()
    call("bots:message-reply", "local", "bot", "message")
    expect(fixture.messageReply).toHaveBeenCalledWith("bot", "message", undefined)
    const providerId = "provider/response:segment::cmb-same-role-duplicate:assistant:2"
    call("bots:message-reply", "local", "bot", providerId, "work")
    expect(fixture.messageReply).toHaveBeenLastCalledWith("bot", providerId, "work")
  })

  it("validates exact same-group history targets and retains numeric backward cursors", () => {
    const call = register()
    for (const cursor of [
      0,
      -1,
      NaN,
      Infinity,
      "40",
      {},
      [],
      { targetMessageId: "../message" },
      { targetMessageId: "" },
      { targetMessageId: "message", before: 40 }
    ]) {
      expect(() => call("bots:group:messages", "local", "group", cursor)).toThrow()
    }
    expect(() =>
      call("bots:group:messages", "remote", "group", { targetMessageId: "message" })
    ).toThrow()
    expect(() => call("bots:group:messages", "local", "../group", 40)).toThrow()
    expect(fixture.groupMessages).not.toHaveBeenCalled()
    call("bots:group:messages", "local", "group", { targetMessageId: "message" })
    call("bots:group:messages", "local", "group", 40)
    call("bots:group:messages", "local", "group")
    expect(fixture.groupMessages.mock.calls).toEqual([
      ["group", { targetMessageId: "message" }],
      ["group", 40],
      ["group", undefined]
    ])
  })
  it("introduces only the validated local Bot when opening its conversation", () => {
    const call = register()
    expect(() => call("bots:open", "remote", "a")).toThrow()
    expect(() => call("bots:open", "local", "../a")).toThrow()
    expect(fixture.introduce).not.toHaveBeenCalled()
    call("bots:open", "local", "a")
    expect(fixture.introduce).toHaveBeenCalledExactlyOnceWith("a")
  })
  it("validates the host and private conversation identity before stopping work", () => {
    const call = register()
    expect(() => call("bots:stop-conversation", "remote", "a")).toThrow()
    expect(() => call("bots:stop-conversation", "local", "../a")).toThrow()
    expect(() => call("bots:stop-conversation", "local", "a", "../g")).toThrow()
    expect(fixture.stopConversation).not.toHaveBeenCalled()
    call("bots:stop-conversation", "local", "a")
    expect(fixture.stopConversation).toHaveBeenCalledExactlyOnceWith("a", undefined, undefined)
    call("bots:stop-conversation", "local", "a", "g")
    expect(fixture.stopConversation).toHaveBeenLastCalledWith("a", "g", undefined)
  })
  it("validates bounded private receipt queries before accessing the Host", () => {
    const call = register()
    const valid = [{ requestId: "request-1", messageHash: "a".repeat(64) }]
    call("bots:request-receipts", "local", "bot-1", valid)
    expect(fixture.requestReceipts).toHaveBeenCalledWith("bot-1", valid, undefined)
    fixture.requestReceipts.mockClear()
    for (const checks of [
      null,
      {},
      [{ requestId: "../other", messageHash: "a".repeat(64) }],
      [{ requestId: "r", messageHash: "short" }],
      [...valid, ...valid],
      Array.from({ length: 33 }, (_, i) => ({ requestId: `r-${i}`, messageHash: "b".repeat(64) }))
    ])
      expect(() => call("bots:request-receipts", "local", "bot-1", checks)).toThrow()
    expect(() => call("bots:request-receipts", "remote", "bot-1", valid)).toThrow()
    expect(() => call("bots:request-receipts", "local", "../bot", valid)).toThrow()
    expect(fixture.requestReceipts).not.toHaveBeenCalled()
  })
  it("validates the observed browser control generation before handing it back", () => {
    const call = register()
    for (const generation of [-1, 1.5, Number.NaN, "1", null, Number.MAX_SAFE_INTEGER + 1])
      expect(() => call("bots:browser:give-back", "local", "a", generation)).toThrow("版本")
    expect(fixture.giveBack).not.toHaveBeenCalled()
    call("bots:browser:give-back", "local", "a", 3)
    expect(fixture.giveBack).toHaveBeenCalledWith("a", 3)
    fixture.giveBack.mockClear()
    for (const outcome of [null, true, "done", "dismissed", {}, []])
      expect(() => call("bots:browser:give-back", "local", "a", 3, outcome)).toThrow("方式")
    expect(fixture.giveBack).not.toHaveBeenCalled()
    expect(() => call("bots:browser:give-back", "local", "a", undefined, "skipped")).toThrow(
      "控制版本"
    )
    call("bots:browser:give-back", "local", "a", 3, "skipped")
    expect(fixture.giveBack).toHaveBeenCalledWith("a", 3, "skipped")
  })
  it("validates human browser operations and their exact scope, target and lease before forwarding", () => {
    const call = register()
    const reload = { action: "reload", pageId: "page-a" }
    for (const generation of [
      undefined,
      null,
      -1,
      1.5,
      NaN,
      Infinity,
      "3",
      Number.MAX_SAFE_INTEGER + 1
    ])
      expect(() => call("bots:browser:operate", "local", "a", reload, generation)).toThrow("版本")
    for (const input of [
      undefined,
      null,
      [],
      "reload",
      {},
      { action: "execute", pageId: "page-a" },
      { action: "reload" },
      { action: "reload", pageId: null },
      { action: "reload", pageId: "../../private" },
      { action: "new", pageId: "page-a" },
      { ...reload, url: "https://example.test" },
      { ...reload, generation: 3 },
      { ...reload, botId: "other" }
    ])
      expect(() => call("bots:browser:operate", "local", "a", input, 3)).toThrow()
    expect(() => call("bots:browser:operate", "remote", "a", reload, 3)).toThrow("本机")
    expect(() => call("bots:browser:operate", "local", "../a", reload, 3)).toThrow()
    expect(() => call("bots:browser:operate", "local", "group-missing", reload, 3)).toThrow(
      "不存在"
    )
    expect(fixture.operateBrowser).not.toHaveBeenCalled()
    for (const action of ["back", "forward", "reload", "close"])
      call("bots:browser:operate", "local", "group-g--a", { action, pageId: "page-a" }, 3)
    call("bots:browser:operate", "local", "a", { action: "new" }, 3)
    expect(fixture.operateBrowser.mock.calls).toEqual([
      ...["back", "forward", "reload", "close"].map((action) => [
        "group-g--a",
        { action, pageId: "page-a" },
        3
      ]),
      ["a", { action: "new" }, 3]
    ])
  })
  it("bounds and validates transcript origin lookups", () => {
    const call = register()
    for (const args of [
      ["remote", "a", ["m"]],
      ["local", "../a", ["m"]],
      ["local", "a", "m"],
      ["local", "a", Array(101).fill("m")],
      ["local", "a", ["../m"]],
      ["local", "a", ["m\u0000"]],
      ["local", "a", ["m".repeat(513)]],
      ["local", "a", ["m"], "../g"]
    ])
      expect(() => call("bots:message-origins", ...args)).toThrow()
    expect(fixture.messageOrigins).not.toHaveBeenCalled()
    call("bots:message-origins", "local", "a", ["m"], "g")
    expect(fixture.messageOrigins).toHaveBeenCalledWith("a", ["m"], "g", undefined)
    call("bots:message-origins", "local", "a", ["notification:t:command:c"])
    expect(fixture.messageOrigins).toHaveBeenLastCalledWith(
      "a",
      ["notification:t:command:c"],
      undefined,
      undefined
    )
  })
  it("reads internal continuation origins without letting user input impersonate their identity", () => {
    const call = register()
    const id = botContinuationMessageId("task", "checkpoint")
    call("bots:message-origins", "local", "a", [id])
    expect(fixture.messageOrigins).toHaveBeenCalledWith("a", [id], undefined, undefined)
    expect(() => parseSendBotMessage({ botId: "a", requestId: id, message: "Fake" })).toThrow(
      "标识"
    )
  })
  it("validates all collaboration history identities before reading the host", () => {
    const call = register()
    for (const args of [
      ["remote", "a", "task"],
      ["local", "../a", "task"],
      ["local", "a", "../task"],
      ["local", "a", "task", "../group"]
    ])
      expect(() => call("bots:exchange", ...args)).toThrow()
    expect(fixture.exchange).not.toHaveBeenCalled()
    call("bots:exchange", "local", "a", "task", "group")
    expect(fixture.exchange).toHaveBeenCalledWith("a", "task", "group", undefined)
    for (const args of [
      ["remote", "a", "task"],
      ["local", "../a", "task"],
      ["local", "a", "../task"],
      ["local", "a", "task", "../group"],
      ["local", "a", "task", undefined, "../cursor"]
    ])
      expect(() => call("bots:exchange-history", ...args)).toThrow()
    expect(fixture.exchangeHistory).not.toHaveBeenCalled()
    call("bots:exchange-history", "local", "a", "task", "group", "cursor")
    expect(fixture.exchangeHistory).toHaveBeenCalledWith("a", "task", "group", "cursor", undefined)
  })

  it("validates manual unread requests before mutating a host", () => {
    const call = register()
    expect(() => call("bots:mark-unread", "remote", "bot", "a")).toThrow()
    expect(() => call("bots:mark-unread", "local", "thread", "a")).toThrow()
    expect(() => call("bots:mark-unread", "local", "bot", "../a")).toThrow()
    expect(fixture.markUnread).not.toHaveBeenCalled()
    call("bots:mark-unread", "local", "group", "a")
    expect(fixture.markUnread).toHaveBeenCalledWith("group", "a")
  })

  it("resolves existing group browser scopes before forwarding page requests", () => {
    const call = register()
    expect(() => call("bots:browser:preview", "local", "group-missing")).toThrow("不存在")
    expect(() => call("bots:browser:preview", "local", "group-../private")).toThrow()
    expect(fixture.preview).not.toHaveBeenCalled()
    call("bots:browser:preview", "local", "group-g--a")
    expect(fixture.preview).toHaveBeenCalledWith("group-g--a", undefined)
  })
  it("rejects invalid read cursors and host identities before changing read state", () => {
    const call = register()
    for (const version of [0, -1, 0.5, "1", NaN, Infinity])
      expect(() => call("bots:mark-read", "local", "bot", "a", version)).toThrow()
    expect(() => call("bots:mark-read", "remote", "bot", "a", 1)).toThrow()
    expect(() => call("bots:mark-read", "local", "thread", "a", 1)).toThrow()
    expect(() => call("bots:mark-read", "local", "bot", "../a", 1)).toThrow()
    expect(fixture.markRead).not.toHaveBeenCalled()
    call("bots:mark-read", "local", "group", "a", 2)
    expect(fixture.markRead).toHaveBeenCalledWith("group", "a", 2)
  })
  it("rejects unknown hosts, unsafe identities and unversioned memory mutations before side effects", () => {
    const call = register()
    expect(() => call("bots:create", "remote", {})).toThrow("仅支持本机")
    expect(() => call("bots:memory:share", "local", "a", "../fact", "a".repeat(64), "b")).toThrow()
    expect(() => call("bots:memory:share", "local", "a", "fact", "invalid", "b")).toThrow()
    expect(() =>
      call("bots:memory:share", "local", "a", "fact", "a".repeat(64), "archived")
    ).toThrow("恢复")
    expect(() =>
      call("bots:memory:write", "local", "a", { id: "fact", name: "N", content: "C" })
    ).toThrow()
    expect(() => call("bots:browser:preview", "local", "a", "../../target")).toThrow()
    expect(fixture.share).not.toHaveBeenCalled()
    expect(fixture.write).not.toHaveBeenCalled()
    expect(fixture.create).not.toHaveBeenCalled()
    expect(fixture.preview).not.toHaveBeenCalled()
    call("bots:memory:share", "local", "a", "fact", "a".repeat(64), "b")
    expect(fixture.share).toHaveBeenCalledWith("a", "fact", "a".repeat(64), "b")
  })
  it("validates deletion ownership before reusing thread teardown and supports partial-cleanup retries", async () => {
    const deleteThread = vi.fn(async () => {})
    const call = register(deleteThread)
    fixture.remove.mockImplementation((_id, _version, cleanup) =>
      cleanup(["private-thread", "already-gone"])
    )
    fixture.getThread.mockImplementation((id) =>
      id === "already-gone"
        ? null
        : { metadata: JSON.stringify({ botId: "b", botHostId: "local" }) }
    )
    expect(() => call("bots:remove", "remote", "a", 1)).toThrow("仅支持本机")
    expect(() => call("bots:remove", "local", "../a", 1)).toThrow()
    expect(() => call("bots:remove", "local", "a", 0)).toThrow()
    await expect(call("bots:remove", "local", "a", 1)).rejects.toThrow("归属")
    expect(deleteThread).not.toHaveBeenCalled()
    expect(fixture.removeBot).not.toHaveBeenCalled()
    fixture.getThread.mockImplementation((id) =>
      id === "already-gone"
        ? null
        : { metadata: JSON.stringify({ botId: "a", botHostId: "local" }) }
    )
    await call("bots:remove", "local", "a", 1)
    expect(deleteThread).toHaveBeenCalledTimes(1)
    expect(deleteThread).toHaveBeenCalledWith({}, "private-thread", { requireIdle: true })
    expect(fixture.removeBot).toHaveBeenCalledTimes(2)
  })
  it("refuses to delete a private thread through the group cleanup route", async () => {
    const deleteThread = vi.fn(async () => {})
    const call = register(deleteThread)
    fixture.removeGroup.mockImplementation((_id, _version, cleanup) => cleanup(["member-thread"]))
    fixture.getThread.mockReturnValue({
      metadata: JSON.stringify({ botId: "a", botHostId: "local" })
    })
    await expect(call("bots:group:remove", "local", "g", 1)).rejects.toThrow("归属")
    expect(deleteThread).not.toHaveBeenCalled()
    fixture.getThread.mockReturnValue({
      metadata: JSON.stringify({ botId: "a", botHostId: "local", botGroupId: "g" })
    })
    await call("bots:group:remove", "local", "g", 1)
    expect(deleteThread).toHaveBeenCalledWith({}, "member-thread", { requireIdle: true })
    expect(fixture.removeBrowserGroup).toHaveBeenCalledWith("g")
  })
  it("keeps existing app registration alive when the optional Bot database cannot open", () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {})
    fixture.getHost.mockImplementation(() => {
      throw new Error("database unavailable")
    })
    try {
      const call = register()
      expect(() => call("bots:snapshot", "local")).toThrow("database unavailable")
      fixture.getHost.mockImplementation(() => fixture)
      expect(call("bots:snapshot", "local")).toEqual({ revision: 1 })
      expect(fixture.subscribe).toHaveBeenCalledTimes(1)
      call("bots:snapshot", "local")
      expect(fixture.subscribe).toHaveBeenCalledTimes(1)
    } finally {
      diagnostic.mockRestore()
    }
  })
})
