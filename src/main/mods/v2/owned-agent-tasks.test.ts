import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
const fixture = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs"),
    path = process.getBuiltinModule("node:path")
  const root = fs.mkdtempSync(
    path.join(process.getBuiltinModule("node:os").tmpdir(), "owned-child-")
  )
  const prior = process.env.CMB_COWORK_AGENT_HOME
  process.env.CMB_COWORK_AGENT_HOME = root
  return { root, prior, page: vi.fn() }
})
vi.mock("electron", () => ({
  app: { getPath: () => fixture.root, getName: () => "test" },
  safeStorage: {}
}))
vi.mock("./session-cold-read", () => ({
  readColdFunctionSessionPage: (...args: unknown[]) => fixture.page(...args)
}))
import {
  initializeDatabase,
  closeDatabase,
  createThread,
  deleteThread,
  getThreadCore,
  getDb
} from "../../db"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { OwnedAgentTasks } from "./owned-agent-tasks"
import type { ModGrant } from "../control-store"
import { ModsManager } from "../manager"
import { FunctionDevelopmentSessions, type DevelopmentActivation } from "./development-session"
import { withDevelopmentNativeAuthority } from "./development-native-authority"
import { withFunctionAgentExecution } from "./host-call"
import { withUserViewAction } from "./user-view-action"
import { captureThreadIncarnation } from "../../services/thread-incarnation"
beforeAll(async () => {
  await initializeDatabase()
})
afterAll(async () => {
  await closeDatabase()
  if (fixture.prior === undefined) delete process.env.CMB_COWORK_AGENT_HOME
  else process.env.CMB_COWORK_AGENT_HOME = fixture.prior
  const fs = process.getBuiltinModule("node:fs"),
    path = process.getBuiltinModule("node:path")
  const target = path.resolve(fixture.root),
    temp = path.resolve(process.getBuiltinModule("node:os").tmpdir())
  if (!target.startsWith(temp + path.sep) || !path.basename(target).startsWith("owned-child-"))
    throw Error("UNSAFE_FIXTURE_CLEANUP")
  fs.rmSync(target, { recursive: true, force: true })
})
function task() {
  const registry = new OwnedAgentTasks(),
    parent = randomUUID(),
    child = randomUUID(),
    agentId = randomUUID()
  createThread(parent, { workspacePath: fixture.root })
  createThread(child, {
    workspacePath: fixture.root,
    parentThreadId: parent,
    isInternalFlowRuntime: true
  })
  const grant: ModGrant = {
    workspace: fixture.root,
    modId: "function:test",
    digest: "digest",
    epoch: 1,
    enabled: true
  }
  const controller = new AbortController()
  const finish = registry.start(
    {
      agentId,
      parent,
      child,
      runId: "run",
      status: "running",
      model: "test",
      description: "task",
      startedAt: 1,
      scope: { workspace: fixture.root, readOnly: true, blockedTools: ["write_file"] }
    },
    grant,
    controller
  )
  return { registry, parent, child, agentId, grant, controller, finish }
}
it("keeps exact-source durable history, marks lost controllers unknown and never invents execution", () => {
  const t = task()
  expect(t.registry.status(t.parent, fixture.root, t.grant, t.agentId).status).toBe("running")
  expect(() =>
    t.registry.status(t.parent, fixture.root, { ...t.grant, digest: "other" }, t.agentId)
  ).toThrow("OWNER_CHANGED")
  expect(() => t.registry.status(t.child, fixture.root, t.grant, t.agentId)).toThrow(
    "OWNER_CHANGED"
  )
  expect(new OwnedAgentTasks().status(t.parent, fixture.root, t.grant, t.agentId).status).toBe(
    "unknown"
  )
  expect(t.registry.stop(t.parent, fixture.root, t.grant, t.agentId).stopRequested).toBe(false)
  t.finish({
    answer: "actual result",
    reason: "answer",
    durationMs: 5,
    isAborted: false,
    turnId: "run",
    agentId: t.agentId
  })
  expect(new OwnedAgentTasks().status(t.parent, fixture.root, t.grant, t.agentId)).toMatchObject({
    status: "completed",
    outcome: { answer: "actual result" }
  })
  deleteThread(t.parent)
  expect(getThreadCore(t.child)).toBeNull()
})
it("requests real cancellation and releases completed child evidence with its parent", () => {
  const t = task()
  expect(t.registry.stop(t.parent, fixture.root, t.grant, t.agentId)).toMatchObject({
    stopRequested: true,
    status: "stopping"
  })
  expect(t.controller.signal.aborted).toBe(true)
  t.finish({
    answer: "cancelled",
    reason: "aborted",
    durationMs: 1,
    isAborted: true,
    turnId: "run",
    agentId: t.agentId
  })
  expect(t.registry.status(t.parent, fixture.root, t.grant, t.agentId).status).toBe("unknown")
  deleteThread(t.parent)
  expect(getThreadCore(t.child)).toBeNull()
  expect(() => t.registry.status(t.parent, fixture.root, t.grant, t.agentId)).toThrow("NOT_FOUND")
})
it("aborts a live child on parent deletion without deleting an active runner's checkpoint", () => {
  const t = task()
  claimLocalThreadRunLease({ threadId: t.child, owner: "mods", runId: "run" })
  expect(() => deleteThread(t.parent)).toThrow("MODS_AGENT_CHILD_RUNNING")
  expect(t.controller.signal.aborted).toBe(true)
  expect(getThreadCore(t.child)).not.toBeNull()
  expect(getThreadCore(t.parent)).not.toBeNull()
  releaseLocalThreadRunLease(t.child, "mods", "run")
  t.finish()
  deleteThread(t.parent)
  expect(getThreadCore(t.child)).toBeNull()
})
it("pins bounded pages to owner and checkpoint, including skipped entries without false text", async () => {
  const t = task()
  fixture.page.mockImplementation(async (_id, _signal, input) => ({
    assertLive() {
      /* The page source is controlled; native ownership remains real SQLite. */
    },
    value: {
      checkpointId: "cp",
      messageCount: 4,
      offset: input.offset,
      messages: input.offset ? [{ role: "assistant", text: "actual", toolUses: [] }] : [],
      skippedMessages: input.offset ? 0 : 1,
      partial: true,
      ...(input.offset ? {} : { nextOffset: 2 })
    }
  }))
  const first = await t.registry.messages(
    t.parent,
    fixture.root,
    t.grant,
    t.agentId,
    new AbortController().signal,
    undefined,
    2
  )
  expect(first).toMatchObject({ messages: [], skippedMessages: 1, history: "partial" })
  expect(first.nextCursor).toBeTruthy()
  const second = await t.registry.messages(
    t.parent,
    fixture.root,
    t.grant,
    t.agentId,
    new AbortController().signal,
    first.nextCursor,
    2
  )
  expect(second.messages[0].text).toBe("actual")
  expect(fixture.page.mock.calls.at(-1)?.[2]).toEqual({ offset: 2, limit: 2, checkpointId: "cp" })
  await expect(
    t.registry.messages(
      t.parent,
      fixture.root,
      t.grant,
      t.agentId,
      new AbortController().signal,
      first.nextCursor + "x"
    )
  ).rejects.toThrow("CURSOR_CHANGED")
  deleteThread(t.parent)
})
it("accepts only a claimed intent with current source, parent incarnation and workspace", () => {
  const t = task()
  let sourceLive = true
  t.registry.requestView(t.parent, fixture.root, t.grant, t.agentId, () => {
    if (!sourceLive) throw Error("SOURCE_CHANGED")
  })
  const intent = t.registry.view(t.parent, fixture.root, () => {})!
  expect(intent.agentId).toBe(t.agentId)
  expect(t.registry.view(t.parent, fixture.root, () => {})).toBeNull()
  expect(t.registry.viewRead(t.parent, fixture.root, intent.id, () => {}).value).toEqual(intent)
  expect(() => t.registry.viewRead(t.parent, "other", intent.id, () => {})).toThrow("VIEW_CHANGED")
  sourceLive = false
  expect(() => t.registry.viewRead(t.parent, fixture.root, intent.id, () => {})).toThrow(
    "SOURCE_CHANGED"
  )
  deleteThread(t.parent)
  createThread(t.parent, { workspacePath: fixture.root })
  expect(() => t.registry.viewRead(t.parent, fixture.root, intent.id, () => {})).toThrow(
    "VIEW_CHANGED"
  )
  deleteThread(t.parent)
  expect(getDb()).toBeDefined()
})

it.each(["stop", "source", "narrowing"] as const)(
  "keeps an authorized-real trial's native viewer usable after SDK admission ends, then rejects %s",
  async (kind) => {
    const manager = new ModsManager(
      process.getBuiltinModule("node:path").join(fixture.root, `trial-${randomUUID()}.sqlite`),
      () => [],
      async () => true,
      () => {
        /* No renderer needed for this native authority regression. */
      }
    )
    manager.configure(fixture.root, true, false)
    const workspace = manager.workspaceKey(fixture.root),
      parent = randomUUID(),
      child = randomUUID(),
      agentId = randomUUID()
    const parentRow = createThread(parent, { workspacePath: workspace })
    createThread(child, {
      workspacePath: workspace,
      parentThreadId: parent,
      isInternalFlowRuntime: true
    })
    const runtime = manager.createRuntimeAuthority({ workspace, threadId: parent, turnId: "turn" })
    manager.bindThread({ ...runtime.authority, runtimeAuthority: runtime.authority })
    let activation: DevelopmentActivation | undefined,
      sourceLive = true
    const sourceCurrent = () => {
      if (!sourceLive) throw Error("MODS_DEVELOPMENT_SOURCE_CHANGED")
    }
    const scope = { workspace, threadId: parent, incarnation: captureThreadIncarnation(parentRow) }
    const sessions = new FunctionDevelopmentSessions({
      assertScope: sourceCurrent,
      prepare: async () => ({
        dispose: async () => {
          /* No model guest in this authority fixture. */
        }
      }),
      retire: async () => {
        /* Authority retirement is real; the child has a controlled controller. */
      },
      activate: (next) => {
        activation = next
      },
      changed: () => {
        /* Native assertions read the actual activation. */
      }
    })
    const revision = {
      componentId: "viewer",
      draftId: "draft",
      revision: 1,
      sourcePath: fixture.root,
      bundleDigest: "a".repeat(64),
      compiledDigest: "b".repeat(64),
      turnId: "creation",
      validation: "authorized-real" as const,
      purpose: "Inspect actual owned child",
      capabilities: ["agent.spawn", "agent.status", "agent.messages", "agent.stop", "ui.view"]
    }
    const controller = new AbortController()
    let identity: ModGrant | undefined
    let finish: (() => void) | undefined
    try {
      sessions.stage(scope, revision, sourceCurrent)
      sessions.approve(
        scope,
        revision.componentId,
        revision.compiledDigest,
        revision.capabilities,
        sourceCurrent
      )
      sessions.noteSettled(scope, revision.turnId, "completed")
      await vi.waitFor(() => expect(activation).toBeDefined())
      await withFunctionAgentExecution(
        {
          ...runtime.authority,
          runtimeAuthority: runtime.authority,
          agentId: "main",
          leased: false,
          immediate: true,
          userInitiated: true
        },
        async () => {
          await withDevelopmentNativeAuthority(
            manager.store,
            workspace,
            parent,
            activation!,
            "agent.spawn",
            async (grant) => {
              finish = manager.ownedAgentTasks.start(
                {
                  agentId,
                  parent,
                  child,
                  runId: "native",
                  status: "running",
                  model: "fixture",
                  description: "Owned native row",
                  startedAt: 1,
                  scope: { workspace, readOnly: true, blockedTools: [] }
                },
                grant,
                controller
              )
            }
          )
          await withUserViewAction("trial-viewer", sourceCurrent, () =>
            withDevelopmentNativeAuthority(
              manager.store,
              workspace,
              parent,
              activation!,
              "ui.view",
              async (grant) => {
                identity = grant
                return manager.functionAgentTask(
                  workspace,
                  parent,
                  grant,
                  "ui.view",
                  { agentId },
                  controller.signal,
                  "trial-viewer",
                  sourceCurrent
                )
              }
            )
          )
        }
      )
      // The guest identity is still expired. Only the already admitted native viewer survives.
      expect(() => manager.store.assertGrant(identity!)).toThrow("MODS_DEVELOPMENT_REVOKED")
      const assertInstalledGrant = (grant: ModGrant) => manager.store.assertGrant(grant)
      const intent = manager.ownedAgentTasks.view(parent, workspace, assertInstalledGrant)!
      const entry = manager.ownedAgentTasks.viewRead(
        parent,
        workspace,
        intent.id,
        assertInstalledGrant
      )
      fixture.page.mockResolvedValue({
        assertLive() {
          /* Controlled page bytes; SQLite owner and activation are real. */
        },
        value: {
          checkpointId: "real-owned-record",
          messageCount: 1,
          offset: 0,
          messages: [{ role: "assistant", text: "Retained fixture evidence", toolUses: [] }],
          skippedMessages: 0,
          partial: false
        }
      })
      const page = await manager.ownedAgentTasks.messages(
        parent,
        workspace,
        entry.grant,
        agentId,
        new AbortController().signal
      )
      expect(page.messages[0].text).toBe("Retained fixture evidence")
      expect(manager.ownedAgentTasks.stop(parent, workspace, entry.grant, agentId)).toMatchObject({
        stopRequested: true,
        status: "stopping"
      })
      expect(controller.signal.aborted).toBe(true)
      expect(() => manager.store.assertGrant(entry.grant)).toThrow("MODS_DEVELOPMENT_REVOKED")
      if (kind === "stop") await sessions.stop(scope, revision.componentId, sourceCurrent)
      else if (kind === "source") sourceLive = false
      else {
        sessions.stage(
          scope,
          {
            ...revision,
            revision: 2,
            compiledDigest: "c".repeat(64),
            turnId: "narrow",
            capabilities: []
          },
          sourceCurrent
        )
        sessions.noteSettled(scope, "narrow", "completed")
        await vi.waitFor(() => expect(activation!.revision.revision).toBe(2))
      }
      expect(() =>
        manager.ownedAgentTasks.viewRead(parent, workspace, intent.id, assertInstalledGrant)
      ).toThrow()
    } finally {
      finish?.()
      sessions.close()
      manager.close()
      deleteThread(parent)
    }
  }
)
