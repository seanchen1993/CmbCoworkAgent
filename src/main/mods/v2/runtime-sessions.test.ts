import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { compileFunctionPlugin } from "./loader"
import type { FunctionRuntimeSession } from "../../../shared/mods/v2/runtime-sessions"
import { RUNTIME_STOP_RECEIPTS_KEY, writeRuntimeStopReceipts } from "./runtime-stop-receipts"
import { ModsManager } from "../manager"
import { ClawStore } from "../claw-store"
import type { ClawProfile } from "../../../shared/mods/claw"
import type { FunctionSessionAppendTicket } from "./session-append-ticket"
import type { FunctionSessionAppendInput } from "../../../shared/mods/v2/session-append"
import type { FunctionGuest } from "../../../shared/mods/v2/contracts"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(startup = "", hooks = "") {
  const root = await mkdtemp(join(tmpdir(), "mods-runtime-release-")),
    path = join(root, "plugin")
  await mkdir(join(path, "hooks"), { recursive: true })
  await writeFile(join(path, "plugin.json"), '{"name":"release-demo"}')
  await writeFile(join(path, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  await writeFile(
    join(path, "hooks/register.ts"),
    `export function register(on) {
    let count = 0;
    on("session.start",async($,e,next)=>{
      const id=await $.session.id();
      await $.store.set("starts:"+id,(await $.store.get("starts:"+id)??0)+1);
      await $.command.register({name:"probe",description:"Probe"});${startup};return next(e)
    });
    on("command.run",{command:"probe"},async()=>({text:String(++count)}));
    ${hooks}
  }`
  )
  const store = new ModControlStore(join(root, "control.sqlite"))
  const state = {
    busy: false,
    drains: 0,
    gate: undefined as Promise<void> | undefined,
    failDrain: false,
    loads: 0,
    loadGate: undefined as Promise<void> | undefined,
    publishGate: undefined as Promise<void> | undefined,
    publishing: false,
    transportProof: true,
    oldPeer: false,
    pending: 0,
    calls: 0,
    readGate: undefined as Promise<void> | undefined,
    reading: false,
    owners: 0
  }
  const guests: FunctionGuestRuntime[] = []
  const managers: FunctionModsManager[] = []
  const createManager = () => {
    const manager = new FunctionModsManager(
      store,
      {
        plugins: () => [{ id: "p", name: "release-demo", path, enabled: true }],
        enabled: () => true,
        clawApplicable: () => true,
        publish: async (_workspace, value) => {
          if (state.publishGate) {
            state.publishing = true
            await state.publishGate
          }
          return value
        },
        changed: () => {},
        readSession: async () => {
          if (state.readGate) { state.reading = true; await state.readGate }
          return {}
        },
        configurationBusy: () => state.busy,
        openConversationOwner: () => {
          state.owners++
          return () => {
            state.owners--
          }
        }
      },
      () => {
        const owned: FunctionGuestRuntime[] = []
        return {
          get stats() {
            return state.transportProof ? { pending: state.pending, calls: state.calls } : undefined
          },
          async load(code, options) {
            state.loads++
            await state.loadGate
            const guest = await FunctionGuestRuntime.create(code, options)
            if (state.oldPeer)
              Object.defineProperty(guest, "registrationQuiescent", { value: undefined })
            owned.push(guest)
            guests.push(guest)
            return guest
          },
          stop: () => {
            for (const guest of owned) guest.dispose()
          },
          async stopAndDrain() {
            state.drains++
            await state.gate
            if (state.failDrain) throw Error("EXIT_UNCONFIRMED")
            for (const guest of owned) guest.dispose()
          }
        }
      }
    )
    managers.push(manager)
    return manager
  }
  const manager = createManager()
  const compiled = await compileFunctionPlugin(path)
  store.grant(root, "function:release-demo", compiled.digest, true)
  cleanup.push(async () => {
    state.gate = undefined
    state.failDrain = false
    for (const manager of managers) manager.close()
    await Promise.all(guests.map((guest) => guest.dispose()))
    await new Promise((resolve) => setTimeout(resolve, 10))
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const signal = new AbortController().signal
  const row = (threadId: string) =>
    manager.runtimeSessions().sessions.find((item) => item.threadId === threadId)!
  const release = (item: FunctionRuntimeSession) =>
    manager.releaseRuntimeSession(root, item.threadId, item.generation, signal, () => {})
  const resume = (item: FunctionRuntimeSession) =>
    manager.resumeRuntimeSession(root, item.threadId, item.generation, signal, () => {})
  const run = async (threadId: string) => {
    const [command] = await manager.commands(root, threadId)
    return manager.runCommand(root, threadId, command, "", signal)
  }
  const starts = (threadId: string) =>
    store.functionState.get(JSON.stringify([root, "release-demo"]), "starts:" + threadId)
  return {
    root,
    manager,
    state,
    row,
    release,
    resume,
    run,
    starts,
    signal,
    store,
    createManager,
    path
  }
}

it("retires generated stage and prepare owners before admitting two actual parallel child VMs", async () => {
  const f = await fixture()
  await f.run("ordinary-history")
  for (const stage of ["prd", "specs", "design", "plan"]) {
    expect(await f.run(stage)).toEqual({ text: "1" })
    await f.manager.closeThreadAndWait(stage)
    expect(f.manager.runtimeSessions()).toMatchObject({ resident: 1, reserved: 0, retiring: 0 })
  }
  await f.run("code")
  await f.run("workflow-prepare")
  await f.manager.closeThreadAndWait("workflow-prepare")
  expect(await Promise.all([f.run("batch-a"), f.run("batch-b")])).toEqual([
    { text: "1" }, { text: "1" }
  ])
  expect(f.manager.runtimeSessions()).toMatchObject({ limit: 6, resident: 4 })
  await Promise.all([f.manager.closeThreadAndWait("batch-a"), f.manager.closeThreadAndWait("batch-b")])
  expect(await f.run("ordinary-history")).toEqual({ text: "2" })
  expect(await f.run("code")).toEqual({ text: "2" })
  expect(f.starts("ordinary-history")).toBe(1)
  expect(f.starts("code")).toBe(1)
})

it("holds a one-shot owner's sixth slot until its actual VM drain confirms", async () => {
  const f = await fixture()
  for (let index = 0; index < 6; index++) await f.run("live-" + index)
  const gate = Promise.withResolvers<void>()
  f.state.gate = gate.promise
  let settled = false
  const closing = f.manager.closeThreadAndWait("live-5").then(() => { settled = true })
  try {
    await vi.waitFor(() => expect(f.state.drains).toBe(1))
    expect(settled).toBe(false)
    expect(f.manager.runtimeSessions()).toMatchObject({ resident: 6, reserved: 1, retiring: 1 })
    await expect(f.run("next-child")).rejects.toThrow("MODS_SESSION_CAPACITY")
    expect(f.state.loads).toBe(6)
  } finally {
    gate.resolve()
    await closing
  }
  expect(f.manager.runtimeSessions()).toMatchObject({ resident: 5, reserved: 0, retiring: 0 })
  expect(await f.run("next-child")).toEqual({ text: "1" })
})

it("does not release capacity or rebuild an owner when its physical retirement fails", async () => {
  const f = await fixture()
  for (let index = 0; index < 6; index++) await f.run("live-" + index)
  f.state.failDrain = true
  await expect(f.manager.closeThreadAndWait("live-5")).rejects.toThrow("EXIT_UNCONFIRMED")
  expect(f.manager.runtimeSessions()).toMatchObject({ resident: 6, reserved: 1, retiring: 1 })
  await expect(f.run("next-child")).rejects.toThrow("MODS_SESSION_CAPACITY")
  await expect(f.run("live-5")).rejects.toThrow("MODS_RUNTIME_SESSION_BUSY")
  expect(f.state.loads).toBe(6)
})

it("awaits an entered native SDK caller's real finally before releasing its retired slot", async () => {
  const f = await fixture(
    'await $.command.register({name:"held",description:"Held"})',
    'on("command.run",{command:"held"},async($)=>{await $.session.messages();return{text:"read"}})'
  )
  const gate = Promise.withResolvers<void>()
  f.state.readGate = gate.promise
  const command = (await f.manager.commands(f.root, "child")).find(item => item.command === "held")!
  const caller = f.manager.runCommand(f.root, "child", command, "", f.signal)
  const callerResult = caller.catch(error => error)
  await vi.waitFor(() => expect(f.state.reading).toBe(true))
  let settled = false
  const closing = f.manager.closeThreadAndWait("child").then(() => { settled = true })
  try {
    await vi.waitFor(() => expect(f.state.drains).toBe(1))
    expect(settled).toBe(false)
    expect(f.manager.runtimeSessions()).toMatchObject({ resident: 1, reserved: 1 })
  } finally {
    gate.resolve()
    await callerResult
    await closing
  }
  expect(f.manager.runtimeSessions()).toMatchObject({ resident: 0, reserved: 0, retiring: 0 })
})

it("a captured predecessor cannot retire a replacement VM with the same thread identity", async () => {
  const f = await fixture()
  await f.run("same")
  const old = f.manager.captureThreadRetirement("same")
  await f.manager.closeThreadAndWait("same")
  await f.run("same")
  expect(() => old.retire()).toThrow("MODS_SCOPE_CHANGED")
  expect(await f.run("same")).toEqual({ text: "2" })
  const current = f.manager.captureThreadRetirement("same")
  const first = current.retire()
  expect(current.retire()).toBe(first)
  await first
  expect(f.state.drains).toBe(2)
})

it("reads occupancy without loading and releases only the selected VM before admitting seven", async () => {
  const f = await fixture()
  expect(f.manager.runtimeSessions()).toMatchObject({ resident: 0, limit: 6, sessions: [] })
  expect(f.state.loads).toBe(0)
  for (let i = 0; i < 6; i++) expect(await f.run(String(i))).toEqual({ text: "1" })
  await expect(f.manager.commands(f.root, "seven")).rejects.toMatchObject({
    code: "MODS_SESSION_CAPACITY"
  })
  const before = f.state.loads,
    old = f.row("0")
  expect(old).toMatchObject({ canRelease: true, state: "resident" })
  await f.release(old)
  expect(f.manager.runtimeSessions().resident).toBe(5)
  expect(f.row("0")).toMatchObject({ state: "stopped", canResume: true })
  expect(await f.manager.commands(f.root, "0")).toEqual([])
  expect(
    await f.manager.classicEvent(f.root, "0", "prompt.edit", {}, f.signal, async () => ({
      text: "ordinary chat"
    }))
  ).toEqual({ text: "ordinary chat" })
  expect(f.state.loads).toBe(before)
  expect(await f.run("seven")).toEqual({ text: "1" })
  for (let i = 1; i < 6; i++) {
    expect(await f.run(String(i))).toEqual({ text: "2" })
    expect(f.starts(String(i))).toBe(1)
  }
  await expect(f.resume(old)).rejects.toMatchObject({ code: "MODS_SESSION_CAPACITY" })
})

it("explicitly resumes once with a new generation and preserves saved host state", async () => {
  const f = await fixture()
  await f.run("one")
  const old = f.row("one")
  const internals = f.manager as unknown as { namedStates: Map<string, unknown> }
  const named = [...internals.namedStates.values()]
  await f.release(old)
  expect([...internals.namedStates.values()]).toEqual(named)
  expect(f.starts("one")).toBe(1)
  await f.resume(old)
  expect(f.row("one").generation).not.toBe(old.generation)
  expect(f.starts("one")).toBe(2)
  expect(await f.run("one")).toEqual({ text: "1" })
  await expect(f.release(old)).rejects.toMatchObject({ code: "MODS_RUNTIME_SESSION_STALE" })
  await expect(f.resume(old)).rejects.toMatchObject({ code: "MODS_RUNTIME_SESSION_STALE" })
})

it("retains its slot and fence until physical exit and prevents UI remount startup", async () => {
  const f = await fixture()
  await f.run("one")
  const gate = Promise.withResolvers<void>()
  f.state.gate = gate.promise
  const loads = f.state.loads
  const releasing = f.release(f.row("one"))
  try {
    await vi.waitFor(() => expect(f.state.drains).toBe(1))
    expect(f.manager.runtimeSessions()).toMatchObject({ resident: 1 })
    expect(f.row("one").state).toBe("releasing")
    await expect(f.manager.siteMount(f.root, "one", "AbovePrompt")).rejects.toMatchObject({
      code: "MODS_CONFIG_RELOAD_STOPPED"
    })
    expect(f.state.loads).toBe(loads)
  } finally {
    gate.resolve()
  }
  await releasing
  expect(f.manager.runtimeSessions().resident).toBe(0)
})

it("refuses busy, resource-owning and development sessions without touching their VM", async () => {
  const f = await fixture()
  await f.run("one")
  const old = f.row("one"),
    loads = f.state.loads
  f.state.busy = true
  await expect(f.release(old)).rejects.toMatchObject({ code: "MODS_RUNTIME_SESSION_BUSY" })
  f.state.busy = false
  const entries = f.manager as unknown as {
    sessions: Map<
      string,
      {
        activity: { retainFreshResource(): { ready(): void; release(): void } }
        developmentPlugins: Map<object, unknown>
      }
    >
  }
  const entry = [...entries.sessions.values()][0]
  const resource = entry.activity.retainFreshResource()
  resource.ready()
  await expect(f.release(old)).rejects.toMatchObject({ code: "MODS_RUNTIME_SESSION_BUSY" })
  resource.release()
  entry.developmentPlugins.set({}, {})
  await expect(f.release(old)).rejects.toMatchObject({ code: "MODS_RUNTIME_SESSION_BUSY" })
  entry.developmentPlugins.clear()
  expect(f.state.loads).toBe(loads)
  expect(await f.run("one")).toEqual({ text: "2" })
})

it("refuses a timer between callbacks even when there is no foreground operation", async () => {
  const f = await fixture("$.clock.after(60000,()=>{})")
  await f.run("timer")
  expect(f.row("timer").canRelease).toBe(false)
  await expect(f.release(f.row("timer"))).rejects.toMatchObject({
    code: "MODS_RUNTIME_SESSION_BUSY"
  })
})

it("keeps failed exits fenced with their capacity reservation and cannot resume them", async () => {
  const f = await fixture()
  await f.run("one")
  const old = f.row("one")
  f.state.failDrain = true
  await expect(f.release(old)).rejects.toThrow("EXIT_UNCONFIRMED")
  expect(f.manager.runtimeSessions()).toMatchObject({ resident: 1, retiring: 1 })
  expect(f.row("one")).toMatchObject({ state: "failed", canRelease: false, canResume: false })
  await expect(f.resume(old)).rejects.toMatchObject({ code: "MODS_RUNTIME_SESSION_STALE" })
  expect(f.starts("one")).toBe(1)
})

it("persists native stop intent across manager restart and source invalidation", async () => {
  const f = await fixture()
  await f.run("one")
  const old = f.row("one")
  await f.release(old)
  f.manager.close()
  const next = f.createManager(),
    loads = f.state.loads
  next.invalidate(f.root)
  expect(await next.commands(f.root, "one")).toEqual([])
  // A durable stop forbids guest replay; it does not hide the original native application.
  await expect(next.siteMount(f.root, "one", "AbovePrompt")).resolves.toBeNull()
  expect(f.state.loads).toBe(loads)
  const stopped = next.runtimeSessions().sessions[0]
  expect(stopped).toMatchObject({ state: "stopped", canResume: true })
  await next.resumeRuntimeSession(f.root, "one", stopped.generation, f.signal, () => {})
  expect(f.starts("one")).toBe(2)
  expect(next.runtimeSessions().sessions[0].generation).not.toBe(old.generation)
  await expect(
    next.resumeRuntimeSession(f.root, "one", stopped.generation, f.signal, () => {})
  ).rejects.toMatchObject({ code: "MODS_RUNTIME_SESSION_STALE" })
  expect(JSON.parse(f.store.getSetting(RUNTIME_STOP_RECEIPTS_KEY)).sessions).toEqual([])
})

it("keeps a failed restart stopped durably and prevents ordinary or repeated resume startup", async () => {
  const f = await fixture('if(await $.store.get("fail"))throw Error("STARTUP_FAILURE")')
  await f.run("one")
  const old = f.row("one")
  await f.release(old)
  f.store.functionState.set(JSON.stringify([f.root, "release-demo"]), "fail", true)
  await expect(f.resume(old)).rejects.toThrow()
  expect(f.row("one")).toMatchObject({ state: "failed", canResume: false })
  const starts = f.starts("one")
  f.manager.close()
  const next = f.createManager(),
    loads = f.state.loads
  await expect(next.commands(f.root, "one")).rejects.toMatchObject({
    code: "MODS_CONFIG_RELOAD_STOPPED"
  })
  await expect(
    next.resumeRuntimeSession(f.root, "one", old.generation, f.signal, () => {})
  ).rejects.toMatchObject({ code: "MODS_RUNTIME_SESSION_STALE" })
  expect(f.state.loads).toBe(loads)
  expect(f.starts("one")).toBe(starts)
})

it("fails closed on unreadable native receipts while diagnostics remain available", async () => {
  const f = await fixture()
  f.store.setSetting(RUNTIME_STOP_RECEIPTS_KEY, "invalid-json")
  const next = f.createManager()
  expect(next.runtimeSessions().error).toContain("无法读取")
  expect(await next.commands(f.root, "one")).toEqual([])
  await expect(next.runtimeReady(f.root, "one")).rejects.toMatchObject({
    code: "MODS_RUNTIME_RECEIPTS_UNAVAILABLE"
  })
  expect(f.state.loads).toBe(0)
})

it("clears the native receipt only for confirmed deletion or successful explicit resume", async () => {
  const f = await fixture()
  await f.run("one")
  await f.release(f.row("one"))
  f.manager.closeThread("one")
  const stopped = JSON.parse(f.store.getSetting(RUNTIME_STOP_RECEIPTS_KEY))
  expect(stopped.sessions).toHaveLength(1)
  f.manager.forgetReleasedThread("one")
  expect(JSON.parse(f.store.getSetting(RUNTIME_STOP_RECEIPTS_KEY)).sessions).toEqual([])
})

it("bounds diagnostics to residents, current stopped chat and recent stops without rereading storage", async () => {
  const f = await fixture()
  f.store.setSetting(
    RUNTIME_STOP_RECEIPTS_KEY,
    JSON.stringify({
      version: 1,
      sessions: Array.from({ length: 40 }, (_, index) => ({
        workspace: f.root,
        threadId: `stopped-${index}`,
        generation: index + 1,
        state: "stopped",
        sourceIds: ["p"]
      }))
    })
  )
  const next = f.createManager()
  const read = vi.spyOn(f.store, "getSetting")
  for (let i = 0; i < 20; i++) {
    const snapshot = next.runtimeSessions("stopped-0")
    expect(snapshot).toMatchObject({ stoppedTotal: 40, omitted: 29 })
    expect(snapshot.sessions).toHaveLength(11)
    expect(snapshot.sessions.some((row) => row.threadId === "stopped-0")).toBe(true)
  }
  expect(read).not.toHaveBeenCalled()
  expect(JSON.parse(f.store.getSetting(RUNTIME_STOP_RECEIPTS_KEY)).sessions).toHaveLength(40)
})

it("refuses release of mandatory completion checks without changing startup or guest state", async () => {
  const f = await fixture()
  await f.run("one")
  f.manager.setCompletionPolicy(f.root, "one", "release-demo", {
    mode: "check",
    scope: "diff",
    checks: ["code-review"],
    maxRepairs: 0,
    timeoutMs: 120000,
    modelTokenBudget: 4096
  })
  expect(f.row("one").canRelease).toBe(false)
  await expect(f.release(f.row("one"))).rejects.toMatchObject({ code: "MODS_RUNTIME_SESSION_BUSY" })
  expect(await f.run("one")).toEqual({ text: "2" })
  expect(f.starts("one")).toBe(1)
})

it("propagates stopped mandatory policy errors through the real runtime preparation bridge", async () => {
  const f = await fixture()
  await f.run("one")
  await f.release(f.row("one"))
  f.manager.setCompletionPolicy(f.root, "one", "release-demo", {
    mode: "repair",
    scope: "diff",
    checks: ["unit-test"],
    maxRepairs: 1,
    timeoutMs: 120000,
    modelTokenBudget: 4096
  })
  const bridge = {
    workspaceKey: (workspace: string) => workspace,
    isEnabled: () => true,
    config: () => ({ epoch: 1 }),
    functionLifecycle: f.manager
  }
  await expect(
    ModsManager.prototype.prepareFunctionRuntime.call(
      bridge as unknown as ModsManager,
      f.root,
      "one",
      f.signal
    )
  ).rejects.toMatchObject({ code: "MODS_RUNTIME_SESSION_REQUIRED" })
  expect(f.starts("one")).toBe(1)
})

it("blocks a stopped combination when a mandatory Claw completion rule is added later", async () => {
  const f = await fixture()
  await f.run("one")
  await f.release(f.row("one"))
  const compiled = await compileFunctionPlugin(f.path)
  const profile: ClawProfile = {
    id: "required",
    name: "Required",
    capabilities: [{ pluginId: "p", name: "release-demo", digest: compiled.digest }],
    completionRules: [
      {
        pluginId: "p",
        name: "release-demo",
        digest: compiled.digest,
        policy: {
          mode: "check",
          scope: "diff",
          checks: ["code-review"],
          maxRepairs: 0,
          timeoutMs: 120000,
          modelTokenBudget: 4096
        }
      }
    ]
  }
  new ClawStore(f.store).write(f.root, { revision: 0, profiles: [profile], active: profile }, 0)
  f.manager.invalidate(f.root)
  await expect(f.manager.runtimeReady(f.root, "one")).rejects.toMatchObject({
    code: "MODS_RUNTIME_SESSION_REQUIRED"
  })
  expect(f.starts("one")).toBe(1)
})

it("shows the stop receipt capacity blocker without deleting hidden historical records", async () => {
  const f = await fixture()
  const records = Array.from({ length: 64 }, (_, index) => ({
    workspace: f.root,
    threadId: `old-${index}`,
    generation: index + 1,
    sourceIds: ["p"],
    names: ["release-demo"],
    state: "stopped" as const
  }))
  writeRuntimeStopReceipts(f.store, records)
  const next = f.createManager()
  await next.commands(f.root, "active")
  const row = next.runtimeSessions().sessions.find((row) => row.threadId === "active")!
  expect(row).toMatchObject({ canRelease: false, blocker: expect.stringContaining("64") })
  await expect(
    next.releaseRuntimeSession(f.root, "active", row.generation, f.signal, () => {})
  ).rejects.toMatchObject({ code: "MODS_RUNTIME_SESSION_BUSY" })
  expect(JSON.parse(f.store.getSetting(RUNTIME_STOP_RECEIPTS_KEY)).sessions).toHaveLength(64)
  next.forgetReleasedThread("old-0")
  expect(next.runtimeSessions().sessions.find((row) => row.threadId === "active")!.canRelease).toBe(
    true
  )
})

it("validates native receipt field and aggregate budgets before overwriting metadata", async () => {
  const f = await fixture()
  const record = {
    workspace: f.root,
    threadId: "one",
    generation: 1,
    sourceIds: ["p"],
    names: ["release-demo"],
    state: "stopped" as const
  }
  writeRuntimeStopReceipts(f.store, [record])
  const saved = f.store.getSetting(RUNTIME_STOP_RECEIPTS_KEY)
  const write = vi.spyOn(f.store, "setSetting")
  for (const extra of [{ error: "x".repeat(2001) }, { incarnationKey: "x".repeat(4097) }])
    expect(() => writeRuntimeStopReceipts(f.store, [{ ...record, ...extra }])).toThrow()
  expect(() =>
    writeRuntimeStopReceipts(
      f.store,
      Array.from({ length: 64 }, (_, index) => ({
        ...record,
        threadId: String(index),
        workspace: "x".repeat(4096),
        error: "x".repeat(2000)
      }))
    )
  ).toThrow()
  expect(write).not.toHaveBeenCalled()
  expect(f.store.getSetting(RUNTIME_STOP_RECEIPTS_KEY)).toBe(saved)
})

it("does not resurrect a deleted thread's receipt when delayed explicit startup fails", async () => {
  const f = await fixture()
  await f.run("one")
  const old = f.row("one")
  await f.release(old)
  const gate = Promise.withResolvers<void>()
  f.state.publishGate = gate.promise
  const pending = f.resume(old).then(
    () => undefined,
    (error) => error
  )
  try {
    await vi.waitFor(() => expect(f.state.publishing).toBe(true))
    f.manager.forgetReleasedThread("one")
    f.manager.closeThread("one")
  } finally {
    gate.resolve()
  }
  expect(await pending).toBeInstanceOf(Error)
  expect(JSON.parse(f.store.getSetting(RUNTIME_STOP_RECEIPTS_KEY)).sessions).toEqual([])
  const controls = f.manager as unknown as {
    reloadControl: { error(workspace: string, thread: string): string | undefined }
  }
  expect(controls.reloadControl.error(f.root, "one")).toBeUndefined()
  expect(f.manager.runtimeSessions()).toMatchObject({ resident: 0, retiring: 0, sessions: [] })
})

it("reserves capacity before awaiting startup across concurrent resume and ordinary admission", async () => {
  const f = await fixture()
  await f.run("old-a")
  const a = f.row("old-a")
  await f.release(a)
  await f.run("old-b")
  const b = f.row("old-b")
  await f.release(b)
  for (let i = 0; i < 4; i++) await f.run(`live-${i}`)
  const gate = Promise.withResolvers<void>()
  f.state.publishGate = gate.promise
  const restoring = f.resume(a)
  const pending: Promise<unknown>[] = [restoring]
  try {
    await vi.waitFor(() => expect(f.state.publishing).toBe(true))
    expect(f.manager.runtimeSessions()).toMatchObject({ resident: 5, reserved: 1 })
    pending.push(f.manager.commands(f.root, "sixth"))
    await vi.waitFor(() => expect(f.manager.runtimeSessions().resident).toBe(6))
    await expect(f.resume(b)).rejects.toMatchObject({ code: "MODS_SESSION_CAPACITY" })
    await expect(f.manager.commands(f.root, "seventh")).rejects.toMatchObject({
      code: "MODS_SESSION_CAPACITY"
    })
  } finally {
    gate.resolve()
  }
  await Promise.all(pending)
  expect(f.manager.runtimeSessions()).toMatchObject({ resident: 6, reserved: 0 })
})

it("retains a failed restart's reservation until physical retirement is confirmed", async () => {
  const f = await fixture('if(await $.store.get("fail"))throw Error("STARTUP_FAILURE")')
  await f.run("old")
  const old = f.row("old")
  await f.release(old)
  for (let i = 0; i < 5; i++) await f.run(`live-${i}`)
  f.store.functionState.set(JSON.stringify([f.root, "release-demo"]), "fail", true)
  f.state.failDrain = true
  await expect(f.resume(old)).rejects.toThrow()
  expect(f.manager.runtimeSessions()).toMatchObject({ resident: 6, reserved: 1, retiring: 1 })
  await expect(f.manager.commands(f.root, "seventh")).rejects.toMatchObject({
    code: "MODS_SESSION_CAPACITY"
  })
})

it.each([false, true])(
  "settles invalidated loading admission only after confirmed physical retirement (failure=%s)",
  async (failDrain) => {
    const f = await fixture()
    const loading = Promise.withResolvers<void>()
    const draining = Promise.withResolvers<void>()
    f.state.loadGate = loading.promise
    f.state.gate = draining.promise
    f.state.failDrain = failDrain
    const opening = f.manager.hasEventHandler(f.root, "formal", "command.run")
    const rejected = expect(opening).rejects.toMatchObject({ code: "MODS_SCOPE_CHANGED" })
    try {
      await vi.waitFor(() => expect(f.state.loads).toBe(1))
      f.manager.invalidate(f.root)
      loading.resolve()
      await rejected
      await vi.waitFor(() => expect(f.state.drains).toBe(1))
      expect(f.manager.runtimeSessions()).toMatchObject({ reserved: 1, retiring: 1 })
      await expect(f.manager.commands(f.root, "formal")).rejects.toMatchObject({
        code: "MODS_RUNTIME_SESSION_BUSY"
      })
    } finally {
      loading.resolve()
      draining.resolve()
    }
    if (failDrain) {
      await vi.waitFor(() => expect(f.state.drains).toBe(1))
      expect(f.manager.runtimeSessions()).toMatchObject({ reserved: 1, retiring: 1 })
      await expect(f.manager.commands(f.root, "formal")).rejects.toMatchObject({
        code: "MODS_RUNTIME_SESSION_BUSY"
      })
      expect(f.state.loads).toBe(1)
    } else {
      await vi.waitFor(() =>
        expect(f.manager.runtimeSessions()).toMatchObject({ reserved: 0, retiring: 0 })
      )
      expect(await f.run("formal")).toEqual({ text: "1" })
      expect(f.starts("formal")).toBe(1)
      expect(f.state.loads).toBe(2)
    }
  }
)

it("automatically reclaims only pure registration probes at six without startup or effect replay", async () => {
  const f = await fixture()
  for (let i = 0; i < 6; i++)
    expect(await f.manager.hasEventHandler(f.root, `quiet-${i}`, "command.run")).toBe(true)
  expect(
    f.manager.runtimeSessions().sessions.every((row) => row.autoReclaimable && !row.guestEntered)
  ).toBe(true)
  expect(f.state.loads).toBe(6)
  expect(f.state.owners).toBe(0)
  expect(await f.manager.hasEventHandler(f.root, "seventh", "command.run")).toBe(true)
  expect(f.manager.runtimeSessions().resident).toBe(6)
  expect(f.state.drains).toBe(1)
  expect(f.row("quiet-0")).toBeUndefined()
  for (let i = 0; i < 6; i++) expect(f.starts(`quiet-${i}`)).toBeUndefined()
  expect(f.starts("seventh")).toBeUndefined()
  expect(await f.run("quiet-0")).toEqual({ text: "1" })
  expect(f.starts("quiet-0")).toBe(1)
  expect(f.row("quiet-0")).toMatchObject({ autoReclaimable: false, guestEntered: true })
  expect(f.state.owners).toBe(1)
})

it("protects a quiet VM after native session.append even when session.start never ran", async () => {
  const f = await fixture(
    "",
    'on("session.append",async($)=>{await $.store.set("appended",true);return{deny:String(++count)}})'
  )
  await f.manager.hasEventHandler(f.root, "append", "session.append")
  const input: FunctionSessionAppendInput = {
    uuid: "native-append",
    door: "prompt",
    origin: { kind: "composer" },
    message: { type: "user", role: "user", content: [{ type: "text", text: "host admitted" }] }
  }
  const ticket = {
    input,
    signal: f.signal,
    assertCurrent: () => {},
    normalizeInput: (value: unknown) => value,
    core: async () => {
      throw Error("DENIED_APPEND_COMMITTED")
    },
    acceptResult: (value: unknown) => value
  } as unknown as FunctionSessionAppendTicket
  expect(await f.manager.appendConversation(f.root, "append", ticket)).toEqual({ deny: "1" })
  expect(f.starts("append")).toBeUndefined()
  expect(f.row("append")).toMatchObject({
    autoReclaimable: false,
    guestEntered: true,
    state: "discovery"
  })
  for (let i = 0; i < 6; i++) await f.manager.hasEventHandler(f.root, `other-${i}`, "command.run")
  expect(await f.manager.appendConversation(f.root, "append", ticket)).toEqual({ deny: "2" })
  expect(f.starts("append")).toBeUndefined()
})

it("retains started closures while reclaiming other pure probes", async () => {
  const f = await fixture()
  await f.manager.hasEventHandler(f.root, "started", "command.run")
  expect(await f.run("started")).toEqual({ text: "1" })
  for (let i = 0; i < 6; i++) await f.manager.hasEventHandler(f.root, `quiet-${i}`, "command.run")
  expect(await f.run("started")).toEqual({ text: "2" })
  expect(f.starts("started")).toBe(1)
})

it("retains applied native behavior selections under probe pressure until explicitly disabled", async () => {
  const f = await fixture(
    "",
    `on.capability({
    apiVersion:"devclaw.capability/v1",id:"format",version:"1.0.0",title:"Format",
    scope:"conversation",stateSchema:{type:"object",additionalProperties:true},actions:[{
      id:"format",title:"Format",inputSchema:{type:"object",additionalProperties:true},
      outputSchema:{type:"object",additionalProperties:true},requiredPermissions:[],
      cancellable:true,idempotency:"keyed"
    }],presentation:{type:"behavior",apiVersion:"devclaw.behavior/v1",id:"format",
      title:"Format",point:"ui.toast",phase:"replace",action:"format"}
  },{act:async()=>({})});`
  )
  const selection = "release-demo/format"
  for (let i = 0; i < 6; i++) {
    const threadId = `selected-${i}`
    await f.manager.hasEventHandler(f.root, threadId, "command.run")
    expect(f.row(threadId).autoReclaimable).toBe(true)
    const preview = f.manager.platformBehaviorPreview(f.root, threadId, [selection])
    expect(preview.canApply).toBe(true)
    f.manager.platformBehaviorApply(f.root, threadId, preview.previewId, preview.revision)
    expect(f.row(threadId)).toMatchObject({
      autoReclaimable: false,
      guestEntered: false,
      canRelease: false,
      state: "discovery",
      diagnostics: { backgroundResources: 0, subscriptions: 0, inFlight: 0 }
    })
  }
  await expect(f.manager.hasEventHandler(f.root, "seventh", "command.run")).rejects.toMatchObject({
    code: "MODS_SESSION_CAPACITY"
  })
  await expect(f.release(f.row("selected-0"))).rejects.toMatchObject({
    code: "MODS_RUNTIME_SESSION_BUSY"
  })
  expect(f.state.drains).toBe(0)
  expect(f.state.loads).toBe(6)
  for (let i = 0; i < 6; i++) {
    expect(f.manager.platformBehaviorList(f.root, `selected-${i}`).active).toEqual([selection])
    expect(f.starts(`selected-${i}`)).toBeUndefined()
  }
  f.manager.platformBehaviorDisable(f.root, "selected-0")
  expect(f.row("selected-0").autoReclaimable).toBe(true)
  expect(await f.manager.hasEventHandler(f.root, "seventh", "command.run")).toBe(true)
  expect(f.row("selected-0")).toBeUndefined()
  expect(f.state.drains).toBe(1)
  expect(f.state.loads).toBe(7)
  expect(f.manager.platformBehaviorList(f.root, "selected-1").active).toEqual([selection])
  expect(f.starts("seventh")).toBeUndefined()
})

it("detaches native drawing without discarding the used guest or replaying startup", async () => {
  const f = await fixture("", 'on("ui.render",{component:"AbovePrompt"},($,e,next)=>next(e))')
  expect(await f.run("visible")).toEqual({ text: "1" })
  const generation = f.row("visible").generation
  const owner = await f.manager.siteMount(f.root, "visible", "AbovePrompt")
  expect(owner).toEqual(expect.any(String))
  expect(f.row("visible")).toMatchObject({ mountedSites: 1, guestEntered: true })
  await f.manager.siteUnmount(f.root, "visible", owner!)
  expect(f.row("visible")).toMatchObject({
    generation,
    mountedSites: 0,
    guestEntered: true,
    autoReclaimable: false
  })
  expect(await f.run("visible")).toEqual({ text: "2" })
  expect(f.starts("visible")).toBe(1)
  expect(f.state.loads).toBe(1)
  expect(f.state.drains).toBe(0)
})

it("does not reclaim pending registration jobs or peers without transport proof", async () => {
  const f = await fixture()
  const source = join(f.path, "hooks/register.ts")
  await writeFile(
    source,
    'Promise.resolve().then(()=>{});export function register(on){on("command.run",async()=>({text:"ok"}))}'
  )
  const compiled = await compileFunctionPlugin(f.path)
  f.store.grant(f.root, "function:release-demo", compiled.digest, true)
  f.manager.invalidate(f.root)
  for (let i = 0; i < 6; i++) await f.manager.hasEventHandler(f.root, `pending-${i}`, "command.run")
  expect(f.manager.runtimeSessions().sessions.every((row) => !row.autoReclaimable)).toBe(true)
  await expect(f.manager.hasEventHandler(f.root, "seventh", "command.run")).rejects.toMatchObject({
    code: "MODS_SESSION_CAPACITY"
  })
  const fresh = await fixture()
  fresh.state.transportProof = false
  for (let i = 0; i < 6; i++)
    await fresh.manager.hasEventHandler(fresh.root, `legacy-${i}`, "command.run")
  await expect(
    fresh.manager.hasEventHandler(fresh.root, "seventh", "command.run")
  ).rejects.toMatchObject({ code: "MODS_SESSION_CAPACITY" })
  const old = await fixture()
  old.state.oldPeer = true
  for (let i = 0; i < 6; i++) await old.manager.hasEventHandler(old.root, `old-${i}`, "command.run")
  await expect(
    old.manager.hasEventHandler(old.root, "seventh", "command.run")
  ).rejects.toMatchObject({ code: "MODS_SESSION_CAPACITY" })
})

it("coalesces the same cold scope and atomically transfers capacity across concurrent pressure", async () => {
  const f = await fixture()
  for (let i = 0; i < 6; i++) await f.manager.hasEventHandler(f.root, `quiet-${i}`, "command.run")
  const gate = Promise.withResolvers<void>()
  f.state.gate = gate.promise
  const operations = [
    f.manager.hasEventHandler(f.root, "seven", "command.run"),
    f.manager.hasEventHandler(f.root, "seven", "command.run"),
    f.manager.hasEventHandler(f.root, "eight", "command.run")
  ]
  try {
    await vi.waitFor(() => expect(f.state.drains).toBe(1))
    expect(f.manager.runtimeSessions().resident).toBe(6)
    expect(f.state.loads).toBe(6)
  } finally {
    gate.resolve()
  }
  expect(await Promise.all(operations)).toEqual([true, true, true])
  expect(f.manager.runtimeSessions().resident).toBe(6)
  expect(f.state.loads).toBe(8)
  expect(f.starts("seven")).toBeUndefined()
})

it.each(["request", "host-call", "native-control"] as const)(
  "does not reclaim a registration probe with pending %s ownership",
  async (kind) => {
    const f = await fixture()
    for (let i = 0; i < 6; i++) await f.manager.hasEventHandler(f.root, `quiet-${i}`, "command.run")
    if (kind === "request") f.state.pending = 1
    if (kind === "host-call") f.state.calls = 1
    if (kind === "native-control") f.state.busy = true
    expect(f.manager.runtimeSessions().sessions.every((row) => !row.autoReclaimable)).toBe(true)
    await expect(f.manager.hasEventHandler(f.root, "seven", "command.run")).rejects.toMatchObject({
      code: "MODS_SESSION_CAPACITY"
    })
    expect(f.state.drains).toBe(0)
    expect(f.state.loads).toBe(6)
  }
)

it("keeps a failed automatic retirement's slot and never reloads that sealed scope", async () => {
  const f = await fixture()
  for (let i = 0; i < 6; i++) await f.manager.hasEventHandler(f.root, `quiet-${i}`, "command.run")
  f.state.failDrain = true
  await expect(f.manager.hasEventHandler(f.root, "seven", "command.run")).rejects.toThrow(
    "EXIT_UNCONFIRMED"
  )
  expect(f.manager.runtimeSessions()).toMatchObject({ resident: 6, retiring: 1 })
  expect(f.row("quiet-0")).toMatchObject({
    state: "failed",
    autoReclaimable: false,
    canRelease: false
  })
  await expect(f.manager.commands(f.root, "quiet-0")).rejects.toThrow()
  expect(f.state.loads).toBe(6)
})

it("keeps mandatory policy probes intact and rejects pressure when none is reclaimable", async () => {
  const f = await fixture()
  for (let i = 0; i < 6; i++)
    await f.manager.hasEventHandler(f.root, `required-${i}`, "command.run")
  f.manager.setCompletionPolicy(f.root, "required-0", "release-demo", {
    mode: "check",
    scope: "diff",
    checks: ["code-review"],
    maxRepairs: 0,
    timeoutMs: 120000,
    modelTokenBudget: 4096
  })
  expect(f.manager.runtimeSessions().sessions.every((row) => !row.autoReclaimable)).toBe(true)
  await expect(f.manager.hasEventHandler(f.root, "seven", "command.run")).rejects.toMatchObject({
    code: "MODS_SESSION_CAPACITY"
  })
  expect(f.state.drains).toBe(0)
  expect(f.state.loads).toBe(6)
  expect(f.starts("required-0")).toBeUndefined()
})

it("seals late guest admission before physical drain and lets same-scope demand rebuild once", async () => {
  const f = await fixture()
  for (let i = 0; i < 6; i++) await f.manager.hasEventHandler(f.root, `quiet-${i}`, "command.run")
  const entries = (
    f.manager as unknown as {
      sessions: Map<string, { session: { plugins: Array<{ guest: FunctionGuest }> } }>
    }
  ).sessions
  const guest = entries.get(JSON.stringify([f.root, "quiet-0"]))!.session.plugins[0].guest
  const gate = Promise.withResolvers<void>()
  f.state.gate = gate.promise
  const pressure = f.manager.hasEventHandler(f.root, "seven", "command.run")
  let commands: Promise<unknown[]>
  try {
    await vi.waitFor(() => expect(f.state.drains).toBe(1))
    expect(() => guest.matches("0", {})).toThrow("MODS_ENTRY_EXPIRED")
    commands = Promise.all([f.run("quiet-0"), f.run("quiet-0")])
    expect(f.state.loads).toBe(6)
    expect(f.starts("quiet-0")).toBeUndefined()
  } finally {
    gate.resolve()
  }
  expect(await pressure).toBe(true)
  expect(await commands!).toEqual([{ text: "1" }, { text: "2" }])
  expect(f.state.loads).toBe(8)
  expect(f.starts("quiet-0")).toBe(1)
  expect(f.manager.runtimeSessions().resident).toBe(6)
})

it("does not turn an admission invalidated during drain into a fresh authorized request", async () => {
  const f = await fixture()
  for (let i = 0; i < 6; i++) await f.manager.hasEventHandler(f.root, `quiet-${i}`, "command.run")
  const gate = Promise.withResolvers<void>()
  f.state.gate = gate.promise
  const pressure = f.manager.hasEventHandler(f.root, "seven", "command.run")
  const rejected = expect(pressure).rejects.toMatchObject({ code: "MODS_SCOPE_CHANGED" })
  try {
    await vi.waitFor(() => expect(f.state.drains).toBe(1))
    f.manager.invalidate(f.root)
  } finally {
    gate.resolve()
  }
  await rejected
  expect(f.state.loads).toBe(6)
  expect(f.manager.runtimeSessions().reserved).toBe(0)
  expect(f.starts("seven")).toBeUndefined()
})
