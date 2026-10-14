import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserWindow } from "electron"
import { afterEach, expect, it, vi } from "vitest"
import type { PluginMetadata } from "../../types"
import {
  registerAgentRunImplementation,
  startAgentRun,
  type AgentRunDelivery
} from "../../agent/agent-run-service"
import { currentRuntimePluginSource } from "../../plugins/runtime-source-scope"
import { LegacyProjectRuntimeService, type LegacyResolvedThread } from "./legacy-runtime-service"
import { LegacyOperationStore } from "./legacy-operation-store"
import { HostPackageSnapshots } from "./package-snapshots"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import { assertLegacyProjectEntry } from "./legacy-entry-gate"
import { FlowManager } from "../../mods/flows/manager"
import { FlowStore } from "../../mods/flows/store"

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach((run) => run()))
const delivery: AgentRunDelivery = {
  window: {} as BrowserWindow,
  send: vi.fn(),
  isAvailable: () => true
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "legacy-runtime-service-"))
  const workspace = join(root, "MixedCaseWorkspace"),
    pluginRoot = join(root, "installed")
  mkdirSync(workspace)
  mkdirSync(pluginRoot)
  const declaration = hostProjectFixture(workspace).manifest
  declaration.mode = "legacy"
  declaration.stateOwner = "plugin"
  writeFileSync(join(pluginRoot, "devclaw.project-runtime.json"), JSON.stringify(declaration))
  writeFileSync(join(pluginRoot, "plugin.json"), '{"name":"docs","version":"1.0.0"}')
  writeFileSync(join(pluginRoot, "original-script.py"), "original fixed source")
  const plugin = {
    id: "installed",
    name: "docs",
    version: "1.0.0",
    path: pluginRoot,
    enabled: true
  } as PluginMetadata
  const thread: LegacyResolvedThread = {
    projectId: "project",
    featureId: "feature",
    workspace,
    incarnation: "original"
  }
  const store = new LegacyOperationStore(join(root, "operations.sqlite"))
  const assertProjectIdle = vi.fn()
  const service = new LegacyProjectRuntimeService(
    store,
    new HostPackageSnapshots(join(root, "snapshots")),
    {
      resolveThread: (id) => (id === "ordinary" ? undefined : { ...thread }),
      resolvePlugin: async () => plugin,
      assertProjectIdle
    }
  )
  const unregister = service.register()
  cleanups.push(() => {
    unregister()
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { service, store, thread, workspace, pluginRoot, assertProjectIdle }
}

it("leaves unconfigured original threads unchanged and pins opted-in original runs", async () => {
  const setup = fixture()
  const calls = vi.fn()
  registerAgentRunImplementation(async (_request, _delivery, context) => {
    calls(currentRuntimePluginSource())
    if (currentRuntimePluginSource()) {
      const source = currentRuntimePluginSource()!
      expect(source.mode).toBe("legacy")
      expect(readFileSync(join(source.plugin.path, "original-script.py"), "utf8")).toBe(
        "original fixed source"
      )
      assertLegacyProjectEntry("project", "feature", setup.workspace, source)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(currentRuntimePluginSource()).toBe(source)
    }
    context.onRunTerminated?.({ outcome: "success", code: "normal" })
  })
  await (
    await startAgentRun({ threadId: "legacy", message: "ordinary prior to opt-in" }, delivery)
  ).completion
  expect(calls.mock.calls[0][0]).toBeUndefined()
  expect(setup.service.operations("project")).toEqual([])
  await setup.service.enable("project", setup.workspace)
  writeFileSync(join(setup.pluginRoot, "original-script.py"), "changed installation")
  await (
    await startAgentRun(
      { threadId: "legacy", message: "run original Skill", streamRequestId: "one" },
      delivery
    )
  ).completion
  expect(setup.service.operations("project")[0]).toMatchObject({
    status: "succeeded",
    businessStateValidity: "unknown"
  })
  await expect(
    startAgentRun(
      { threadId: "legacy", message: "run original Skill", streamRequestId: "one" },
      delivery
    )
  ).rejects.toThrow("ALREADY_RECORDED")
  expect(() => assertLegacyProjectEntry("project", "feature", setup.workspace, undefined)).toThrow(
    "LEGACY_RUN_ENTRY_REQUIRED"
  )
  expect(() =>
    assertLegacyProjectEntry("unconfigured", "feature", setup.workspace, undefined)
  ).not.toThrow()
  await (
    await startAgentRun({ threadId: "ordinary", message: "unrelated" }, delivery)
  ).completion
  expect(calls.mock.calls.at(-1)?.[0]).toBeUndefined()
})

it("retains unknown scope when original runtime never emits a terminal", async () => {
  const setup = fixture()
  await setup.service.enable("project", setup.workspace)
  registerAgentRunImplementation(async () => {})
  await (
    await startAgentRun(
      { threadId: "legacy", message: "uncertain", streamRequestId: "one" },
      delivery
    )
  ).completion
  expect(setup.service.operations("project")[0].status).toBe("unknown")
  expect(() => setup.service.disable("project")).toThrow("LEGACY_OPERATION_ACTIVE")
  expect(setup.service.get("project")).toBeDefined()
  await expect(
    startAgentRun({ threadId: "legacy", message: "retry", streamRequestId: "two" }, delivery)
  ).rejects.toThrow("LEGACY_OPERATION_ACTIVE")
})

it("pins project sessions without inventing a business Feature and preserves history when disabled", async () => {
  const setup = fixture()
  setup.thread.featureId = ""
  await setup.service.enable("project", setup.workspace)
  registerAgentRunImplementation(async (_request, _delivery, context) => {
    const source = currentRuntimePluginSource()!
    expect(source.featureId).toBe("__project_session__")
    assertLegacyProjectEntry("project", "", setup.workspace, source)
    context.onRunTerminated?.({ outcome: "success", code: "normal" })
  })
  await (
    await startAgentRun({ threadId: "legacy", message: "plan" }, delivery)
  ).completion
  setup.service.disable("project")
  expect(setup.service.get("project")).toBeUndefined()
  expect(setup.service.operations("project")).toHaveLength(1)
  expect(setup.assertProjectIdle).toHaveBeenCalledTimes(2)
  expect(() => assertLegacyProjectEntry("project", "", setup.workspace, undefined)).not.toThrow()
})

it("checks original run leases after asynchronous enable preparation and before disable", async () => {
  const setup = fixture()
  setup.assertProjectIdle.mockImplementation(() => {
    throw Error("original-run-active")
  })
  await expect(setup.service.enable("project", setup.workspace)).rejects.toThrow(
    "original-run-active"
  )
  expect(setup.service.get("project")).toBeUndefined()
  setup.assertProjectIdle.mockImplementation(() => {})
  await setup.service.enable("project", setup.workspace)
  setup.assertProjectIdle.mockImplementation(() => {
    throw Error("original-run-active")
  })
  expect(() => setup.service.disable("project")).toThrow("original-run-active")
  expect(setup.service.get("project")).toBeDefined()
})

it("holds the same legacy ledger through original Flow execution and disposal", async () => {
  const setup = fixture()
  await setup.service.enable("project", setup.workspace)
  const modsWorkspace =
    process.platform === "win32" ? setup.workspace.toLowerCase() : setup.workspace
  const settings = new Map<string, string>()
  const flows = new FlowStore({
    getSetting: (key, fallback = "") => settings.get(key) ?? fallback,
    setSetting: (key, value) => {
      settings.set(key, value)
    }
  })
  let dispose!: () => void
  const disposed = new Promise<void>((resolve) => {
    dispose = resolve
  })
  const manager = new FlowManager(flows, {
    assertScope: () => {},
    changed: () => {},
    prepare: async () => {
      expect(currentRuntimePluginSource()?.mode).toBe("legacy")
      assertLegacyProjectEntry("project", "feature", modsWorkspace, currentRuntimePluginSource())
      return {
        assertLive: () => {},
        fingerprint: async () => "input",
        execute: async () => ({
          passed: true,
          source: "native-check" as const,
          summary: "checked"
        }),
        finalize: async (_context, confirm) => {
          await confirm()
          return { passed: true, source: "native-check" as const, summary: "original validated" }
        },
        dispose: async () => {
          await disposed
          expect(currentRuntimePluginSource()?.mode).toBe("legacy")
        }
      }
    }
  })
  const saved = flows.save(
    modsWorkspace,
    {
      schemaVersion: 1,
      id: "original",
      name: "Original",
      goal: "Original work",
      plugin: "docs",
      timeoutMs: 10000,
      maxExecutions: 4,
      steps: [{ id: "check", name: "Check", enabled: true, kind: "check", check: "unit-test" }]
    },
    0
  )
  const run = await manager.startSaved(modsWorkspace, "legacy", saved)
  expect(setup.service.operations("project")[0].status).toBe("started")
  expect(() => setup.service.disable("project")).toThrow("LEGACY_OPERATION_ACTIVE")
  dispose()
  await manager.waitForSettlement(modsWorkspace, "legacy", run.id)
  expect(setup.service.operations("project")[0]).toMatchObject({
    status: "succeeded",
    businessStateValidity: "unknown"
  })
})

it.each(["unconfirmed-effect", "negative-receipt"] as const)(
  "classifies original Flow %s without replaying uncertain effects",
  async (mode) => {
    const setup = fixture()
    await setup.service.enable("project", setup.workspace)
    const settings = new Map<string, string>()
    const flows = new FlowStore({
      getSetting: (key, fallback = "") => settings.get(key) ?? fallback,
      setSetting: (key, value) => {
        settings.set(key, value)
      }
    })
    const manager = new FlowManager(flows, {
      assertScope: vi.fn(),
      changed: vi.fn(),
      prepare: async () => ({
        assertLive: vi.fn(),
        fingerprint: async () => "input",
        execute: async () => {
          writeFileSync(join(setup.workspace, "effect.txt"), "real effect before return")
          if (mode === "unconfirmed-effect") throw Error("result transport lost after write")
          return {
            passed: false,
            source: "native-check" as const,
            summary: "confirmed negative receipt"
          }
        },
        finalize: async () => ({
          passed: false,
          source: "native-check" as const,
          summary: "failed"
        }),
        dispose: vi.fn(async () => undefined)
      })
    })
    const saved = flows.save(
      setup.workspace,
      {
        schemaVersion: 1,
        id: "original",
        name: "Original",
        goal: "Original work",
        plugin: "docs",
        timeoutMs: 10000,
        maxExecutions: 4,
        steps: [{ id: "check", name: "Check", kind: "check", check: "unit-test", enabled: true }]
      },
      0
    )
    const run = await manager.startSaved(setup.workspace, "legacy", saved)
    await manager.waitForSettlement(setup.workspace, "legacy", run.id)
    expect(readFileSync(join(setup.workspace, "effect.txt"), "utf8")).toContain("real effect")
    expect(setup.service.operations("project")[0].status).toBe(
      mode === "unconfirmed-effect" ? "unknown" : "failed"
    )
    if (mode === "unconfirmed-effect") {
      await expect(manager.startSaved(setup.workspace, "legacy", saved)).rejects.toThrow(
        "LEGACY_OPERATION_ACTIVE"
      )
      expect(() => setup.service.disable("project")).toThrow("LEGACY_OPERATION_ACTIVE")
    } else {
      setup.service.disable("project")
      expect(setup.service.get("project")).toBeUndefined()
    }
  }
)
