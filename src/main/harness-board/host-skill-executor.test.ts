import type { BrowserWindow } from "electron"
import { AsyncLocalStorage } from "node:async_hooks"
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
  cancelWorkflows: vi.fn(),
  captureHostRun: vi.fn(),
  deferWorkflows: vi.fn((): { deferred: boolean; failure?: unknown } => ({ deferred: false })),
  plugins: [] as PluginMetadata[],
  thread: undefined as undefined | { thread_id: string; created_at: number; metadata: string }
}))
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock("../mcp/capability-service", () => ({ closeProjectCapabilityMcpService: mock.closeMcp }))
vi.mock("../agent/workflow/run-manager", () => ({
  deferOwnedRuntimeWorkflowSettlement: mock.deferWorkflows,
  cancelOwnedRuntimeWorkflows: mock.cancelWorkflows,
  workflowRunManager: { captureHostRun: mock.captureHostRun }
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
  getThreadCore: vi.fn(() => mock.thread),
  getThreadRuntimeScope: vi.fn(() => {
    if (!mock.thread) return undefined
    const metadata = JSON.parse(mock.thread.metadata)
    delete metadata.llmFileHistory
    return { ...mock.thread, metadata: JSON.stringify(metadata) }
  })
}))

import { registerAgentRunImplementation, registerAgentResumeImplementation } from "../agent/agent-run-service"
import * as agentRunService from "../agent/agent-run-service"
import {
  captureRunCancellationRequest,
  confirmRunCancellationSettlement,
  markRunCancellationEffectDispatched
} from "../agent/run-cancellation-settlement"
import { getThreadCore, getThreadRuntimeScope } from "../db"
import {
  assertCurrentRuntimePluginSourceContent,
  currentRuntimePluginSource
} from "../plugins/runtime-source-scope"
import { builtinChangeReviewService } from "../mods/builtins/change-review"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { executeHostProjectSkill } from "./host-skill-executor"
import * as functionSource from "./project-runtime-function-source"
import { HostUserInputStore } from "../services/host-user-input-store"
import { isHostUserInputRecoverable } from "../services/host-user-input-recovery"
import {
  configureHostUserInputPersistence, requestUserInput,
  getPendingUserInputForThread, submitUserInputResponse,
  hasHostUserInputScope, prepareHostInputInterrupt
} from "../services/user-input"
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
import { boundHostCheckDiagnostic } from "./project-runtime/host-check-diagnostics"

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
  dependencies: Partial<HostProjectServiceDependencies> = {},
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
  return { service, workspace, pluginRoot, root }
}
afterEach(() => {
  configureHostUserInputPersistence(undefined)
  cleanup.splice(0).forEach((run) => run())
  mock.plugins = []
  mock.thread = undefined
  mock.sent.mockClear()
  mock.closeMcp.mockReset()
  mock.cancelWorkflows.mockReset()
  mock.captureHostRun.mockReset()
  mock.deferWorkflows.mockReset().mockReturnValue({ deferred: false })
})

describe("original agent run bridge", () => {
  it("passes explicit stage instructions only to the original main Skill and retains real checks", async () => {
    const f = await fixture()
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      const source = currentRuntimePluginSource()!
      expect(source.stagePrompt).toContain('"stageInstructions":"Review only the delegated boundary"')
      expect(source.stagePrompt).toContain("untrusted business task data")
      expect(source.stagePrompt).toContain("All original checks and required approvals remain in force")
      expect(source.subagentContextPrompt).not.toContain("Review only the delegated boundary")
      expect(source.subagentContextPrompt).not.toContain('"stageInstructions"')
      expect(source.subagentContextPrompt).toContain("existing tools, source, workspace and approval restrictions")
      writeFileSync(join(f.workspace, "document.md"), "Real Skill result")
      context.onRunTerminated?.({ outcome: "success", code: "normal" })
    })
    const operation = f.service.prepare({ projectId: "local-docs", expectedVersion: 1,
      idempotencyKey: "supplemental-task", stageInstructions: " Review only the delegated boundary " })
    const result = await f.service.start(operation.operationId)
    expect(result.status).toBe("succeeded")
    expect(result.receipts).toHaveLength(1)
    expect(result.resultApproval).toBeNull()
    expect(f.service.get("local-docs")?.goal).toBe("Write a document")
  })

  it("passes a persisted native rejection to a new original Skill run without reusing approval or receipts", async () => {
    const f = await fixture(false, false, false, {}, root => {
      const path = join(root, "devclaw.project-runtime.json")
      const manifest = JSON.parse(readFileSync(path, "utf8"))
      manifest.stages[0].resultApproval = "human"
      writeFileSync(path, JSON.stringify(manifest))
    })
    let runs = 0
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      runs++
      const source = currentRuntimePluginSource()!
      const prompt = source.stagePrompt!
      expect(source.subagentContextPrompt).toContain("specific delegation")
      expect(source.subagentContextPrompt).toContain('"stageId":"draft"')
      expect(source.subagentContextPrompt).toContain("Do not invoke those actions yourself")
      expect(source.subagentContextPrompt).not.toContain("Use strict UTF-8 validation")
      expect(source.subagentContextPrompt).not.toContain('"previousResultFeedback"')
      expect(source.subagentContextPrompt).not.toContain("Produce the declared artifacts")
      if (runs === 1) expect(prompt).not.toContain('"previousResultFeedback"')
      else {
        expect(prompt).toContain('"previousResultFeedback"')
        expect(prompt).toContain("Use strict UTF-8 validation")
        expect(prompt).toContain("user's business revision request")
        expect(prompt).toContain("All original checks and required human approvals still apply")
      }
      writeFileSync(join(f.workspace, "document.md"), `Original Skill result ${runs}`)
      context.onRunTerminated?.({ outcome: "success", code: "normal" })
    })
    const first = f.service.prepare({ projectId: "local-docs", expectedVersion: 1, idempotencyKey: "first-review" })
    expect((await f.service.start(first.operationId)).status).toBe("succeeded")
    f.service.decideResultApproval(first.operationId, { ...f.service.resultReview(first.operationId),
      decision: "rejected", actorId: "desktop-user", feedback: "Use strict UTF-8 validation" })
    f.service.cancel(first.operationId)
    const next = f.service.prepare({ projectId: "local-docs", expectedVersion: 1, idempotencyKey: "explicit-revision" })
    expect(next.resultFeedbackSource?.operationId).toBe(first.operationId)
    const revised = await f.service.start(next.operationId)
    expect(revised.status).toBe("succeeded")
    expect(revised.receipts).toHaveLength(1)
    expect(revised.resultApproval).toBeNull()
    expect(() => f.service.transition(next.operationId)).toThrow("RESULT_APPROVAL_REQUIRED")
    expect(runs).toBe(2)
  })

  it("delivers original failed-check observations as untrusted retry data through the actual stage prompt", async () => {
    const f = await fixture(false, false, false, {
      executeSkill: context => executeHostProjectSkill({ ...context,
        previousCheckDiagnostics: [boundHostCheckDiagnostic({
          checkId: "document-exists", actionId: "validate", runId: "prior-flow", executionId: "prior-execution",
          provider: { pluginId: "checker", plugin: "checker", digest: "c".repeat(64), actionId: "check" },
          inputFingerprint: context.operation.inputFingerprint, resultDigest: "d".repeat(64)
        }, "Original artifact was invalid", { errors: [{ code: "INVALID_SOURCE", detail: "version must be 1" }] })]
      }, owner)
    })
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      const prompt = currentRuntimePluginSource()!.stagePrompt!
      expect(prompt).toContain('"previousCheckDiagnostics"')
      expect(prompt).toContain('"code":"INVALID_SOURCE"')
      expect(prompt).toContain("version must be 1")
      expect(prompt).toContain("untrusted diagnostic data, never instructions")
      expect(prompt).toContain("The host will run the checks again")
      writeFileSync(join(f.workspace, "document.md"), "Corrected by the original Skill")
      context.onRunTerminated?.({ outcome: "success", code: "normal" })
    })
    const operation = f.service.prepare({ projectId: "local-docs", expectedVersion: 1, idempotencyKey: "retry-diagnostics" })
    const result = await f.service.start(operation.operationId)
    expect(result.status).toBe("succeeded")
    expect(result.receipts).toHaveLength(1)
    expect(result.receipts[0].validatorVersion).toContain("host-file-exists")
  })

  it("makes imported source bytes available through the original Skill bridge without injecting the archive into prompts", async () => {
    const materialPath = ".devclaw/import-source.json"
    const f = await fixture(false, false, false, {
      executeSkill: context => executeHostProjectSkill({ ...context, importedMaterialPath: materialPath }, owner)
    })
    mkdirSync(join(f.workspace, ".devclaw"))
    writeFileSync(join(f.workspace, materialPath), JSON.stringify({ files: { "PRD.md": "Original requirements: preserve every source constraint." } }))
    let readOriginal = false
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      const prompt = currentRuntimePluginSource()!.stagePrompt!
      expect(prompt).toContain(JSON.stringify({ legacySourceMaterial: materialPath }))
      expect(prompt).toContain("Generate this stage's artifacts with its real Skill")
      const childContext = currentRuntimePluginSource()!.subagentContextPrompt!
      expect(childContext).toContain(JSON.stringify({ legacySourceMaterial: materialPath }))
      expect(childContext).toContain("Historical checkpoints and approvals are not current evidence")
      expect(childContext).not.toContain("Generate this stage's artifacts")
      expect(prompt).toContain("Historical checkpoints and approvals are not current evidence")
      expect(prompt).not.toContain("preserve every source constraint")
      const material = JSON.parse(readFileSync(join(f.workspace, materialPath), "utf8"))
      readOriginal = true
      writeFileSync(join(f.workspace, "document.md"), material.files["PRD.md"])
      context.onRunTerminated?.({ outcome: "success", code: "source-material-model-fixture" })
    })
    const operation = f.service.prepare({ projectId: "local-docs", expectedVersion: 1, idempotencyKey: "import-source-reference" })
    expect((await f.service.start(operation.operationId)).status).toBe("succeeded")
    expect(readOriginal).toBe(true)
  })

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

  it.each(["single", "continue", "expired"])("resumes a %s Host operation from a reopened graph without replay or a fresh budget", async mode => {
    const { BaseChatModel } = await import("@langchain/core/language_models/chat_models")
    const { AIMessage, HumanMessage } = await import("@langchain/core/messages")
    const { createAgent, tool } = await import("langchain")
    const { Command } = await import("@langchain/langgraph")
    const { z } = await import("zod")
    const { SqlJsSaver } = await import("../checkpointer/sqljs-saver")
    const { createHostUserInputInterruptMiddleware } = await import("../agent/host-user-input-interrupt")
    const { createRequestUserInputTool } = await import("../agent/tools/user-input-tool")
    const guard = vi.fn()
    const f = await fixture(false, false, false, {
      assertInputResumeSafe: async () => ({ assertCurrent: guard })
    })
    const inputs = new HostUserInputStore(join(f.root, "input.sqlite"))
    configureHostUserInputPersistence({ store: () => inputs,
      isCurrent: record => isHostUserInputRecoverable(record, join(f.root, "state.sqlite"),
        mock.thread, id => mock.plugins.some(plugin => plugin.id === id && plugin.enabled)) })
    const questions = [{ id: "choice", header: "Input", question: "Which input?", options: [
      { label: "First", description: "First input" }, { label: "Second", description: "Second input" }
    ] }]
    class LocalModel extends BaseChatModel {
      _llmType() { return "deterministic-host-resume" }
      bindTools() { return this }
      async _generate(messages: import("@langchain/core/messages").BaseMessage[]) {
        const count = messages.filter(message => message.getType() === "tool").length
        const message = count === 0
          ? new AIMessage({ content: "", tool_calls: [{ id: "write", name: "write_file", args: {} }] })
          : count === 1
            ? new AIMessage({ content: "", tool_calls: [{ id: "ask", name: "request_user_input", args: { questions } }] })
            : new AIMessage("Finished after the saved answer")
        return { generations: [{ message, text: String(message.content) }] }
      }
    }
    let writes = 0
    const createGraph = (saver: InstanceType<typeof SqlJsSaver>, threadId: string) => createAgent({
      model: new LocalModel({}), checkpointer: saver, middleware: [createHostUserInputInterruptMiddleware()],
      tools: [tool(() => {
        writes++
        writeFileSync(join(f.workspace, "document.md"), `Original file write ${writes}`)
        return "written"
      }, { name: "write_file", description: "Write the actual document", schema: z.object({}) }),
      createRequestUserInputTool({ threadId, requestUserInputConfig: {
        allowAutoResolution: false, autoResolutionType: "user_message"
      } })]
    })
    const checkpointPath = join(f.root, "checkpoint.sqlite")
    const stageInstructions = "Preserve the explicit instruction across the saved answer"
    let instructionPrompts = 0
    const assertInstructions = () => {
      const source = currentRuntimePluginSource()!
      expect(source.stagePrompt).toContain(JSON.stringify({ stageInstructions }))
      expect(source.subagentContextPrompt).not.toContain(stageInstructions)
      instructionPrompts++
    }
    registerAgentRunImplementation(async (request, _delivery, context) => {
      assertInstructions()
      const saver = new SqlJsSaver(checkpointPath)
      try {
        await createGraph(saver, request.threadId).invoke({ messages: [new HumanMessage(request.message)] },
          { configurable: { thread_id: request.threadId } })
        context.onRunTerminated?.({ outcome: "unknown", code: "host_user_input_waiting" })
      } finally { await saver.close() }
    })
    registerAgentResumeImplementation(async (request, _delivery, context) => {
      assertInstructions()
      expect(context.trustedExplicitSkill).toBeUndefined()
      expect(currentRuntimePluginSource()?.plugin.path).not.toBe(f.pluginRoot)
      const saver = new SqlJsSaver(checkpointPath)
      try {
        const graph = createGraph(saver, request.threadId)
        const config = { configurable: { thread_id: request.threadId } }
        context.hostUserInputResume!.beforeResume(await graph.getState(config))
        const result = await graph.invoke(new Command({ resume: {
          requestId: context.hostUserInputResume!.requestId
        } }), config)
        expect(result.messages.at(-1)?.content).toBe("Finished after the saved answer")
        context.onRunTerminated?.({ outcome: "success", code: "resumed-original-checkpoint" })
      } finally { await saver.close() }
    })
    let restoreClock: (() => void) | undefined
    let coldStore: HostProjectStore | undefined
    try {
      const operation = f.service.prepare({ projectId: "local-docs", expectedVersion: 1,
        idempotencyKey: "checkpoint", stageInstructions })
      const first = mode === "single" ? await f.service.start(operation.operationId)
        : (await f.service.continue("local-docs", { maxSteps: 1, maxDurationMs: 60_000 })).operations[0]
      expect(first.status).toBe("unknown")
      expect(first.execution?.terminal?.code).toBe("host_user_input_waiting")
      const request = getPendingUserInputForThread(first.execution!.threadId)!
      expect(submitUserInputResponse({ requestId: request.requestId, answers: { choice: {
        questionId: "choice", type: "option", optionIndex: 0, label: "First", description: "First input"
      } } })).toBe(true)
      const intent = inputs.get(request.requestId)?.continuation?.continueIntent
      if (mode === "single") expect(intent).toBeUndefined()
      else expect(intent?.remainingSteps).toBe(1)
      if (mode === "expired") {
        const clock = vi.spyOn(Date, "now").mockReturnValue(intent!.deadlineAt + 1)
        restoreClock = () => clock.mockRestore()
      }
      coldStore = new HostProjectStore(join(f.root, "state.sqlite"))
      expect(coldStore.getOperation(operation.operationId)?.stageInstructions).toBe(stageInstructions)
      const recovered = new HostProjectService(coldStore, new HostPackageSnapshots(join(f.root, "snapshots")),
        (f.service as unknown as { deps: HostProjectServiceDependencies }).deps)
      if (mode === "single") {
        const deps = (f.service as unknown as { deps: HostProjectServiceDependencies }).deps
        const original = deps.assertInputResumeSafe
        for (const change of ["destroyed", "replaced"]) {
          const owner = { destroyed: false }
          let mainWindow = owner
          deps.assertInputResumeSafe = async () => {
            await Promise.resolve()
            if (change === "destroyed") owner.destroyed = true
            else mainWindow = { destroyed: false }
            return { assertCurrent: guard }
          }
          await expect(recovered.resumeInput(operation.operationId, request.requestId, {
            assertAuthority: () => {
              if (mainWindow !== owner || owner.destroyed) throw Error("WINDOW_REVOKED")
            }
          })).rejects.toThrow("WINDOW_REVOKED")
          expect(inputs.get(request.requestId)?.status).toBe("answered")
          expect(inputs.get(request.requestId)?.continuation?.claimed).toBe(false)
          expect(coldStore.getOperation(operation.operationId)?.status).toBe("unknown")
          expect(writes).toBe(1)
        }
        deps.assertInputResumeSafe = original
      }
      const resumed = await recovered.resumeInput(operation.operationId, request.requestId)
      expect(resumed.status).toBe(mode === "continue" ? "transitioned" : "succeeded")
      expect(f.service.get("local-docs")?.stageIndex).toBe(mode === "continue" ? 1 : 0)
      expect(f.service.operations("local-docs")).toHaveLength(1)
      expect(inputs.get(request.requestId)?.continuation?.continueIntent).toEqual(intent)
      expect(resumed.execution?.threadId).toBe(first.execution?.threadId)
      expect(resumed.operationId).toBe(operation.operationId)
      expect(resumed.stageInstructions).toBe(stageInstructions)
      expect(instructionPrompts).toBe(2)
      expect(resumed.receipts.every(receipt => receipt.result === "passed")).toBe(true)
      expect(inputs.get(request.requestId)?.status).toBe("consumed")
      expect(writes).toBe(1)
      expect(guard).toHaveBeenCalledTimes(1)
      await expect(f.service.resumeInput(operation.operationId, request.requestId)).rejects.toThrow("INPUT_RESUME_MISMATCH")
      expect(writes).toBe(1)
    } finally {
      restoreClock?.()
      coldStore?.close()
      configureHostUserInputPersistence(undefined)
      inputs.close()
    }
  })
  it("persists and resumes a question through the actual Host executor and original run bridge", async () => {
    const f = await fixture()
    const inputs = new HostUserInputStore(join(f.root, "user-input.sqlite"))
    configureHostUserInputPersistence({
      store: () => inputs,
      isCurrent: (record) => isHostUserInputRecoverable(record, join(f.root, "state.sqlite"),
        mock.thread, (id) => mock.plugins.some((plugin) => plugin.id === id && plugin.enabled))
    })
    let requestId = ""
    registerAgentRunImplementation(async (request, _delivery, context) => {
      const pending = requestUserInput({ threadId: request.threadId, questions: [{
        id: "choice", header: "Input", question: "Which input should be used?", options: [
          { label: "First", description: "Use the first input" },
          { label: "Second", description: "Use the second input" }
        ]
      }] })
      requestId = getPendingUserInputForThread(request.threadId)!.requestId
      expect(inputs.get(requestId)?.binding.operationId).toBe(operation.operationId)
      expect(inputs.get(requestId)?.status).toBe("waiting")
      expect(submitUserInputResponse({ requestId, answers: { choice: {
        type: "option", questionId: "choice", optionIndex: 0, label: "First", description: "Use the first input"
      } } })).toBe(true)
      await pending
      writeFileSync(join(f.workspace, "document.md"), "Result produced after the actual answer")
      context.onRunTerminated?.({ outcome: "success", code: "answered-original-run" })
    })
    const operation = f.service.prepare({
      projectId: "local-docs", expectedVersion: 1, idempotencyKey: "durable-input"
    })
    try {
      expect((await f.service.start(operation.operationId)).status).toBe("succeeded")
      expect(inputs.get(requestId)?.status).toBe("consumed")
    } finally {
      configureHostUserInputPersistence(undefined)
      inputs.close()
    }
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
    const settled = vi.spyOn(functionSource, "settleProjectRuntimeFunctionSource")
    cleanup.push(() => settled.mockRestore())
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
    expect(settled).not.toHaveBeenCalled()
    expect(mock.closeMcp).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "host-plugin-source" })
    )
    release()
    await expect(pending).resolves.toMatchObject({ status: "succeeded" })
    expect(settled).toHaveBeenCalledExactlyOnceWith(mock.closeMcp.mock.calls[0][0])
  })
  it("keeps ownership unknown when scoped MCP cleanup cannot be confirmed", async () => {
    const f = await fixture(false, false, true)
    const settled = vi.spyOn(functionSource, "settleProjectRuntimeFunctionSource")
    cleanup.push(() => settled.mockRestore())
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
    expect(settled).not.toHaveBeenCalled()
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
  it("checks fresh scope identity without reading adoption history or weakening the Host binding", async () => {
    const { service, workspace } = await fixture()
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      const metadata = JSON.parse(mock.thread!.metadata)
      const history = { adopted: "x".repeat(1024 * 1024) }
      const set = (value: Record<string, unknown>) => {
        mock.thread!.metadata = JSON.stringify(value)
      }
      const valid = { ...metadata, llmFileHistory: history }
      set(valid)
      const fullReads = vi.mocked(getThreadCore).mock.calls.length
      const scopeReads = vi.mocked(getThreadRuntimeScope).mock.calls.length
      expect(currentRuntimePluginSource()?.stageId).toBe("draft")
      expect(context.verifyResolvedThread?.({ workspacePath: workspace, metadata: valid })).toBeNull()
      for (const key of ["projectId", "operationId", "stageId", "pluginDigest"]) {
        set({ ...valid, hostProjectRuntime: { ...metadata.hostProjectRuntime, [key]: "changed" } })
        expect(() => currentRuntimePluginSource()).toThrow("PROJECT_HOST_THREAD_CHANGED")
        set(valid)
        expect(currentRuntimePluginSource()?.stageId).toBe("draft")
      }
      set({ ...valid, workspacePath: join(workspace, "other") })
      expect(() => currentRuntimePluginSource()).toThrow("PROJECT_HOST_THREAD_CHANGED")
      set({ ...valid, cmb_thread_incarnation: "replacement" })
      expect(() => currentRuntimePluginSource()).toThrow("PROJECT_HOST_THREAD_CHANGED")
      set(valid)
      expect(currentRuntimePluginSource()?.stageId).toBe("draft")
      expect(vi.mocked(getThreadRuntimeScope).mock.calls.length).toBeGreaterThan(scopeReads)
      expect(vi.mocked(getThreadCore).mock.calls.length).toBe(fullReads)
      expect(JSON.parse(mock.thread!.metadata).llmFileHistory).toEqual(history)
      writeFileSync(join(workspace, "document.md"), "Actual artifact")
      context.onRunTerminated?.({ outcome: "success", code: "normal" })
    })
    const operation = service.prepare({ projectId: "local-docs", expectedVersion: 1,
      idempotencyKey: "scope-reader" })
    expect((await service.start(operation.operationId)).status).toBe("succeeded")
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
  it("records effect-free physical cancellation without restoring aborted source authority", async () => {
    const { service } = await fixture()
    const entered = Promise.withResolvers<void>()
    const observedAbort = Promise.withResolvers<void>()
    const physicallyStopped = Promise.withResolvers<void>()
    registerAgentRunImplementation(async (_request, _delivery, context) => {
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
      confirmRunCancellationSettlement(true)
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
    expect(mock.cancelWorkflows).toHaveBeenCalledTimes(1)
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
  it.each([false, true])("ordinary Stop uses its original coordinator and rejects late success after effects=%s", async (effect) => {
    const { service } = await fixture()
    const entered = Promise.withResolvers<() => void>()
    const stopped = Promise.withResolvers<void>()
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      if (effect) markRunCancellationEffectDispatched()
      entered.resolve(captureRunCancellationRequest(context.onStopRequested))
      await new Promise<void>((resolve) => {
        context.signal!.addEventListener("abort", () => resolve(), { once: true })
      })
      await stopped.promise
      context.onRunCancelled?.()
      confirmRunCancellationSettlement(true)
      context.onRunTerminated?.({ outcome: "success", code: "late-success" })
    })
    const operation = service.prepare({ projectId: "local-docs", expectedVersion: 1,
      idempotencyKey: `ordinary-stop-${effect}` })
    const pending = service.start(operation.operationId)
    const stop = await entered.promise
    stop()
    expect(service.operations("local-docs")[0]).toMatchObject({ status: "cancel_requested" })
    expect(service.operations("local-docs")[0].execution?.terminal).toBeNull()
    expect(mock.cancelWorkflows).toHaveBeenCalledTimes(1)
    stopped.resolve()
    const result = await pending
    expect(result.status).toBe(effect ? "unknown" : "cancelled")
    expect(result.receipts).toEqual([])
    expect(service.get("local-docs")?.version).toBe(1)
  })
  it.each(["none", "configuration-only", "function"] as const)(
    "requires effect-free preflight as well as physical cancellation for %s sources",
    async (source) => {
      const review = vi.spyOn(functionSource, "assertProjectRuntimeSourceApproved")
        .mockResolvedValue({ name: "docs", digest: "a".repeat(64),
          configurationReady: true, capabilities: [], scannedMethods: [], scanIncomplete: false,
          state: "ready" })
      cleanup.push(() => review.mockRestore())
      const { service } = await fixture(false, false, false, {}, (root) => {
        if (source === "configuration-only") {
          writeFileSync(join(root, "plugin.json"), JSON.stringify({
            name: "docs", version: "1.0.0", skills: "skills",
            userConfig: { note: { type: "string", title: "Note",
              description: "Optional configuration note", required: false } }
          }))
        } else if (source === "function") {
          mkdirSync(join(root, "mods"))
          writeFileSync(join(root, "mods/manifest.json"), JSON.stringify({
            apiVersion: "cmb.mods/v2", id: "docs", entry: "main.ts"
          }))
          writeFileSync(join(root, "mods/main.ts"),
            'export function register(on) { on("tool.describe", () => ({text:"description"})) }')
        }
      })
      const entered = Promise.withResolvers<() => void>()
      registerAgentRunImplementation(async (_request, _delivery, context) => {
        entered.resolve(captureRunCancellationRequest(context.onStopRequested))
        await new Promise<void>((resolve) => {
          context.signal!.addEventListener("abort", () => resolve(), { once: true })
        })
        context.onRunCancelled?.()
        confirmRunCancellationSettlement(true)
        context.onRunTerminated?.({ outcome: "success", code: "late-success" })
      })
      const operation = service.prepare({ projectId: "local-docs", expectedVersion: 1,
        idempotencyKey: `preflight-stop-${source}` })
      const pending = service.start(operation.operationId)
      const stop = await entered.promise
      stop()
      const result = await pending
      expect(review).toHaveBeenCalledTimes(source === "function" ? 1 : 0)
      expect(result.status).toBe(source === "function" ? "unknown" : "cancelled")
      if (source === "function")
        expect(result.execution?.terminal?.code).toBe("cancellation_preflight_unconfirmed")
      expect(result.receipts).toEqual([])
      expect(service.get("local-docs")?.version).toBe(1)
    }
  )
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
      confirmRunCancellationSettlement(true)
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

// Model and captured workflow handles are deterministic here; the separate
// host-workflow-continuation.integration test exercises the original real run manager.
describe("Host managed workflow result turns", () => {
  function declareWorkflow(root: string) {
    const path = join(root, "devclaw.project-runtime.json")
    const manifest = JSON.parse(readFileSync(path, "utf8"))
    manifest.stages[0].executionMode = "workflow"
    writeFileSync(path, JSON.stringify(manifest))
  }
  function originalWorkflow(wait: Promise<void> = Promise.resolve()) {
    let delivered = false
    const fact = {
      runId: "wf_original",
      startedAt: "2026-10-26T00:00:00.000Z",
      assertCurrent: vi.fn(),
      wait: () => wait,
      read: async () => ({
        status: "completed",
        notificationOwner: "managed",
        notificationDelivered: delivered
      })
    }
    mock.captureHostRun.mockReturnValue(fact)
    return {
      fact,
      deliver: () => {
        delivered = true
      }
    }
  }

  it("keeps repeated native notice ownership checks off the source-content read boundary", async () => {
    const f = await fixture(false, false, false, {}, declareWorkflow)
    const original = originalWorkflow()
    const reads = vi.spyOn(HostPackageSnapshots.prototype, "read")
    let turns = 0, readsAtNotification = 0
    try {
      registerAgentRunImplementation(async (request, _delivery, context) => {
        if (++turns === 1) {
          context.onDetachedResultAvailable?.({
            kind: "workflow", threadId: request.threadId, runId: original.fact.runId
          })
        } else {
          const notice = context.hostWorkflowNotification!
          readsAtNotification = reads.mock.calls.length
          for (let index = 0; index < 3; index++) notice.assertCurrent()
          expect(reads.mock.calls.length).toBe(readsAtNotification)
          expect(original.fact.assertCurrent).toHaveBeenCalled()
          const installed = mock.plugins
          mock.plugins = []
          expect(() => notice.assertCurrent()).toThrow("PLUGIN_UNAVAILABLE")
          mock.plugins = installed
          notice.assertCurrent()
          original.deliver()
          writeFileSync(join(f.workspace, "document.md"), "Original notification consumed")
        }
        context.onRunTerminated?.({ outcome: "success", code: "original-notification" })
      })
      const operation = f.service.prepare({ projectId: "local-docs", expectedVersion: 1,
        idempotencyKey: "native-notice-source-boundary" })
      expect((await f.service.start(operation.operationId)).status).toBe("succeeded")
      expect(turns).toBe(2)
      // The original consume/final execution boundaries still revalidate every byte.
      expect(reads.mock.calls.length).toBeGreaterThan(readsAtNotification)
    } finally { reads.mockRestore() }
  })

  it("waits physical workflow settlement before the same-source result turn and original checks", async () => {
    const f = await fixture(false, false, true, {}, declareWorkflow)
    const physical = Promise.withResolvers<void>()
    const waiting = Promise.withResolvers<void>()
    const original = originalWorkflow(physical.promise)
    original.fact.wait = () => {
      waiting.resolve()
      return physical.promise
    }
    let firstSource: unknown
    let firstThread = ""
    let turns = 0
    registerAgentRunImplementation(async (request, _delivery, context) => {
      turns++
      expect(request.agentMode).toBe("workflow")
      expect(JSON.parse(mock.thread!.metadata).agentMode).toBe("workflow")
      expect(hasHostUserInputScope(request.threadId)).toBe(true)
      expect(context.backgroundNotificationOwner).toBe("managed")
      if (turns === 1) {
        firstSource = context.pluginSourceSnapshot
        firstThread = request.threadId
        expect(context.trustedExplicitSkill).toBeDefined()
        context.onDetachedResultAvailable?.({
          kind: "workflow",
          threadId: request.threadId,
          runId: original.fact.runId
        })
        context.onRunTerminated?.({ outcome: "success", code: "launched-original-workflow" })
      } else {
        expect(turns).toBe(2)
        expect(request.threadId).toBe(firstThread)
        expect(context.pluginSourceSnapshot).toBe(firstSource)
        expect(context.trustedExplicitSkill).toBeUndefined()
        expect(context.hostUserInputResume).toBeUndefined()
        expect(context.hostWorkflowNotification).toMatchObject({
          runId: original.fact.runId,
          startedAt: original.fact.startedAt
        })
        expect(mock.closeMcp).not.toHaveBeenCalled()
        context.hostWorkflowNotification!.assertCurrent()
        original.deliver()
        writeFileSync(join(f.workspace, "document.md"), "Model consumed the original result")
        context.onRunTerminated?.({ outcome: "success", code: "consumed-original-workflow" })
      }
    })
    const operation = f.service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "workflow-result"
    })
    const result = f.service.start(operation.operationId)
    await waiting.promise
    expect(turns).toBe(1)
    expect(mock.closeMcp).not.toHaveBeenCalled()
    expect(f.service.operations("local-docs")[0].receipts).toEqual([])
    physical.resolve()
    expect((await result).status).toBe("succeeded")
    expect(turns).toBe(2)
    expect(hasHostUserInputScope(firstThread)).toBe(false)
    expect(mock.closeMcp).toHaveBeenCalledTimes(1)
  })

  it("keeps the same input binding live after workflow effects and never creates a replay checkpoint", async () => {
    const f = await fixture(false, false, false, {}, declareWorkflow)
    const original = originalWorkflow()
    const inputs = new HostUserInputStore(join(f.root, "result-user-input.sqlite"))
    configureHostUserInputPersistence({
      store: () => inputs,
      isCurrent: (record) =>
        isHostUserInputRecoverable(record, join(f.root, "state.sqlite"), mock.thread, (id) =>
          mock.plugins.some((plugin) => plugin.id === id && plugin.enabled)
        )
    })
    let requestId = ""
    let turns = 0
    try {
      registerAgentRunImplementation(async (request, _delivery, context) => {
        expect(hasHostUserInputScope(request.threadId)).toBe(true)
        if (++turns === 1) {
          context.onDetachedResultAvailable?.({
            kind: "workflow",
            threadId: request.threadId,
            runId: original.fact.runId
          })
        } else {
          const questions = [
            {
              id: "choice",
              header: "Input",
              question: "Keep this result?",
              options: [
                { label: "Keep", description: "Keep the original result" },
                { label: "Review", description: "Review the result" }
              ]
            }
          ]
          // Persistence still records the live question; the existing external-effect
          // boundary must prevent a new replayable checkpoint in this result turn.
          expect(
            prepareHostInputInterrupt(request.threadId, "result-question", questions)
          ).toBeUndefined()
          const pending = requestUserInput({ threadId: request.threadId, questions })
          const question = getPendingUserInputForThread(request.threadId)!
          requestId = question.requestId
          expect(inputs.get(requestId)?.binding.operationId).toBe(operation.operationId)
          expect(inputs.get(requestId)?.continuation).toBeUndefined()
          expect(
            submitUserInputResponse({
              requestId: question.requestId,
              answers: {
                choice: {
                  type: "option",
                  questionId: "choice",
                  optionIndex: 0,
                  label: "Keep",
                  description: "Keep the original result"
                }
              }
            })
          ).toBe(true)
          await pending
          original.deliver()
          writeFileSync(join(f.workspace, "document.md"), "Original answer consumed")
        }
        context.onRunTerminated?.({ outcome: "success", code: "original-model" })
      })
      const operation = f.service.prepare({
        projectId: "local-docs",
        expectedVersion: 1,
        idempotencyKey: "workflow-result-live-input"
      })
      expect((await f.service.start(operation.operationId)).status).toBe("succeeded")
      expect(turns).toBe(2)
      expect(mock.captureHostRun).toHaveBeenCalledTimes(1)
      expect(inputs.get(requestId)?.status).toBe("consumed")
      expect(inputs.get(requestId)?.continuation).toBeUndefined()
    } finally {
      configureHostUserInputPersistence(undefined)
      inputs.close()
    }
  })

  it("retains the initial effect veto when Stop arrives only in the final physical cleanup tail", async () => {
    const f = await fixture(false, false, false, {}, declareWorkflow)
    const original = originalWorkflow()
    let turns = 0
    registerAgentRunImplementation(async (request, _delivery, context) => {
      if (++turns === 1) {
        markRunCancellationEffectDispatched()
        context.onDetachedResultAvailable?.({
          kind: "workflow",
          threadId: request.threadId,
          runId: original.fact.runId
        })
      } else {
        const inOriginalResultFrame = AsyncLocalStorage.snapshot()
        const stop = captureRunCancellationRequest(context.onStopRequested)
        // Both foreground models and the notice finish successfully. Stop happens
        // later, so consume's error catch cannot accidentally make this test pass.
        mock.closeMcp.mockImplementationOnce(() =>
          inOriginalResultFrame(() => {
            stop()
            context.onRunCancelled?.()
            confirmRunCancellationSettlement(true)
          })
        )
        original.deliver()
        writeFileSync(join(f.workspace, "document.md"), "Produced before the late Stop")
      }
      context.onRunTerminated?.({ outcome: "success", code: "model-settled" })
    })
    const operation = f.service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "workflow-result-late-stop"
    })
    const result = await f.service.start(operation.operationId)
    expect(result.status).toBe("unknown")
    expect(result.execution?.terminal?.code).toBe("cancellation_settlement_unconfirmed")
    expect(result.receipts).toEqual([])
    expect(turns).toBe(2)
    expect(f.service.get("local-docs")?.version).toBe(1)
  })
})
