import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"
import { FunctionDesktopBroker } from "./desktop-broker"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import * as loader from "./loader"
import { WorkflowWorktreeLedger } from "../../agent/workflow/worktree-lease"
import * as gitWorktrees from "../../services/git-worktree"

const cleanups: Array<() => Promise<void>> = []
vi.setConfig({ testTimeout: 20000 })
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function fixture() {
  const container = await mkdtemp(join(tmpdir(), "native-mods-lifecycle-"))
  const root = join(container, "repo"),
    plugin = join(container, "plugin")
  await mkdir(root)
  await cp(resolve("resources/mods/function-commands"), plugin, { recursive: true })
  await writeFile(
    join(plugin, "hooks/register.ts"),
    `export function register(on) {
    const record=async($,kind,e)=>{
      const events=await $.store.get("events")??[];
      await $.store.set("events",[...events,{kind,...e,surfaces:await $.session.surfaces()}]);
    };
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"lifecycle",description:"native lifecycle probe"});
      return next(e);
    });
    on("session.attach",async($,e,next)=>{await record($,"attach",e);return {clientId:"not-a-credential"}});
    on("session.detach",async($,e,next)=>{await record($,"detach",e);return next(e)});
    on("session.end",async($,e,next)=>{await record($,"end",e);return next(e)});
    on("classic.WorktreeRemove",async($,e,next)=>{
      await $.store.set("remove",e);await next(e);return {worktree_path:"forged"};
    });
  }`
  )
  const store = new ModControlStore(join(container, "control.sqlite"))
  const desktop = new FunctionDesktopBroker(() => {})
  let enabled = true,
    loads = 0
  const guests = new Set<FunctionGuestRuntime>()
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [{ id: "source", name: "function-commands", path: plugin, enabled: true }],
      desktop,
      enabled: () => enabled,
      changed: () => {},
      publish: async (_workspace, value) => value
    },
    () => ({
      async load(code, options) {
        loads++
        const guest = await FunctionGuestRuntime.create(code, options)
        guests.add(guest)
        return guest
      },
      stop() {
        for (const guest of guests) void guest.dispose()
      },
      async stopAndDrain() {
        await Promise.all([...guests].map((guest) => guest.dispose()))
      }
    })
  )
  cleanups.push(async () => {
    await manager.closeThreadAndWait("thread").catch(() => {})
    manager.close()
    await Promise.all([...guests].map((guest) => guest.dispose()))
    store.close()
    await rm(container, { recursive: true, force: true })
  })
  const status = await manager.status(root)
  await manager.approve(root, "source", status[0].digest!)
  const read = (key: string) =>
    store.functionState.get(JSON.stringify([root, "function-commands"]), key)
  const events = () => (read("events") ?? []) as Array<Record<string, unknown>>
  return {
    root,
    container,
    manager,
    desktop,
    store,
    read,
    events,
    loads: () => loads,
    disable() {
      enabled = false
      manager.invalidate(root)
    }
  }
}

it("does no VM/scan work on cold desktop bindings and late-start observes the real snapshot once", async () => {
  const f = await fixture(),
    before = f.loads()
  const compile = vi.spyOn(loader, "compileFunctionPlugin")
  f.desktop.attach("thread", "renderer-A", 11, () => {})
  f.desktop.attach("thread", "renderer-A", 11, () => {})
  expect(f.loads()).toBe(before)
  expect(compile).not.toHaveBeenCalled()
  expect(f.events()).toEqual([])
  await f.manager.commands(f.root, "thread")
  await expect.poll(() => f.events().length).toBe(1)
  const attached = f.desktop.bindings("thread")[0]
  expect(f.events()).toEqual([
    { kind: "attach", surface: "desktop", clientId: attached.clientId, surfaces: ["desktop"] }
  ])
  await f.manager.commands(f.root, "thread")
  f.desktop.attach("thread", "renderer-A", 11, () => {})
  expect(f.events()).toHaveLength(1)
})

it("bounds native lifecycle notification bursts while retaining the real latest desktop owner", async () => {
  const f = await fixture()
  await f.manager.commands(f.root, "thread")
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  const before = f.loads()
  for (let index = 0; index < 40; index++)
    f.desktop.attach("thread", `renderer-${index}`, index, () => {})
  expect(f.desktop.bindings("thread")[0].owner).toBe("renderer-39")
  expect(f.loads()).toBe(before)
  expect(warning).toHaveBeenCalledWith("[Mods] Desktop lifecycle observation stopped: pending observer limit")
  f.disable()
})

async function ownedLedger(
  f: Awaited<ReturnType<typeof fixture>>,
  observer: ConstructorParameters<typeof WorkflowWorktreeLedger>[0]["removalObserver"]
) {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", f.root, ...args], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    })
  git("init", "--initial-branch=main")
  git("config", "user.name", "Lifecycle Test")
  git("config", "user.email", "lifecycle@example.invalid")
  git("config", "commit.gpgsign", "false")
  await writeFile(join(f.root, "README.md"), "isolated lifecycle fixture\n")
  git("add", "README.md")
  git("commit", "-m", "isolated fixture")
  const changed = vi.fn(),
    deleted = vi.fn()
  const ledger = new WorkflowWorktreeLedger({
    workspacePath: f.root,
    threadId: "thread",
    runId: "workflow",
    appDataRoot: join(f.container, "worktree-control"),
    removalObserver: observer,
    onRecordChange: changed,
    onRecordDelete: deleted
  })
  return { ledger, changed, deleted }
}

it("produces WorktreeRemove through the real owned ledger before real pristine Git reclamation", async () => {
  const f = await fixture()
  await f.manager.commands(f.root, "thread")
  const observer = f.manager.captureWorktreeRemovalObserver(f.root, "thread", "workflow", () => {})
  expect(observer).toBeDefined()
  const { ledger, deleted } = await ownedLedger(f, observer)
  const worktree = await ledger.acquire("real-observer")
  expect(existsSync(worktree.directory)).toBe(true)
  await ledger.settle(worktree, { succeeded: true })
  expect(f.read("remove")).toMatchObject({
    hook_event_name: "WorktreeRemove",
    session_id: "thread",
    cwd: f.root,
    worktree_path: worktree.directory
  })
  expect(existsSync(worktree.directory)).toBe(false)
  expect(deleted).toHaveBeenCalledOnce()
})

it("keeps dirty trees without an event and never fakes completion after native removal failure", async () => {
  const f = await fixture(),
    observe = vi.fn(async () => {})
  const { ledger, changed, deleted } = await ownedLedger(f, { observe })
  const dirty = await ledger.acquire("dirty")
  await writeFile(join(dirty.workspaceDirectory, "uncommitted.txt"), "retain my changes\n")
  await ledger.settle(dirty, { succeeded: false })
  expect(observe).not.toHaveBeenCalled()
  expect(existsSync(dirty.directory)).toBe(true)
  const pristine = await ledger.acquire("failure")
  const remove = vi
    .spyOn(gitWorktrees, "removeWorkflowWorktree")
    .mockRejectedValueOnce(Error("owned-git-remove-failed"))
  await ledger.settle(pristine, { succeeded: true })
  expect(observe).toHaveBeenCalledOnce()
  expect(remove).toHaveBeenCalledWith(
    expect.objectContaining({ directory: pristine.directory, preserveChanges: true })
  )
  expect(existsSync(pristine.directory)).toBe(true)
  expect(deleted).not.toHaveBeenCalled()
  expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({
    status: "recoverable",
    dirty: false,
    error: expect.stringContaining("owned-git-remove-failed")
  })
})

it("bounds a failed observer and still performs the original conservative cleanup", async () => {
  const f = await fixture()
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  const { ledger, deleted } = await ownedLedger(f, { observe: async () => new Promise(() => {}) })
  const worktree = await ledger.acquire("bounded-observer")
  const began = performance.now()
  await ledger.settle(worktree, { succeeded: true })
  expect(performance.now() - began).toBeGreaterThan(1300)
  expect(performance.now() - began).toBeLessThan(3000)
  expect(warning).toHaveBeenCalledWith(
    "[Mods] Worktree removal observation stopped:",
    expect.any(String)
  )
  expect(deleted).toHaveBeenCalledOnce()
  expect(existsSync(worktree.directory)).toBe(false)
})

it("delivers replacement/destroy exactly once and uses the actual roster without fake end", async () => {
  const f = await fixture()
  await f.manager.commands(f.root, "thread")
  f.desktop.attach("thread", "renderer-A", 11, () => {})
  await expect.poll(() => f.events().length).toBe(1)
  const first = f.desktop.bindings("thread")[0].clientId
  f.desktop.attach("thread", "renderer-B", 12, () => {})
  await expect.poll(() => f.events().length).toBe(3)
  const second = f.desktop.bindings("thread")[0].clientId
  f.desktop.closeSender(11)
  expect(f.desktop.bindings("thread")[0].clientId).toBe(second)
  f.desktop.closeSender(12)
  f.desktop.closeSender(12)
  await expect.poll(() => f.events().length).toBe(4)
  expect(f.events().map((event) => [event.kind, event.clientId, event.reason])).toEqual([
    ["attach", first, undefined],
    ["detach", first, "detach"],
    ["attach", second, undefined],
    ["detach", second, "detach"]
  ])
  expect(f.events().at(-1)?.surfaces).toEqual([])
})

it("cuts the real desktop roster before reason:end and session.end, with no revoke notification", async () => {
  const f = await fixture()
  await f.manager.commands(f.root, "thread")
  f.desktop.attach("thread", "renderer", 10, () => {})
  await expect.poll(() => f.events().length).toBe(1)
  const clientId = f.desktop.bindings("thread")[0].clientId
  const end = f.manager.prepareEnd("clear", "thread")
  await Promise.all([end.notify(), end.notify()])
  expect(
    f.events().map((event) => [event.kind, event.clientId, event.reason, event.surfaces])
  ).toEqual([
    ["attach", clientId, undefined, ["desktop"]],
    ["detach", clientId, "end", []],
    ["end", undefined, "clear", []]
  ])
  end.finish()
  f.desktop.detach("thread", "renderer", 10)
  expect(f.events()).toHaveLength(3)

  const g = await fixture()
  await g.manager.commands(g.root, "thread")
  g.desktop.attach("thread", "renderer", 10, () => {})
  await expect.poll(() => g.events().length).toBe(1)
  const loads = g.loads(),
    compile = vi.spyOn(loader, "compileFunctionPlugin")
  g.disable()
  g.desktop.closeSender(10)
  g.desktop.attach("thread", "other", 11, () => {})
  expect(g.loads()).toBe(loads)
  expect(compile).not.toHaveBeenCalled()
  expect(g.events()).toHaveLength(1)
})

it("captures only an already-started WorktreeRemove observer and rechecks original native ownership", async () => {
  const f = await fixture(),
    owner = vi.fn()
  expect(
    f.manager.captureWorktreeRemovalObserver(f.root, "thread", "workflow", owner)
  ).toBeUndefined()
  const before = f.loads()
  await f.manager.commands(f.root, "thread")
  const observer = f.manager.captureWorktreeRemovalObserver(f.root, "thread", "workflow", owner)
  expect(observer).toBeDefined()
  await observer!.observe({
    workspace: f.root,
    threadId: "thread",
    runId: "workflow",
    path: join(f.root, "owned")
  })
  expect(f.read("remove")).toEqual({
    hook_event_name: "WorktreeRemove",
    session_id: "thread",
    transcript_path: "",
    cwd: f.root,
    worktree_path: join(f.root, "owned")
  })
  expect(f.loads()).toBe(before + 1)
  await expect(
    observer!.observe({ workspace: f.root, threadId: "thread", runId: "other", path: "forged" })
  ).rejects.toMatchObject({ code: "MODS_WORKTREE_OBSERVER_SCOPE" })
  owner.mockImplementation(() => {
    throw Error("original-native-owner-ended")
  })
  await expect(
    observer!.observe({
      workspace: f.root,
      threadId: "thread",
      runId: "workflow",
      path: join(f.root, "owned")
    })
  ).rejects.toThrow("original-native-owner-ended")
})

it("real Guest observers cannot rewrite native inputs or turn a result into a host fact", async () => {
  const received: unknown[] = []
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.attach",async($,e,next)=>{await $.session.messages();return {clientId:"forged"}});
    on("classic.WorktreeRemove",async($,e,next)=>next({...e,worktree_path:"forged"}));
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "observer",
        root: "/root",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/root",
      threadId: "thread",
      assertLive: () => undefined,
      publish: async (value) => value,
      readSession: async () => {
        received.push("actual-guest")
        return []
      }
    }
  )
  cleanups.push(() => session.close())
  await session.start()
  await session.observeNativeEvent(
    "session.attach",
    { surface: "desktop", clientId: "native" },
    { clientId: "native" },
    () => {}
  )
  expect(received).toEqual(["actual-guest"])
  await expect(
    session.observeNativeEvent(
      "classic.WorktreeRemove",
      {
        hook_event_name: "WorktreeRemove",
        session_id: "thread",
        transcript_path: "",
        cwd: "/root",
        worktree_path: "/root/owned"
      },
      {},
      () => {}
    )
  ).rejects.toMatchObject({ code: "MODS_PINNED_INPUT" })
})

it("detach and session.end spend one shared 1.5 second end deadline", async () => {
  const seen: string[] = []
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.detach",async($,e,next)=>{await $.clock.sleep(900);return next(e)});
    on("session.end",async($,e,next)=>{await $.session.messages();await $.clock.sleep(900);return next(e)});
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "observer",
        root: "/root",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/root",
      threadId: "thread",
      assertLive: () => undefined,
      publish: async (value) => value,
      detachDesktopForEnd: () => [{ clientId: "native" }],
      readSession: async () => {
        seen.push("end")
        return []
      }
    }
  )
  cleanups.push(() => session.close())
  await session.start()
  const began = performance.now()
  await expect(session.end("clear")).rejects.toMatchObject({ code: "MODS_DISPATCH_TIMEOUT" })
  expect(seen).toEqual(["end"])
  expect(performance.now() - began).toBeGreaterThan(1300)
  expect(performance.now() - began).toBeLessThan(2400)
})

it("rechecks the exact native observer owner after an awaited Guest SDK call", async () => {
  let live = true
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.attach",async($,e,next)=>{await $.session.messages();return next(e)});
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "observer",
        root: "/root",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/root",
      threadId: "thread",
      assertLive: () => undefined,
      publish: async (value) => value,
      readSession: async () => {
        await Promise.resolve()
        live = false
        return []
      }
    }
  )
  cleanups.push(() => session.close())
  await session.start()
  await expect(
    session.observeNativeEvent(
      "session.attach",
      { surface: "desktop", clientId: "native" },
      { clientId: "native" },
      () => {
        if (!live) throw Error("native-owner-replaced")
      }
    )
  ).rejects.toThrow("native-owner-replaced")
})
