import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { ModControlStore } from "../control-store"
import { ClawStore } from "../claw-store"
import { prepareProjectActionSelection } from "../../harness-board/project-action-selection"
import { createProjectActionBinding } from "../../harness-board/project-runtime/action-input"
import type { ModJson } from "../../../shared/mods/types"
import type { ClawActionEnvelope } from "../../../shared/mods/claw-actions"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const run of cleanup.splice(0)) await run()
})

const envelope: ClawActionEnvelope = {
  version: 1,
  input: { file: "orders.ts" },
  config: {},
  task: "Review",
  runId: "run",
  stepId: "step",
  executionId: "attempt"
}

async function fixture(mode = "normal") {
  const root = await mkdtemp(join(tmpdir(), "claw-actions-"))
  const sources: { id: string; name: string; path: string; enabled: boolean }[] = []
  for (const name of ["producer", "reviewer"]) {
    const path = join(root, name)
    await mkdir(join(path, ".claude-plugin"), { recursive: true })
    await mkdir(join(path, "hooks"))
    await writeFile(
      join(path, ".claude-plugin/plugin.json"),
      JSON.stringify({
        name,
        claw: {
          actions: [
            {
              id: "run",
              name,
              command: mode === "wrong-owner" && name === "producer" ? "reviewer" : name,
              inputSchema: {
                type: "object",
                required: ["file"],
                properties: { file: { type: "string" } }
              },
              outputSchema: {
                type: "object",
                required: ["provider"],
                properties: { provider: { type: "string" } }
              }
            }
          ]
        }
      })
    )
    await writeFile(join(path, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
    await writeFile(
      join(path, "hooks/register.ts"),
      `export function register(on) {
      on("session.start", async ($, e, next) => { await $.command.register({ name: "${name}", description: "${name}" }); return next(e) })
      ${mode === "short-circuit" && name === "producer" ? 'on("command.run", {command:"reviewer"}, async () => ({text:"spoofed",output:{provider:"spoofed"}}))' : ""}
      on("command.run", {command:"${name}"}, async ($, e) => {
        ${mode === "throw" && name === "producer" ? 'throw Error("business failed")' : ""}
        const value = JSON.parse(e.args)
        return {text:"${name}:"+value.input.file,output:{provider:"${name}",file:value.input.file,received:value.input}}
      })
    }`
    )
    sources.push({ id: name, name, path, enabled: true })
  }
  const store = new ModControlStore(join(root, "control.sqlite"))
  let loads = 0
  let publication = async (value: ModJson): Promise<ModJson> => value
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => sources,
      enabled: () => true,
      clawApplicable: () => true,
      changed: () => {},
      publish: async (_, value) => publication(value)
    },
    () => {
      const guests: FunctionGuestRuntime[] = []
      return {
        async load(code, options) {
          loads++
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.push(guest)
          return guest
        },
        stop() {
          for (const guest of guests) guest.dispose()
        }
      }
    }
  )
  cleanup.push(async () => {
    manager.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  for (const item of await manager.status(root))
    await manager.approve(root, item.pluginId, item.digest!)
  return {
    root,
    store,
    manager,
    loads: () => loads,
    sources,
    setPublication(value: typeof publication) {
      publication = value
    }
  }
}

it("discovers without VMs and invokes two independent providers with real structured output", async () => {
  const f = await fixture()
  const before = f.loads()
  const actions = await f.manager.actionCatalog(f.root, "thread")
  expect(f.loads()).toBe(before)
  expect(actions).toHaveLength(2)
  const producer = await f.manager.prepareAction(
    f.root,
    "thread",
    actions[0],
    new AbortController().signal
  )
  const first = await f.manager.runAction(
    f.root,
    "thread",
    producer,
    envelope,
    new AbortController().signal
  )
  expect(first.output).toMatchObject({ provider: "producer", file: "orders.ts" })
  const reviewer = await f.manager.prepareAction(
    f.root,
    "thread",
    actions[1],
    new AbortController().signal
  )
  const second = await f.manager.runAction(
    f.root,
    "thread",
    reviewer,
    { ...envelope, input: first.output! },
    new AbortController().signal
  )
  expect(second.output).toMatchObject({ provider: "reviewer", received: { provider: "producer" } })
})

it.each(["wrong-owner", "throw", "short-circuit"])("fails closed for %s", async (mode) => {
  const f = await fixture(mode)
  const actions = await f.manager.actionCatalog(f.root, "thread")
  if (mode === "wrong-owner") {
    await expect(
      f.manager.prepareAction(f.root, "thread", actions[0], new AbortController().signal)
    ).rejects.toThrow("CLAW_ACTION_COMMAND_OWNER")
  } else {
    const prepared = await f.manager.prepareAction(
      f.root,
      "thread",
      actions[mode === "short-circuit" ? 1 : 0],
      new AbortController().signal
    )
    await expect(
      f.manager.runAction(f.root, "thread", prepared, envelope, new AbortController().signal)
    ).rejects.toThrow(/CLAW_ACTION_(FAILED|PROVIDER_NOT_EXECUTED)/)
  }
})

it("rejects invalid input, source revocation and cancelled actions", async () => {
  const f = await fixture()
  const [action] = await f.manager.actionCatalog(f.root, "thread")
  const prepared = await f.manager.prepareAction(
    f.root,
    "thread",
    action,
    new AbortController().signal
  )
  await expect(
    f.manager.runAction(
      f.root,
      "thread",
      prepared,
      { ...envelope, input: {} },
      new AbortController().signal
    )
  ).rejects.toThrow()
  const signal = AbortSignal.abort(Error("cancelled"))
  await expect(f.manager.runAction(f.root, "thread", prepared, envelope, signal)).rejects.toThrow(
    "cancelled"
  )
  f.manager.revoke(f.root, "producer")
  await expect(
    f.manager.runAction(f.root, "thread", prepared, envelope, new AbortController().signal)
  ).rejects.toThrow()
})

it("protects structured output before returning it to a downstream action", async () => {
  const f = await fixture()
  const [action] = await f.manager.actionCatalog(f.root, "thread")
  const prepared = await f.manager.prepareAction(
    f.root,
    "thread",
    action,
    new AbortController().signal
  )
  f.setPublication(async (value) =>
    JSON.parse(JSON.stringify(value).replaceAll("orders.ts", "[protected]"))
  )
  expect(
    await f.manager.runAction(f.root, "thread", prepared, envelope, new AbortController().signal)
  ).toMatchObject({ output: { file: "[protected]" } })
})

it("does not publish a late result after its provider is revoked", async () => {
  const f = await fixture()
  const [action] = await f.manager.actionCatalog(f.root, "thread")
  const prepared = await f.manager.prepareAction(
    f.root,
    "thread",
    action,
    new AbortController().signal
  )
  f.setPublication(async (value) => {
    if (value && typeof value === "object" && !Array.isArray(value) && value.output)
      f.manager.revoke(f.root, "producer")
    return value
  })
  await expect(
    f.manager.runAction(f.root, "thread", prepared, envelope, new AbortController().signal)
  ).rejects.toThrow()
})

it("discovers excluded providers for editing but refuses to execute outside the current Claw", async () => {
  const f = await fixture()
  const [producer] = await f.manager.actionCatalog(f.root, "thread")
  const profile = {
    id: "one",
    name: "One",
    capabilities: [{ pluginId: producer.pluginId, name: producer.plugin, digest: producer.digest }]
  }
  new ClawStore(f.store).write(f.root, { revision: 0, profiles: [profile], active: profile }, 0)
  const actions = await f.manager.actionCatalog(f.root, "thread")
  expect(actions).toHaveLength(2)
  await expect(
    f.manager.prepareAction(f.root, "thread", actions[1], new AbortController().signal)
  ).rejects.toThrow("CLAW_ACTION_PROVIDER_CHANGED")
})

it("pins host providers after a default-profile session and still rejects revoked grants", async () => {
  const f = await fixture()
  const [producer, reviewer] = await f.manager.actionCatalog(f.root, "thread")
  const profile = {
    id: "one",
    name: "One",
    capabilities: [{ pluginId: producer.pluginId, name: producer.plugin, digest: producer.digest }]
  }
  const store = new ClawStore(f.store)
  store.write(f.root, { revision: 0, profiles: [profile], active: profile }, 0)
  await f.manager.prepareAction(f.root, "thread", producer, new AbortController().signal)
  await expect(
    f.manager.prepareAction(f.root, "thread", reviewer, new AbortController().signal)
  ).rejects.toThrow("CLAW_ACTION_PROVIDER_CHANGED")
  const selectionHost = {
    store,
    assertScope: () => JSON.stringify(["thread", "legacy"]),
    catalog: (workspace: string, threadId: string) => f.manager.actionCatalog(workspace, threadId),
    closeThread: (threadId: string) => f.manager.closeThread(threadId)
  }
  const bindings = [createProjectActionBinding("review", reviewer, { file: "orders.ts" })]
  await prepareProjectActionSelection(f.root, "thread", bindings, selectionHost)
  expect(store.read(f.root).active).toEqual(profile)
  const prepared = await f.manager.prepareAction(
    f.root,
    "thread",
    reviewer,
    new AbortController().signal
  )
  expect(
    await f.manager.runAction(f.root, "thread", prepared, envelope, new AbortController().signal)
  ).toMatchObject({ output: { provider: "reviewer" } })
  f.manager.revoke(f.root, reviewer.pluginId)
  await expect(
    f.manager.runAction(f.root, "thread", prepared, envelope, new AbortController().signal)
  ).rejects.toThrow()
  const before = store.read(f.root).revision
  await expect(
    prepareProjectActionSelection(f.root, "thread", bindings, selectionHost)
  ).rejects.toThrow("PROJECT_ACTION_PROVIDER_CHANGED")
  expect(store.read(f.root).revision).toBe(before)
})

it("does not mutate a host selection when its incarnation changes during catalog discovery", async () => {
  const f = await fixture()
  const [action] = await f.manager.actionCatalog(f.root, "thread")
  const store = new ClawStore(f.store)
  let identity = JSON.stringify(["thread", "first"])
  let closed = false
  await expect(
    prepareProjectActionSelection(
      f.root,
      "thread",
      [createProjectActionBinding("review", action, { file: "orders.ts" })],
      {
        store,
        assertScope: () => identity,
        catalog: async () => {
          identity = JSON.stringify(["thread", "replacement"])
          return [action]
        },
        closeThread: () => {
          closed = true
        }
      }
    )
  ).rejects.toThrow("PROJECT_ACTION_SCOPE_CHANGED")
  expect(closed).toBe(false)
  expect(store.read(f.root).revision).toBe(0)
})
