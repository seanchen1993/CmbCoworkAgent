import { afterEach, expect, it, vi } from "vitest"
import { BotDomainError } from "../../../shared/bot-types"
import type { BotApprovalRuleChange, BotApprovalRules } from "../../../shared/bot-approval-rules"
import { pendingApprovalRuleStore } from "./bot-approval-pending"
import { matchesApprovalRuleReceipt } from "./bot-settings-save-receipt"
import { useBotSettingsSave } from "./use-bot-settings-save"
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
    return [ports.hooks.slots[i], (value: unknown) => (ports.hooks.slots[i] = value)]
  },
  useRef(initial: unknown) {
    const i = ports.hooks.cursor++
    if (!(i in ports.hooks.slots)) ports.hooks.slots[i] = { current: initial }
    return ports.hooks.slots[i]
  },
  useCallback: (callback: unknown) => callback,
  useEffect(effect: () => void | (() => void)) {
    const i = ports.hooks.cursor++
    if (!(i in ports.hooks.slots)) {
      ports.hooks.slots[i] = true
      ports.hooks.effects.push(effect)
    }
  },
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
const input: BotApprovalRuleChange = {
  botId: "bot",
  ruleId: "rule",
  revision: 1,
  dataEpoch: "before",
  nonce: "exact",
  behavior: "deny"
}
const initial: BotApprovalRules = {
  botId: "bot",
  revision: 1,
  dataEpoch: "before",
  rules: [{ id: "rule", title: "Tests", prompt: "npm test", behavior: "ask", createdAt: 1 }]
}
const receipt: BotApprovalRules = {
  ...initial,
  revision: 2,
  rules: [{ ...initial.rules[0], behavior: "deny" }]
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { resolve, reject, promise }
}
function fixture() {
  ports.values.clear()
  ports.state.snapshot.dataEpoch = "before"
  ports.state.host.capabilities = ["mutation-data-epoch", "mutation-data-epoch-v2"]
  ports.hooks.slots = []
  ports.hooks.effects = []
  const faults = { read: false, remove: false, writeEpoch: false },
    read = vi.fn(async () => initial),
    change = vi.fn(async () => receipt),
    cleanup: (() => void)[] = []
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => {
      if (faults.read) throw Error("unreadable")
      return ports.values.get(key) ?? null
    },
    setItem: (key: string, raw: string) => {
      ports.values.set(key, raw)
      if (faults.writeEpoch) ports.state.snapshot.dataEpoch = "after"
    },
    removeItem: (key: string) => {
      if (faults.remove) throw Error("denied")
      ports.values.delete(key)
    }
  })
  const render = () => {
    ports.hooks.cursor = 0
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Actual Hook with deterministic React ports; separate Chrome suite validates mounted components.
    const session = useBotSettingsSave({
      botId: "bot",
      pending: pendingApprovalRuleStore,
      read,
      change,
      verifies: matchesApprovalRuleReceipt
    })
    for (const effect of ports.hooks.effects.splice(0)) {
      const stop = effect()
      if (stop) cleanup.push(stop)
    }
    return session
  }
  return {
    faults,
    read,
    change,
    render,
    unmount: () => cleanup.splice(0).forEach((stop) => stop()),
    ready: async () => {
      await render().load()
      return render()
    }
  }
}
afterEach(() => vi.unstubAllGlobals())
it.each(["success", "definitive rejection"])(
  "keeps mounted retired original on late %s and releases busy",
  async (mode) => {
    const f = fixture(),
      held = deferred<BotApprovalRules>()
    f.change.mockReturnValue(held.promise)
    const operation = (await f.ready()).save(() => input),
      raw = [...ports.values.values()][0]
    ports.state.snapshot.dataEpoch = "after"
    f.render()
    if (mode === "success") held.resolve(receipt)
    else held.reject(new BotDomainError("revision_conflict", "rejected"))
    expect(await operation).toBe(false)
    expect([...ports.values.values()][0]).toBe(raw)
    expect(f.render().busy).toBe(false)
    expect(f.read).toHaveBeenCalledTimes(1)
  }
)
it.each(["success", "definitive rejection"])(
  "allows same-epoch unmounted exact ACK cleanup on %s without refresh",
  async (mode) => {
    const f = fixture(),
      held = deferred<BotApprovalRules>()
    f.change.mockReturnValue(held.promise)
    const operation = (await f.ready()).save(() => input)
    f.unmount()
    if (mode === "success") held.resolve(receipt)
    else held.reject(new BotDomainError("revision_conflict", "rejected"))
    expect(await operation).toBe(false)
    expect(ports.values.size).toBe(0)
    expect(f.read).toHaveBeenCalledTimes(1)
  }
)
it("checks current epoch after synchronous pending storage and before actual API dispatch", async () => {
  const f = fixture()
  const session = await f.ready()
  f.faults.writeEpoch = true
  expect(await session.save(() => input)).toBe(false)
  expect(f.change).not.toHaveBeenCalled()
  expect(ports.values.size).toBe(1)
})
it("does not let old mounted handler dispatch after restore", async () => {
  const f = fixture()
  const session = await f.ready()
  ports.state.snapshot.dataEpoch = "after"
  expect(await session.save(() => input)).toBe(false)
  expect(f.change).not.toHaveBeenCalled()
  expect(ports.values.size).toBe(0)
})
it.each(["success", "definitive rejection"])(
  "keeps known %s cleanup failures as cleanup-only retry",
  async (mode) => {
    const f = fixture()
    f.faults.remove = true
    if (mode === "definitive rejection")
      f.change.mockRejectedValue(new BotDomainError("revision_conflict", "rejected"))
    expect(await (await f.ready()).save(() => input)).toBe(false)
    expect(f.render().acknowledged).toBe(true)
    f.faults.remove = false
    await f.render().save(() => ({ ...input, nonce: "different" }))
    expect(f.change).toHaveBeenCalledTimes(1)
    expect(ports.values.size).toBe(0)
    expect(f.render().acknowledged).toBe(false)
  }
)
it("retry after receipt sync failure only reads current revision, never dispatches a new mutation", async () => {
  const f = fixture()
  const s = await f.ready()
  f.read.mockRejectedValueOnce(Error("sync failed"))
  expect(await s.save(() => input)).toBe(false)
  expect(f.render().acknowledged).toBe(true)
  expect(ports.values.size).toBe(0)
  const current = { ...receipt, revision: 7 }
  f.read.mockResolvedValue(current)
  expect(await f.render().save(() => ({ ...input, nonce: "new" }))).toBe(true)
  expect(f.change).toHaveBeenCalledTimes(1)
  expect(f.render().value).toEqual(current)
})
it("late current-policy read after restore cannot update the old form or report current success", async () => {
  const f = fixture(),
    held = deferred<BotApprovalRules>()
  const s = await f.ready()
  f.read.mockReturnValue(held.promise)
  const operation = s.save(() => input)
  await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2))
  ports.state.snapshot.dataEpoch = "after"
  held.resolve(receipt)
  expect(await operation).toBe(false)
  expect(f.render().value).toEqual(initial)
  expect(f.render().saved).toBe(false)
})
it("data_epoch rejection preserves original request even before Workspace refresh delivers its new epoch", async () => {
  const f = fixture()
  f.change.mockRejectedValue(new BotDomainError("data_epoch", "restored"))
  expect(await (await f.ready()).save(() => input)).toBe(false)
  expect(ports.values.size).toBe(1)
  expect(f.render().restored).toBe(true)
  expect(await f.render().save()).toBe(false)
})
it("unknown reply retains exact nonce and another pane pending blocks a different draft before dispatch", async () => {
  const f = fixture(),
    s = await f.ready()
  pendingApprovalRuleStore.remember(input)
  expect(await s.save(() => ({ ...input, nonce: "different" }))).toBe(false)
  expect(f.change).not.toHaveBeenCalled()
  f.change.mockRejectedValueOnce(Error("lost ACK"))
  await f.render().save()
  expect(f.change).toHaveBeenCalledWith(input)
  expect(ports.values.size).toBe(1)
})
it("mismatched successful receipt does not clear the pending request", async () => {
  const f = fixture()
  f.change.mockResolvedValue({ ...receipt, botId: "other" })
  expect(await (await f.ready()).save(() => input)).toBe(false)
  expect(ports.values.size).toBe(1)
  expect(f.render().acknowledged).toBe(false)
})
it("load begun before a save cannot roll the UI back after the newer committed read", async () => {
  const f = fixture()
  const s = await f.ready(),
    held = deferred<BotApprovalRules>()
  f.read.mockReturnValueOnce(held.promise)
  const reading = s.load()
  f.read.mockResolvedValue(receipt)
  expect(await f.render().save(() => input)).toBe(true)
  held.resolve(initial)
  await reading
  expect(f.render().value).toEqual(receipt)
})

it("retired unmounted handler cannot start a new settings read or mutation", async () => {
  const f = fixture(),
    s = await f.ready()
  f.unmount()
  expect(await s.load()).toBeUndefined()
  expect(await s.save(() => input)).toBe(false)
  expect(f.read).toHaveBeenCalledTimes(1)
  expect(f.change).not.toHaveBeenCalled()
})

it("retiring only the read visibility lease ignores the late projection while the owning pane remains mounted", async () => {
  const f = fixture(),
    session = await f.ready(),
    held = deferred<BotApprovalRules>()
  let active = true
  f.read.mockReturnValue(held.promise)
  const reading = session.load(() => active)
  active = false
  held.resolve(receipt)
  expect(await reading).toBeUndefined()
  expect(f.render().value).toEqual(initial)
  expect(await f.render().load(() => false)).toBeUndefined()
  expect(f.read).toHaveBeenCalledTimes(2)
})

it("old epoch archive handler cannot clear a corrupt reviewed record after restore", async () => {
  const f = fixture(),
    session = await f.ready()
  const key = "cmb:bot-approval-rule:pending:bot"
  ports.values.set(key, "{")
  session.refreshRecord()
  ports.state.snapshot.dataEpoch = "after"
  expect(session.discard("{")).toBe(false)
  expect(ports.values.get(key)).toBe("{")
})

it("unmounted archive handler cannot clear a reviewed corrupt record", async () => {
  const f = fixture(),
    session = await f.ready()
  const key = "cmb:bot-approval-rule:pending:bot"
  ports.values.set(key, "{")
  f.unmount()
  expect(session.discard("{")).toBe(false)
  expect(ports.values.get(key)).toBe("{")
})

it.each([false, true])(
  "old generic epoch capability remains readonly with original record=%s",
  async (remembered) => {
    const f = fixture()
    if (remembered) pendingApprovalRuleStore.remember(input)
    await f.render().load()
    ports.state.host.capabilities = ["mutation-data-epoch"]
    const session = f.render(),
      raw = ports.values.get("cmb:bot-approval-rule:pending:bot")
    if (remembered) expect(raw).toBeTruthy()
    expect(session.fieldsDisabled).toBe(true)
    expect(session.saveDisabled).toBe(true)
    expect(session.error).toContain("更新")
    expect(await session.save(() => input)).toBe(false)
    expect(f.change).not.toHaveBeenCalled()
    expect(ports.values.get("cmb:bot-approval-rule:pending:bot")).toBe(raw)
  }
)
