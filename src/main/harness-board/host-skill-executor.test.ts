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
  plugins: [] as PluginMetadata[],
  thread: undefined as undefined | { thread_id: string; created_at: number; metadata: string }
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
import { currentRuntimePluginSource } from "../plugins/runtime-source-scope"
import { builtinChangeReviewService } from "../mods/builtins/change-review"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { executeHostProjectSkill } from "./host-skill-executor"
import { HostProjectService } from "./project-runtime/host-service"
import { HostProjectStore } from "./project-runtime/host-store"
import { HostPackageSnapshots } from "./project-runtime/package-snapshots"
import { hostProjectFixture } from "./project-runtime/host-fixtures.test-helper"

const cleanup: Array<() => void> = []
const owner = {
  id: 1,
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: mock.sent }
} as unknown as BrowserWindow
async function fixture(sharedSkill = false) {
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
  const service = new HostProjectService(store, new HostPackageSnapshots(join(root, "snapshots")), {
    resolveInstalledPlugin: async () => ({
      installedPluginId: "installation-id",
      root: pluginRoot,
      packageId: "docs",
      packageVersion: "1.0.0",
      enabled: true
    }),
    authorize: async () => {},
    executeSkill: (context) => executeHostProjectSkill(context, owner)
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
})

describe("original agent run bridge", () => {
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
