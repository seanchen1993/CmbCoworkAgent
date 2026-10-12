import { afterEach, expect, it, vi } from "vitest"
import { BotDomainError, type BotSkill } from "../../../shared/bot-types"
import { useBotSkillSave } from "./use-bot-skill-save"

const ports = vi.hoisted(() => {
  const values = new Map<string, string>()
  const state = {
    snapshot: { dataEpoch: "before" },
    host: { capabilities: ["skill-save-receipts", "mutation-data-epoch-v2"] }
  }
  const hooks = { slots: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }
  return { values, state, hooks, saveSkill: vi.fn() }
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
vi.mock("./bot-api", () => ({ botApi: { saveSkill: ports.saveSkill } }))
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
  id: "skill",
  version: 1,
  name: "Old draft",
  instructions: "Evidence",
  enabled: true
}
const receipt: BotSkill = {
  ...fields,
  botId: "owner",
  version: 2,
  verified: false,
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
function fixture(onSaved = vi.fn(async () => {})) {
  ports.values.clear()
  ports.hooks.slots = []
  ports.hooks.effects = []
  ports.state.snapshot.dataEpoch = "before"
  ports.state.host.capabilities = ["skill-save-receipts", "mutation-data-epoch-v2"]
  ports.saveSkill.mockReset()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => ports.values.get(key) ?? null,
    setItem: (key: string, value: string) => ports.values.set(key, value),
    removeItem: (key: string) => ports.values.delete(key)
  })
  const cleanup: (() => void)[] = []
  const render = () => {
    ports.hooks.cursor = 0
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Execute the actual hook against deterministic React ports; the browser suite covers real React mounting.
    const session = useBotSkillSave("owner", "skill", onSaved)
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
      response = deferred<BotSkill>()
    ports.saveSkill.mockReturnValue(response.promise)
    const result = f.render().save(fields)
    const raw = [...ports.values.values()][0]
    expect(raw).toContain('"expectedDataEpoch":"before"')
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
  expect(ports.saveSkill).not.toHaveBeenCalled()
  expect(ports.values.size).toBe(0)
  f.unmount()
})
it("returns false when the list refresh finishes after a restore and releases mounted busy state", async () => {
  const refresh = deferred<void>(),
    f = fixture(vi.fn(() => refresh.promise))
  ports.saveSkill.mockResolvedValue(receipt)
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
    response = deferred<BotSkill>()
  ports.saveSkill.mockReturnValue(response.promise)
  const result = f.render().save(fields)
  expect(ports.values.size).toBe(1)
  f.unmount()
  response.resolve(receipt)
  await expect(result).resolves.toBe(false)
  expect(ports.values.size).toBe(0)
  expect(f.onSaved).not.toHaveBeenCalled()
})

it.each(["data_epoch", "workspace_replaced"])(
  "retains typed %s refusal before the renderer observes restore and blocks replay",
  async (code) => {
    const f = fixture()
    ports.saveSkill.mockRejectedValue(new BotDomainError(code, "Host restored"))
    await expect(f.render().save(fields)).resolves.toBe(false)
    const raw = [...ports.values.values()][0]
    expect(raw).toContain('"expectedDataEpoch":"before"')
    expect(f.render()).toMatchObject({
      restored: true,
      busy: false,
      actionsDisabled: true
    })
    await expect(f.render().save()).resolves.toBe(false)
    expect(ports.saveSkill).toHaveBeenCalledOnce()
    expect([...ports.values.values()]).toEqual([raw])
    expect(f.onSaved).not.toHaveBeenCalled()
    f.unmount()
  }
)
it("blocks saving on a Host without mutation authority while retaining the original exact record", async () => {
  const f = fixture()
  ports.state.host.capabilities = ["skill-save-receipts"]
  await expect(f.render().save(fields)).resolves.toBe(false)
  expect(ports.saveSkill).not.toHaveBeenCalled()
  expect(ports.values.size).toBe(0)
  f.unmount()
})
