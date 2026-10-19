import { randomUUID } from "node:crypto"
import { AsyncResource } from "node:async_hooks"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { FakeChatModel } from "@langchain/core/utils/testing"
import { createAgent } from "langchain"
import { tool } from "@langchain/core/tools"
import { z } from "zod"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => paths.database,
  getOpenworkDir: () => tmpdir(),
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
vi.mock("../harness-board/service", () => ({
  getHarnessCapabilityWorkspaces: () => [],
  getHarnessCapabilityFeatureWorkspace: () => undefined
}))
vi.mock("./local-sandbox", () => ({ LocalSandbox: class {} }))
vi.mock("../services/subagent-session-capture", () => ({
  withSubagentSessionCapture: (_context: unknown, _label: string, run: () => Promise<unknown>) => run(),
  subagentSessionCallbacks: () => []
}))
vi.mock("../services/adoption-tracker", () => ({ setAdoptionContext: vi.fn() }))
import * as db from "../db"
import { createWorkflowChildModsRuntime, readWorkflowChildModsContext } from "./workflow-child-mods-context"
import { readNativeChildModsThread } from "./native-child-mods-context"
import { createHostRuntimeLifecycle } from "./runtime-host-lifecycle"
import { runWorkflowSubagent, type WorkflowSubagentRuntime } from "./workflow/subagent"
import { currentFunctionExecution, withFunctionWriteLease } from "../mods/v2/execution-context"
import { ModsManager } from "../mods/manager"
import { functionFileScope } from "../mods/v2/file-permission-host"
import { captureNativeCapabilityContext } from "../mods/project-capability-context"
import {
  captureRuntimePluginSourceThreadGuard, currentRuntimePluginSource,
  issueRuntimePluginSourceToken, registerRuntimePluginSourceChild, withRuntimePluginSource
} from "../plugins/runtime-source-scope"

let root = ""
const close: Array<() => void> = []
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "workflow-child-mods-"))
  paths.database = join(root, "actual.sqlite")
  await db.initializeDatabase()
})
afterEach(async () => {
  for (const stop of close.splice(0).reverse()) stop()
  await db.closeDatabase()
  rmSync(root, { recursive: true, force: true })
})
function fixture(isolated = false) {
  const workspace = join(root, "project")
  mkdirSync(workspace)
  const fileRoot = isolated ? join(root, "actual-worktree") : workspace
  if (isolated) mkdirSync(fileRoot)
  writeFileSync(join(workspace, "scope.txt"), "parent-source")
  if (isolated) writeFileSync(join(fileRoot, "scope.txt"), "child-worktree")
  const parentThreadId = randomUUID()
  const parent = db.createThread(parentThreadId, { workspacePath: workspace, agentMode: "workflow" })
  const signal = new AbortController()
  return { parentThreadId, parent, workspace, fileRoot, signal,
    childThreadId: randomUUID(), agentId: "actual-workflow-agent" }
}

it.each([
  { isolated: false, mode: undefined }, { isolated: true, mode: undefined },
  { isolated: false, mode: "legacy" }, { isolated: true, mode: "host" }
] as const)("runs an actual Workflow child model with real parent data and its own file root (%j)", async ({ isolated, mode }) => {
  const f = fixture(isolated)
  const token = mode ? issueRuntimePluginSourceToken({
    mode, threadId: "native-source-owner", incarnationKey: "original-incarnation",
    projectId: "original-project", operationId: "original-operation", workspace: f.workspace,
    packageDigest: "a".repeat(64), stageId: "code",
    plugin: { id: "original-uuid", name: "original-source", path: f.workspace, version: "1",
      description: "", author: "", enabled: true, skillCount: 1, mcpServerCount: 0,
      hookCount: 0, createdAt: "", updatedAt: "" }
  }) : undefined
  if (token) withRuntimePluginSource(token, () => {
    close.push(registerRuntimePluginSourceChild("native-source-owner", f.parentThreadId, () => {
      f.signal.signal.throwIfAborted()
    }))
  })
  const manager = new ModsManager(join(root, "control.sqlite"), () => [], async () => true, () => {})
  close.push(() => manager.close())
  manager.configure(f.workspace, true, false)
  const workspace = manager.workspaceKey(f.workspace)
  const grant = manager.store.grant(workspace, "function:source", "digest", true)
  let retire: (() => void) | undefined
  let models = 0
  let captured!: ReturnType<typeof readWorkflowChildModsContext>
  const invokeEffect = vi.fn(async () => ({}))
  const result = await withRuntimePluginSource(token, () => runWorkflowSubagent({
    parentThreadId: f.parentThreadId,
    isRetryableApiError: () => false,
    cleanupThread: async () => { retire?.(); retire = undefined },
    createRuntime: async (actual) => {
      const child = await createWorkflowChildModsRuntime({ ...f,
        childThreadId: actual.threadId, agentId: actual.agentId, signal: actual.abortSignal
      }, async (bindLifecycle) => {
        // Parent attribution is data only; creation cannot inherit any ancestor action.
        expect(currentFunctionExecution()?.userInitiated).toBe(false)
        expect(currentFunctionExecution()?.runtimeAuthority).toBeUndefined()
        expect(db.getThreadCore(actual.threadId)).toBeNull()
        expect(readNativeChildModsThread(actual.threadId).thread?.thread_id).toBe(f.parentThreadId)
        const instance = manager.createRuntimeAuthority({ workspace, threadId: actual.threadId,
          agentId: actual.agentId, turnId: actual.threadId, signal: actual.abortSignal })
        const release = manager.bindThread({ workspace, executionWorkspace: f.fileRoot,
          threadId: actual.threadId, agentId: actual.agentId, turnId: actual.threadId,
          runtimeAuthority: instance.authority, readOnly: true,
          blockedToolNames: new Set(["write_file", "execute"]),
          queryTool: async () => ({ decision: "allow" }), invokeTool: invokeEffect })
        close.push(release, instance.release)
        bindLifecycle(createHostRuntimeLifecycle(instance.authority, actual.abortSignal))
        const capability = captureNativeCapabilityContext(actual.threadId, f.workspace)
        expect(capability.usage).toBe("chat")
        class Model extends FakeChatModel {
          bindTools() { return this }
          async _generate(messages: BaseMessage[]) {
            models++
            captured = readWorkflowChildModsContext(actual.threadId)
            captured!.assertCurrent()
            expect(readNativeChildModsThread(`${actual.threadId}-sibling`).thread).toBeNull()
            captureRuntimePluginSourceThreadGuard(actual.threadId, f.workspace)()
            expect(currentRuntimePluginSource()?.plugin.id).toBe(mode ? "original-uuid" : undefined)
            if (mode) expect(() => captureRuntimePluginSourceThreadGuard("unregistered-sibling", f.workspace))
              .toThrow("LEGACY_CHILD_ADMISSION_REQUIRED")
            capability.assertCurrent()
            expect(currentFunctionExecution()?.runtimeAuthority).toBe(instance.authority)
            expect(currentFunctionExecution()?.userInitiated).toBe(false)
            const scope = functionFileScope(manager, () => { throw Error("cold fallback") }, workspace, actual.threadId)
            expect(scope.workspace).toBe(manager.workspaceKey(f.fileRoot))
            for (const target of ["host:write_file", "host:execute"])
              expect(await scope.queryTool(target, {})).toMatchObject({ decision: "deny" })
            await expect(withFunctionWriteLease(workspace, actual.threadId, async () => {})).rejects.toThrow("MODS_WRITE_REQUIRES_USER_ACTION")
            await expect(manager.invokeFunctionTool(workspace, actual.threadId, grant, "host:execute",
              { command: "must not spawn" }, actual.abortSignal, false, false)).rejects.toThrow("MODS_WRITE_REQUIRES_USER_ACTION")
            const message = ToolMessage.isInstance(messages.at(-1))
              ? new AIMessage(isolated ? "child-worktree" : "parent-source")
              : new AIMessage({ content: "", tool_calls: [{ name: "read_scope", id: "actual-read", args: {}, type: "tool_call" }] })
            return { generations: [{ text: "", message }] }
          }
        }
        const model = createAgent({ model: new Model({}), tools: [tool(async () => {
          const view = readWorkflowChildModsContext(actual.threadId)!
          return readFileSync(join(view.fileRoot, "scope.txt"), "utf8")
        }, { name: "read_scope", description: "Read actual child file root", schema: z.object({}) })] })
        return { preparePrompt: async (prompt) => {
          expect(readNativeChildModsThread(actual.threadId).thread?.thread_id).toBe(f.parentThreadId)
          return prompt
        }, stream: async (input, config) => model.stream(input as Parameters<typeof model.stream>[0], config as Parameters<typeof model.stream>[1]) }
      })
      retire = child.close
      return child.runtime
    }
  }, { prompt: "read scope", agentIndex: 1, label: "actual child", runId: "opaque-run",
    signal: f.signal.signal, singleAttempt: true, strictModel: true }))
  expect(models).toBe(2)
  expect(result.text).toBe(isolated ? "child-worktree" : "parent-source")
  expect(invokeEffect).not.toHaveBeenCalled()
  expect(() => captured!.assertCurrent()).toThrow(/MODS_CALL_SCOPE_EXPIRED|abort/i)
  expect(readWorkflowChildModsContext(f.childThreadId)).toBeUndefined()
  expect(readNativeChildModsThread(f.childThreadId).thread).toBeNull()
})

it.each(["cancel", "rebuild", "workspace", "directory", "close"] as const)("rejects captured child attribution after %s and still calls physical iterator cleanup", async (change) => {
  const f = fixture(true)
  const external = new AsyncResource("outside-workflow")
  close.push(() => { external.emitDestroy() })
  let view!: NonNullable<ReturnType<typeof readWorkflowChildModsContext>>
  let cleaned = 0
  const actual: WorkflowSubagentRuntime = { stream: async () => ({
    [Symbol.asyncIterator]() { return {
      next: async () => {
        view = readWorkflowChildModsContext(f.childThreadId)!
        return { done: false, value: "actual" }
      },
      return: async () => { cleaned++; return { done: true, value: undefined } }
    } }
  }) }
  const child = await createWorkflowChildModsRuntime({ ...f, signal: f.signal.signal }, async () => actual)
  close.push(child.close)
  const stream = await child.runtime.stream({}, {})
  const iterator = stream[Symbol.asyncIterator]()
  expect(await iterator.next()).toMatchObject({ value: "actual" })
  expect(() => external.runInAsyncScope(view.assertCurrent)).not.toThrow()
  expect(external.runInAsyncScope(() => readNativeChildModsThread(f.childThreadId).thread)).toBeNull()
  if (change === "cancel") f.signal.abort()
  else if (change === "rebuild") {
    db.deleteThread(f.parentThreadId)
    db.createThread(f.parentThreadId, { workspacePath: f.workspace, agentMode: "workflow" })
  } else if (change === "workspace") db.updateThread(f.parentThreadId, { metadata: JSON.stringify({ workspacePath: root }) })
  else if (change === "directory") {
    renameSync(f.fileRoot, f.fileRoot + "-old")
    mkdirSync(f.fileRoot)
  } else child.close()
  expect(() => view.assertCurrent()).toThrow()
  await expect(iterator.next()).rejects.toThrow()
  expect(cleaned).toBe(1)
})

it("retires an iterator's captured callbacks while retaining explicit child completion and cleanup", async () => {
  const f = fixture()
  let view!: NonNullable<ReturnType<typeof readWorkflowChildModsContext>>
  const child = await createWorkflowChildModsRuntime({ ...f, signal: f.signal.signal }, async () => ({
    stream: async () => ({ [Symbol.asyncIterator]() { return {
      next: async () => { view = readWorkflowChildModsContext(f.childThreadId)!; return { done: true, value: undefined } }
    } } }),
    completeTurn: async () => { expect(readWorkflowChildModsContext(f.childThreadId)).toBeDefined() }
  }))
  close.push(child.close)
  await (await child.runtime.stream({}, {}))[Symbol.asyncIterator]().next()
  expect(() => view.assertCurrent()).toThrow("MODS_CALL_SCOPE_EXPIRED")
  await child.runtime.completeTurn!({ text: "done", structured: undefined, outputTokens: 1, modelFellBack: false })
  child.close()
  await expect(child.runtime.stream({}, {})).rejects.toThrow("MODS_CALL_SCOPE_EXPIRED")
})
