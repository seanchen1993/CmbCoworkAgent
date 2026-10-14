import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import { createMiddleware, FakeToolCallingModel } from "langchain"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"
import { captureFunctionConversationNativeTaskConfig, createFunctionConversationSharedAgent } from
  "../agent/mods-conversation-shared-invocation"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { ModsManager, type FunctionNativeConversationRuntime } from "./manager"
import { currentFunctionExecution } from "./v2/execution-context"
import { FunctionConversationCoordinator } from "./v2/conversation-coordinator"
import { projectFunctionSessionApiMessages } from "./v2/session-api-transcript"
import { FunctionSessionAppendTicket } from "./v2/session-append-ticket"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => "", getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] },
  dialog: {}, ipcMain: { handle: () => {} } }))
import * as appDb from "../db"

type Append = NonNullable<Parameters<ModsManager["attachFunctions"]>[0]["appendConversation"]>
interface FixtureWork { cancel(): void; readonly completion: Promise<void> }
const works = new Set<FixtureWork>()
let directory = ""

function tracked(run: (controller: AbortController) => Promise<void>, release?: () => void) {
  const controller = new AbortController()
  const completion = Promise.resolve().then(() => run(controller))
  const work: FixtureWork = { completion, cancel() {
    controller.abort(Error("ACTUAL_SHARED_EPOCH_FIXTURE_CANCELLED"))
    release?.()
  } }
  works.add(work)
  const settled = () => works.delete(work)
  void completion.then(settled, settled)
  return completion
}

async function cancelWorks() {
  const selected = [...works]
  for (const work of selected) work.cancel()
  await Promise.allSettled(selected.map(work => work.completion))
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-shared-epoch-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(cancelWorks)
afterAll(async () => {
  await cancelWorks()
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

/** This probes dispatch selection, without manufacturing a Keeper ACK or PolicySource. */
async function fixture(controller: AbortController, append: Append) {
  const manager = new ModsManager(join(directory, `${randomUUID()}.control.sqlite`),
    () => [], async () => true, () => undefined)
  manager.configure(directory, true, false)
  manager.attachFunctions({ appendConversation: append, invalidate: () => undefined,
    closeThread: () => undefined, close: () => undefined })
  const workspace = manager.workspaceKey(directory), threadId = randomUUID(), runId = randomUUID()
  const signal = controller.signal
  appDb.createThread(threadId, { workspacePath: workspace })
  if (!claimLocalThreadRunLease({ threadId, runId, owner: "desktop" }).acquired)
    throw Error("ACTUAL_SHARED_EPOCH_LEASE_REQUIRED")
  const parent = manager.createRuntimeAuthority({ workspace, threadId, turnId: runId, signal })
  const unbind = manager.bindThread({ workspace, threadId, turnId: runId, signal,
    runtimeAuthority: parent.authority })
  const guard = manager.captureFunctionRuntimeGuard(parent.authority)
  const store = new FunctionConversationStore(appDb.getDb())
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
    assertScope: guard, readCurrentCheckpoint: async () => null,
    protect: async (_context, value, protectionSignal, current) => {
      protectionSignal.throwIfAborted(); current(); return value
    }, apiMessages: projectFunctionSessionApiMessages, changed: () => undefined
  })
  manager.setFunctionConversations(coordinator)
  const closeOwner = coordinator.openConversationOwner({ owner: {}, workspace, threadId,
    readOnly: false, signal, assertCurrent: guard })
  const saver = new SqlJsSaver(join(directory, `${randomUUID()}.graph.sqlite`))
  let parentRun: Promise<unknown> | undefined, cleanup: Promise<void> | undefined
  const parentNodes: Promise<unknown>[] = [], childRuns: Promise<unknown>[] = []
  const captured: FunctionNativeConversationRuntime[] = []
  const outcomes: PromiseSettledResult<unknown>[] = []
  let coreCalls = 0, providerCalls = 0
  const close = () => cleanup ??= (async () => {
    controller.abort(Error("ACTUAL_SHARED_EPOCH_FIXTURE_FINISHED"))
    if (parentRun) await Promise.allSettled([parentRun])
    await Promise.allSettled(parentNodes)
    await Promise.allSettled(childRuns)
    const results = await Promise.allSettled([
      Promise.resolve().then(closeOwner), Promise.resolve().then(unbind),
      Promise.resolve().then(() => parent.release()),
      Promise.resolve().then(() => manager.close()),
      Promise.resolve().then(() => releaseLocalThreadRunLease(threadId, "desktop", runId)),
      Promise.resolve().then(() => saver.close())
    ])
    const failed = results.find(result => result.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
  })()
  try {
    await coordinator.prepareRuntime(workspace, threadId)
    await manager.prepareFunctionConversationRuntime(parent.authority, signal)
    const capture = () => {
      const authority = currentFunctionExecution()?.runtimeAuthority
      if (!authority) throw Error("ACTUAL_CHILD_AUTHORITY_REQUIRED")
      return manager.captureFunctionConversationSharedScope(authority)
    }
    const record = createMiddleware({ name: "actual-child-epoch-dispatch-probe",
      beforeModel: async () => {
        const authority = currentFunctionExecution()?.runtimeAuthority
        if (!authority || authority === parent.authority || authority.agentId === "main")
          throw Error("ACTUAL_CHILD_AUTHORITY_REQUIRED")
        const runtime = manager.captureFunctionNativeConversationRuntime(authority)
        if (!runtime) throw Error("ACTUAL_SHARED_NATIVE_RUNTIME_REQUIRED")
        captured.push(runtime)
        const ticket = new FunctionSessionAppendTicket({ kind: "native", target: runtime.target,
          signal: runtime.signal, assertCurrent: runtime.assertCurrent,
          input: { uuid: randomUUID(), door: "response", origin: { kind: "model", model: "probe" },
            message: { type: "assistant", role: "assistant",
              content: [{ type: "text", text: "actual dispatch probe" }] } },
          protect: async () => { coreCalls++; throw Error("ACTUAL_CORE_NOT_SELECTED") },
          prepare: async () => { throw Error("NO_FIXTURE_COMMIT_PERMISSION") }
        })
        const result = await Promise.allSettled([runtime.dispatch(ticket)])
        outcomes.push(result[0])
        throw Error("ACTUAL_DISPATCH_PROBE_FINISHED")
      },
      wrapModelCall: (request, handler) => { providerCalls++; return handler(request) }
    })
    const child = createFunctionConversationSharedAgent({
      model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [], middleware: [record]
    }, capture)
    const state = Annotation.Root({ messages: Annotation<BaseMessage[]>({
      reducer: (_old, incoming) => incoming, default: () => [] }) })
    const graph = new StateGraph(state).addNode("native-tools", (_state, config) => {
      const nodeRun = (async () => {
        const childRun = manager.withSharedAgent(parent.authority, `mod-task:${randomUUID()}`,
          signal, { blockedToolNames: new Set(), readOnly: false },
          () => child.invoke({ messages: [new HumanMessage("actual child seed")] }, config),
          runId, { type: "same-role", description: "actual epoch probe" },
          { invocation: Object.freeze({}), saver,
            config: captureFunctionConversationNativeTaskConfig(config) })
        childRuns.push(childRun)
        const result = await childRun
        return { messages: result.messages.slice(-1) }
      })()
      parentNodes.push(nodeRun)
      return nodeRun
    }).addEdge(START, "native-tools").addEdge("native-tools", END).compile({ checkpointer: saver })
    return { manager, workspace, threadId, captured, outcomes, close,
      coreCalls: () => coreCalls, providerCalls: () => providerCalls,
      rows: () => captured.flatMap(runtime => store.readRows(runtime.target.ref)),
      start: () => {
        if (parentRun) throw Error("ACTUAL_FIXTURE_INVOKE_ONCE")
        parentRun = graph.invoke({ messages: [new HumanMessage("actual parent seed")] },
          { configurable: { thread_id: threadId }, signal, durability: "async" })
        return parentRun
      }
    }
  } catch (error) {
    await close()
    throw error
  }
}

describe("actual shared child creation epoch", () => {
  it("selects its captured loaded-only lifecycle before core or provider execution", () =>
    tracked(async controller => {
      const sentinel = Error("ACTUAL_CAPTURED_LIFECYCLE_ENTERED")
      const calls: Array<{ workspace: string; threadId: string; ticket: FunctionSessionAppendTicket }> = []
      const f = await fixture(controller, async (workspace, threadId, ticket) => {
        calls.push({ workspace, threadId, ticket })
        throw sentinel
      })
      try {
        const result = await Promise.allSettled([f.start()])
        expect(result[0].status).toBe("rejected")
        expect(calls).toHaveLength(1)
        expect(calls[0].workspace).toBe(f.workspace)
        expect(calls[0].threadId).toBe(f.threadId)
        expect(f.captured).toHaveLength(1)
        expect(f.captured[0].target.ref.kind).toBe("child")
        expect(f.captured[0].destination.threadId).not.toBe(f.threadId)
        expect(f.outcomes).toEqual([{ status: "rejected", reason: sentinel }])
        expect(f.coreCalls()).toBe(0)
        expect(f.providerCalls()).toBe(0)
        expect(f.rows()).toEqual([])
      } finally { await f.close() }
    }))

  it("rejects the original held dispatch after its creation epoch changes without replay", () => {
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
    return tracked(async controller => {
      let lifecycleCalls = 0
      const f = await fixture(controller, async () => {
        lifecycleCalls++
        entered.resolve()
        await released.promise
        return { deny: "explicit fixture denial is not an ACK" }
      })
      try {
        const run = f.start()
        await Promise.race([entered.promise, run.then(
          () => { throw Error("ACTUAL_HELD_LIFECYCLE_NOT_ENTERED") },
          error => { throw error })])
        f.manager.configure(f.workspace, true, false)
        released.resolve()
        expect((await Promise.allSettled([run]))[0].status).toBe("rejected")
        expect(lifecycleCalls).toBe(1)
        expect(f.outcomes).toHaveLength(1)
        const outcome = f.outcomes[0]
        expect(outcome.status).toBe("rejected")
        if (outcome.status !== "rejected") throw Error("ACTUAL_EPOCH_REJECTION_REQUIRED")
        expect(outcome.reason).toMatchObject({ code: "MODS_CALL_SCOPE_CHANGED" })
        expect(f.coreCalls()).toBe(0)
        expect(f.providerCalls()).toBe(0)
        expect(f.rows()).toEqual([])
      } finally { released.resolve(); await f.close() }
    }, () => released.resolve())
  })
})
