import type { BrowserWindow } from "electron"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PluginMetadata } from "../types"
import { AUTO_MODE_MANAGED_STREAM_STARTED_CHANNEL } from "../../shared/harness-board-types"
import { resolveAgentStreamRequestChannel } from "../../shared/agent-stream-channel"

const mock = vi.hoisted(() => ({
  sent: vi.fn(),
  closeMcp: vi.fn(),
  deferWorkflows: vi.fn((): { deferred: boolean; failure?: unknown } => ({ deferred: false })),
  plugins: [] as PluginMetadata[],
  thread: undefined as undefined | { thread_id: string; created_at: number; metadata: string }
}))
vi.mock("../mcp/capability-service", () => ({ closeProjectCapabilityMcpService: mock.closeMcp }))
vi.mock("../agent/workflow/run-manager", () => ({
  deferOwnedRuntimeWorkflowSettlement: mock.deferWorkflows
}))
vi.mock("../mods/manager", () => ({ getModsManager: () => undefined }))
vi.mock("../storage", () => ({ getPlugins: () => mock.plugins }))
vi.mock("../db", () => ({
  createThread: (threadId: string, metadata: Record<string, unknown>) => {
    mock.thread = {
      thread_id: threadId,
      created_at: 1,
      metadata: JSON.stringify({ ...metadata, cmb_thread_incarnation: "original-incarnation" })
    }
    return mock.thread
  },
  getThreadCore: () => mock.thread
}))

import { registerAgentRunImplementation } from "../agent/agent-run-service"
import * as agentRunService from "../agent/agent-run-service"
import {
  assertCurrentRuntimePluginSourceContent,
  currentRuntimePluginSource
} from "../plugins/runtime-source-scope"
import { builtinChangeReviewService } from "../mods/builtins/change-review"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { executeHostProjectSkill } from "./host-skill-executor"
import {
  HostProjectService,
  type HostProjectServiceDependencies
} from "./project-runtime/host-service"
import { HostProjectStore } from "./project-runtime/host-store"
import { HostPackageSnapshots } from "./project-runtime/package-snapshots"
import { hostProjectFixture } from "./project-runtime/host-fixtures.test-helper"
import { withProjectActionScope } from "./project-action-scope"
import { resolveClawThread } from "../mods/claw-scope"
import { configureStageRecoveryHookJournal } from "../hooks/stage-recovery-journal"
import { MARKET_CONTENT_PREFIX, protectMarketDirectory } from "../services/market-content"

const cleanup: Array<() => void> = []
const owner = {
  id: 1,
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: mock.sent }
} as unknown as BrowserWindow
async function fixture(
  sharedSkill = false,
  internal = false,
  mcp = false,
  dependencies: Pick<HostProjectServiceDependencies, "inputIdentity"> = {},
  configurePlugin?: (root: string) => void
) {
  const root = mkdtempSync(join(tmpdir(), "host-skill-executor-"))
  const workspace = join(root, "workspace"),
    pluginRoot = join(root, "plugin")
  mkdirSync(workspace)
  mkdirSync(pluginRoot)
  const manifest = hostProjectFixture(workspace).manifest
  if (sharedSkill) manifest.stages[1].skill = manifest.stages[0].skill
  writeFileSync(join(pluginRoot, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  writeFileSync(
    join(pluginRoot, "plugin.json"),
    '{"name":"docs","version":"1.0.0","skills":"skills"}'
  )
  if (mcp)
    writeFileSync(
      join(pluginRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "node", args: [] } } })
    )
  for (const stage of manifest.stages) {
    mkdirSync(join(pluginRoot, "skills", stage.id), { recursive: true })
    writeFileSync(join(pluginRoot, stage.skill!), `---\nname: ${stage.id}\n---\nPinned Skill`)
  }
  mock.plugins = [
    {
      id: "installation-id",
      name: "docs",
      version: "1.0.0",
      description: "",
      author: "",
      path: pluginRoot,
      enabled: true,
      skillCount: 2,
      mcpServerCount: 0,
      createdAt: "",
      updatedAt: ""
    }
  ]
  const store = new HostProjectStore(join(root, "state.sqlite"))
  cleanup.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  configurePlugin?.(pluginRoot)
  const service = new HostProjectService(store, new HostPackageSnapshots(join(root, "snapshots")), {
    resolveInstalledPlugin: async () => ({
      installedPluginId: "installation-id",
      root: pluginRoot,
      packageId: "docs",
      packageVersion: "1.0.0",
      enabled: true
    }),
    authorize: async () => {},
    executeSkill: (context) =>
      executeHostProjectSkill({ ...context, internalCompositionUnit: internal }, owner),
    ...dependencies
  })
  await service.localCreate({
    projectId: "local-docs",
    name: "Docs",
    goal: "Write a document",
    workspace,
    installedPluginId: "installation-id"
  })
  return { service, workspace, pluginRoot }
}
afterEach(() => {
  cleanup.splice(0).forEach((run) => run())
  mock.plugins = []
  mock.thread = undefined
  mock.sent.mockClear()
  mock.closeMcp.mockReset()
  mock.deferWorkflows.mockReset().mockReturnValue({ deferred: false })
})

describe("original agent run bridge", () => {
  it("reads a protected Skill name and the full plaintext limit without changing retained bytes", async () => {
    const header = "---\nname: protected-document-author\n---\n"
    const plain = header + "x".repeat(256 * 1024 - Buffer.byteLength(header))
    const f = await fixture(false, false, false, {}, (root) => {
      writeFileSync(join(root, "skills/draft/SKILL.md"), plain)
      protectMarketDirectory(root)
    })
    let observed = false
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      observed = true
      expect(context.trustedExplicitSkill!.name).toBe("protected-document-author")
      const retainedPath = context.trustedExplicitSkill!.path
      expect(retainedPath).not.toBe(join(f.pluginRoot, "skills/draft/SKILL.md"))
      expect(readFileSync(retainedPath, "utf8").startsWith(MARKET_CONTENT_PREFIX)).toBe(true)
      expect(readFileSync(retainedPath)).toEqual(
        readFileSync(join(f.pluginRoot, "skills/draft/SKILL.md"))
      )
      assertCurrentRuntimePluginSourceContent()
      writeFileSync(join(f.workspace, "document.md"), "Protected source output")
      context.onRunTerminated?.({ outcome: "success", code: "protected-skill" })
    })
    const operation = f.service.prepare({
      projectId: "local-docs", expectedVersion: 1, idempotencyKey: "protected-skill"
    })
    expect((await f.service.start(operation.operationId)).status).toBe("succeeded")
    expect(observed).toBe(true)
  })

  it.each([false, true])("rejects Skills above the plaintext limit (protected=%s)", async (protectedSkill) => {
    await expect(fixture(false, false, false, {}, (root) => {
      writeFileSync(join(root, "skills/draft/SKILL.md"), "x".repeat(256 * 1024 + 1))
      if (protectedSkill) protectMarketDirectory(root)
    })).rejects.toThrow("FILE_LIMIT")
  })

  it("rejects a corrupt protected Skill before launching the original agent", async () => {
    await expect(fixture(false, false, false, {}, (root) => {
      protectMarketDirectory(root)
      writeFileSync(join(root, "skills/draft/SKILL.md"), MARKET_CONTENT_PREFIX + "invalid!")
    })).rejects.toThrow("市场资源编码损坏")
  })

  it("retains a genuine agent terminal while an unresolved recovery Hook keeps the overall operation unknown", async () => {
    const f = await fixture()
    configureStageRecoveryHookJournal({
      begin: () => {
        throw Error("unused")
      },
      unresolved: () => true
    })
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      writeFileSync(join(f.workspace, "document.md"), "Actually settled model output")
      context.onRunTerminated?.({ outcome: "success", code: "physical-agent-complete" })
    })
    const operation = f.service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "separate-physical-agent-fact"
    })
    // The native wrapper, rather than model input, supplies the recovery policy.
    const execute = f.service as unknown as { deps: HostProjectServiceDependencies }
    const original = execute.deps.executeSkill
    execute.deps.executeSkill = (context) =>
      original({
        ...context,
        stageDebug: {
          workspace: f.workspace,
          baselineId: "native-baseline",
          commandHooks: {
            readOnlyRoots: [f.pluginRoot],
            networkAccess: "explicitly-approved"
          }
        }
      })
    try {
      await expect(f.service.start(operation.operationId)).resolves.toMatchObject({
        status: "unknown",
        receipts: [],
        execution: {
          terminal: {
            outcome: "success",
            code: "physical-agent-complete"
          }
        }
      })
    } finally {
      configureStageRecoveryHookJournal({
        begin: () => {
          throw Error("unused")
        },
        unresolved: () => false
      })
    }
  })
  it("runs an isolated Host stage through the real Claw selector without borrowing a parent", async () => {
    const f = await fixture(false, true)
    let resolved = false
    registerAgentRunImplementation(async (request, _delivery, context) => {
      const row = mock.thread
      if (!row) throw Error("Original Host thread missing")
      const metadata = JSON.parse(row.metadata)
      expect(metadata.isInternalFlowRuntime).toBe(true)
      expect(metadata.parentThreadId).toBeUndefined()
      expect(currentRuntimePluginSource()?.mode).toBe("host")
      await withProjectActionScope(
        request.threadId,
        metadata.hostProjectRuntime,
        () => {
          expect(mock.thread).toBe(row)
        },
        async () => {
          expect(
            resolveClawThread(request.threadId, (id) => (id === row.thread_id ? row : null))
          ).toBeNull()
          resolved = true
          writeFileSync(join(f.workspace, "document.md"), "Original isolated Host stage")
          context.onRunTerminated?.({ outcome: "success", code: "normal" })
        }
      )
    })
    const operation = f.service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "isolated-claw-selector"
    })
    await expect(f.service.start(operation.operationId)).resolves.toMatchObject({
      status: "succeeded"
    })
    expect(resolved).toBe(true)
  })
  it.each(["completed", "failed"])(
    "retains the host stage and input guards until owned workflow cleanup is %s",
    async (outcome) => {
      const f = await fixture()
      const registered = Promise.withResolvers<void>()
      let settleWorkflow!: (failure?: unknown) => Promise<void>
      let assertSource!: () => void
      let sourceToken: unknown
      mock.deferWorkflows.mockImplementationOnce((...args: unknown[]) => {
        expect(args[0]).toBe(sourceToken)
        settleWorkflow = args[1] as typeof settleWorkflow
        registered.resolve()
        return { deferred: true }
      })
      registerAgentRunImplementation(async (_request, _delivery, context) => {
        sourceToken = context.pluginSourceSnapshot
        // Capture the original bound guard, rather than reading ALS from the test continuation.
        const { captureRuntimePluginSourceContentGuard } =
          await import("../plugins/runtime-source-scope")
        assertSource = captureRuntimePluginSourceContentGuard()!
        context.onRunTerminated?.({ outcome: "success", code: "foreground-returned" })
      })
      const operation = f.service.prepare({
        projectId: "local-docs",
        expectedVersion: 1,
        idempotencyKey: `workflow-${outcome}`
      })
      const pending = f.service.start(operation.operationId)
      await registered.promise
      expect(f.service.operations("local-docs")[0].status).toBe("started")
      expect(mock.closeMcp).not.toHaveBeenCalled()
      expect(assertSource).not.toThrow()
      writeFileSync(join(f.workspace, "document.md"), "Written by the background child")
      const cleanup = settleWorkflow(
        outcome === "failed" ? Error("WORKFLOW_SOURCE_OWNER_NOT_SUCCEEDED") : undefined
      )
      if (outcome === "failed")
        await expect(cleanup).rejects.toThrow("PROJECT_WORKFLOW_CLEANUP_UNCONFIRMED")
      else await cleanup
      const result = await pending
      expect(result.status).toBe(outcome === "completed" ? "succeeded" : "unknown")
      if (outcome === "failed") {
        expect(result.receipts).toEqual([])
        expect(result.execution?.terminal?.code).toBe("project_workflow_cleanup_unconfirmed")
      }
      expect(mock.closeMcp).toHaveBeenCalledExactlyOnceWith(sourceToken)
      expect(assertSource).toThrow()
    }
  )
  it("rejects an already-retired workflow failure before recording host stage success", async () => {
    const f = await fixture()
    mock.deferWorkflows.mockReturnValueOnce({
      deferred: false,
      failure: Error("WORKFLOW_SOURCE_OWNER_NOT_SUCCEEDED")
    })
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      writeFileSync(join(f.workspace, "document.md"), "Partial output from a failed child")
      context.onRunTerminated?.({ outcome: "success", code: "late-parent-success" })
    })
    const operation = f.service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "retired-workflow-failure"
    })
    await expect(f.service.start(operation.operationId)).resolves.toMatchObject({
      status: "unknown",
      receipts: [],
      execution: { terminal: { outcome: "unknown", code: "project_workflow_cleanup_unconfirmed" } }
    })
    expect(mock.closeMcp).toHaveBeenCalledTimes(1)
    expect(f.service.get("local-docs")?.version).toBe(1)
  })
  it("records unknown before host settlement when a successful child swallowed source revocation", async () => {
    const f = await fixture()
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      writeFileSync(join(f.workspace, "document.md"), "Partial artifact")
      mock.plugins = []
      context.onRunTerminated?.({ outcome: "success", code: "child-caught-revocation" })
    })
    const operation = f.service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "final-source-revoked"
    })
    await expect(f.service.start(operation.operationId)).resolves.toMatchObject({
      status: "unknown",
      receipts: [],
      execution: { terminal: { outcome: "unknown", code: "project_runtime_inputs_changed" } }
    })
    expect(mock.closeMcp).toHaveBeenCalledTimes(1)
    expect(f.service.get("local-docs")?.version).toBe(1)
  })
  it("closes the original token-scoped MCP service even when the package declares no MCP servers", async () => {
    const f = await fixture()
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      writeFileSync(join(f.workspace, "document.md"), "No MCP declaration")
      context.onRunTerminated?.({ outcome: "success", code: "normal" })
    })
    const operation = f.service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "empty-mcp"
    })
    await expect(f.service.start(operation.operationId)).resolves.toMatchObject({
      status: "succeeded"
    })
    expect(mock.closeMcp).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "host-plugin-source" })
    )
  })
  it.each(["disabled", "uninstalled"])(
    "revokes host runtime/source boundaries when the installation is %s",
    async (change) => {
      const f = await fixture()
      registerAgentRunImplementation(async (_request, _delivery, context) => {
        expect(currentRuntimePluginSource()?.plugin.enabled).toBe(true)
        if (change === "disabled") mock.plugins[0].enabled = false
        else mock.plugins = []
        expect(() => currentRuntimePluginSource()).toThrow("PLUGIN_UNAVAILABLE")
        expect(() => assertCurrentRuntimePluginSourceContent()).toThrow("PLUGIN_UNAVAILABLE")
        context.onRunTerminated?.({ outcome: "unknown", code: "source-revoked" })
      })
      const operation = f.service.prepare({
        projectId: "local-docs",
        expectedVersion: 1,
        idempotencyKey: change
      })
      await expect(f.service.start(operation.operationId)).resolves.toMatchObject({
        status: "unknown",
        receipts: []
      })
    }
  )
  it("retains pinned runtime bytes when an enabled installation is updated", async () => {
    const f = await fixture()
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      const pinned = currentRuntimePluginSource()!.plugin.path
      mock.plugins[0].path = join(f.pluginRoot, "new-live-version")
      mock.plugins[0].version = "2.0.0"
      expect(currentRuntimePluginSource()!.plugin.path).toBe(pinned)
      expect(currentRuntimePluginSource()!.plugin.version).toBe("1.0.0")
      expect(() => assertCurrentRuntimePluginSourceContent()).not.toThrow()
      writeFileSync(join(f.workspace, "document.md"), "Pinned version")
      context.onRunTerminated?.({ outcome: "success", code: "normal" })
    })
    const operation = f.service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "pinned"
    })
    await expect(f.service.start(operation.operationId)).resolves.toMatchObject({
      status: "succeeded"
    })
  })
  it("waits for only its source-token MCP service to close before publishing a successful terminal", async () => {
    const f = await fixture(false, false, true)
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const closing = new Promise<void>((resolve) => {
      release = resolve
    })
    mock.closeMcp.mockImplementation(async () => {
      enter()
      await closing
    })
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      writeFileSync(join(f.workspace, "document.md"), "actual document")
      context.onRunTerminated?.({ outcome: "success", code: "normal" })
    })
    const operation = f.service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "mcp-drain"
    })
    const pending = f.service.start(operation.operationId)
    await entered
    expect(f.service.operations("local-docs")[0].status).toBe("started")
    expect(mock.closeMcp).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "host-plugin-source" })
    )
    release()
    await expect(pending).resolves.toMatchObject({ status: "succeeded" })
  })
  it("keeps ownership unknown when scoped MCP cleanup cannot be confirmed", async () => {
    const f = await fixture(false, false, true)
    mock.closeMcp.mockRejectedValueOnce(Error("MODS_MCP_CLEANUP_UNCONFIRMED"))
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      writeFileSync(join(f.workspace, "document.md"), "actual write")
      context.onRunTerminated?.({ outcome: "success", code: "normal" })
    })
    const operation = f.service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "mcp-unknown"
    })
    await expect(f.service.start(operation.operationId)).resolves.toMatchObject({
      status: "unknown",
      receipts: [],
      execution: { terminal: { outcome: "unknown", code: "project_mcp_cleanup_unconfirmed" } }
    })
  })
  it("does not preserve an earlier success label when the original run-body promise rejects", async () => {
    const f = await fixture()
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      context.onRunTerminated?.({ outcome: "success", code: "early-label" })
      throw Error("physical body failed after terminal callback")
    })
    const operation = f.service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "body-unknown"
    })
    await expect(f.service.start(operation.operationId)).resolves.toMatchObject({
      status: "unknown",
      receipts: [],
      execution: { terminal: { outcome: "unknown", code: "runtime_completion_rejected" } }
    })
  })

  it.each([false, true])(
    "isolates the original host runtime to its exact retained source (internal=%s)",
    async (internal) => {
      const { service } = await fixture(false, internal)
      registerAgentRunImplementation(async (_request, _delivery, context) => {
        expect(currentRuntimePluginSource()?.capabilitySources).toEqual([])
        expect(currentRuntimePluginSource()?.mode).toBe("host")
        expect(currentRuntimePluginSource()?.preserveParentContext).toBe(true)
        context.onRunTerminated?.({ outcome: "success", code: "normal" })
      })
      const operation = service.prepare({
        projectId: "local-docs",
        expectedVersion: 1,
        idempotencyKey: "internal"
      })
      await service.start(operation.operationId)
    }
  )
  it("closes the registered renderer stream when original admission rejects before returning a handle", async () => {
    const { service } = await fixture()
    const start = vi
      .spyOn(agentRunService, "startAgentRun")
      .mockRejectedValueOnce(Error("admission refused"))
    try {
      const operation = service.prepare({
        projectId: "local-docs",
        expectedVersion: 1,
        idempotencyKey: "admission"
      })
      await service.start(operation.operationId)
      const notification = mock.sent.mock.calls.find(
        ([channel]) => channel === AUTO_MODE_MANAGED_STREAM_STARTED_CHANNEL
      )![1]
      expect(mock.sent).toHaveBeenCalledWith(
        resolveAgentStreamRequestChannel(
          `agent:stream:${notification.threadId}`,
          notification.streamRequestId
        ),
        expect.objectContaining({ type: "error" })
      )
    } finally {
      start.mockRestore()
    }
  })
  it.each(["missing", "rejected"])(
    "registers the original renderer stream before execution and closes %s evidence",
    async (mode) => {
      const { service } = await fixture()
      let requestChannel = ""
      registerAgentRunImplementation(async (request) => {
        expect(mock.sent).toHaveBeenCalledWith(AUTO_MODE_MANAGED_STREAM_STARTED_CHANNEL, {
          runId: request.streamRequestId,
          threadId: request.threadId,
          streamRequestId: request.streamRequestId,
          agentMode: "normal"
        })
        expect(request.managedExecution).toBeUndefined()
        requestChannel = resolveAgentStreamRequestChannel(
          `agent:stream:${request.threadId}`,
          request.streamRequestId
        )
        if (mode === "rejected") throw Error("original failure")
      })
      const operation = service.prepare({
        projectId: "local-docs",
        expectedVersion: 1,
        idempotencyKey: mode
      })
      expect((await service.start(operation.operationId)).status).toBe("unknown")
      expect(mock.sent).toHaveBeenCalledWith(
        requestChannel,
        expect.objectContaining({ type: "error" })
      )
    }
  )
  it("captures the workspace before the original run startup hooks can write", async () => {
    const { service, workspace } = await fixture()
    execFileSync("git", ["init", "--quiet", workspace])
    writeFileSync(join(workspace, "document.md"), "Before original startup\n")
    const operation = service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "startup-baseline"
    })
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      writeFileSync(join(workspace, "document.md"), "Written by original startup\n")
      const review = await builtinChangeReviewService.read(
        {
          threadId: mock.thread!.thread_id,
          workspace,
          incarnationKey: JSON.stringify(captureThreadIncarnation(mock.thread!)),
          runId: `project-operation:${operation.operationId}`
        },
        "task"
      )
      expect(review.status).toBe("available")
      expect(review.files.find((file) => file.path === "document.md")?.patch).toContain(
        "-Before original startup"
      )
      context.onRunTerminated?.({ outcome: "success", code: "normal" })
    })
    expect((await service.start(operation.operationId)).status).toBe("succeeded")
  })
  it("binds different stage instructions when stages share the same Skill", async () => {
    const { service, workspace } = await fixture(true)
    const prompts: string[] = []
    const skills: string[] = []
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      prompts.push(currentRuntimePluginSource()!.stagePrompt!)
      skills.push(context.trustedExplicitSkill!.path)
      if (prompts.length === 1) writeFileSync(join(workspace, "document.md"), "Draft")
      context.onRunTerminated?.({ outcome: "success", code: "normal" })
    })
    const draft = service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "draft"
    })
    await service.start(draft.operationId)
    service.transition(draft.operationId)
    const review = service.prepare({
      projectId: "local-docs",
      expectedVersion: 2,
      idempotencyKey: "review"
    })
    service.approve(review.operationId, {
      expectedVersion: 2,
      inputFingerprint: review.inputFingerprint,
      decision: "approved",
      actorId: "local-user"
    })
    expect((await service.start(review.operationId)).status).toBe("succeeded")
    expect(skills[0]).toBe(skills[1])
    expect(prompts[0]).toContain('"stageId":"draft"')
    expect(prompts[1]).toContain('"stageId":"review"')
  })
  it("passes a trusted fixed Skill and persists thread plus settlement evidence", async () => {
    const { service, workspace, pluginRoot } = await fixture()
    registerAgentRunImplementation(async (request, _delivery, context) => {
      expect(request.threadId).toBe(mock.thread?.thread_id)
      expect(
        context.verifyResolvedThread?.({
          workspacePath: workspace,
          metadata: JSON.parse(mock.thread!.metadata)
        })
      ).toBeNull()
      expect(currentRuntimePluginSource()?.plugin.path).not.toBe(pluginRoot)
      expect(currentRuntimePluginSource()?.stagePrompt).toContain('"stageId":"draft"')
      expect(currentRuntimePluginSource()?.stagePrompt).toContain('"path":"document.md"')
      expect(request.message).toBe("Write a document")
      expect(readFileSync(context.trustedExplicitSkill!.path, "utf8")).toContain("Pinned Skill")
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(currentRuntimePluginSource()?.operationId).toBeDefined()
      writeFileSync(join(workspace, "document.md"), "Real artifact")
      context.onRunTerminated?.({ outcome: "success", code: "normal" })
    })
    const operation = service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "draft"
    })
    writeFileSync(join(pluginRoot, "skills/draft/SKILL.md"), "Changed mutable installation")
    const result = await service.start(operation.operationId)
    expect(result.status).toBe("succeeded")
    expect(result.execution).toMatchObject({
      threadId: mock.thread!.thread_id,
      terminal: { outcome: "success", code: "normal", settledAt: expect.any(Number) }
    })
    expect(result.startedAt).toEqual(expect.any(Number))
    expect(currentRuntimePluginSource()).toBeUndefined()
  })
  it("does not infer a successful original run from generated files when terminal evidence is missing", async () => {
    const { service, workspace } = await fixture()
    registerAgentRunImplementation(async () => {
      writeFileSync(join(workspace, "document.md"), "partial")
    })
    const operation = service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "draft"
    })
    const result = await service.start(operation.operationId)
    expect(result.status).toBe("unknown")
    expect(result.execution?.terminal?.code).toBe("runtime_terminal_missing")
    expect(service.get("local-docs")?.version).toBe(1)
  })
  it("records known physical cancellation without restoring aborted source authority", async () => {
    const { service, workspace } = await fixture()
    const entered = Promise.withResolvers<void>()
    const observedAbort = Promise.withResolvers<void>()
    const physicallyStopped = Promise.withResolvers<void>()
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      writeFileSync(join(workspace, "document.md"), "Effect completed before cancellation")
      entered.resolve()
      await new Promise<void>((resolve) => {
        if (context.signal!.aborted) resolve()
        else context.signal!.addEventListener("abort", () => resolve(), { once: true })
      })
      expect(() => currentRuntimePluginSource()).toThrow()
      observedAbort.resolve()
      await physicallyStopped.promise
      expect(() => currentRuntimePluginSource()).toThrow()
      context.onRunCancelled?.()
      context.onRunTerminated?.({ outcome: "success", code: "physical_cancel_confirmed" })
    })
    const operation = service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "physical-cancellation"
    })
    const completion = service.start(operation.operationId)
    await entered.promise
    expect(service.cancel(operation.operationId).status).toBe("cancel_requested")
    await observedAbort.promise
    expect(service.operations("local-docs")[0]).toMatchObject({
      status: "cancel_requested",
      receipts: []
    })
    expect(service.operations("local-docs")[0].execution?.terminal).toBeNull()
    expect(mock.closeMcp).not.toHaveBeenCalled()
    physicallyStopped.resolve()
    const result = await completion
    expect(result.status).toBe("cancelled")
    expect(result.execution?.terminal).toMatchObject({
      outcome: "cancelled",
      code: "physical_cancel_confirmed"
    })
    expect(result.receipts).toEqual([])
    expect(service.get("local-docs")?.version).toBe(1)
  })
  it.each([
    "missing-terminal",
    "unknown-terminal",
    "cleanup-failure",
    "workflow-failure",
    "changed-source",
    "changed-knowledge",
    "changed-thread",
    "revoked-installation"
  ])("keeps actual cancellation unknown with %s", async (failure) => {
    let knowledgePath = ""
    const { service, workspace } = await fixture(false, false, false, {
      inputIdentity: () => (knowledgePath ? readFileSync(knowledgePath, "utf8") : "unloaded")
    })
    knowledgePath = join(workspace, "knowledge.md")
    writeFileSync(knowledgePath, "Original knowledge")
    const entered = Promise.withResolvers<void>()
    if (failure === "cleanup-failure")
      mock.closeMcp.mockRejectedValueOnce(Error("scoped peer did not close"))
    if (failure === "workflow-failure")
      mock.deferWorkflows.mockReturnValueOnce({
        deferred: false,
        failure: Error("child cleanup failed")
      })
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      const sourceRoot = currentRuntimePluginSource()!.plugin.path
      writeFileSync(join(workspace, "document.md"), "Effect completed before cancellation")
      entered.resolve()
      await new Promise<void>((resolve) => {
        if (context.signal!.aborted) resolve()
        else context.signal!.addEventListener("abort", () => resolve(), { once: true })
      })
      if (failure === "changed-source")
        writeFileSync(join(sourceRoot, "skills/draft/SKILL.md"), "Changed retained source")
      if (failure === "changed-knowledge") writeFileSync(knowledgePath!, "Changed knowledge")
      if (failure === "changed-thread")
        mock.thread!.metadata = JSON.stringify({
          ...JSON.parse(mock.thread!.metadata),
          cmb_thread_incarnation: "replaced"
        })
      if (failure === "revoked-installation") mock.plugins = []
      expect(() => currentRuntimePluginSource()).toThrow()
      context.onRunCancelled?.()
      if (failure !== "missing-terminal")
        context.onRunTerminated?.({
          outcome: failure === "unknown-terminal" ? "unknown" : "success",
          code: "physical_cancel_confirmed"
        })
    })
    const operation = service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: `physical-cancellation-${failure}`
    })
    const completion = service.start(operation.operationId)
    await entered.promise
    expect(service.cancel(operation.operationId).status).toBe("cancel_requested")
    const result = await completion
    expect(result.status).toBe("unknown")
    expect(result.receipts).toEqual([])
    expect(service.get("local-docs")?.version).toBe(1)
    expect(() =>
      service.prepare({
        projectId: "local-docs",
        expectedVersion: 1,
        idempotencyKey: `retry-${failure}`
      })
    ).toThrow()
  })
  it.each(["missing", "unknown"])(
    "keeps unknown ownership after cancellation with %s terminal evidence",
    async (evidence) => {
      const { service, workspace } = await fixture()
      registerAgentRunImplementation(async (_request, _delivery, context) => {
        writeFileSync(join(workspace, "document.md"), "possibly completed external effect")
        context.onRunCancelled?.()
        if (evidence === "unknown")
          context.onRunTerminated?.({ outcome: "unknown", code: "unconfirmed" })
      })
      const operation = service.prepare({
        projectId: "local-docs",
        expectedVersion: 1,
        idempotencyKey: "cancelled"
      })
      const result = await service.start(operation.operationId)
      expect(result.status).toBe("unknown")
      expect(result.execution?.terminal?.outcome).toBe("unknown")
      expect(() =>
        service.prepare({ projectId: "local-docs", expectedVersion: 1, idempotencyKey: "retry" })
      ).toThrow()
      expect(service.get("local-docs")?.version).toBe(1)
    }
  )
})
