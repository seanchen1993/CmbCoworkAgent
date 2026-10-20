import { beforeEach, describe, expect, it, vi } from "vitest"
import type { IpcMain } from "electron"
const fixture = vi.hoisted(() => ({
  getHost: vi.fn(),
  conversationLinks:{forBot:()=>[],forThread:()=>null},
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
  create: vi.fn(),
  preview: vi.fn(),
  giveBack: vi.fn(),
  browserScope: vi.fn((id: string) => {
    if (id === "group-missing") throw new Error("群聊不存在")
    return id
  }),
  snapshot: vi.fn(() => ({ revision: 1 })),
  exchange: vi.fn(),
  exchangeHistory: vi.fn(),
  messageOrigins: vi.fn(),
  messageReply: vi.fn(),
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
  windowFor:vi.fn(()=>({})),mockBindings:vi.fn(),mockBinding:vi.fn(),createMockBinding:vi.fn(),injectMockEvent:vi.fn(),revokeMockBinding:vi.fn(),setMockOnline:vi.fn(),mockHistory:vi.fn()
}))
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents:fixture.windowFor },
  powerMonitor: { on: vi.fn() }
}))
vi.mock("../bots/local-service", () => ({
  initializeBotNotificationDispatch: vi.fn(),
  getLocalBotHost: fixture.getHost,
  getBotMemoryService: () => ({
    removeBot: fixture.removeBot,
    share: fixture.share,
    write: fixture.write,
    remove: fixture.remove
  }),
  getBotBrowserService: () => ({
    giveBack: fixture.giveBack,
    preview: fixture.preview,
    removeBot: fixture.removeBot,
    removeGroup: fixture.removeBrowserGroup
  })
}))
vi.mock("../bots/conversation-link-service",()=>({resolveWorkConversation:vi.fn(),exposeWorkConversation:vi.fn(),linkExistingConversation:vi.fn(),unlinkWorkConversation:vi.fn(),unlinkDeletingWorkConversation:vi.fn()}))
vi.mock("../db", () => ({ getThreadCore: fixture.getThread }))
vi.mock("../bots/runtime-adapter", () => ({ prepareBotThread: vi.fn() }))
vi.mock("./bot-files", () => ({ registerBotFileHandlers: vi.fn() }))
import { registerBotHandlers } from "./bots"

function register(deleteThread?: Parameters<typeof registerBotHandlers>[1], event:unknown={}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerBotHandlers(
    {
      handle: (channel, listener) => handlers.set(channel, listener)
    } as unknown as IpcMain,
    deleteThread
  )
  return (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args)
}
beforeEach(() => {
  vi.clearAllMocks()
  fixture.getHost.mockImplementation(() => fixture)
})
describe("Bot IPC boundaries", () => {
  it("keeps simulation binding authority in a top-level local desktop window and rejects injected source/paths",()=>{
    const frame={},event={senderFrame:frame,sender:{mainFrame:frame}}
    const call=register(undefined,event)
    const input={simulation:true,botId:"a",operationId:"bind",kind:"dm",channelKey:"dm-a",label:"Personal",allowedSenderIds:["alice"]}
    call("bots:mock:create","local",input)
    expect(fixture.createMockBinding).toHaveBeenCalledWith(input)
    for(const extra of [{owner:true},{threadId:"private"},{source:{audienceKey:"desktop"}},{modelRef:"model"},{workspacePath:"/private"}])expect(()=>call("bots:mock:create","local",{...input,...extra})).toThrow()
    const message={simulation:true,bindingId:"b",eventId:"e",messageId:"m",senderId:"alice",text:"Hello",mentionsBotIds:[]}
    call("bots:mock:inject","local",message)
    expect(fixture.injectMockEvent).toHaveBeenCalledWith(message)
    for(const extra of [{origin:"user"},{mockSource:{}},{workId:"w"},{threadId:"private"},{credentials:"secret"}])expect(()=>call("bots:mock:inject","local",{...message,...extra})).toThrow()
    expect(()=>call("bots:mock:inject","local",{...message,text:'<attachment filename="private">x</attachment>'})).toThrow()
    expect(()=>register(undefined,{...event,senderFrame:{}})("bots:mock:create","local",input)).toThrow("桌面")
    fixture.windowFor.mockReturnValueOnce(null as any)
    expect(()=>call("bots:mock:create","local",input)).toThrow("桌面")
    expect(()=>call("bots:mock:create","remote",input)).toThrow()
    expect(()=>call("bots:mock:online","local","a","b","yes")).toThrow()
    expect(()=>call("bots:mock:revoke","local","a","b",0)).toThrow()
    expect(()=>call("bots:mock:history","local","a","b","x".repeat(1025))).toThrow()
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
    expect(() => call("bots:message-reply", "local", "bot", "other/thread")).toThrow()
    expect(fixture.messageReply).not.toHaveBeenCalled()
    call("bots:message-reply", "local", "bot", "message")
    expect(fixture.messageReply).toHaveBeenCalledWith("bot", "message", undefined)
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
