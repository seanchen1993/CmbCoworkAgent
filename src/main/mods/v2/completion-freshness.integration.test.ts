import { cp, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"
import { emitWorkspaceFilesChanged } from "../../services/workspace-change-events"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mods-freshness-"))
  const plugin = join(root, "plugin")
  await cp(resolve("resources/mods/function-commands"), plugin, { recursive: true })
  await writeFile(
    join(plugin, "hooks/register.ts"),
    `export function register(on) {
    on("completion.check", () => ({ decision: "pass" }))
    on("session.start", async ($, e, next) => {
      await $.command.register({ name: "configure", description: "change config" })
      return next(e)
    })
    on("command.run", { command: "configure" }, async ($) => {
      await $.store.set("review-target", "new.ts")
      return { text: "configured" }
    })
  }`
  )
  const store = new ModControlStore(join(root, "control.sqlite"))
  let enabled = true
  const changed = vi.fn()
  const load = vi.fn(async (code, options) => FunctionGuestRuntime.create(code, options))
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [{ id: "source", name: "function-commands", path: plugin, enabled: true }],
      enabled: () => enabled,
      publish: async (_, value) => value,
      changed
    },
    () => ({ load, stop: () => undefined })
  )
  const signal = new AbortController().signal
  const approve = async () => {
    const status = await manager.status(root)
    await manager.approve(root, "source", status[0].digest!)
  }
  const pass = async () => {
    await manager.turnStart(root, "thread", { turnId: "turn", text: "implement" }, signal)
    const gate = await manager.completionGate(root, "thread", () => ({
      turnId: "turn",
      runId: "run"
    }))
    expect(await gate!({ signal, revisionAttempts: 0, maxRevisionAttempts: 1 })).toMatchObject({
      decision: "pass"
    })
  }
  const notify = () =>
    emitWorkspaceFilesChanged({
      workspacePath: root,
      threadIds: ["thread"],
      changeType: "file",
      update: { kind: "rescan" }
    })
  const stale = () =>
    store.completionEvidence(root, "thread").filter((row) => row.phase === "invalidated")
  cleanups.push(async () => {
    manager.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    plugin,
    manager,
    store,
    load,
    changed,
    approve,
    pass,
    notify,
    stale,
    disable() {
      enabled = false
      manager.invalidateAll()
    }
  }
}

it("a real guest PASS becomes stale after a workspace file change, without rerunning the guest", async () => {
  const f = await fixture()
  await f.approve()
  await f.pass()
  f.notify()
  await new Promise((r) => setTimeout(r, 200))
  expect(f.stale()).toEqual([])
  const loads = f.load.mock.calls.length
  await writeFile(join(f.root, "requirements.md"), "changed requirement")
  for (let i = 0; i < 100; i++) f.notify()
  await vi.waitFor(() => expect(f.stale()).toHaveLength(1))
  expect(f.stale()[0]).toMatchObject({ status: "stale", detail: { reason: "input-changed" } })
  expect(f.load).toHaveBeenCalledTimes(loads)
  expect(
    f.store.completionEvidence(f.root, "thread").filter((row) => row.phase === "check.result")
  ).toHaveLength(1)
  f.notify()
  await new Promise((r) => setTimeout(r, 150))
  expect(f.stale()).toHaveLength(1)
})

it.each(["replaced", "off", "revoked"])(
  "invalidates existing proof on %s and removes background work",
  async (mode) => {
    const f = await fixture()
    await f.approve()
    await f.pass()
    const loads = f.load.mock.calls.length
    if (mode === "off") f.disable()
    else if (mode === "revoked") f.manager.revoke(f.root, "function-commands")
    else f.manager.invalidate(f.root)
    expect(f.stale()).toHaveLength(1)
    f.notify()
    await new Promise((r) => setTimeout(r, 100))
    expect(f.load).toHaveBeenCalledTimes(loads)
  }
)

it("updates proof freshness on SDK configuration writes without a file notification", async () => {
  const f = await fixture()
  await f.approve()
  await f.pass()
  const command = (await f.manager.commands(f.root, "thread")).find(
    (c) => c.command === "configure"
  )!
  expect(
    await f.manager.runCommand(f.root, "thread", command, "", new AbortController().signal)
  ).toEqual({ text: "configured" })
  await vi.waitFor(() => expect(f.stale()).toHaveLength(1))
  expect(f.stale()[0].detail).toMatchObject({ reason: "COMPLETION_CONFIG_CHANGED" })
})

it("invalidates persisted PASS after restart without loading a guest or rewriting old execution facts", async () => {
  const f = await fixture()
  await f.approve()
  await f.pass()
  const original = f.store
    .completionEvidence(f.root, "thread")
    .find((row) => row.phase === "check.result")!
  // Simulate an earlier process record with no orderly close/invalidation.
  f.store.saveCompletionEvidence({
    ...original,
    id: "prior-process",
    idempotencyKey: "prior-process",
    binding: { ...original.binding, runtimeGeneration: original.binding.runtimeGeneration - 1 }
  })
  const before = f.load.mock.calls.length
  const rows = f.manager.completionEvidence(f.root, "thread")
  expect(rows).toContainEqual(expect.objectContaining({ id: "prior-process", status: "pass" }))
  expect(rows).toContainEqual(
    expect.objectContaining({
      phase: "invalidated",
      status: "stale",
      binding: expect.objectContaining({
        runtimeGeneration: original.binding.runtimeGeneration - 1
      })
    })
  )
  const length = rows.length
  expect(f.manager.completionEvidence(f.root, "thread")).toHaveLength(length)
  expect(f.load).toHaveBeenCalledTimes(before)
})

it("records changed plugin source as stale without accepting or executing the new version", async () => {
  const f = await fixture()
  await f.approve()
  await f.pass()
  const before = f.load.mock.calls.length
  await writeFile(join(f.plugin, "hooks/register.ts"), "export function register(on) {}")
  f.notify()
  await vi.waitFor(() => expect(f.stale()).toHaveLength(1))
  expect(f.stale()[0].detail).toMatchObject({ reason: "MODS_PLUGIN_CHANGED" })
  expect(f.load).toHaveBeenCalledTimes(before)
})

it("reopens a durable ledger in a new manager without reviving the previous PASS", async () => {
  const f = await fixture()
  await f.approve()
  await f.pass()
  const prior = f.store
    .completionEvidence(f.root, "thread")
    .find((row) => row.phase === "check.result")!
  const path = join(f.root, "restart.sqlite")
  const previousStore = new ModControlStore(path)
  previousStore.saveCompletionEvidence(prior)
  previousStore.close()
  const reopened = new ModControlStore(path)
  const load = vi.fn(() => {
    throw Error("must not create a runtime")
  })
  const manager = new FunctionModsManager(
    reopened,
    {
      plugins: () => [],
      enabled: () => true,
      changed: () => undefined,
      publish: async (_, value) => value
    },
    load
  )
  try {
    const rows = manager.completionEvidence(f.root, "thread")
    expect(rows).toContainEqual(expect.objectContaining({ id: prior.id, status: "pass" }))
    expect(rows).toContainEqual(expect.objectContaining({ phase: "invalidated", status: "stale" }))
    expect(manager.completionEvidence(f.root, "thread")).toHaveLength(rows.length)
    expect(load).not.toHaveBeenCalled()
  } finally {
    manager.close()
    reopened.close()
  }
})

it("does not discover plugins or load a runtime for disabled file notifications", async () => {
  const f = await fixture()
  f.disable()
  const discover = vi.spyOn(f.manager, "status")
  for (let i = 0; i < 100; i++) f.notify()
  expect(f.load).not.toHaveBeenCalled()
  expect(discover).not.toHaveBeenCalled()
  expect(f.changed).not.toHaveBeenCalled()
})
