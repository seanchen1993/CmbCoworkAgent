import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { compileFunctionPlugin } from "./loader"
import { ModControlStore } from "../control-store"
import {
  currentRuntimePluginSource,
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../../plugins/runtime-source-scope"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mods-host-handoff-")),
    workspace = join(root, "workspace")
  mkdirSync(workspace)
  const make = (name: string, source: string) => {
    const path = join(root, name)
    mkdirSync(join(path, "mods"), { recursive: true })
    writeFileSync(
      join(path, "plugin.json"),
      JSON.stringify({ name, version: "1.0.0", mods: "mods/manifest.json" })
    )
    writeFileSync(
      join(path, "mods/manifest.json"),
      JSON.stringify({ apiVersion: "cmb.mods/v2", id: name, entry: "main.ts" })
    )
    writeFileSync(join(path, "mods/main.ts"), source)
    return { id: name + "-uuid", name, path, enabled: true }
  }
  const provider = make(
    "provider",
    `export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"provider",description:"Original provider"});return next(e)});
    on("command.run",{command:"provider"},async($)=>{await $.tool.call({tool:"read_file",file_path:"knowledge.txt"});return{text:"original-context"}})
  }`
  )
  const parent = make(
    "parent",
    `export function register(on){
    on("prompt.compose",async()=>({sections:[]}));
    on("session.start",async($,e,next)=>{await $.command.register({name:"parent",description:"Exact parent"});return next(e)})
  }`
  )
  const retained = join(root, "retained")
  cpSync(parent.path, retained, { recursive: true })
  const store = new ModControlStore(join(root, "control.sqlite"))
  let onTool = async () => {},
    onDrain = async () => {},
    drains = 0,
    active = true
  const guests: FunctionGuestRuntime[] = []
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [provider, parent],
      enabled: () => true,
      changed: () => {},
      publish: async (_, value) => value,
      clawApplicable: () => false,
      callTool: async () => {
        await onTool()
        return { text: "actual-read", result: { text: "actual-read" } }
      }
    },
    () => {
      const local: FunctionGuestRuntime[] = []
      return {
        async load(code, options) {
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.push(guest)
          local.push(guest)
          return guest
        },
        stop() {
          for (const guest of local) void guest.dispose()
        },
        async stopAndDrain() {
          await onDrain()
          drains++
          await Promise.all(local.map((guest) => guest.dispose()))
        }
      }
    }
  )
  cleanup.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close(),
    async () => {
      onDrain = async () => {}
      manager.close()
      await Promise.all(guests.map((guest) => guest.dispose()))
    }
  )
  const compiledProvider = await compileFunctionPlugin(provider.path)
  store.grant(workspace, `function:${compiledProvider.name}`, compiledProvider.digest, true)
  const plugin = { ...parent, path: retained }
  const input = {
    workspace,
    plugin,
    scope: { projectId: "project", packageDigest: "a".repeat(64) }
  }
  const facts = await manager.prepareRuntimeSourceFacts(input)
  await manager.approveRuntimeSource({ ...input, digest: facts!.digest }, () => {})
  const token = issueRuntimePluginSourceToken(
    {
      mode: "host",
      capabilitySources: [],
      preserveParentContext: true,
      threadId: "stage",
      incarnationKey: "incarnation",
      projectId: "project",
      operationId: "operation",
      workspace,
      packageDigest: "a".repeat(64),
      stageId: "draft",
      plugin: {
        ...plugin,
        version: "1.0.0",
        description: "",
        author: "",
        skillCount: 1,
        mcpServerCount: 0,
        hookCount: 0,
        createdAt: "2026-10-18",
        updatedAt: "2026-10-18"
      }
    },
    () => {
      if (!active) throw Error("PROJECT_REVOKED")
    },
    () => {
      if (!active) throw Error("PROJECT_REVOKED")
    }
  )
  const before = await manager.commands(workspace, "stage")
  expect(before.map((command) => command.command)).toEqual(["provider"])
  return {
    manager,
    workspace,
    store,
    token,
    input,
    facts,
    before,
    guests,
    drains: () => drains,
    onTool: (run: () => Promise<void>) => {
      onTool = run
    },
    onDrain: (run: () => Promise<void>) => {
      onDrain = run
    },
    revoke: () => {
      active = false
    }
  }
}

it("retires the actual provider VM before loading exact-consent parent Mods for the same Host thread", async () => {
  const f = await fixture(),
    prior = [...f.guests]
  const providerGrant = f.store.getGrant(f.workspace, "function:provider")
  expect(
    await f.manager.runCommand(f.workspace, "stage", f.before[0], "", new AbortController().signal)
  ).toEqual({ text: "original-context" })
  const result = await withRuntimePluginSource(f.token, () =>
    f.manager.classicEvent(
      f.workspace,
      "stage",
      "prompt.compose",
      {
        model: "fixture",
        promptModel: "fixture",
        surfaces: ["desktop"],
        tools: [],
        traits: [],
        outputStyle: null
      },
      new AbortController().signal,
      async () => ({ sections: [{ id: "native", scope: "session", text: "must-remove" }] })
    )
  )
  expect(result).toEqual({ sections: [] })
  expect(prior.every((guest) => guest.stats.disposed)).toBe(true)
  expect(f.drains()).toBeGreaterThan(0)
  expect(
    (await withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage"))).map(
      (row) => row.command
    )
  ).toEqual(["parent"])
  expect(f.store.getGrant(f.workspace, "function:parent")).toBeNull()
  expect(f.store.getGrant(f.workspace, "function:provider")).toEqual(providerGrant)
  expect(
    f.store.getProjectFunctionGrant(f.workspace, "project", "a".repeat(64), "parent")?.digest
  ).toBe(f.facts!.digest)
  // Original native UI callbacks retain the new exact owner's lexical guard without ambient ALS.
  expect((await f.manager.commands(f.workspace, "stage")).map((row) => row.command)).toEqual([
    "parent"
  ])
  await expect(
    f.manager.runCommand(f.workspace, "stage", f.before[0], "", new AbortController().signal)
  ).rejects.toThrow()
  const binding = withRuntimePluginSource(f.token, () => currentRuntimePluginSource()!)
  const other = issueRuntimePluginSourceToken({ ...binding, operationId: "other-operation" })
  await expect(
    withRuntimePluginSource(other, () => f.manager.commands(f.workspace, "stage"))
  ).rejects.toThrow("MODS_RUNTIME_SOURCE_CHANGED")
})

it("never replaces an actually running provider call or borrows its active grant", async () => {
  const f = await fixture(),
    started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  f.onTool(async () => {
    started.resolve()
    await release.promise
  })
  const running = f.manager.runCommand(
    f.workspace,
    "stage",
    f.before[0],
    "",
    new AbortController().signal
  )
  await started.promise
  try {
    await expect(
      withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage"))
    ).rejects.toThrow("MODS_RUNTIME_SOURCE_BUSY")
    expect((await f.manager.commands(f.workspace, "stage")).map((row) => row.command)).toEqual([
      "provider"
    ])
  } finally {
    release.resolve()
    await running
  }
  expect(
    (await withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage"))).map(
      (row) => row.command
    )
  ).toEqual(["parent"])
})

it("retains the old slot and refuses reconstruction when physical retirement fails", async () => {
  const f = await fixture()
  f.onDrain(async () => {
    throw Error("PHYSICAL_DRAIN_FAILED")
  })
  await expect(
    withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage"))
  ).rejects.toThrow("PHYSICAL_DRAIN_FAILED")
  await expect(
    withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage"))
  ).rejects.toThrow("MODS_RUNTIME_SOURCE_CLEANUP_UNCONFIRMED")
  expect(f.manager.runtimeSessions(f.workspace).resident).toBe(1)
})

it("requires the original exact project grant before retiring an ordinary provider", async () => {
  const f = await fixture()
  f.store.grantProjectFunction(
    f.workspace,
    "project",
    "a".repeat(64),
    f.facts!.name,
    f.facts!.digest,
    false
  )
  await expect(
    withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage"))
  ).rejects.toThrow("PROJECT_MODS_APPROVAL_REQUIRED")
  expect(f.drains()).toBe(0)
  expect((await f.manager.commands(f.workspace, "stage")).map((row) => row.command)).toEqual([
    "provider"
  ])
  expect(f.store.getGrant(f.workspace, "function:parent")).toBeNull()
})

it.each(["authority", "source"] as const)(
  "rejects %s changes during physical drain without constructing a replacement",
  async (mode) => {
    const f = await fixture(),
      started = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    f.onDrain(async () => {
      started.resolve()
      await release.promise
    })
    const replacing = withRuntimePluginSource(f.token, () =>
      f.manager.commands(f.workspace, "stage")
    )
    const rejected = expect(replacing).rejects.toThrow(
      mode === "authority" ? "PROJECT_REVOKED" : "MODS_CONFIG_SOURCE_CHANGED"
    )
    await started.promise
    expect(f.manager.runtimeSessions().resident).toBe(1)
    const count = f.guests.length
    if (mode === "authority") f.revoke()
    else writeFileSync(join(f.input.plugin.path, "mods/main.ts"), "export function register(){}")
    release.resolve()
    await rejected
    expect(f.guests.length).toBe(count)
    expect(f.manager.runtimeSessions().resident).toBe(1)
  }
)

it("serializes the physical handoff and refuses an ABA token while preserving the original new VM", async () => {
  const f = await fixture(),
    started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  f.onDrain(async () => {
    started.resolve()
    await release.promise
  })
  const replacing = withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage"))
  await started.promise
  const binding = withRuntimePluginSource(f.token, () => currentRuntimePluginSource()!)
  const other = issueRuntimePluginSourceToken({ ...binding })
  const racing = withRuntimePluginSource(other, () => f.manager.commands(f.workspace, "stage"))
  const refusal = expect(racing).rejects.toThrow("MODS_RUNTIME_SOURCE_CHANGED")
  release.resolve()
  expect((await replacing).map((row) => row.command)).toEqual(["parent"])
  await refusal
  expect(
    (await withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage"))).map(
      (row) => row.command
    )
  ).toEqual(["parent"])
  expect(f.manager.runtimeSessions().resident).toBe(1)
  expect(f.manager.runtimeSessions().limit).toBe(6)
})

it("keeps separate legitimate executions and refuses a token's foreign workspace", async () => {
  const f = await fixture()
  await withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage"))
  const binding = withRuntimePluginSource(f.token, () => currentRuntimePluginSource()!)
  const next = issueRuntimePluginSourceToken({
    ...binding,
    threadId: "stage-next",
    operationId: "next"
  })
  expect(
    (await withRuntimePluginSource(next, () => f.manager.commands(f.workspace, "stage-next"))).map(
      (row) => row.command
    )
  ).toEqual(["parent"])
  await expect(
    withRuntimePluginSource(f.token, () => f.manager.commands(f.input.plugin.path, "foreign"))
  ).rejects.toThrow("MODS_RUNTIME_SOURCE_CHANGED")
  expect(f.manager.runtimeSessions().resident).toBe(2)
})
