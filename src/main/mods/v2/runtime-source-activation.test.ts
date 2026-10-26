import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { ModControlStore } from "../control-store"
import {
  issueRuntimePluginSourceToken,
  currentRuntimePluginSource,
  withRuntimePluginSource
} from "../../plugins/runtime-source-scope"
import { compileFunctionPlugin } from "./loader"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
  vi.restoreAllMocks()
})
function fixture(mode: "host" | "legacy" = "host") {
  const root = mkdtempSync(join(tmpdir(), "mods-source-scope-"))
  const installed = join(root, "installed"),
    retained = join(root, "retained"),
    workspace = join(root, "workspace")
  mkdirSync(join(installed, "mods"), { recursive: true })
  mkdirSync(workspace)
  writeFileSync(
    join(installed, "plugin.json"),
    JSON.stringify({ name: "package-name", version: "1.0.0", mods: "mods/manifest.json" })
  )
  writeFileSync(
    join(installed, "mods/manifest.json"),
    JSON.stringify({ apiVersion: "cmb.mods/v2", id: "actual-native-id", entry: "main.ts" })
  )
  writeFileSync(
    join(installed, "mods/main.ts"),
    `export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"pinned",description:"Pinned original"});return next(e)});
    on("command.run",{command:"pinned"},async($)=>{await $.tool.call({tool:"read_file",file_path:"fixture.md"});return{text:"original-pinned"}})
  }`
  )
  cpSync(installed, retained, { recursive: true })
  const store = new ModControlStore(join(root, "control.sqlite"))
  let enabled = true,
    authority = true,
    loads = 0,
    contentChecks = 0
  let toolHook: (() => void) | undefined
  const source = { id: "installed-id", name: "package-name", path: installed, enabled: true }
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [source],
      enabled: () => enabled,
      publish: async (_, value) => value,
      changed: () => {},
      callTool: async (workspace, _thread, grant) => {
        expect(store.getGrant(workspace, grant.modId)).toBe(grant)
        store.assertGrant(grant)
        toolHook?.()
        return { text: "scoped native lookup", result: { text: "scoped native lookup" } }
      },
      clawApplicable: () => false
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
          for (const guest of guests) void guest.dispose()
        },
        async stopAndDrain() {
          await Promise.all(guests.map((guest) => guest.dispose()))
        }
      }
    }
  )
  cleanup.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close(),
    () => manager.close()
  )
  const plugin = { ...source, path: retained }
  const token = issueRuntimePluginSourceToken(
    {
      threadId: "stage",
      incarnationKey: "incarnation",
      projectId: "project",
      operationId: "operation",
      workspace,
      packageDigest: "a".repeat(64),
      stageId: "draft",
      mode,
      capabilitySources: [],
      preserveParentContext: true,
      plugin: {
        ...plugin,
        version: "1.0.0",
        description: "",
        author: "",
        skillCount: 1,
        mcpServerCount: 0,
        hookCount: 0,
        createdAt: "2026-10-17T00:00:00Z",
        updatedAt: "2026-10-17T00:00:00Z"
      }
    },
    () => {
      contentChecks++
      if (!authority) throw Error("PROJECT_SCOPE_REVOKED")
    },
    () => {
      if (!authority) throw Error("PROJECT_SCOPE_REVOKED")
    }
  )
  const input = {
    workspace,
    plugin,
    scope: { projectId: "project", packageDigest: "a".repeat(64) }
  }
  return {
    root,
    workspace,
    installed,
    retained,
    store,
    manager,
    source,
    input,
    token,
    loads: () => loads,
    contentChecks: () => contentChecks,
    onTool: (run: () => void) => {
      toolHook = run
    },
    revoke() {
      authority = false
    },
    disable() {
      enabled = false
    }
  }
}

it("uses only native exact project consent for an opaque internal Legacy source", async () => {
  const f = fixture("legacy"), facts = await f.manager.prepareRuntimeSourceFacts(f.input)
  f.store.grant(f.workspace, `function:${facts!.name}`, facts!.digest, true)
  expect(await withRuntimePluginSource(f.token, () => f.manager.runtimeReady(f.workspace, "stage"))).toBe(false)
  await f.manager.approveRuntimeSource({ ...f.input, digest: facts!.digest }, () => {})
  expect((await withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage")))[0].command).toBe("pinned")
  const binding = withRuntimePluginSource(f.token, () => currentRuntimePluginSource()!)
  for (const changed of [{ projectId: "other-unit" }, { projectId: "parent" }, { packageDigest: "b".repeat(64) }]) {
    const token = issueRuntimePluginSourceToken({ ...binding, ...changed, threadId: changed.projectId ?? "new-digest" })
    expect(await withRuntimePluginSource(token, () => f.manager.runtimeReady(f.workspace, changed.projectId ?? "new-digest"))).toBe(false)
  }
  f.store.grantProjectFunction(f.workspace, "project", "a".repeat(64), facts!.name, facts!.digest, false)
  await expect(f.manager.commands(f.workspace, "stage")).rejects.toThrow()
  // Unselected original Legacy and external-provider capability scopes keep their ordinary grant semantics.
  for (const variant of ["legacy", "capabilities", "legacy-selected"] as const) {
    const token = issueRuntimePluginSourceToken({ ...binding, mode: variant === "capabilities" ? variant : "legacy", threadId: `ordinary-${variant}`,
      capabilitySources: variant === "legacy" ? undefined : [{ plugin: binding.plugin,
        packageDigest: binding.packageDigest, capability: { id: "external-provider", title: "External provider",
          kind: "skill", usage: "project", entry: "skills/provider/SKILL.md", dependsOn: [] } }] })
    expect(await withRuntimePluginSource(token, () => f.manager.runtimeReady(f.workspace, `ordinary-${variant}`))).toBe(true)
  }
})

it("keeps loaded catalog reads cheap while real tool boundaries revalidate exact bytes before and after awaits", async () => {
  const f = fixture()
  const facts = await f.manager.prepareRuntimeSourceFacts(f.input)
  await f.manager.approveRuntimeSource({ ...f.input, digest: facts!.digest }, () => {})
  const commands = await withRuntimePluginSource(f.token, () =>
    f.manager.commands(f.workspace, "stage")
  )
  const before = f.contentChecks()
  for (let index = 0; index < 25; index++) {
    expect((await f.manager.commands(f.workspace, "stage"))[0].command).toBe("pinned")
  }
  expect(f.contentChecks()).toBe(before)
  f.onTool(() => writeFileSync(join(f.retained, "mods/main.ts"), "export function register(){}"))
  await expect(
    f.manager.runCommand(f.workspace, "stage", commands[0], "", new AbortController().signal)
  ).rejects.toThrow("MODS_CONFIG_SOURCE_CHANGED")
  expect(f.contentChecks()).toBeGreaterThan(before)
})

it("uses the real native identity, one proved compile and no grant or guest during source admission", async () => {
  const f = fixture()
  expect(f.manager.getRuntimeSourceFacts(f.input)).toBeUndefined()
  const facts = await f.manager.prepareRuntimeSourceFacts(f.input)
  expect(facts).toMatchObject({ name: "actual-native-id", digest: expect.any(String) })
  expect(facts?.name).not.toBe(f.input.plugin.name)
  expect(f.manager.getRuntimeSourceFacts(f.input)).toEqual(facts)
  expect(f.loads()).toBe(0)
  expect(f.store.getGrant(f.workspace, "function:actual-native-id")).toBeNull()
  writeFileSync(join(f.retained, "mods/main.ts"), "export function register(){}")
  expect(() => f.manager.getRuntimeSourceFacts(f.input)).toThrow("MODS_CONFIG_SOURCE_CHANGED")
})

it("reuses only the exact retained grant, loads scoped source and guards deferred UI without ALS", async () => {
  const f = fixture()
  const compiled = await compileFunctionPlugin(f.installed)
  const pinned = await compileFunctionPlugin(f.retained)
  f.store.grant(f.workspace, `function:${compiled.name}`, compiled.digest, true)
  if (compiled.digest !== pinned.digest)
    expect((await f.manager.runtimeSourceReview(f.input))?.state).toBe("needs-approval")
  f.store.grantProjectFunction(
    f.workspace,
    "project",
    "a".repeat(64),
    pinned.name,
    pinned.digest,
    true
  )
  // A mutable installation changes after the project was pinned. Its live code must not run.
  writeFileSync(
    join(f.installed, "mods/main.ts"),
    "export function register(){throw Error('MUTABLE_INSTALL_MUST_NOT_RUN')}"
  )
  const commands = await withRuntimePluginSource(f.token, () =>
    f.manager.commands(f.workspace, "stage")
  )
  expect(commands.map((row) => row.command)).toEqual(["pinned"])
  expect(commands[0].digest).toBe(pinned.digest)
  expect((await f.manager.commands(f.workspace, "stage"))[0].command).toBe("pinned")
  expect(
    await f.manager.runCommand(f.workspace, "stage", commands[0], "", new AbortController().signal)
  ).toEqual({ text: "original-pinned" })
  expect(f.store.getGrant(f.workspace, `function:${compiled.name}`)?.digest).toBe(compiled.digest)
  f.revoke()
  await expect(f.manager.commands(f.workspace, "stage")).rejects.toThrow("PROJECT_SCOPE_REVOKED")
})

it("requires explicit native approval in each real preview directory and never borrows the author grant", async () => {
  const f = fixture()
  const facts = await f.manager.prepareRuntimeSourceFacts(f.input)
  f.store.grant(f.root, `function:${facts!.name}`, facts!.digest, true)
  expect((await f.manager.runtimeSourceReview(f.input))?.state).toBe("needs-approval")
  expect(
    await withRuntimePluginSource(f.token, () => f.manager.runtimeReady(f.workspace, "stage"))
  ).toBe(false)
  // Renderer discovery before consent must not pin a false empty graph.
  await withRuntimePluginSource(f.token, async () => {
    expect(await f.manager.commands(f.workspace, "stage")).toEqual([])
    expect(await f.manager.panes(f.workspace, "stage")).toEqual([])
    expect(await f.manager.runtimeReady(f.workspace, "stage")).toBe(false)
  })
  expect(f.loads()).toBe(0)
  await expect(
    f.manager.approveRuntimeSource({ ...f.input, digest: "b".repeat(64) }, () => {})
  ).rejects.toThrow("MODS_APPROVAL_STALE")
  expect(f.loads()).toBe(0)
  await f.manager.approveRuntimeSource({ ...f.input, digest: facts!.digest }, () => {})
  expect((await f.manager.runtimeSourceReview(f.input))?.state).toBe("ready")
  expect(
    (await withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage")))[0]
      .command
  ).toBe("pinned")
  f.store.grantProjectFunction(
    f.workspace,
    "project",
    "a".repeat(64),
    facts!.name,
    facts!.digest,
    false
  )
  await expect(f.manager.commands(f.workspace, "stage")).rejects.toThrow()
})

it("fails approval on source or native authority changes during the original registration probe", async () => {
  const f = fixture()
  const facts = await f.manager.prepareRuntimeSourceFacts(f.input)
  let calls = 0
  await expect(
    f.manager.approveRuntimeSource({ ...f.input, digest: facts!.digest }, () => {
      if (++calls > 2) throw Error("PROJECT_INPUT_CHANGED")
    })
  ).rejects.toThrow("PROJECT_INPUT_CHANGED")
  expect(f.store.getGrant(f.workspace, `function:${facts!.name}`)).toBeNull()
  f.disable()
  expect((await f.manager.runtimeSourceReview(f.input))?.state).toBe("disabled")
})

it("keeps a live project's proved compiler facts when unrelated configuration views evict the bounded cache", async () => {
  const f = fixture(),
    facts = await f.manager.prepareRuntimeSourceFacts(f.input)
  await f.manager.approveRuntimeSource({ ...f.input, digest: facts!.digest }, () => {})
  await withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage"))
  const loads = f.loads()
  for (let index = 0; index < 17; index++) {
    const path = join(f.root, "other-" + index)
    cpSync(f.installed, path, { recursive: true })
    await f.manager.prepareRuntimeSourceFacts({
      workspace: f.workspace,
      plugin: { ...f.source, id: "other-" + index, path }
    })
  }
  expect(f.manager.getRuntimeSourceFacts(f.input)).toEqual(facts)
  expect(f.loads()).toBe(loads)
  writeFileSync(join(f.retained, "mods/main.ts"), "export function register(){}")
  expect(() => f.manager.getRuntimeSourceFacts(f.input)).toThrow("MODS_CONFIG_SOURCE_CHANGED")
})
