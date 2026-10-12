import { afterEach, expect, it, vi } from "vitest"
import { BotDomainError } from "../../../shared/bot-types"
import type { BotMemoryPolicy, BotMemoryRetryInput } from "../../../shared/bot-memory"
import { pendingMemoryRetryStore } from "./bot-memory-pending"
import { useBotEpochOperation } from "./use-bot-epoch-operation"
const ports = vi.hoisted(() => ({
  values: new Map<string, string>(),
  state: {
    snapshot: { dataEpoch: "before" },
    host: { capabilities: ["mutation-data-epoch", "mutation-data-epoch-v2"] }
  },
  hooks: { slots: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }
}))
vi.mock("react", () => ({
  useState(initial: unknown) {
    const i = ports.hooks.cursor++
    if (!(i in ports.hooks.slots))
      ports.hooks.slots[i] = typeof initial === "function" ? initial() : initial
    return [ports.hooks.slots[i], (next: unknown) => (ports.hooks.slots[i] = next)]
  },
  useRef(initial: unknown) {
    const i = ports.hooks.cursor++
    if (!(i in ports.hooks.slots)) ports.hooks.slots[i] = { current: initial }
    return ports.hooks.slots[i]
  },
  useCallback: (callback: unknown) => callback,
  useLayoutEffect(effect: () => void | (() => void)) {
    const i = ports.hooks.cursor++
    if (!(i in ports.hooks.slots)) {
      ports.hooks.slots[i] = true
      ports.hooks.effects.push(effect)
    }
  }
}))
vi.mock("./bot-workspace-store", () => ({
  useBotWorkspaceStore: Object.assign(
    (select: (state: unknown) => unknown) => select(ports.state),
    { getState: () => ports.state }
  )
}))
const botId = "03165af2-0d60-4bb4-a960-6fe665cc8e93",
  key = `cmb:bot-memory-retry:pending:${botId}`
const input: BotMemoryRetryInput = { botId, dataEpoch: "before", revision: 0, nonce: "exact" }
const receipt: BotMemoryPolicy = {
  dataEpoch: "before",
  revision: 1,
  enabled: true,
  pending: 1,
  lastOutcome: "queued",
  lastAttemptAt: 1
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (failure: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function fixture() {
  ports.values.clear()
  ports.state.snapshot.dataEpoch = "before"
  ports.state.host.capabilities = ["mutation-data-epoch", "mutation-data-epoch-v2"]
  ports.hooks.slots = []
  ports.hooks.effects = []
  const faults = { read: false, remove: false, writeRestore: false },
    cleanups: (() => void)[] = [],
    change = vi.fn(async () => receipt),
    sync = vi.fn<(reply: BotMemoryPolicy, live: () => boolean) => Promise<void>>(async () => {}),
    props = { scope: `memory:${botId}` }
  vi.stubGlobal("localStorage", {
    getItem: (id: string) => {
      if (faults.read) throw Error("unreadable")
      return ports.values.get(id) ?? null
    },
    setItem: (id: string, raw: string) => {
      ports.values.set(id, raw)
      if (faults.writeRestore) ports.state.snapshot.dataEpoch = "after"
    },
    removeItem: (id: string) => {
      if (faults.remove) throw Error("denied")
      ports.values.delete(id)
    }
  })
  const render = () => {
    ports.hooks.cursor = 0
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Actual Hook ports; formal Chrome owns React commit tests.
    const operation = useBotEpochOperation({
      scope: props.scope,
      pending: {
        inspect: (epoch) => pendingMemoryRetryStore.inspect(botId, epoch),
        remember: pendingMemoryRetryStore.remember,
        acknowledge: pendingMemoryRetryStore.acknowledge,
        discard: (epoch, raw) => pendingMemoryRetryStore.discard(botId, epoch, raw)
      },
      matchesInput: (next: BotMemoryRetryInput) => next.botId === botId,
      verifies: (next, reply) =>
        reply.dataEpoch === next.dataEpoch &&
        reply.revision === next.revision + 1 &&
        reply.lastOutcome === "queued",
      change,
      definitiveErrors: [
        "invalid_input",
        "revision_conflict",
        "nonce_conflict",
        "not_found",
        "memory_disabled"
      ],
      onConfirmed: sync
    })
    for (const effect of ports.hooks.effects.splice(0)) {
      const cleanup = effect()
      if (cleanup) cleanups.push(cleanup)
    }
    return operation
  }
  return {
    render,
    change,
    sync,
    faults,
    props,
    unmount: () => cleanups.splice(0).forEach((stop) => stop())
  }
}
afterEach(() => vi.unstubAllGlobals())
it.each(["success", "rejection"])(
  "retired %s retains the original raw and releases mounted busy",
  async (mode) => {
    const f = fixture(),
      held = deferred<BotMemoryPolicy>()
    f.change.mockReturnValue(held.promise)
    const saving = f.render().save(() => input),
      raw = ports.values.get(key)
    ports.state.snapshot.dataEpoch = "after"
    f.render()
    if (mode === "success") held.resolve(receipt)
    else held.reject(new BotDomainError("revision_conflict", "rejected"))
    expect(await saving).toBe(false)
    expect(ports.values.get(key)).toBe(raw)
    expect(f.render().busy).toBe(false)
    expect(f.sync).not.toHaveBeenCalled()
  }
)
it.each(["success", "rejection"])(
  "same-epoch unmount permits exact %s ACK without follow-up",
  async (mode) => {
    const f = fixture(),
      held = deferred<BotMemoryPolicy>()
    f.change.mockReturnValue(held.promise)
    const saving = f.render().save(() => input)
    f.unmount()
    if (mode === "success") held.resolve(receipt)
    else held.reject(new BotDomainError("revision_conflict", "rejected"))
    expect(await saving).toBe(false)
    expect(ports.values.size).toBe(0)
    expect(f.sync).not.toHaveBeenCalled()
  }
)
it.each(["success", "rejection"])(
  "confirmed %s cleanup failure retries only local cleanup",
  async (mode) => {
    const f = fixture()
    f.faults.remove = true
    if (mode === "rejection")
      f.change.mockRejectedValue(new BotDomainError("revision_conflict", "rejected"))
    expect(await f.render().save(() => input)).toBe(false)
    expect(f.render().acknowledged).toBe(true)
    f.faults.remove = false
    await f.render().save(() => ({ ...input, nonce: "new" }))
    expect(f.change).toHaveBeenCalledTimes(1)
    expect(ports.values.size).toBe(0)
    expect(f.render().acknowledged).toBe(false)
  }
)
it("known follow-up failure retries reading, never dispatches another mutation", async () => {
  const f = fixture()
  f.sync.mockRejectedValueOnce(Error("read failed"))
  expect(await f.render().save(() => input)).toBe(false)
  expect(f.render().acknowledged).toBe(true)
  expect(ports.values.size).toBe(0)
  expect(await f.render().save(() => ({ ...input, nonce: "new" }))).toBe(true)
  expect(f.change).toHaveBeenCalledTimes(1)
  expect(f.sync).toHaveBeenCalledTimes(2)
})
it("checks the actual current epoch after synchronous pending storage", async () => {
  const f = fixture()
  f.faults.writeRestore = true
  expect(await f.render().save(() => input)).toBe(false)
  expect(f.change).not.toHaveBeenCalled()
  expect(ports.values.get(key)).toBeTruthy()
})
it("an unknown request from another pane is shown before dispatch, and retry preserves it", async () => {
  const f = fixture(),
    pane = f.render()
  pendingMemoryRetryStore.remember(input)
  expect(await pane.save(() => ({ ...input, nonce: "new" }))).toBe(false)
  expect(f.change).not.toHaveBeenCalled()
  f.change.mockRejectedValueOnce(Error("lost"))
  expect(await f.render().save()).toBe(false)
  expect(f.change).toHaveBeenCalledWith(input)
  expect(ports.values.size).toBe(1)
})
it("data_epoch refusal preserves the request even before Workspace refresh", async () => {
  const f = fixture()
  f.change.mockRejectedValue(new BotDomainError("data_epoch", "restored"))
  expect(await f.render().save(() => input)).toBe(false)
  expect(f.render().restored).toBe(true)
  expect(ports.values.size).toBe(1)
  expect(await f.render().save()).toBe(false)
  expect(f.change).toHaveBeenCalledTimes(1)
})
it("mismatched receipt is never acknowledged", async () => {
  const f = fixture()
  f.change.mockResolvedValue({ ...receipt, revision: 5 })
  expect(await f.render().save(() => input)).toBe(false)
  expect(ports.values.size).toBe(1)
  expect(f.render().acknowledged).toBe(false)
  expect(f.sync).not.toHaveBeenCalled()
})
it("changing owner scope revokes its held ACK even without a Workspace epoch change", async () => {
  const f = fixture(),
    held = deferred<BotMemoryPolicy>()
  f.change.mockReturnValue(held.promise)
  const saving = f.render().save(() => input),
    raw = ports.values.get(key)
  f.props.scope = "other"
  f.render()
  held.resolve(receipt)
  expect(await saving).toBe(false)
  expect(ports.values.get(key)).toBe(raw)
  expect(f.sync).not.toHaveBeenCalled()
})
it("retired/unmounted archive handlers cannot remove a reviewed corrupt record", () => {
  const f = fixture(),
    pane = f.render()
  ports.values.set(key, "{")
  ports.state.snapshot.dataEpoch = "after"
  expect(pane.discard("{")).toBe(false)
  ports.state.snapshot.dataEpoch = "before"
  ports.state.host.capabilities = ["mutation-data-epoch", "mutation-data-epoch-v2"]
  f.unmount()
  expect(pane.discard("{")).toBe(false)
  expect(ports.values.get(key)).toBe("{")
})
it("a readonly follow-up finishing after restore cannot report current success", async () => {
  const f = fixture(),
    held = deferred<void>()
  f.sync.mockReturnValue(held.promise)
  const saving = f.render().save(() => input)
  await vi.waitFor(() => expect(f.sync).toHaveBeenCalledTimes(1))
  ports.state.snapshot.dataEpoch = "after"
  held.resolve()
  expect(await saving).toBe(false)
  expect(f.render().busy).toBe(false)
})

it.each([false, true])(
  "old generic epoch capability cannot dispatch an original-nonce operation with record=%s",
  async (remembered) => {
    const f = fixture()
    if (remembered) pendingMemoryRetryStore.remember(input)
    ports.state.host.capabilities = ["mutation-data-epoch"]
    const operation = f.render(),
      raw = ports.values.get(key)
    if (remembered) expect(raw).toBeTruthy()
    expect(operation.fieldsDisabled).toBe(true)
    expect(operation.saveDisabled).toBe(true)
    expect(operation.error).toContain("更新")
    expect(await operation.save(() => input)).toBe(false)
    expect(f.change).not.toHaveBeenCalled()
    expect(ports.values.get(key)).toBe(raw)
  }
)
