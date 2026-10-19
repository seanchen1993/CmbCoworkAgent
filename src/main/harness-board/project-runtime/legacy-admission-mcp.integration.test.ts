import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { setImmediate as tick } from "node:timers/promises"
import { afterEach, expect, it, vi } from "vitest"
import { AIMessage } from "@langchain/core/messages"
import type { BrowserWindow } from "electron"
import type { PluginMetadata } from "../../types"
import type { McpCapabilityService } from "../../mcp/capability-types"

// Persistence is isolated. The original declaration validator, token, native authorization
// adapter, SDK transports, actual peer processes and close implementation remain real.
const storage = vi.hoisted(() => ({ root: "", plugins: [] as PluginMetadata[] }))
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "cmb-test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: () => [] },
  ipcMain: {
    handle: () => {
      /* No renderer is attached to this actual background runner. */
    },
    on: () => {
      /* Native events are exercised by separate IPC tests. */
    }
  }
}))
vi.mock("../../storage", async (original) => ({
  ...(await original<typeof import("../../storage")>()),
  getOpenworkDir: () => storage.root,
  getPlugins: () => storage.plugins,
  getEnabledMcpConnectors: () => [],
  getUserInfo: () => ({}),
  parseMcpJsonFile: (path: string) =>
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).mcpServers : null
}))
vi.mock("../../services/subagent-session-capture", () => ({
  withSubagentSessionCapture: (_context: unknown, _label: string, run: () => Promise<unknown>) =>
    run(),
  subagentSessionCallbacks: () => []
}))
vi.mock("../../services/adoption-tracker", () => ({ setAdoptionContext: vi.fn() }))

import { createProjectTemplate } from "../../mods/devtools/project-template"
import { LegacyOperationStore } from "./legacy-operation-store"
import { HostPackageSnapshots } from "./package-snapshots"
import { LegacyProjectRuntimeService } from "./legacy-runtime-service"
import {
  registerAgentRunImplementation,
  startAgentRun,
  settleAgentFunctionTurn,
  type AgentRunDelivery,
  type AgentRunExecutionContext,
  type AgentRunTerminal
} from "../../agent/agent-run-service"
import {
  currentRuntimePluginSource,
  captureRuntimePluginSourceToken,
  captureRuntimePluginSourceContentGuard,
  type RuntimePluginSourceToken
} from "../../plugins/runtime-source-scope"
import {
  getProjectMcpCapabilityService,
  getGlobalMcpCapabilityService,
  closeGlobalMcpCapabilityService,
  closeProjectCapabilityMcpService
} from "../../mcp/capability-service"
import { modCallContext } from "../../mods/context"
import { workflowRunManager } from "../../agent/workflow/run-manager"
import { validateWorkflowScript } from "../../agent/workflow/script"
import { registerProjectCapabilityRunAdmission } from "../../agent/agent-run-admission"
import { ProjectCapabilityRuntimeService } from "../../plugins/project-capability-runtime"
import { dispatchManagedTurnObservation } from "../managed-turn-dispatch"
import { executeRemoteStandardTurnOnDesktopRunBody } from "../../services/im/desktop-run-bridge"
import { ImGoalRunBridge } from "../../services/im/goal-runner"
import { createFunctionPluginPromptHost } from "../../mods/v2/plugin-prompt-host"
import * as database from "../../db"
import { goalManager } from "../../agent/goals/runtime"
import { FunctionTurnLifecycle } from "../../mods/v2/turn-lifecycle"
import {
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  onLocalThreadRunLeaseReleased,
  releaseLocalThreadRunLease
} from "../../agent/thread-run-lease"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  await closeGlobalMcpCapabilityService()
  for (const close of cleanup.splice(0).reverse()) await close()
  storage.plugins = []
})
const delivery: AgentRunDelivery = {
  window: {} as BrowserWindow,
  send: () => undefined,
  isAvailable: () => true
}

it("dispatches the next native managed observation outside the settled original Legacy turn token", async () => {
  const f = await fixture()
  await f.service.enable(f.projectId, f.workspace)
  let release!: () => void
  const completed = new Promise<void>((resolve) => {
    release = resolve
  })
  let observed!: () => void
  let rejected!: (error: unknown) => void
  const observation = new Promise<void>((resolve, reject) => {
    observed = resolve
    rejected = reject
  })
  let previousToken: RuntimePluginSourceToken | undefined
  const staleObservation = new Promise<unknown>((resolve) => {
    void f
      .start(async () => {
        previousToken = captureRuntimePluginSourceToken()
        setImmediate(() => {
          void completed.then(() => {
            try {
              currentRuntimePluginSource()
              resolve(undefined)
            } catch (error) {
              resolve(error)
            }
          })
        })
        dispatchManagedTurnObservation(async () => {
          await completed
          expect(currentRuntimePluginSource()).toBeUndefined()
          expect(f.service.operations(f.projectId)).toHaveLength(1)
          expect(f.service.operations(f.projectId)[0].status).toBe("succeeded")
          await f.start(async () => {
            expect(currentRuntimePluginSource()?.mode).toBe("legacy")
            expect(captureRuntimePluginSourceToken()).not.toBe(previousToken)
          })
          observed()
        }, rejected)
      })
      .then(release, rejected)
  })
  await observation
  expect(await staleObservation).toMatchObject({ message: "PROJECT_HOST_LEGACY_RUN_SCOPE_CHANGED" })
  expect(f.service.operations(f.projectId).map((operation) => operation.status)).toEqual([
    "succeeded",
    "succeeded"
  ])
})
async function fixture(authority = true, selected = false, original = true) {
  const root = await mkdtemp(join(tmpdir(), "legacy-owned-mcp-"))
  storage.root = root
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const source = join(root, "installed"),
    workspace = join(root, "workspace")
  await mkdir(source)
  await mkdir(workspace)
  const declaration = JSON.parse(
    createProjectTemplate({ packageId: "owned-mcp", name: "Owned MCP" }).files.find(
      (file) => file.path === "devclaw.project-runtime.json"
    )!.text
  )
  declaration.mode = "legacy"
  declaration.stateOwner = "plugin"
  await writeFile(join(source, "devclaw.project-runtime.json"), JSON.stringify(declaration))
  await writeFile(
    join(source, "plugin.json"),
    JSON.stringify({
      name: "owned-mcp",
      version: "0.1.0",
      mcpServers: ".mcp.json"
    })
  )
  await cp(resolve("tests/support/project-package-mcp-server.mjs"), join(source, "server.mjs"))
  const journal = join(root, "calls.jsonl")
  await writeFile(
    join(source, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        parent: {
          command: process.execPath,
          args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs", journal, "pinned"]
        }
      }
    })
  )
  const plugin = {
    id: randomUUID(),
    name: "owned-mcp",
    version: "0.1.0",
    path: source,
    enabled: true,
    mcpServerCount: 0
  } as PluginMetadata
  // Neither an unrelated normal plugin nor a derived plugin may join this legacy MCP scope.
  storage.plugins = [
    plugin,
    { ...plugin, id: "unrelated", name: "unrelated", mcpServerCount: 1 },
    { ...plugin, id: "derived-unselected", name: "unselected", mcpServerCount: 1 }
  ]
  const projectId = randomUUID(),
    threadId = randomUUID()
  let adapterId = plugin.id
  const counts = { authority: 0, binding: 0 }
  const store = new LegacyOperationStore(join(root, "operations.sqlite"))
  cleanup.push(() => store.close())
  const snapshots = new HostPackageSnapshots(join(root, "snapshots"))
  const service = new LegacyProjectRuntimeService(store, snapshots, {
    resolveThread: (id) =>
      id === threadId
        ? { projectId, featureId: "alpha", workspace, incarnation: "original" }
        : undefined,
    resolvePlugin: async () => storage.plugins.find((item) => item.id === adapterId)!,
    assertProjectIdle: () => undefined,
    ...(authority
      ? {
          assertInstalledSourceCurrent: (id: string, directory: string, uuid: string) => {
            counts.authority++
            if (
              id !== projectId ||
              directory !== workspace ||
              !storage.plugins.some((item) => item.id === uuid && item.enabled)
            )
              throw Error("ORIGINAL_PLUGIN_UNAVAILABLE")
          },
          assertProjectBindingCurrent: (id: string, directory: string, uuid: string) => {
            counts.binding++
            if (id !== projectId || directory !== workspace || adapterId !== uuid)
              throw Error("ORIGINAL_PROJECT_BINDING_CHANGED")
          }
        }
      : {})
  })
  const terminals: AgentRunTerminal[] = []
  if (original) cleanup.push(service.register())
  if (selected) {
    const assertSelected = () => {
      if (!storage.plugins.some((item) => item.id === plugin.id && item.enabled))
        throw Error("ORIGINAL_PLUGIN_UNAVAILABLE")
    }
    const selectedService = new ProjectCapabilityRuntimeService(join(root, "selected-packages"), {
      getPlugin: (id) => storage.plugins.find((item) => item.id === id),
      assertCurrent: assertSelected
    })
    cleanup.push(
      registerProjectCapabilityRunAdmission(async (_request, context) => {
        const parentPlugin = await selectedService.retainParentPluginAsync(plugin)
        const selectedToken = selectedService.issue(
          {
            threadId,
            incarnationKey: "original",
            projectId,
            workspace,
            operationId: randomUUID(),
            sources: [],
            parentPlugin
          },
          assertSelected,
          context.pluginSourceSnapshot
        )
        return {
          context: {
            ...context,
            pluginSourceSnapshot: selectedToken,
            ...(!original
              ? {
                  onRunTerminated: (terminal: AgentRunTerminal) => {
                    terminals.push(terminal)
                    context.onRunTerminated?.(terminal)
                  }
                }
              : {})
          },
          settle: () => closeProjectCapabilityMcpService(selectedToken)
        }
      })
    )
  }
  let scoped: McpCapabilityService | undefined, token: RuntimePluginSourceToken | undefined
  const registerBody = (
    body: (mcp: McpCapabilityService, context: AgentRunExecutionContext) => Promise<void>
  ) => {
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      const source = currentRuntimePluginSource()!
      expect(source.mode).toBe(original ? "legacy" : "capabilities")
      if (selected) expect(source.capabilitySources).toEqual([])
      else expect(source.capabilitySources).toBeUndefined()
      token = captureRuntimePluginSourceToken()!
      scoped = getProjectMcpCapabilityService(plugin.id)
      await body(scoped, context)
      context.onRunTerminated?.({ outcome: "success", code: "real_peer_body_complete" })
    })
  }
  const start = async (
    body: (mcp: McpCapabilityService, context: AgentRunExecutionContext) => Promise<void>,
    context: AgentRunExecutionContext = { source: "desktop" }
  ) => {
    registerBody(body)
    await (
      await startAgentRun(
        { threadId, message: "Call this package's MCP", streamRequestId: randomUUID() },
        delivery,
        context
      )
    ).completion
  }
  // Use the real final-input authorization adapter with a controlled native decision.
  const invoke = (
    mcp: McpCapabilityService,
    id: string,
    text: string,
    authorize: () => Promise<void> = async () => undefined
  ) =>
    modCallContext.run(
      {
        identity: {
          workspace,
          threadId,
          turnId: "actual-physical-run",
          agentId: "main",
          callId: randomUUID(),
          origin: "model",
          grantEpoch: 0
        },
        toolId: `mcp:${id}`,
        routeClaimed: false,
        protectedOutput: false,
        readOnly: false,
        authorize: async (_target, args) => {
          expect(args).toEqual({ text })
          await authorize()
        }
      },
      () => mcp.invoke(id, { text })
    )
  const rows = () =>
    readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { pid: number; source: string; revision: string; text: string }
      )
  return {
    root,
    source,
    workspace,
    plugin,
    projectId,
    threadId,
    service,
    snapshots,
    start,
    registerBody,
    invoke,
    journal,
    rows,
    counts,
    terminals,
    scoped: () => scoped!,
    token: () => token!,
    rebind: () => {
      adapterId = "unrelated"
    }
  }
}

it("requires current original source authority before admitting a no-Mod legacy MCP package", async () => {
  const f = await fixture(false)
  await expect(f.service.enable(f.projectId, f.workspace)).rejects.toThrow(
    "LEGACY_MCP_SOURCE_AUTHORITY_REQUIRED"
  )
  expect(f.service.get(f.projectId)).toBeUndefined()
  expect(existsSync(f.journal)).toBe(false)
})

it.each(["complete", "cancel", "source-change", "revoke", "observer-error", "unjoined"] as const)(
  "settles the exact actual Legacy logical turn before its original source owner: %s",
  async (outcome) => {
    const f = await fixture()
    await f.service.enable(f.projectId, f.workspace)
    const entered = Promise.withResolvers<void>(),
      publish = Promise.withResolvers<void>()
    const notices: string[] = [],
      errors: unknown[] = []
    let lifecycle: FunctionTurnLifecycle | undefined
    let captured: Promise<void> | undefined
    const runId = randomUUID(),
      controller = new AbortController()
    let physicalComplete = false
    const pending = f.start(async (_mcp, context) => {
      const assertSource = captureRuntimePluginSourceContentGuard()!
      lifecycle = new FunctionTurnLifecycle({
        start: async () => {},
        complete: async (_binding, input) => {
          entered.resolve()
          await publish.promise
          assertSource()
          if (outcome === "observer-error") throw Error("OPTIONAL_OBSERVER_FAILED")
          notices.push(input.reason)
        },
        isBusy: (threadId) => !!getLocalThreadRunLease(threadId),
        onIdle: (listener) => onLocalThreadRunLeaseReleased((lease) => listener(lease.threadId)),
        error: (error) => errors.push(error)
      })
      expect(
        claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId }).acquired
      ).toBe(true)
      await lifecycle.start({
        workspace: f.workspace,
        threadId: f.threadId,
        runId,
        turnId: runId,
        text: "Actual original managed turn",
        signal: controller.signal,
        cancel: () => controller.abort(),
        assertCurrent: () => {
          if (getLocalThreadRunLease(f.threadId)?.runId !== runId)
            throw Error("MODS_CALL_SCOPE_CHANGED")
        }
      })
      captured = lifecycle.captureSettlement(f.threadId, runId)
      expect(captured).toBeDefined()
      // The actual native body already reported its business outcome. A later source
      // settlement failure must outrank that success in the original operation ledger.
      context.onRunTerminated?.({ outcome: "success", code: "real_business_complete" })
      if (outcome === "cancel") {
        controller.abort()
        context.onRunCancelled?.()
      }
      lifecycle.finish(f.threadId, runId, { reason: "answer" })
      releaseLocalThreadRunLease(f.threadId, "desktop", runId)
      physicalComplete = true
      if (outcome !== "unjoined") await settleAgentFunctionTurn(captured)
    })
    void pending.catch(() => {})
    try {
      await entered.promise
      expect(physicalComplete).toBe(true)
      expect(getLocalThreadRunLease(f.threadId)).toBeUndefined()
      expect(notices).toEqual([])
      if (outcome === "unjoined") {
        // Preserve the real pre-fix race: without joining logical publication, the
        // original MCP owner is already terminal when the held observer resumes.
        await pending
        expect(f.service.operations(f.projectId)[0].status).toBe("succeeded")
      } else expect(f.service.operations(f.projectId)[0].status).toBe("started")
      if (outcome === "source-change") {
        const binding = f.service.get(f.projectId)!
        const retained = f.snapshots.read(binding.packageDigest)
        await writeFile(
          join(retained.root, "plugin-source-changed.txt"),
          "changed during publication"
        )
      }
      if (outcome === "revoke")
        storage.plugins.find((plugin) => plugin.id === f.plugin.id)!.enabled = false
      publish.resolve()
      if (outcome === "source-change") {
        await expect(pending).rejects.toThrow("Function turn settlement could not confirm")
        expect(f.service.operations(f.projectId)[0].status).toBe("unknown")
        expect(notices).toEqual([])
        expect(errors).toHaveLength(1)
      } else if (outcome === "revoke") {
        // This fixture's original source authority throws its own explicit
        // fixture error; the real Legacy finalizer still refuses success.
        await pending
        expect(f.service.operations(f.projectId)[0].status).toBe("unknown")
        expect(notices).toEqual([])
        expect(errors).toHaveLength(1)
        expect(errors[0]).toMatchObject({ message: "ORIGINAL_PLUGIN_UNAVAILABLE" })
      } else if (outcome === "unjoined") {
        await expect(captured).rejects.toThrow("PROJECT_HOST_LEGACY_RUN_SCOPE_CHANGED")
        expect(notices).toEqual([])
        expect(errors).toHaveLength(1)
      } else {
        await pending
        expect(f.service.operations(f.projectId)[0].status).toBe(
          outcome === "cancel" ? "cancelled" : "succeeded"
        )
        expect(notices).toEqual(
          outcome === "observer-error" ? [] : [outcome === "cancel" ? "aborted" : "answer"]
        )
        expect(errors).toHaveLength(outcome === "observer-error" ? 1 : 0)
      }
      await tick()
      expect(lifecycle!.stats).toEqual({ entries: 0, running: 0 })
    } finally {
      publish.resolve()
      await pending.catch(() => {})
      lifecycle?.close()
      releaseLocalThreadRunLease(f.threadId, "desktop", runId)
    }
  }
)

function externalLogicalTurn(f: Awaited<ReturnType<typeof fixture>>) {
  const publishing = Promise.withResolvers<void>(),
    publish = Promise.withResolvers<void>()
  const bodyFinished = Promise.withResolvers<void>(),
    notices: string[] = [],
    errors: unknown[] = []
  let assertSource: (() => void) | undefined,
    pid = 0
  const lifecycle = new FunctionTurnLifecycle({
    start: async () => {},
    complete: async (_binding, input) => {
      publishing.resolve()
      await publish.promise
      assertSource!()
      notices.push(input.turnId)
    },
    isBusy: (threadId) => !!getLocalThreadRunLease(threadId),
    onIdle: (listener) => onLocalThreadRunLeaseReleased((lease) => listener(lease.threadId)),
    error: (error) => errors.push(error)
  })
  cleanup.push(() => {
    publish.resolve()
    lifecycle.close()
  })
  f.registerBody(async (mcp, context) => {
    const lease = context.localRunLease!
    expect(lease.managedExternally).toBe(true)
    expect(context.deferSourceSettlement).toBe(true)
    assertSource = captureRuntimePluginSourceContentGuard()!
    const tools = await mcp.listTools()
    await f.invoke(mcp, tools[0].capabilityId, "actual-external-body")
    pid = f.rows()[0].pid
    await lifecycle.start({
      workspace: f.workspace,
      threadId: f.threadId,
      runId: lease.runId,
      turnId: lease.runId,
      text: "actual external turn",
      signal: context.signal ?? new AbortController().signal,
      cancel: () => {},
      assertCurrent: () => {
        if (getLocalThreadRunLease(f.threadId)?.runId !== lease.runId)
          throw Error("MODS_CALL_SCOPE_CHANGED")
      }
    })
    context.pluginPrompt?.started()
    const owner = lifecycle.captureSettlementOwner(f.threadId, lease.runId)!
    lifecycle.finish(f.threadId, lease.runId, { reason: "answer" })
    context.onFunctionTurnSettlement?.(owner.settlement, owner.invalidate)
    await context.onFinalAssistant?.({
      messageId: "actual-reply",
      finalText: "actual durable reply"
    })
    bodyFinished.resolve()
  })
  return { lifecycle, publishing, publish, bodyFinished, notices, errors, pid: () => pid }
}

it.each([
  ["im", false],
  ["goal", false],
  ["im", true],
  ["goal", true]
] as const)(
  "keeps actual Legacy MCP alive through the original %s bridge until external release (changed=%s)",
  async (owner, changed) => {
    const f = await fixture()
    await f.service.enable(f.projectId, f.workspace)
    const run = externalLogicalTurn(f),
      runId = randomUUID()
    expect(claimLocalThreadRunLease({ threadId: f.threadId, owner: "im", runId }).acquired).toBe(
      true
    )
    let sourceSettlement: Promise<void> | undefined
    const onSourceSettlement = (settlement: Promise<void>) => {
      sourceSettlement = settlement
    }
    const signal = new AbortController().signal
    try {
      const reply =
        owner === "im"
          ? await executeRemoteStandardTurnOnDesktopRunBody(
              {
                rawMessage: "actual remote task",
                userMessageId: randomUUID(),
                threadId: f.threadId,
                targetKind: "feature",
                metadata: {},
                workspacePath: f.workspace,
                runId,
                runOwner: "im",
                source: "im",
                routingTaskSource: "chat",
                signal,
                onSourceSettlement
              },
              {
                startRun: startAgentRun,
                getDelivery: () => delivery,
                announceUserMessage: () => {}
              }
            )
          : await new ImGoalRunBridge({
              startRun: startAgentRun,
              getDelivery: () => delivery,
              announceUserMessage: () => {},
              hasActiveGoal: () => true
            }).run({
              threadId: f.threadId,
              target: {
                kind: "thread",
                targetId: f.threadId,
                threadId: f.threadId,
                title: "Actual remote goal",
                workspacePath: f.workspace,
                grantId: randomUUID(),
                grantVersion: 1
              },
              metadata: {},
              prepared: { kind: "ordinary", visibleText: "actual remote goal" },
              runId,
              signal,
              userMessageId: randomUUID(),
              agentMode: "normal",
              onSourceSettlement
            })
      expect(reply).toBe("actual durable reply")
      expect(sourceSettlement).toBeDefined()
      expect(getLocalThreadRunLease(f.threadId)).toMatchObject({ owner: "im", runId })
      expect(f.service.operations(f.projectId)[0].status).toBe("started")
      expect(() => process.kill(run.pid(), 0)).not.toThrow()
      expect(run.notices).toEqual([])
      // The actual remote-runner durable reply/outbox remains before this owner release.
      releaseLocalThreadRunLease(f.threadId, "im", runId)
      await run.publishing.promise
      if (changed) {
        const retained = f.snapshots.read(f.service.get(f.projectId)!.packageDigest)
        await writeFile(join(retained.root, "changed-after-durable-reply.txt"), "changed")
      }
      run.publish.resolve()
      if (changed) {
        await expect(sourceSettlement).rejects.toThrow("Function turn settlement could not confirm")
        expect(run.notices).toEqual([])
        expect(run.errors).toHaveLength(1)
        expect(f.service.operations(f.projectId)[0].status).toBe("unknown")
      } else {
        await sourceSettlement
        expect(run.notices).toEqual([runId])
        expect(run.errors).toEqual([])
        expect(f.service.operations(f.projectId)[0].status).toBe("succeeded")
      }
      await vi.waitFor(() => expect(() => process.kill(run.pid(), 0)).toThrow(), { timeout: 5000 })
    } finally {
      releaseLocalThreadRunLease(f.threadId, "im", runId)
      run.publish.resolve()
      await sourceSettlement?.catch(() => {})
    }
  }
)

it.each([false, true, "aba"] as const)(
  "the actual prompt queue releases before exact source settlement (changed=%s)",
  async (changed) => {
    const f = await fixture()
    await f.service.enable(f.projectId, f.workspace)
    const run = externalLogicalTurn(f)
    const row = vi
      .spyOn(database, "getThreadCore")
      .mockReturnValue({
        thread_id: f.threadId,
        created_at: 1,
        updated_at: 1,
        title: "actual external prompt",
        status: "idle",
        metadata: JSON.stringify({ workspacePath: f.workspace, agentMode: "normal" })
      })
    const goal = vi.spyOn(goalManager, "get").mockReturnValue(null)
    const warning = vi.spyOn(console, "error").mockImplementation(() => {})
    const queue = createFunctionPluginPromptHost(
      { workspaceKey: (path) => path, isEnabled: () => true, functionTurns: run.lifecycle },
      (workspace, threadId) => {
        expect(workspace).toBe(f.workspace)
        expect(threadId).toBe(f.threadId)
      }
    )
    let replacementRunId: string | undefined
    try {
      const ticket = queue.reserve(
        f.workspace,
        f.threadId,
        { kind: "plugin", name: "actual" },
        new AbortController().signal,
        () => {}
      )
      const accepted = ticket.accept({
        text: "actual prompt",
        origin: { kind: "plugin", name: "actual" },
        wait: false
      })
      ticket.finish(accepted)
      await expect(ticket.wait()).resolves.toMatchObject({ text: "actual prompt" })
      if (changed === "aba") {
        const original = getLocalThreadRunLease(f.threadId)!
        replacementRunId = original.runId
        releaseLocalThreadRunLease(f.threadId, "mods", original.runId)
        expect(
          claimLocalThreadRunLease({ threadId: f.threadId, owner: "mods", runId: original.runId })
            .acquired
        ).toBe(true)
      } else {
        await run.publishing.promise
        expect(getLocalThreadRunLease(f.threadId)).toBeUndefined()
        expect(f.service.operations(f.projectId)[0].status).toBe("started")
        expect(() => process.kill(run.pid(), 0)).not.toThrow()
      }
      if (changed === true) {
        const retained = f.snapshots.read(f.service.get(f.projectId)!.packageDigest)
        await writeFile(join(retained.root, "changed-before-observer.txt"), "changed")
      }
      if (changed !== "aba") run.publish.resolve()
      await vi.waitFor(() =>
        expect(f.service.operations(f.projectId)[0].status).toBe(changed ? "unknown" : "succeeded")
      )
      await vi.waitFor(() => expect(() => process.kill(run.pid(), 0)).toThrow(), { timeout: 5000 })
      if (changed) {
        await vi.waitFor(() =>
          expect(warning).toHaveBeenCalledWith(
            "[Mods] Plugin prompt cleanup failed:",
            expect.any(Error)
          )
        )
        expect(run.notices).toEqual([])
        if (changed === "aba")
          expect(getLocalThreadRunLease(f.threadId)).toMatchObject({
            owner: "mods",
            runId: replacementRunId
          })
      } else {
        expect(run.notices).toHaveLength(1)
        expect(warning).not.toHaveBeenCalled()
      }
    } finally {
      run.publish.resolve()
      if (replacementRunId) releaseLocalThreadRunLease(f.threadId, "mods", replacementRunId)
      queue.close()
      row.mockRestore()
      goal.mockRestore()
      warning.mockRestore()
    }
  }
)

it("calls only the retained parent through actual native approval and closes it after the physical run", async () => {
  const f = await fixture()
  await f.service.enable(f.projectId, f.workspace)
  const ordinary = getGlobalMcpCapabilityService()
  let pid = 0
  await f.start(async (mcp) => {
    expect(mcp).not.toBe(ordinary)
    const tools = await mcp.listTools()
    expect(tools).toHaveLength(1)
    expect(tools[0].pluginId).toBe(f.plugin.id)
    const native = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>()
    const pending = f.invoke(mcp, tools[0].capabilityId, "real-approval", async () => {
      entered.resolve()
      await native.promise
    })
    await entered.promise
    expect(existsSync(f.journal)).toBe(false) // readOnlyHint never replaces native approval.
    const updated = join(f.root, "new-installation")
    await cp(f.source, updated, { recursive: true })
    await writeFile(join(updated, ".mcp.json"), '{"mcpServers":{}}')
    f.plugin.path = updated
    f.plugin.mcpServerCount = 0
    native.resolve()
    expect((await pending).text).toContain("pinned:real-approval")
    expect((await f.invoke(mcp, tools[0].capabilityId, "still-pinned")).text).toContain(
      "pinned:still-pinned"
    )
    const records = f.rows()
    pid = records[0].pid
    expect(records).toHaveLength(2)
    expect(
      records.every((row) => decodeURIComponent(row.source).includes("/package/server.mjs"))
    ).toBe(true)
    expect(records.every((row) => row.revision === "pinned")).toBe(true)
  })
  expect(f.service.operations(f.projectId)[0].status).toBe("succeeded")
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 })
  await expect(f.scoped().listTools()).rejects.toThrow("MODS_MCP_SERVICE_CLOSED")
  expect(getGlobalMcpCapabilityService()).toBe(ordinary)
}, 30_000)

it.each(
  [
    { selected: false, original: true },
    { selected: true, original: true },
    { selected: true, original: false }
  ].flatMap((owner) =>
    (["complete", "fail", "fast-fail", "uninstall", "cancel"] as const).map((outcome) => ({
      ...owner,
      outcome
    }))
  )
)(
  "keeps the real package peer until physical $outcome settlement (selected=$selected, original=$original)",
  async ({ outcome, selected, original }) => {
    const f = await fixture(true, selected, original)
    await f.service.enable(f.projectId, f.workspace)
    const started = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const childDone = Promise.withResolvers<void>()
    let runId = "",
      pid = 0
    cleanup.push(async () => {
      release.resolve()
      await workflowRunManager.cancelAndWait(f.threadId)
    })
    await f.start(async (mcp) => {
      const [tool] = await mcp.listTools()
      await f.invoke(mcp, tool.capabilityId, "foreground")
      pid = f.rows()[0].pid
      await workflowRunManager.prepareLaunch(f.workspace, f.threadId)
      runId = `wf_${randomUUID().replaceAll("-", "").slice(0, 12)}`
      const script =
        'export const meta={name:"owned MCP",description:"actual background lifecycle"}\nreturn await agent("task")'
      const launch = workflowRunManager.launch({
        threadId: f.threadId,
        workspacePath: f.workspace,
        runId,
        parsed: validateWorkflowScript(script),
        script,
        scriptSha256: "b".repeat(64),
        subagentDeps: {
          parentThreadId: f.threadId,
          isRetryableApiError: () => false,
          cleanupThread: async () => {
            /* The controlled model seam has no DB session. */
          },
          createRuntime: async () => ({
            stream: async () =>
              (async function* () {
                started.resolve()
                try {
                  await release.promise
                  if (outcome === "fail" || outcome === "fast-fail")
                    throw Error("ACTUAL_CHILD_FAILED")
                  if (outcome === "uninstall")
                    await expect(
                      f.invoke(mcp, tool.capabilityId, "revoked-child")
                    ).rejects.toThrow()
                  else if (outcome !== "cancel")
                    expect((await f.invoke(mcp, tool.capabilityId, "background")).text).toContain(
                      "pinned:background"
                    )
                  yield ["values", { messages: [new AIMessage("real peer child complete")] }]
                } finally {
                  childDone.resolve()
                }
              })()
          })
        }
      })
      await launch.whenInitialPersisted
      await started.promise
      if (outcome === "fast-fail") {
        release.resolve()
        await childDone.promise
        await workflowRunManager.waitForRunLifecycle(f.threadId, runId)
        expect(workflowRunManager.activeRunId(f.threadId)).toBeUndefined()
      }
    })
    if (outcome === "fast-fail") {
      if (original) expect(f.service.operations(f.projectId)[0].status).toBe("unknown")
      else expect(f.terminals.at(-1)?.outcome).toBe("unknown")
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 })
      expect(f.rows().map((row) => row.text)).toEqual(["foreground"])
      return
    }
    // Foreground completion does not wait for the still-blocked physical child.
    expect(workflowRunManager.activeRunId(f.threadId)).toBe(runId)
    if (original) expect(f.service.operations(f.projectId)[0].status).toBe("started")
    else expect(f.service.operations(f.projectId)).toEqual([])
    expect(() => process.kill(pid, 0)).not.toThrow()
    if (outcome === "uninstall")
      storage.plugins = storage.plugins.filter((item) => item.id !== f.plugin.id)
    if (outcome === "cancel") expect(workflowRunManager.cancel(f.threadId, runId)).toBe(true)
    release.resolve()
    await childDone.promise
    if (selected && outcome === "uninstall")
      await expect(workflowRunManager.waitForRunLifecycle(f.threadId, runId)).rejects.toThrow(
        "WORKFLOW_SOURCE_CLEANUP_UNCONFIRMED"
      )
    else await workflowRunManager.waitForRunLifecycle(f.threadId, runId)
    if (original)
      await vi.waitFor(
        () =>
          expect(f.service.operations(f.projectId)[0].status).toBe(
            outcome === "complete" ? "succeeded" : "unknown"
          ),
        { timeout: 5000 }
      )
    else expect(f.terminals.at(-1)?.outcome).toBe(outcome === "complete" ? "success" : "unknown")
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 })
    expect(f.rows().map((row) => row.text)).toEqual(
      outcome === "complete" ? ["foreground", "background"] : ["foreground"]
    )
    await expect(f.scoped().listTools()).rejects.toThrow("MODS_MCP_SERVICE_CLOSED")
  },
  30_000
)

it.each(["disable", "uninstall", "rebind"] as const)(
  "revokes a no-Mod legacy peer before IO on original %s and retains unknown",
  async (change) => {
    const f = await fixture()
    await f.service.enable(f.projectId, f.workspace)
    let pid = 0
    await f.start(async (mcp) => {
      const [tool] = await mcp.listTools()
      await f.invoke(mcp, tool.capabilityId, "before-revocation")
      pid = f.rows()[0].pid
      const native = Promise.withResolvers<void>(),
        entered = Promise.withResolvers<void>()
      const pending = f.invoke(mcp, tool.capabilityId, "must-not-run", async () => {
        entered.resolve()
        await native.promise
      })
      await entered.promise
      const originalGuard = captureRuntimePluginSourceContentGuard()!
      if (change === "disable") f.plugin.enabled = false
      else if (change === "uninstall")
        storage.plugins = storage.plugins.filter((item) => item.id !== f.plugin.id)
      else f.rebind()
      native.resolve()
      await expect(pending).rejects.toThrow("MODS_EXECUTION_FAILED")
      // The existing native adapter redacts arbitrary exception strings. Verify the actual
      // original authority fence separately, as well as the absence of any second tool IO.
      expect(originalGuard).toThrow(
        change === "rebind" ? "ORIGINAL_PROJECT_BINDING_CHANGED" : "ORIGINAL_PLUGIN_UNAVAILABLE"
      )
    })
    expect(f.service.operations(f.projectId)[0].status).toBe("unknown")
    expect(f.rows().map((row) => row.text)).toEqual(["before-revocation"])
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 })
  },
  30_000
)

it("keeps close uncertainty in the original ledger and permits only physical cleanup to retry", async () => {
  const f = await fixture()
  await f.service.enable(f.projectId, f.workspace)
  let restore: (() => void) | undefined,
    pid = 0
  await f.start(async (mcp) => {
    const [tool] = await mcp.listTools()
    await f.invoke(mcp, tool.capabilityId, "actual-effect")
    pid = f.rows()[0].pid
    const close = vi.spyOn(mcp, "close").mockRejectedValueOnce(Error("ACTUAL_CLOSE_REPLY_LOST"))
    restore = () => close.mockRestore()
  })
  expect(f.service.operations(f.projectId)[0]).toMatchObject({
    status: "unknown",
    terminalCode: "legacy_mcp_cleanup_unconfirmed"
  })
  expect(() => process.kill(pid, 0)).not.toThrow()
  restore!()
  await closeProjectCapabilityMcpService(f.token())
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 })
  expect(f.rows().map((row) => row.text)).toEqual(["actual-effect"])
  expect(f.service.operations(f.projectId)[0].status).toBe("unknown")
}, 30_000)
