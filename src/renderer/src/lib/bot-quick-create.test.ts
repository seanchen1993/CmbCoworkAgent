import { expect, it, vi } from "vitest"
import { BotDomainError, type CoworkBot, type BotCreateInput } from "../../../shared/bot-types"
import { createPendingBotStore } from "./bot-editor-pending"
import {
  createBotQuickCreateController,
  type BotQuickCreateReceipt,
  type BotQuickCreateScope
} from "./bot-quick-create"
const defaults = () => ({
  name: "新 Bot",
  instructions: "",
  modelRef: null,
  workspacePath: null,
  connectorIds: [],
  avatarShape: null,
  avatarColor: null
})
const receipt: BotQuickCreateReceipt = {
  conversationId: "conversation",
  bot: {
    id: "bot",
    name: "新 Bot",
    instructions: "",
    modelRef: null,
    workspacePath: null,
    revision: 1,
    hidden: false,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null
  } satisfies CoworkBot
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, no) => {
    resolve = ok
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture() {
  const values = new Map<string, string>()
  let cleanupFailure = false
  const pending = createPendingBotStore(() => ({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      if (cleanupFailure) throw new Error("denied")
      values.delete(key)
    }
  }))
  let scope: BotQuickCreateScope = {
    dataEpoch: "epoch",
    selected: "old",
    lease: { viewId: "old", generation: 1 },
    capabilities: ["scoped-bot-create", "mutation-data-epoch-v2"]
  }
  const create = vi.fn(async (input: BotCreateInput) => ({
      ...receipt,
      bot: { ...receipt.bot, name: input.name }
    })),
    refresh = vi.fn(async () => {}),
    select = vi.fn(),
    nonce = vi.fn(() => "create-nonce")
  const controller = createBotQuickCreateController({
    scope: () => scope,
    defaults,
    create,
    refresh,
    select,
    pending,
    nonce
  })
  return {
    pending,
    controller,
    create,
    refresh,
    select,
    values,
    setScope: (next: BotQuickCreateScope) => {
      scope = next
    },
    scope: () => scope,
    setCleanupFailure: (value: boolean) => {
      cleanupFailure = value
    }
  }
}
it("accepts one immediate entity creation without model configuration and blocks duplicate clicks", async () => {
  const f = fixture(),
    request = deferred<BotQuickCreateReceipt>()
  f.create.mockImplementation(() => request.promise)
  const first = f.controller.start()
  await f.controller.start()
  expect(f.create).toHaveBeenCalledTimes(1)
  expect(f.pending.read(undefined, "epoch")).toMatchObject({
    nonce: "create-nonce",
    expectedDataEpoch: "epoch",
    modelRef: null,
    instructions: ""
  })
  request.resolve(receipt)
  await first
  expect(f.select).toHaveBeenCalledWith("conversation")
  expect(f.values.size).toBe(0)
})
it("reopens and verifies exactly the lost ACK instead of replacing the pending nonce or payload", async () => {
  const f = fixture()
  f.create.mockRejectedValueOnce(new Error("disconnected"))
  await f.controller.start()
  const original = f.pending.read(undefined, "epoch")!
  expect(f.controller.getSnapshot().phase).toBe("uncertain")
  f.controller.dispose()
  const newCreate = vi.fn(async () => receipt),
    next = createBotQuickCreateController({
      scope: f.scope,
      defaults,
      create: newCreate,
      refresh: f.refresh,
      select: f.select,
      pending: f.pending,
      nonce: () => "do-not-use"
    })
  await next.start()
  expect(newCreate).toHaveBeenCalledWith(original)
  expect(f.values.size).toBe(0)
  expect(f.select).toHaveBeenCalledTimes(1)
})
it("never resends an acknowledged mutation just because refresh or cleanup failed", async () => {
  const f = fixture()
  f.setCleanupFailure(true)
  await f.controller.start()
  expect(f.controller.getSnapshot().phase).toBe("cleanup_failed")
  expect(f.create).toHaveBeenCalledTimes(1)
  f.setCleanupFailure(false)
  f.refresh.mockRejectedValueOnce(new Error("offline"))
  await f.controller.start()
  expect(f.controller.getSnapshot().phase).toBe("sync_failed")
  expect(f.values.size).toBe(0)
  await f.controller.start()
  expect(f.create).toHaveBeenCalledTimes(1)
  expect(f.select).toHaveBeenCalledTimes(1)
})
it("does not steal the current view after A→B→A or unmount while still acknowledging its receipt", async () => {
  const f = fixture(),
    request = deferred<BotQuickCreateReceipt>()
  f.create.mockImplementation(() => request.promise)
  const first = f.controller.start()
  f.setScope({ ...f.scope(), lease: { viewId: "old", generation: 3 } })
  request.resolve(receipt)
  await first
  expect(f.select).not.toHaveBeenCalled()
  expect(f.values.size).toBe(0)
  const g = fixture(),
    late = deferred<BotQuickCreateReceipt>()
  g.create.mockImplementation(() => late.promise)
  const second = g.controller.start()
  g.controller.dispose()
  late.resolve(receipt)
  await second
  expect(g.select).not.toHaveBeenCalled()
  expect(g.values.size).toBe(0)
})
it("does not replay an old workspace intent after restore or send when the Host lacks the fence", async () => {
  const f = fixture()
  f.pending.remember({ nonce: "old", ...defaults() }, "previous")
  await f.controller.start()
  expect(f.controller.getSnapshot().phase).toBe("blocked")
  expect(f.create).not.toHaveBeenCalled()
  const raw = f.values.get("bot-editor-pending:new")!
  expect(f.controller.repair(raw + "changed")).toBe(false)
  expect(f.controller.repair(raw)).toBe(true)
  f.setScope({ ...f.scope(), capabilities: [] })
  await f.controller.start()
  expect(f.create).not.toHaveBeenCalled()
})
it("ends only typed definitive rejection and cleanup retry never replays a rejected operation", async () => {
  const f = fixture()
  f.create.mockRejectedValueOnce(new BotDomainError("bot_limit", "达到上限"))
  f.setCleanupFailure(true)
  await f.controller.start()
  expect(f.controller.getSnapshot().phase).toBe("cleanup_failed")
  f.setCleanupFailure(false)
  await f.controller.start()
  expect(f.controller.getSnapshot().phase).toBe("error")
  expect(f.create).toHaveBeenCalledTimes(1)
  expect(f.values.size).toBe(0)
  const g = fixture()
  g.create.mockRejectedValueOnce(new BotDomainError("unauthorized", "认证失败"))
  await g.controller.start()
  expect(g.pending.read(undefined, "epoch")).not.toBeNull()
})
it("preserves legacy pending payload unchanged without introducing the new hash fields", async () => {
  const f = fixture(),
    old = { nonce: "legacy", ...defaults() }
  f.pending.remember(old, "epoch")
  await f.controller.start()
  expect(f.create).toHaveBeenCalledWith(old)
  expect(f.create.mock.calls[0][0]).not.toHaveProperty("expectedDataEpoch")
})

it("delivers selection only to the current mounted effect registration", async () => {
  const f = fixture(),
    request = deferred<BotQuickCreateReceipt>(),
    old = vi.fn(),
    current = vi.fn()
  f.create.mockImplementation(() => request.promise)
  const unregisterOld = f.controller.onSelected(old)
  const started = f.controller.start()
  f.controller.onSelected(current)
  unregisterOld()
  request.resolve(receipt)
  await started
  expect(old).not.toHaveBeenCalled()
  expect(current).toHaveBeenCalledWith("conversation")
  const g = fixture(),
    pending = deferred<BotQuickCreateReceipt>(),
    detached = vi.fn()
  g.create.mockImplementation(() => pending.promise)
  const unregister = g.controller.onSelected(detached)
  const another = g.controller.start()
  unregister()
  pending.resolve(receipt)
  await another
  expect(detached).not.toHaveBeenCalled()
})

it("retains an exact retired creation intent when a definitive rejection arrives after restore", async () => {
  const f = fixture(),
    request = deferred<BotQuickCreateReceipt>()
  f.create.mockImplementation(() => request.promise)
  const started = f.controller.start()
  const original = f.values.get("bot-editor-pending:new")
  f.setScope({ ...f.scope(), dataEpoch: "replacement" })
  request.reject(new BotDomainError("workspace_replaced", "恢复后的工作区拒绝了原请求"))
  await started
  expect(f.values.get("bot-editor-pending:new")).toBe(original)
  expect(f.pending.inspect(undefined, "replacement").kind).toBe("obsolete")
  expect(f.select).not.toHaveBeenCalled()
  expect(f.controller.getSnapshot()).toMatchObject({
    busy: false,
    phase: "error"
  })
})

it("clears a definitively rejected same-epoch intent after unmount without publishing UI", async () => {
  const f = fixture(),
    request = deferred<BotQuickCreateReceipt>(),
    changed = vi.fn()
  f.controller.subscribe(changed)
  f.create.mockImplementation(() => request.promise)
  const started = f.controller.start()
  f.controller.dispose()
  changed.mockClear()
  request.reject(new BotDomainError("bot_limit", "达到上限"))
  await started
  expect(f.values.size).toBe(0)
  expect(f.select).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
})

it("rechecks epoch after the busy publication immediately before real dispatch", async () => {
  const f = fixture()
  f.controller.subscribe(() => {
    if (f.controller.getSnapshot().busy) f.setScope({ ...f.scope(), dataEpoch: "replacement" })
  })
  await f.controller.start()
  expect(f.create).not.toHaveBeenCalled()
  expect(f.pending.inspect(undefined, "replacement").kind).toBe("obsolete")
  expect(f.controller.getSnapshot().busy).toBe(false)
})

it.each(["data_epoch", "workspace_replaced"])(
  "retains original create on %s before snapshot catches up and never automatically resends it",
  async (code) => {
    const f = fixture()
    f.create.mockRejectedValue(new BotDomainError(code, "Restored"))
    await f.controller.start()
    const raw = f.values.get("bot-editor-pending:new")
    expect(raw).toContain('"expectedDataEpoch":"epoch"')
    expect(f.controller.getSnapshot().phase).toBe("error")
    await f.controller.start()
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.values.get("bot-editor-pending:new")).toBe(raw)
    expect(f.refresh).not.toHaveBeenCalled()
    expect(f.select).not.toHaveBeenCalled()
  }
)
it("does not refresh a disposed owner after an exact same-epoch ACK", async () => {
  const f = fixture(),
    late = deferred<BotQuickCreateReceipt>()
  f.create.mockImplementation(() => late.promise)
  const started = f.controller.start()
  f.controller.dispose()
  late.resolve(receipt)
  await started
  expect(f.values.size).toBe(0)
  expect(f.refresh).not.toHaveBeenCalled()
  expect(f.select).not.toHaveBeenCalled()
})
it("blocks creating when scoped-create exists but mutation-data-epoch does not", async () => {
  const f = fixture()
  f.setScope({ ...f.scope(), capabilities: ["scoped-bot-create"] })
  await f.controller.start()
  expect(f.create).not.toHaveBeenCalled()
  expect(f.values.size).toBe(0)
})

it("adopts the authenticated first-use target before refresh and never rewrites it on sync retry", async () => {
  const f = fixture(),
    events: string[] = []
  f.setScope({ ...f.scope(), selected: null, lease: null })
  const adopt = vi.fn((_input, saved) => {
    events.push("adopt")
    f.setScope({
      ...f.scope(),
      selected: saved.conversationId,
      lease: { viewId: saved.conversationId, generation: 2 }
    })
    return true
  })
  const ready = vi.fn(() => true),
    selected = vi.fn()
  f.controller.onSelected(selected)
  f.refresh
    .mockImplementationOnce(async () => {
      events.push("refresh-failed")
      throw new Error("read failed")
    })
    .mockImplementationOnce(async () => {
      events.push("refresh")
    })
  const continuation = {
    openNonce: "ui-session",
    sourceRevision: "revision",
    current: () => true,
    adopt,
    ready
  }
  await f.controller.start(continuation)
  expect(events).toEqual(["adopt", "refresh-failed"])
  expect(f.controller.getSnapshot().phase).toBe("sync_failed")
  await f.controller.start({
    ...continuation,
    openNonce: "later-session",
    adopt: vi.fn(() => false)
  })
  expect(events).toEqual(["adopt", "refresh-failed", "refresh"])
  expect(adopt).toHaveBeenCalledTimes(1)
  expect(f.create).toHaveBeenCalledTimes(1)
  expect(selected).toHaveBeenCalledExactlyOnceWith(receipt.conversationId)
  expect(f.select).not.toHaveBeenCalled()
})

it("an unknown create retains its original UI binding and nonce rather than adopting a later draft", async () => {
  const f = fixture(),
    first = vi.fn(() => false),
    later = vi.fn(() => true)
  f.create.mockRejectedValueOnce(new Error("lost ACK"))
  const original = {
    openNonce: "old-ui",
    sourceRevision: "old-revision",
    current: () => false,
    adopt: first,
    ready: () => false
  }
  await f.controller.start(original)
  const input = f.create.mock.calls[0][0]
  await f.controller.start({ ...original, openNonce: "new-ui", current: () => true, adopt: later })
  expect(f.create.mock.calls[1][0]).toEqual(input)
  expect(first).not.toHaveBeenCalled()
  expect(later).not.toHaveBeenCalled()
  expect(f.select).not.toHaveBeenCalled()
  expect(f.values.size).toBe(0)
})

it("a restored pending create cannot adopt an unrelated new local session", async () => {
  const f = fixture(),
    adopt = vi.fn(() => true)
  f.pending.remember({ ...defaults(), nonce: "old-create", expectedDataEpoch: "epoch" }, "epoch")
  await f.controller.start({
    openNonce: "new-ui",
    sourceRevision: "revision",
    current: () => true,
    adopt,
    ready: () => true
  })
  expect(f.create.mock.calls[0][0].nonce).toBe("old-create")
  expect(adopt).not.toHaveBeenCalled()
  expect(f.select).not.toHaveBeenCalled()
})

it("a blocked draft handoff still settles create without changing the selected conversation", async () => {
  const f = fixture(),
    adopt = vi.fn(() => false),
    ready = vi.fn(() => true),
    selected = vi.fn()
  f.controller.onSelected(selected)
  await f.controller.start({
    openNonce: "ui",
    sourceRevision: "revision",
    current: () => true,
    adopt,
    ready
  })
  expect(adopt).toHaveBeenCalledTimes(1)
  expect(f.refresh).toHaveBeenCalledExactlyOnceWith(true)
  expect(f.values.size).toBe(0)
  expect(f.select).not.toHaveBeenCalled()
  expect(selected).not.toHaveBeenCalled()
  expect(ready).not.toHaveBeenCalled()
})

it("freezes an explicitly chosen recipient name into only the new original create intent", async () => {
  const f = fixture()
  f.create.mockRejectedValueOnce(new Error("lost ACK"))
  await f.controller.start(undefined, "具名助手")
  const input = f.create.mock.calls[0][0]
  expect(input.name).toBe("具名助手")
  await f.controller.start(undefined, "后来输入的新名字")
  expect(f.create.mock.calls[1][0]).toEqual(input)
  expect(f.create.mock.calls[1][0].name).toBe("具名助手")
})

function supportReview(f: ReturnType<typeof fixture>) {
  f.setScope({ ...f.scope(), capabilities: [...f.scope().capabilities, "bot-create-review-v1"] })
}
it.each([true, false])(
  "waits for explicit creation confirmation before storing review=%s",
  async (enabled) => {
    const f = fixture()
    supportReview(f)
    await f.controller.start(undefined, "Named")
    expect(f.controller.getSnapshot().phase).toBe("configure")
    expect(f.create).not.toHaveBeenCalled()
    expect(f.pending.inspect(undefined, "epoch").kind).toBe("empty")
    await f.controller.confirmReview(enabled)
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.create.mock.calls[0][0]).toMatchObject({ name: "Named", autoReviewEnabled: enabled })
    expect(f.controller.getSnapshot().phase).toBe("idle")
  }
)
it("cancels an unsubmitted creation without writing a request or policy", async () => {
  const f = fixture()
  supportReview(f)
  await f.controller.start()
  f.controller.cancelReview()
  await f.controller.confirmReview(true)
  expect(f.create).not.toHaveBeenCalled()
  expect(f.pending.inspect(undefined, "epoch").kind).toBe("empty")
  expect(f.controller.getSnapshot().phase).toBe("idle")
})
it("does not apply creation consent to another chat or workspace", async () => {
  const f = fixture()
  supportReview(f)
  await f.controller.start()
  f.setScope({ ...f.scope(), selected: "other" })
  await f.controller.confirmReview(true)
  expect(f.create).not.toHaveBeenCalled()
  expect(f.pending.inspect(undefined, "epoch").kind).toBe("empty")
  expect(f.controller.getSnapshot().notice?.message).toContain("尚未创建")
})
it("retains an exact acknowledged-lost review choice and never retrofits legacy pending requests", async () => {
  const f = fixture()
  supportReview(f)
  f.create.mockRejectedValueOnce(new Error("ack lost"))
  await f.controller.start()
  await f.controller.confirmReview(false)
  const submitted = f.create.mock.calls[0][0]
  expect(submitted.autoReviewEnabled).toBe(false)
  await f.controller.start()
  expect(f.create.mock.calls[1][0]).toEqual(submitted)
  const legacy = fixture()
  legacy.create.mockRejectedValueOnce(new Error("ack lost"))
  await legacy.controller.start()
  supportReview(legacy)
  await legacy.controller.start()
  expect(legacy.create.mock.calls[1][0]).toEqual(legacy.create.mock.calls[0][0])
  expect(legacy.create.mock.calls[1][0]).not.toHaveProperty("autoReviewEnabled")
})
it("blocks a pending explicit choice on an older Host instead of silently losing it", async () => {
  const f = fixture()
  supportReview(f)
  f.create.mockRejectedValueOnce(new Error("ack lost"))
  await f.controller.start()
  await f.controller.confirmReview(true)
  f.setScope({ ...f.scope(), capabilities: ["scoped-bot-create", "mutation-data-epoch-v2"] })
  await f.controller.start()
  expect(f.create).toHaveBeenCalledTimes(1)
  expect(f.pending.read(undefined, "epoch")?.autoReviewEnabled).toBe(true)
  expect(f.controller.getSnapshot().notice?.message).toContain("支持此功能")
})

it("does not transfer unsubmitted review consent across Host changes sharing an initial epoch", async () => {
  const f = fixture()
  supportReview(f)
  f.setScope({ ...f.scope(), hostId: "first-host" })
  await f.controller.start()
  f.setScope({ ...f.scope(), hostId: "second-host" })
  await f.controller.confirmReview(true)
  expect(f.create).not.toHaveBeenCalled()
  expect(f.pending.inspect(undefined, "epoch").kind).toBe("empty")
})
