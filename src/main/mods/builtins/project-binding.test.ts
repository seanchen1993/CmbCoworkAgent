import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HostProjectStore } from "../../harness-board/project-runtime/host-store"
import {
  hostProjectFixture,
  prepareFixture,
  TEST_FINGERPRINT
} from "../../harness-board/project-runtime/host-fixtures.test-helper"
import { protectFunctionStreamCore } from "../v2/protected-stream-core"
import {
  matchesProjectHostBinding,
  projectHostFacts,
  readBuiltinProjectBinding,
  readBuiltinProjectFacts,
  registerBuiltinProjectBinding,
  registerBuiltinProjectFacts
} from "./project-facts"

const cleanup: Array<() => void> = []
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close())
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "host-binding-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "state.sqlite")
  const store = new HostProjectStore(path)
  cleanup.push(() => store.close())
  store.create(hostProjectFixture(root))
  const prepared = store.prepare(prepareFixture())
  const ticket = store.start(prepared.operationId, TEST_FINGERPRINT)
  store.bindExecutionThread(ticket, "original-thread")
  store.recordResult(ticket, { outcome: "failed", receipts: [] })
  const operation = store.getOperation(prepared.operationId)!
  const project = store.get(operation.projectId)!
  const binding = {
    projectId: project.projectId,
    operationId: operation.operationId,
    stageId: operation.stageId,
    pluginDigest: operation.pluginDigest
  }
  const database = new DatabaseSync(path)
  cleanup.push(() => database.close())
  return { root, store, database, project, operation, binding }
}

describe("exact Host project binding admission", () => {
  it("uses the same original scope predicate as full UI facts, including historical versions", () => {
    const { root, project, operation, binding } = fixture()
    const variants = [
      {
        thread: "original-thread",
        workspace: root,
        scope: binding,
        state: project,
        op: operation,
        valid: true
      },
      {
        thread: "foreign",
        workspace: root,
        scope: binding,
        state: project,
        op: operation,
        valid: false
      },
      {
        thread: "original-thread",
        workspace: join(root, "foreign"),
        scope: binding,
        state: project,
        op: operation,
        valid: false
      },
      ...["projectId", "operationId", "stageId", "pluginDigest"].map((key) => ({
        thread: "original-thread",
        workspace: root,
        scope: { ...binding, [key]: "foreign" },
        state: project,
        op: operation,
        valid: false
      })),
      {
        thread: "original-thread",
        workspace: root,
        scope: binding,
        state: undefined,
        op: operation,
        valid: false
      },
      {
        thread: "original-thread",
        workspace: root,
        scope: binding,
        state: project,
        op: undefined,
        valid: false
      },
      {
        thread: "original-thread",
        workspace: root,
        scope: binding,
        state: project,
        op: { ...operation, pluginDigest: "f".repeat(64) },
        valid: false
      },
      {
        thread: "original-thread",
        workspace: root,
        scope: binding,
        state: { ...project, version: project.version + 1, stageIndex: 1 },
        op: operation,
        valid: true
      }
    ]
    for (const item of variants) {
      expect(
        matchesProjectHostBinding(item.thread, item.workspace, item.scope, item.state, item.op)
      ).toBe(item.valid)
      expect(
        projectHostFacts(
          item.thread,
          item.workspace,
          item.scope,
          item.state,
          item.op ? [item.op] : []
        )?.facts.state === "observed"
      ).toBe(item.valid)
    }
  })

  it("retains the exact recent twenty window and validates unrelated rows without an N+1 read", () => {
    const { store, database, project, operation } = fixture()
    const insert = database.prepare(
      "INSERT INTO host_operations(id,project_id,idempotency_key,status,data) VALUES(?,?,?,?,?)"
    )
    const append = (index: number) => {
      const copy = { ...operation, operationId: `later-${index}`, idempotencyKey: `later-${index}` }
      insert.run(
        copy.operationId,
        project.projectId,
        copy.idempotencyKey,
        copy.status,
        JSON.stringify(copy)
      )
    }
    for (let index = 1; index < 20; index++) append(index)
    const individualRead = vi.spyOn(store, "getOperation")
    expect(store.getRecentBindingOperation(project.projectId, operation.operationId)).toEqual(
      operation
    )
    expect(individualRead).not.toHaveBeenCalled()
    append(20)
    expect(
      store.getRecentBindingOperation(project.projectId, operation.operationId)
    ).toBeUndefined()
    expect(store.getRecentBindingOperation("other-project", "later-20")).toBeUndefined()
    database.prepare("UPDATE host_operations SET data=? WHERE id=?").run("{}", "later-1")
    expect(() => store.getRecentBindingOperation(project.projectId, "later-20")).toThrow()
    expect(() => store.listOperations(project.projectId, 20)).toThrow()
  })

  it("does not discover a runtime or fall back to full UI facts, and fails closed on reader loss", () => {
    const full = vi.fn(() => ({ identity: "ui-only", facts: { state: "unavailable" as const } }))
    cleanup.push(registerBuiltinProjectFacts(full))
    expect(readBuiltinProjectBinding("thread", "workspace", "project")).toBe(false)
    let available = true
    const exact = vi.fn(() => {
      if (!available) throw Error("changed")
      return true
    })
    const stop = registerBuiltinProjectBinding(exact)
    cleanup.push(stop)
    expect(readBuiltinProjectBinding("thread", "workspace", "project")).toBe(true)
    available = false
    expect(readBuiltinProjectBinding("thread", "workspace", "project")).toBe(false)
    expect(full).not.toHaveBeenCalled()
    expect(readBuiltinProjectFacts("thread", "workspace").identity).toBe("ui-only")
    stop()
    expect(readBuiltinProjectBinding("thread", "workspace", "project")).toBe(false)
  })

  it.each(["between chunks", "during publication"])(
    "rechecks the original SQLite binding %s without caching a stream admission",
    async (boundary) => {
      const { store, database, project, operation, binding } = fixture()
      const full = vi.fn(() => {
        throw Error("UI facts must not run in the stream guard")
      })
      cleanup.push(registerBuiltinProjectFacts(full))
      const read = vi.fn((thread: string, workspace: string, projectId: string) =>
        matchesProjectHostBinding(
          thread,
          workspace,
          binding,
          store.get(projectId),
          store.getRecentBindingOperation(projectId, operation.operationId)
        )
      )
      cleanup.push(registerBuiltinProjectBinding(read))
      const guard = () => {
        if (!readBuiltinProjectBinding("original-thread", project.workspace, project.projectId))
          throw Error("CAPABILITY_PROJECT_UNAVAILABLE")
      }
      const revoke = () =>
        database.prepare("DELETE FROM host_operations WHERE id=?").run(operation.operationId)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let publications = 0
      const core = protectFunctionStreamCore(
        async function* () {
          yield { text: "first" }
          yield { text: "second" }
          return null
        },
        async (value) => {
          guard()
          if (++publications === 2 && boundary === "during publication") {
            entered.resolve()
            await release.promise
          }
          guard()
          return value
        },
        guard
      )
      const stream = core({}, { callId: "original", signal: new AbortController().signal })
      expect(await stream.next()).toEqual({ done: false, value: { text: "first" } })
      // Initial entry plus all five original guards surrounding the first frame.
      expect(read).toHaveBeenCalledTimes(6)
      if (boundary === "between chunks") {
        revoke()
        await expect(stream.next()).rejects.toThrow("CAPABILITY_PROJECT_UNAVAILABLE")
      } else {
        const pending = stream.next()
        const rejected = expect(pending).rejects.toThrow("CAPABILITY_PROJECT_UNAVAILABLE")
        await entered.promise
        revoke()
        release.resolve()
        await rejected
      }
      expect(full).not.toHaveBeenCalled()
    }
  )
})
