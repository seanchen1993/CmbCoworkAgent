import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { runInNewContext } from "node:vm"
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple
} from "@langchain/langgraph-checkpoint"
import ts from "typescript"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))

import * as appDb from "../db"
import { CoordinatorWorkerManager } from "../agent/coordinator-worker-manager"
import { CoordinatorWorkerRestoreIndexStore } from "../agent/coordinator-worker-restore-index"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { nativeFunctionConversationWorkspace } from "../checkpointer/function-conversation-main-recovery"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { readLatestCheckpointTuple } from "../checkpointer/runtime-projection-store"
import { createThreadDisplayMetadataGuard } from "./thread-display-read-retry"
import {
  hasInvalidFunctionConversationTranscriptStamp,
  readFunctionConversationTranscriptStamp
} from "../../shared/mods/v2/conversation-transcript"

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((done) => {
    release = done
  })
  return { promise, release }
}

function productionHandler(scope: object): (event: object, id: string) => Promise<unknown> {
  const source = ts.createSourceFile(
    "threads.ts",
    readFileSync(resolve("src/main/ipc/threads.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true
  )
  const names = new Set([
    "captureThreadDisplayRead",
    "captureLatestCheckpointDisplayRead",
    "assertWorkerCheckpointDisplay"
  ])
  const declarations = source.statements.filter(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text)
  )
  const handlers: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === "ipcMain" &&
      node.expression.name.text === "handle" &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "threads:latest-checkpoint"
    )
      handlers.push(node.arguments[1])
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(declarations).toHaveLength(3)
  expect(handlers).toHaveLength(1)
  const code = ts.transpileModule(
    `${declarations.map((node) => node.getText(source)).join("\n")}
    (${handlers[0].getText(source)})`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }
  ).outputText
  return runInNewContext(code, scope)
}

let root = ""
const managers: CoordinatorWorkerManager[] = []
const stores: CoordinatorWorkerRestoreIndexStore[] = []
const savers: SqlJsSaver[] = []
const gates: Array<ReturnType<typeof deferred>> = []
const links: string[] = []
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cmb-worker-checkpoint-read-"))
  paths.database = join(root, "app.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => {
  const failures: unknown[] = []
  const attempt = async (run: () => unknown | Promise<unknown>) => {
    try {
      await run()
    } catch (reason) {
      failures.push(reason)
    }
  }
  for (const held of gates.splice(0)) held.release()
  for (const manager of managers) await attempt(() => manager.cancelAllWorkersAndWait())
  for (const saver of savers.splice(0)) await attempt(() => saver.close())
  for (const manager of managers.splice(0)) await attempt(() => manager.clear())
  for (const store of stores.splice(0)) await attempt(() => store.waitForIdle())
  for (const link of links.splice(0)) await attempt(() => unlinkSync(link))
  vi.restoreAllMocks()
  await attempt(() => appDb.closeDatabase())
  await attempt(() => {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("cmb-worker-checkpoint-read-")
    )
      throw Error("Only the isolated worker checkpoint fixture may be removed")
    rmSync(root, { recursive: true, force: true })
  })
  if (failures.length)
    throw new AggregateError(failures, "Worker checkpoint fixture cleanup failed")
})

async function fixture(alias = false) {
  const workspace = join(root, "project")
  if (alias) {
    const physical = join(root, "physical-project")
    mkdirSync(physical)
    symlinkSync(physical, workspace, process.platform === "win32" ? "junction" : "dir")
    links.push(workspace)
  } else mkdirSync(workspace)
  const parentId = randomUUID()
  const parent = appDb.createThread(parentId, {
    workspacePath: workspace,
    agentMode: "coordinator"
  })
  const store = new CoordinatorWorkerRestoreIndexStore()
  const manager = new CoordinatorWorkerManager({ restoreIndexStore: store })
  managers.push(manager)
  stores.push(store)
  const worker = manager.startWorker({
    parentThreadId: parentId,
    workspacePath: workspace,
    role: "implementer",
    workload: "read_only",
    description: "Actual checkpoint worker",
    prompt: "Inspect the fixture",
    runner: async () => ({ summary: "Actual worker completed" })
  })
  await manager.waitForWorkers(parentId, { workerId: worker.worker_id })
  await manager.waitForWorkerCleanup(parentId, [worker.worker_id])
  const databasePath = join(root, "worker.sqlite")
  const saver = new SqlJsSaver(databasePath)
  savers.push(saver)
  const checkpoint: Checkpoint = {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    channel_values: {
      messages: [
        {
          id: "worker-user",
          type: "human",
          content: "HIDDEN_WORKER_CONTEXT",
          additional_kwargs: { cmb_visible_user_message: "Visible worker request" }
        },
        { id: "worker-reply", type: "ai", content: "Complete worker reply 完整" }
      ]
    },
    channel_versions: { messages: 1 },
    versions_seen: {}
  }
  const config = { configurable: { thread_id: worker.worker_thread_id, checkpoint_ns: "" } }
  const metadata: CheckpointMetadata<{ writes: Record<string, never> }> = {
    source: "loop",
    step: 1,
    writes: {},
    parents: {}
  }
  await saver.put(config, checkpoint, metadata)
  const sender = Object.assign(new EventEmitter(), { id: 9, mainFrame: {}, isDestroyed: () => false })
  const counters = { ordinaryProjection: 0, nativeProjection: 0, opens: 0 }
  let beforeProjection: (() => Promise<void> | void) | undefined = undefined
  const handler = productionHandler({
    Error,
    AbortController,
    process,
    realpathSync,
    getDb: appDb.getDb,
    getThreadCore: appDb.getThreadCore,
    createThreadDisplayMetadataGuard,
    captureThreadIncarnation,
    matchesThreadIncarnation,
    nativeFunctionConversationWorkspace,
    coordinatorWorkerManager: manager,
    readFunctionConversationTranscriptStamp,
    hasInvalidFunctionConversationTranscriptStamp,
    getThreadCheckpointPath: () => databasePath,
    getDbPath: () => paths.database,
    assertValidCheckpointThreadId: (id: string) => {
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
      return id
    },
    withCheckpointer: async (id: string, run: (value: SqlJsSaver) => Promise<unknown>) => {
      expect(id).toBe(worker.worker_thread_id)
      counters.opens++
      return run(saver)
    },
    readLatestCheckpointTupleInWorker: async (
      actualPath: string,
      id: string,
      ns: string,
      options: NonNullable<Parameters<typeof readLatestCheckpointTuple>[3]>
    ) => {
      expect(actualPath).toBe(databasePath)
      expect(id).toBe(worker.worker_thread_id)
      expect(ns).toBe("")
      expect(options.messageLimit).toBe(500)
      expect(options.messageByteBudget).toBe(1024 * 1024)
      if (options.nativeDisplay) counters.nativeProjection++
      else counters.ordinaryProjection++
      await beforeProjection?.()
      return readLatestCheckpointTuple(actualPath, id, ns, options)
    },
    getModsManager: () => ({ workspaceKey: (value: string) => realpathSync(value) }),
    // Only the old branch selection is observed here; this stub mints no native Source.
    verifyCanonicalCheckpointWorkerDisplay: (value: unknown) => value,
    isCheckpointRuntimeProjectionCancelled: () => false,
    console: { warn: vi.fn() }
  })
  return {
    workspace,
    parentId,
    parent,
    manager,
    worker,
    saver,
    checkpoint,
    config,
    sender,
    counters,
    setBeforeProjection: (run: () => Promise<void> | void) => {
      beforeProjection = run
    },
    readId: (id: string) => handler({ sender }, id),
    read: () => handler({ sender }, worker.worker_thread_id)
  }
}

function messages(
  value: unknown
): Array<{ id: string; content: string; additional_kwargs?: object }> {
  return (value as CheckpointTuple).checkpoint.channel_values.messages as Array<{
    id: string
    content: string
  }>
}

describe("actual coordinator worker checkpoint display read", () => {
  it("reads a completed worker's own bounded checkpoint without an ordinary row or parent proof", async () => {
    const f = await fixture()
    expect(appDb.getThreadCore(f.worker.worker_thread_id)).toBeNull()
    const rawBefore = JSON.stringify(await f.saver.getTuple(f.config))
    const value = await f.read()
    expect(messages(value).map((message) => [message.id, message.content])).toEqual([
      ["worker-user", "Visible worker request"],
      ["worker-reply", "Complete worker reply 完整"]
    ])
    expect(JSON.stringify(value)).not.toContain("HIDDEN_WORKER_CONTEXT")
    expect(f.counters).toEqual({ opens: 1, ordinaryProjection: 1, nativeProjection: 0 })
    expect(JSON.stringify(await f.saver.getTuple(f.config))).toBe(rawBefore)
    expect(f.sender.eventNames()).toEqual([])
  })

  it("captures only actual retained records and supports the original restart restore", async () => {
    const f = await fixture()
    const unknownId = `${f.parentId}__worker__unknown`
    expect(f.manager.captureWorkerCheckpointRead(unknownId)).toBeUndefined()
    await expect(f.readId(unknownId)).rejects.toThrow("MODS_CONVERSATION_DISPLAY_SOURCE_INVALID")
    expect(f.counters.opens).toBe(0)
    const old = f.manager.captureWorkerCheckpointRead(f.worker.worker_thread_id)
    expect(old).toBeDefined()
    f.manager.forgetThread(f.parentId)
    expect(() => old?.assertCurrent()).toThrow()
    expect(f.manager.captureWorkerCheckpointRead(f.worker.worker_thread_id)).toBeUndefined()
    const restored = await f.manager.restoreWorkersForThread({
      parentThreadId: f.parentId,
      workspacePath: f.workspace,
      mode: "recent"
    })
    expect(restored.map((row) => row.worker_thread_id)).toContain(f.worker.worker_thread_id)
    expect(messages(await f.read())[1].id).toBe("worker-reply")
  })

  it.each([
    "recreate",
    "workspace",
    "junction-retarget",
    "forget",
    "navigation",
    "frame",
    "saver-close"
  ] as const)(
    "rejects %s during the real checkpoint read and releases window listeners",
    async (kind) => {
      const f = await fixture(kind === "junction-retarget")
      f.setBeforeProjection(async () => {
        if (kind === "recreate") {
          appDb.deleteThread(f.parentId)
          appDb.createThread(f.parentId, { workspacePath: f.workspace, agentMode: "coordinator" })
        } else if (kind === "workspace") {
          const replacement = join(root, "replacement")
          mkdirSync(replacement)
          appDb.updateThread(f.parentId, {
            metadata: JSON.stringify({
              ...JSON.parse(f.parent.metadata ?? "{}"),
              workspacePath: replacement
            })
          })
        } else if (kind === "junction-retarget") {
          const replacement = join(root, "replacement")
          mkdirSync(replacement)
          unlinkSync(f.workspace)
          symlinkSync(replacement, f.workspace, process.platform === "win32" ? "junction" : "dir")
        } else if (kind === "forget") f.manager.forgetThread(f.parentId)
        else if (kind === "navigation") f.sender.emit("did-start-navigation")
        else if (kind === "frame") f.sender.mainFrame = {}
        else await f.saver.close()
      })
      await expect(f.read()).rejects.toThrow()
      expect(f.sender.eventNames()).toEqual([])
    }
  )

  it("retires a captured terminal record when a true continuation starts", async () => {
    const f = await fixture()
    const old = f.manager.captureWorkerCheckpointRead(f.worker.worker_thread_id)
    const held = deferred(),
      entered = deferred()
    gates.push(held)
    await f.manager.continueWorker({
      parentThreadId: f.parentId,
      workerId: f.worker.worker_id,
      prompt: "Actual continuation",
      runner: async () => {
        entered.release()
        await held.promise
        return { summary: "Continuation finished" }
      }
    })
    await entered.promise
    expect(() => old?.assertCurrent()).toThrow("MODS_CONVERSATION_DISPLAY_SOURCE_INVALID")
    held.release()
    await f.manager.waitForWorkers(f.parentId, { workerId: f.worker.worker_id })
    await f.manager.waitForWorkerCleanup(f.parentId, [f.worker.worker_id])
    expect(f.manager.captureWorkerCheckpointRead(f.worker.worker_thread_id)).toBeDefined()
  })

  it.each(["valid", "invalid"] as const)(
    "rejects unexpected %s canonical markers instead of borrowing parent membership",
    async (kind) => {
      const f = await fixture()
      const marked = {
        ...f.checkpoint,
        id: randomUUID(),
        ts: new Date(Date.parse(f.checkpoint.ts) + 1).toISOString(),
        channel_values: {
          messages: [
            {
              id: "unexpected-native",
              type: "human",
              content: "Canonical raw input",
              additional_kwargs: {
                function_row:
                  kind === "valid"
                    ? {
                        conversationId: "actual",
                        branchId: "branch",
                        uuid: "unexpected-native",
                        sequence: 1,
                        door: "note",
                        messageType: "user",
                        isMeta: true,
                        origin: { kind: "plugin", name: "ActualPlugin" }
                      }
                    : null,
                cmb_visible_user_message: "False safe alias"
              }
            }
          ]
        }
      }
      const metadata: CheckpointMetadata<{ writes: Record<string, never> }> = {
        source: "loop",
        step: 2,
        writes: {},
        parents: {}
      }
      await f.saver.put(f.config, marked, metadata)
      const head = await f.saver.getLatestRuntimeTuple(f.config)
      expect(head?.checkpoint.id).toBe(marked.id)
      await expect(f.read()).rejects.toThrow("MODS_CONVERSATION_DISPLAY_SOURCE_INVALID")
      expect(f.counters.nativeProjection).toBe(0)
      expect(f.sender.eventNames()).toEqual([])
    }
  )

  it("keeps the genuine ordinary-row latest-checkpoint branch on the original native projection", async () => {
    const f = await fixture()
    appDb.createThread(f.worker.worker_thread_id, { workspacePath: f.workspace })
    await f.read()
    expect(f.counters).toEqual({ opens: 1, ordinaryProjection: 0, nativeProjection: 1 })
    expect(f.sender.eventNames()).toEqual([])
  })
})
