import { afterEach, expect, it, vi } from "vitest"
import { BotDomainError, type BotConversation } from "../../../shared/bot-types"
import { useBotGroupSave, type BotGroupSaveOptions } from "./use-bot-group-save"

const ports = vi.hoisted(() => {
  const values = new Map<string, string>()
  const state = {
    snapshot: { dataEpoch: "before" },
    host: { capabilities: ["group-update-receipts", "mutation-data-epoch-v2"] }
  }
  const hooks = {
    slots: [] as unknown[],
    cursor: 0,
    effects: [] as (() => void | (() => void))[]
  }
  return { values, state, hooks, updateGroup: vi.fn(), createGroup: vi.fn() }
})
vi.mock("react", () => ({
  useState(initial: unknown) {
    const index = ports.hooks.cursor++
    if (!(index in ports.hooks.slots))
      ports.hooks.slots[index] = typeof initial === "function" ? initial() : initial
    return [ports.hooks.slots[index], (value: unknown) => (ports.hooks.slots[index] = value)]
  },
  useRef(initial: unknown) {
    const index = ports.hooks.cursor++
    if (!(index in ports.hooks.slots)) ports.hooks.slots[index] = { current: initial }
    return ports.hooks.slots[index]
  },
  useLayoutEffect(effect: () => void | (() => void)) {
    const index = ports.hooks.cursor++
    if (!(index in ports.hooks.slots)) {
      ports.hooks.slots[index] = true
      ports.hooks.effects.push(effect)
    }
  },
  useEffect(effect: () => void | (() => void)) {
    const index = ports.hooks.cursor++
    if (!(index in ports.hooks.slots)) {
      ports.hooks.slots[index] = true
      ports.hooks.effects.push(effect)
    }
  }
}))
vi.mock("./bot-api", () => ({
  botApi: { updateGroup: ports.updateGroup, createGroup: ports.createGroup }
}))
vi.mock("./bot-workspace-store", () => {
  const useBotWorkspaceStore = Object.assign(
    (select: (state: unknown) => unknown) => select(ports.state),
    {
      getState: () => ports.state
    }
  )
  return { useBotWorkspaceStore }
})
const fields = {
  id: "group",
  revision: 1,
  name: "Team",
  description: "",
  members: ["b", "a"]
}
const receipt: BotConversation = {
  id: "group",
  kind: "group",
  name: "Team",
  description: "",
  revision: 2,
  members: ["a", "b"],
  createdAt: 1
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function fixture(
  onSaved = vi.fn(async () => {}),
  options?: BotGroupSaveOptions,
  id: string | null = "group"
) {
  ports.values.clear()
  ports.hooks.slots = []
  ports.hooks.effects = []
  ports.state.snapshot.dataEpoch = "before"
  ports.state.host.capabilities = ["group-update-receipts", "mutation-data-epoch-v2"]
  ports.updateGroup.mockReset()
  ports.createGroup.mockReset()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => ports.values.get(key) ?? null,
    setItem: (key: string, value: string) => ports.values.set(key, value),
    removeItem: (key: string) => ports.values.delete(key)
  })
  const cleanup: (() => void)[] = []
  const render = () => {
    ports.hooks.cursor = 0
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Execute the actual hook against deterministic React ports; the browser suite covers real React mounting.
    const session = useBotGroupSave(id ?? undefined, onSaved, options)
    for (const effect of ports.hooks.effects.splice(0)) {
      const dispose = effect()
      if (dispose) cleanup.push(dispose)
    }
    return session
  }
  return {
    render,
    onSaved,
    unmount: () => cleanup.splice(0).forEach((dispose) => dispose())
  }
}
afterEach(() => vi.unstubAllGlobals())

it.each(["success", "definitive rejection"])(
  "retains the exact retired record on late %s while the original card remains mounted",
  async (mode) => {
    const f = fixture(),
      response = deferred<BotConversation>()
    ports.updateGroup.mockReturnValue(response.promise)
    const result = f.render().save(fields)
    const raw = [...ports.values.values()][0]
    expect(raw).toContain('"dataEpoch":"before"')
    ports.state.snapshot.dataEpoch = "restored"
    expect(f.render()).toMatchObject({ restored: true, busy: true })
    if (mode === "success") response.resolve(receipt)
    else response.reject(new BotDomainError("revision_conflict", "Changed"))
    await expect(result).resolves.toBe(false)
    expect([...ports.values.values()]).toEqual([raw])
    expect(f.onSaved).not.toHaveBeenCalled()
    expect(f.render()).toMatchObject({
      busy: false,
      restored: true,
      acknowledged: false,
      error: null
    })
    f.unmount()
  }
)
it("does not dispatch a handler captured before restore, even before the next render", async () => {
  const f = fixture(),
    stale = f.render()
  ports.state.snapshot.dataEpoch = "restored"
  await expect(stale.save(fields)).resolves.toBe(false)
  expect(ports.updateGroup).not.toHaveBeenCalled()
  expect(ports.values.size).toBe(0)
  f.unmount()
})
it("returns false when the list refresh finishes after a restore and releases mounted busy state", async () => {
  const refresh = deferred<void>(),
    f = fixture(vi.fn(() => refresh.promise))
  ports.updateGroup.mockResolvedValue(receipt)
  const result = f.render().save(fields)
  await vi.waitFor(() => expect(f.onSaved).toHaveBeenCalledOnce())
  // This receipt was confirmed in its own epoch before list reading began.
  expect(ports.values.size).toBe(0)
  ports.state.snapshot.dataEpoch = "restored"
  expect(f.render().restored).toBe(true)
  refresh.resolve()
  await expect(result).resolves.toBe(false)
  expect(f.render().busy).toBe(false)
  f.unmount()
})
it("cleans an exact same-epoch ACK after unmount without running the old UI callback", async () => {
  const f = fixture(),
    response = deferred<BotConversation>()
  ports.updateGroup.mockReturnValue(response.promise)
  const result = f.render().save(fields)
  expect(ports.values.size).toBe(1)
  f.unmount()
  response.resolve(receipt)
  await expect(result).resolves.toBe(false)
  expect(ports.values.size).toBe(0)
  expect(f.onSaved).not.toHaveBeenCalled()
})

it("retries only cleanup after a known acknowledgement cannot remove its exact pending record", async () => {
  const f = fixture()
  let cleanupDenied = true
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => ports.values.get(key) ?? null,
    setItem: (key: string, value: string) => ports.values.set(key, value),
    removeItem: (key: string) => {
      if (cleanupDenied) throw new Error("denied")
      ports.values.delete(key)
    }
  })
  ports.updateGroup.mockResolvedValue(receipt)
  await expect(f.render().save(fields)).resolves.toBe(false)
  expect(f.render()).toMatchObject({ acknowledged: true, busy: false })
  expect(ports.values.size).toBe(1)
  cleanupDenied = false
  await expect(f.render().save()).resolves.toBe(true)
  expect(ports.updateGroup).toHaveBeenCalledOnce()
  expect(f.onSaved).toHaveBeenCalledOnce()
  expect(ports.values.size).toBe(0)
  f.unmount()
})
it("shows another pane's original request before dispatching or replacing its intent", async () => {
  const f = fixture(),
    session = f.render(),
    other = {
      dataEpoch: "before",
      input: { ...fields, nonce: "other", name: "Other" }
    }
  ports.values.set("bot-group-pending:group", JSON.stringify(other))
  await expect(session.save(fields)).resolves.toBe(false)
  expect(ports.updateGroup).not.toHaveBeenCalled()
  expect(f.render().pending).toMatchObject(other.input)
  f.unmount()
})
it("accepts the backend's sorted membership and trimmed fields without requiring an unchanged save to increment revision", async () => {
  const f = fixture()
  ports.updateGroup.mockResolvedValue({ ...receipt, revision: 1 })
  await expect(f.render().save({ ...fields, name: " Team ", description: "  " })).resolves.toBe(
    true
  )
  expect(ports.values.size).toBe(0)
  f.unmount()
})
it.each([["a"], ["a", "a"]])(
  "does not clear an intent for an acknowledgement with mismatched members %j",
  async (...members) => {
    const f = fixture()
    ports.updateGroup.mockResolvedValue({ ...receipt, members })
    await expect(f.render().save(fields)).resolves.toBe(false)
    expect(ports.values.size).toBe(1)
    expect(f.onSaved).not.toHaveBeenCalled()
    f.unmount()
  }
)

it.each(["data_epoch", "workspace_replaced"])(
  "retains and retires an original request on Host %s before Workspace projection updates",
  async (code) => {
    const f = fixture()
    ports.updateGroup.mockRejectedValue(new BotDomainError(code, "Restored"))
    await expect(f.render().save(fields)).resolves.toBe(false)
    const raw = [...ports.values.values()][0]
    expect(JSON.parse(raw).input.expectedDataEpoch).toBe("before")
    const session = f.render()
    expect(session).toMatchObject({
      restored: true,
      acknowledged: false,
      saveDisabled: true
    })
    await expect(session.save()).resolves.toBe(false)
    expect(ports.updateGroup).toHaveBeenCalledOnce()
    expect([...ports.values.values()]).toEqual([raw])
    f.unmount()
  }
)
it.each(["restore", "unmount"])(
  "does not archive or dispatch through a stale %s handler",
  async (transition) => {
    const f = fixture(),
      stale = f.render()
    const raw = "{"
    ports.values.set("bot-group-pending:group", raw)
    if (transition === "restore") ports.state.snapshot.dataEpoch = "restored"
    else f.unmount()
    expect(stale.discard(raw)).toBe(false)
    await expect(stale.save(fields)).resolves.toBe(false)
    expect(ports.updateGroup).not.toHaveBeenCalled()
    expect([...ports.values.values()]).toEqual([raw])
    f.unmount()
  }
)
it("blocks new saves on a Host without submitted generation fencing", async () => {
  const f = fixture()
  ports.state.host.capabilities = ["group-update-receipts"]
  const session = f.render()
  expect(session).toMatchObject({ supported: false, saveDisabled: true })
  await expect(session.save(fields)).resolves.toBe(false)
  expect(ports.values.size).toBe(0)
  expect(ports.updateGroup).not.toHaveBeenCalled()
  f.unmount()
})

const newFields = { name: "New Team", description: "", members: ["b", "a"] }
const newReceipt: BotConversation = { ...receipt, name: "New Team", revision: 1 }

it("rejects a retired local group owner before retaining or submitting a request", async () => {
  const prepared = vi.fn()
  const f = fixture(undefined, { isCurrent: () => false, prepared }, null)
  await expect(f.render().save(newFields)).resolves.toBe(false)
  expect(ports.values.size).toBe(0)
  expect(ports.createGroup).not.toHaveBeenCalled()
  expect(prepared).not.toHaveBeenCalled()
  f.unmount()
})

it("prepares only the new protected request and replays its exact original nonce", async () => {
  const order: string[] = []
  const prepared = vi.fn((input) => {
    expect(JSON.parse(ports.values.get("bot-group-pending:new")!).input).toEqual(input)
    expect(Object.isFrozen(input)).toBe(true)
    expect(Object.isFrozen(input.members)).toBe(true)
    order.push("prepared")
  })
  const onSaved = vi.fn(async () => {})
  const f = fixture(onSaved, { isCurrent: () => true, prepared }, null)
  ports.createGroup.mockImplementationOnce(async () => {
    order.push("submitted")
    throw new Error("response lost")
  })
  await expect(f.render().save(newFields)).resolves.toBe(false)
  const original = JSON.parse(ports.values.get("bot-group-pending:new")!).input
  expect(order).toEqual(["prepared", "submitted"])
  expect(prepared).toHaveBeenCalledOnce()
  ports.createGroup.mockResolvedValue(newReceipt)
  await expect(f.render().save({ ...newFields, name: "Must not replace" })).resolves.toBe(true)
  expect(ports.createGroup.mock.calls.map(([input]) => input)).toEqual([original, original])
  expect(prepared).toHaveBeenCalledOnce()
  expect(onSaved).toHaveBeenCalledWith(newReceipt, original)
  expect(ports.values.size).toBe(0)
  f.unmount()
})

it("does not prepare a restored old creation request with a new local continuation", async () => {
  const prepared = vi.fn()
  const f = fixture(undefined, { prepared }, null)
  const original = { ...newFields, nonce: "original", expectedDataEpoch: "before" }
  ports.values.set(
    "bot-group-pending:new",
    JSON.stringify({ dataEpoch: "before", input: original })
  )
  ports.createGroup.mockResolvedValue(newReceipt)
  await expect(f.render().save(newFields)).resolves.toBe(true)
  expect(ports.createGroup).toHaveBeenCalledWith(original)
  expect(prepared).not.toHaveBeenCalled()
  f.unmount()
})

it("first reveals another pane's original creation and only the next action replays it", async () => {
  const prepared = vi.fn()
  const f = fixture(undefined, { prepared }, null)
  const before = f.render()
  const original = { ...newFields, nonce: "other-pane", expectedDataEpoch: "before" }
  ports.values.set(
    "bot-group-pending:new",
    JSON.stringify({ dataEpoch: "before", input: original })
  )
  await expect(before.save(newFields)).resolves.toBe(false)
  expect(ports.createGroup).not.toHaveBeenCalled()
  expect(f.render().pending).toEqual(original)
  ports.createGroup.mockResolvedValue(newReceipt)
  await expect(f.render().save()).resolves.toBe(true)
  expect(ports.createGroup).toHaveBeenCalledOnce()
  expect(ports.createGroup).toHaveBeenCalledWith(original)
  expect(prepared).not.toHaveBeenCalled()
  f.unmount()
})

it("retains a prepared request when the UI owner retires before dispatch", async () => {
  let current = true
  const prepared = vi.fn(() => {
    current = false
  })
  const f = fixture(undefined, { isCurrent: () => current, prepared }, null)
  await expect(f.render().save(newFields)).resolves.toBe(false)
  expect(prepared).toHaveBeenCalledOnce()
  expect(ports.createGroup).not.toHaveBeenCalled()
  expect(ports.values.size).toBe(1)
  expect(f.render().pending).toMatchObject(newFields)
  f.unmount()
})

it("cleans a confirmed same-epoch ACK without navigating a retired group UI owner", async () => {
  let current = true
  const onSaved = vi.fn(async () => {})
  const f = fixture(onSaved, { isCurrent: () => current, prepared: vi.fn() }, null)
  const response = deferred<BotConversation>()
  ports.createGroup.mockReturnValue(response.promise)
  const result = f.render().save(newFields)
  current = false
  response.resolve(newReceipt)
  await expect(result).resolves.toBe(false)
  expect(ports.values.size).toBe(0)
  expect(onSaved).not.toHaveBeenCalled()
  f.unmount()
})

it("never prepares or submits when protected storage cannot retain the new request", async () => {
  const prepared = vi.fn()
  const f = fixture(undefined, { prepared }, null)
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => ports.values.get(key) ?? null,
    setItem: () => {
      throw new Error("storage unavailable")
    },
    removeItem: (key: string) => ports.values.delete(key)
  })
  await expect(f.render().save(newFields)).resolves.toBe(false)
  expect(prepared).not.toHaveBeenCalled()
  expect(ports.createGroup).not.toHaveBeenCalled()
  expect(ports.values.size).toBe(0)
  f.unmount()
})
