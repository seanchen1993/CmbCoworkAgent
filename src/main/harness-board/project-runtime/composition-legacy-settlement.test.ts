import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import type { PluginMetadata } from "../../types"

const boundary = vi.hoisted(() => ({
  thread: { created_at: 1, metadata: "" },
  finalize: undefined as undefined | ((failure?: unknown) => Promise<void>),
  close: vi.fn(async (): Promise<void> => undefined),
  deferred: true
}))
// Other managed-project operations are irrelevant to this admission's settlement contract.
// Their actual adapter/engine integration is covered separately; no success receipt is supplied.
vi.mock("../service", () => ({}))
vi.mock("../auto-mode-controller", () => ({}))
vi.mock("../managed-run-store", () => ({}))
vi.mock("../human-gate-service", () => ({}))
vi.mock("../notifications", () => ({}))
vi.mock("../biz-retry-service", () => ({}))
vi.mock("../../db", () => ({ getThreadCore: () => boundary.thread }))
vi.mock("../../mcp/capability-service", () => ({
  closeProjectCapabilityMcpService: boundary.close
}))
vi.mock("../../agent/workflow/run-manager", () => ({
  deferOwnedRuntimeWorkflowSettlement: (_token: object, finalize: (failure?: unknown) => Promise<void>) => {
    if (!boundary.deferred) return { deferred: false }
    boundary.finalize = finalize
    return { deferred: true }
  }
}))

import { registerLegacyCompositionAdmission } from "./composition-legacy-production"
import { prepareAgentRunAdmission } from "../../agent/agent-run-admission"
import { registerInternalHarnessProjectProvider, type InternalHarnessProjectContext } from "../internal-project-context"
import { RetainedPackageSnapshots } from "./package-snapshots"
import { createHostProjectInputIdentity } from "./package-input-identity"
import { setProjectActionRuntime } from "../project-action-runtime"
import { FunctionModsManager } from "../../mods/v2/manager"
import { ModControlStore } from "../../mods/control-store"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import { CONTEXT_HANDOFF_PROTOCOL, wrapProjectRuntimeManifest } from "../../../shared/project-runtime"
import { extensionContextStorageKey } from "../extension-context"
import {
  captureRuntimePluginSourceAuthorityGuard,
  captureRuntimePluginSourceContentGuard,
  currentRuntimePluginSource,
  withRuntimePluginSource
} from "../../plugins/runtime-source-scope"
import { projectCheckpointAvailable, registerProjectCheckpointProvider } from "./project-checkpoint"
import { classifyManagedAgentFailure } from "../../agent/managed-agent-failure"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  boundary.close.mockReset().mockResolvedValue(undefined)
  boundary.finalize = undefined
  boundary.deferred = true
})

async function fixture(
  prepare?: (source: string, workspace: string, root: string) => Promise<void>,
  owner: {
    kind?: "creator-business-trial"
    assertCurrent?(): void
    mcp?: boolean
    signal?: AbortSignal
    physical?: Array<{ threadId: string; requestId: string; confirmed?: boolean }>
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "internal-settlement-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const source = join(root, "source"), workspace = join(root, "workspace")
  await mkdir(source)
  await mkdir(workspace)
  await writeFile(join(source, "plugin.json"), JSON.stringify({
    name: "internal-lifecycle", version: "1.0.0",
    ...(owner.mcp === false ? {} : { mcpServers: ".mcp.json" })
  }))
  if (owner.mcp !== false) await writeFile(join(source, ".mcp.json"), '{"mcpServers":{}}')
  await prepare?.(source, workspace, root)
  const retained = new RetainedPackageSnapshots(join(root, "retained")).capture(source)
  const plugin = {
    id: "original-uuid", name: "internal-lifecycle", version: "1.0.0",
    path: retained.root, enabled: true
  } as PluginMetadata
  const projectId = owner.kind === "creator-business-trial"
    ? "creator-business-trial:trial"
    : "composition-legacy:run:unit"
  const current = {
    ...(owner.kind === "creator-business-trial" ? {
      ownerKind: owner.kind, trialId: projectId,
      creatorScope: { threadId: "creator", workspace,
        incarnation: { token: "creator-incarnation", legacyCreatedAt: 1 } },
      onPhysicalStarted: (value: { threadId: string; requestId: string }) =>
        owner.physical?.push({ ...value }),
      onPhysicalSettlement: (value: { threadId: string; requestId: string; confirmed: boolean }) =>
        owner.physical?.push({ ...value })
    } : { parentProjectId: "parent", compositionRunId: "run", unitId: "unit" }),
    featureId: "alpha",
    goal: "actual managed stage", context: { plugin, project: { projectId } },
    featureBinding: { sessionWorkspace: { source: "directory", path: workspace } }
  } as InternalHarnessProjectContext
  boundary.thread = { created_at: 1, metadata: JSON.stringify({
    workspacePath: workspace, harnessFeature: { projectId, slug: "alpha" }
  }) }
  cleanup.push(registerInternalHarnessProjectProvider(() => current, () => () => {
    owner.assertCurrent?.()
  }, undefined, owner.kind))
  cleanup.push(registerLegacyCompositionAdmission())
  const admission = await prepareAgentRunAdmission(
    { threadId: "original-thread", message: "run" },
    { source: "desktop", signal: owner.signal }
  )
  expect(admission).toBeDefined()
  return admission!
}

it("admits an exact creator candidate through the original source guard without composition checkpoint authority", async () => {
  const admission = await fixture(undefined, { kind: "creator-business-trial" })
  cleanup.push(registerProjectCheckpointProvider({
    available: () => true,
    execute: async () => { throw Error("MUST_NOT_EXECUTE_COMPOSITION_CHECKPOINT") }
  }))
  withRuntimePluginSource(admission.context.pluginSourceSnapshot, () => {
    const source = currentRuntimePluginSource()!
    expect(source.projectId).toBe("creator-business-trial:trial")
    expect(source.operationId).toBe("creator-business-trial:trial")
    expect(source.mode).toBe("legacy")
    expect(source.stagePrompt).toBeUndefined()
    expect(projectCheckpointAvailable()).toBe(false)
    expect(captureRuntimePluginSourceContentGuard()).toBeTypeOf("function")
  })
  boundary.deferred = false
  await admission.settle()
  expect(boundary.close).toHaveBeenCalledOnce()
})

it("rechecks the original creator owner before admitting completion or publishing another source operation", async () => {
  let current = true
  const admission = await fixture(undefined, {
    kind: "creator-business-trial",
    assertCurrent: () => { if (!current) throw Error("ORIGINAL_CREATOR_SCOPE_CHANGED") }
  })
  const guard = withRuntimePluginSource(admission.context.pluginSourceSnapshot,
    captureRuntimePluginSourceAuthorityGuard)!
  current = false
  expect(guard).toThrow("ORIGINAL_CREATOR_SCOPE_CHANGED")
  boundary.deferred = false
  await expect(admission.settle()).rejects.toThrow("ORIGINAL_CREATOR_SCOPE_CHANGED")
  expect(boundary.close).toHaveBeenCalledOnce()
})

it("rejects actual retained candidate mutation at the creator content and physical settlement boundaries", async () => {
  const admission = await fixture(undefined, { kind: "creator-business-trial" })
  const captured = withRuntimePluginSource(admission.context.pluginSourceSnapshot, () => ({
    root: currentRuntimePluginSource()!.plugin.path,
    guard: captureRuntimePluginSourceContentGuard()!
  }))
  await writeFile(join(captured.root, "plugin.json"), '{"name":"tampered"}')
  expect(captured.guard).toThrow("PACKAGE_CHANGED")
  boundary.deferred = false
  await expect(admission.settle()).rejects.toThrow("PACKAGE_CHANGED")
  expect(boundary.close).toHaveBeenCalledOnce()
})

it("awaits original owned Workflow settlement even when the candidate has no MCP declaration", async () => {
  const physical: Array<{ threadId: string; requestId: string; confirmed?: boolean }> = []
  const admission = await fixture(undefined, { kind: "creator-business-trial", mcp: false, physical })
  expect(physical).toHaveLength(1)
  expect(physical[0]).toMatchObject({ threadId: "original-thread" })
  expect(physical[0].requestId).toBeTruthy()
  const settling = Promise.resolve(admission.settle())
  await vi.waitFor(() => expect(boundary.finalize).toBeTypeOf("function"))
  const closed = Promise.withResolvers<void>()
  boundary.close.mockImplementationOnce(() => closed.promise)
  const finalize = boundary.finalize!()
  await vi.waitFor(() => expect(boundary.close).toHaveBeenCalledOnce())
  expect(physical).toHaveLength(1)
  closed.resolve()
  await finalize
  await settling
  expect(physical).toEqual([physical[0], { ...physical[0], confirmed: true }])
})

it("does not restore a cancelled runtime token while confirming original cleanup with a current owner", async () => {
  const controller = new AbortController()
  const physical: Array<{ threadId: string; requestId: string; confirmed?: boolean }> = []
  const admission = await fixture(undefined, {
    kind: "creator-business-trial", mcp: false, physical, signal: controller.signal
  })
  const guard = withRuntimePluginSource(admission.context.pluginSourceSnapshot,
    captureRuntimePluginSourceAuthorityGuard)!
  controller.abort(Error("ORIGINAL_NATIVE_CANCELLATION"))
  expect(guard).toThrow("ORIGINAL_NATIVE_CANCELLATION")
  boundary.deferred = false
  await admission.settle()
  expect(physical.at(-1)?.confirmed).toBe(true)
  expect(guard).toThrow("ORIGINAL_NATIVE_CANCELLATION")
})

it("reports unconfirmed physical cleanup without converting it into business success", async () => {
  const physical: Array<{ threadId: string; requestId: string; confirmed?: boolean }> = []
  const admission = await fixture(undefined, { kind: "creator-business-trial", physical })
  boundary.deferred = false
  boundary.close.mockRejectedValueOnce(Error("ACTUAL_PEER_CLOSE_UNCONFIRMED"))
  await expect(admission.settle()).rejects.toThrow("ACTUAL_PEER_CLOSE_UNCONFIRMED")
  expect(physical).toEqual([physical[0], { ...physical[0], confirmed: false }])
})

it("classifies actual native creator-owner revocation as local failure without provider retry", async () => {
  let current = true
  const admission = await fixture(undefined, {
    kind: "creator-business-trial",
    assertCurrent: () => { if (!current) throw Error("BUSINESS_TRIAL_RUNTIME_CHANGED") }
  })
  const guard = withRuntimePluginSource(admission.context.pluginSourceSnapshot,
    captureRuntimePluginSourceAuthorityGuard)!
  current = false
  let failure: unknown
  try { guard() } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(Error)
  expect(classifyManagedAgentFailure(failure)).toBe("unknown")
})

it("keeps the internal business operation pending until original child resource cleanup completes", async () => {
  const admission = await fixture()
  let completed = false
  const settling = admission.settle()!
  const observed = Promise.resolve(settling).then(() => { completed = true })
  await vi.waitFor(() => expect(boundary.finalize).toBeTypeOf("function"))
  expect(completed).toBe(false)
  expect(boundary.close).not.toHaveBeenCalled()
  const actualClose = Promise.withResolvers<void>()
  boundary.close.mockImplementationOnce(() => actualClose.promise)
  const finalized = boundary.finalize!()
  await vi.waitFor(() => expect(boundary.close).toHaveBeenCalledTimes(1))
  expect(completed).toBe(false)
  actualClose.resolve()
  await finalized
  await observed
  expect(completed).toBe(true)
})

it.each(["workflow", "mcp"])("rejects internal business completion on %s cleanup uncertainty", async kind => {
  const admission = await fixture()
  if (kind === "mcp") boundary.close.mockRejectedValueOnce(Error("ACTUAL_CLOSE_UNCONFIRMED"))
  const settling = Promise.resolve(admission.settle())
  // Attach the rejection observer before releasing the deferred lifecycle callback.
  const rejection = expect(settling).rejects.toThrow(kind === "mcp" ? "ACTUAL_CLOSE_UNCONFIRMED" : "WORKFLOW_CLEANUP_UNCONFIRMED")
  await vi.waitFor(() => expect(boundary.finalize).toBeTypeOf("function"))
  await expect(boundary.finalize!(kind === "workflow" ? Error("WORKFLOW_CLEANUP_UNCONFIRMED") : undefined)).rejects.toThrow()
  await rejection
  expect(boundary.close).toHaveBeenCalledTimes(1)
})

it("awaits the original close directly when there is no owned background entry", async () => {
  const admission = await fixture()
  boundary.deferred = false
  const actualClose = Promise.withResolvers<void>()
  boundary.close.mockImplementationOnce(() => actualClose.promise)
  let completed = false
  const settling = Promise.resolve(admission.settle()).then(() => { completed = true })
  await vi.waitFor(() => expect(boundary.close).toHaveBeenCalledTimes(1))
  expect(completed).toBe(false)
  actualClose.resolve()
  await settling
  expect(completed).toBe(true)
})

it.each(["knowledge", "units"])(
  "rejects changed real %s at internal admission content and final settlement boundaries",
  async change => {
    let knowledgeFile = "", configurationFile = ""
    const admission = await fixture(async (source, workspace, root) => {
      const context = {
        sourceAccess: "read-only" as const, mutableData: "host" as const,
        configuration: "host-resolved" as const, knowledge: { required: true },
        provider: { entry: "context-provider.py", operations: ["session-context" as const] }
      }
      const manifest = {
        ...hostProjectFixture(workspace).manifest,
        plugin: { id: "internal-lifecycle", version: "1.0.0" },
        mode: "legacy" as const, stateOwner: "plugin" as const, stages: []
      }
      const board = Buffer.from('{"apiVersion":2,"supported_deploy_units":["default"]}')
      await mkdir(join(source, "board_core"))
      await writeFile(join(source, "board_core/board_config.json"), board)
      await writeFile(join(source, "context-provider.py"), "# original plugin provider")
      await writeFile(join(source, "devclaw.project-runtime.json"), JSON.stringify(
        wrapProjectRuntimeManifest(manifest, {
          apiVersion: "devclaw.extension-contract/v1", requires: [CONTEXT_HANDOFF_PROTOCOL], context
        })
      ))
      const dataRoot = join(root, "data")
      const key = extensionContextStorageKey(
        { name: "internal-lifecycle", version: "1.0.0" }, board, context
      )
      await mkdir(join(dataRoot, key, "knowledge"), { recursive: true })
      knowledgeFile = join(dataRoot, key, "knowledge", "domain.md")
      configurationFile = join(dataRoot, key, "board_config.json")
      await writeFile(knowledgeFile, "original knowledge")
      const store = new ModControlStore(join(root, "control.sqlite"))
      const functions = new FunctionModsManager(store, {
        plugins: () => [], enabled: () => false, changed: () => {},
        publish: async (_workspace, value) => value
      })
      cleanup.push(() => store.close(), () => functions.close())
      const inputs = createHostProjectInputIdentity(functions, {
        contextDataRoot: dataRoot, rules: () => []
      })
      setProjectActionRuntime({
        ...inputs, catalog: async () => [], prepareSelection: async () => {},
        flows: { startSaved: vi.fn(), waitForSettlement: vi.fn(), run: vi.fn(), cancel: vi.fn() }
      })
    })
    const guards = withRuntimePluginSource(admission.context.pluginSourceSnapshot, () => ({
      authority: captureRuntimePluginSourceAuthorityGuard(),
      content: captureRuntimePluginSourceContentGuard()
    }))
    expect(guards.content).toBeTypeOf("function")
    if (change === "knowledge") await writeFile(knowledgeFile, "changed knowledge")
    else await writeFile(configurationFile, '{"supported_deploy_units":["warehouse"]}')
    expect(() => guards.authority!()).not.toThrow()
    expect(() => guards.content!()).toThrow("COMPOSITION_CONTEXT_INPUT_CHANGED")
    boundary.deferred = false
    await expect(admission.settle()).rejects.toThrow("COMPOSITION_CONTEXT_INPUT_CHANGED")
    expect(boundary.close).toHaveBeenCalledOnce()
  }
)
