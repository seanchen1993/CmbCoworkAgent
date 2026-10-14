import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, basename, resolve } from "node:path"
import { HostProjectStore } from "../../harness-board/project-runtime/host-store"
import {
  hostProjectFixture,
  prepareFixture,
  receiptFixture,
  TEST_FINGERPRINT
} from "../../harness-board/project-runtime/host-fixtures.test-helper"
import {
  projectHostFacts,
  readBuiltinProjectFacts,
  registerBuiltinProjectFacts
} from "./project-facts"

describe("readonly project facts", () => {
  it("requires the actual project/workspace/operation/thread binding and never includes goal or files", () => {
    const root = mkdtempSync(join(tmpdir(), "project-facts-"))
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("project-facts-")
    )
      throw Error("Unexpected test cleanup path")
    const store = new HostProjectStore(join(root, "state.sqlite"), () => 1_000_000)
    try {
      store.create(hostProjectFixture(process.cwd()))
      const operation = store.prepare(prepareFixture())
      const ticket = store.start(operation.operationId, TEST_FINGERPRINT)
      store.bindExecutionThread(ticket, "owned-thread")
      store.recordResult(ticket, { outcome: "succeeded", receipts: [receiptFixture(ticket)] })
      const project = store.get("local-docs")!
      const binding = {
        projectId: project.projectId,
        operationId: operation.operationId,
        stageId: "draft",
        pluginDigest: project.pluginDigest
      }
      const read = (id = "owned-thread", workspace = project.workspace, scope = binding) =>
        projectHostFacts(
          id,
          workspace,
          scope,
          store.get(project.projectId),
          store.listOperations(project.projectId, 20)
        )
      expect(read()?.facts).toMatchObject({
        state: "observed",
        checks: { passed: 1 },
        receiptsMatchCurrentVersion: true,
        declaredArtifacts: 1
      })
      if (process.platform === "win32")
        expect(read("owned-thread", project.workspace.toLowerCase())?.facts.state).toBe("observed")
      expect(JSON.stringify(read()?.facts)).not.toContain(project.goal)
      expect(JSON.stringify(read()?.facts)).not.toContain("document.md")
      expect(read()?.review?.evidence.checks[0]).toMatchObject({
        checkId: "document-exists",
        label: "确认成果文件存在（document.md）"
      })
      expect(read("other-thread")).toBeUndefined()
      expect(read("owned-thread", "other-workspace")).toBeUndefined()
      expect(
        read("owned-thread", project.workspace, { ...binding, operationId: "foreign" })
      ).toBeUndefined()
      const before = read()!.identity
      store.transition(ticket.operationId, TEST_FINGERPRINT)
      expect(read()?.facts).toMatchObject({
        receiptsMatchCurrentVersion: false,
        currentStageNumber: 2
      })
      expect(read()!.identity).not.toBe(before)
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
  it("reports unavailable without creating a project runtime", () => {
    expect(readBuiltinProjectFacts("thread", "workspace").facts.state).toBe("unavailable")
    const stop = registerBuiltinProjectFacts(() => undefined)
    try {
      expect(readBuiltinProjectFacts("thread", "workspace").facts.state).toBe("unavailable")
    } finally {
      stop()
    }
  })
  it("keeps an unreadable observation ledger out of the ordinary runtime failure path", () => {
    const stop = registerBuiltinProjectFacts(() => {
      throw Error("malformed metadata")
    })
    try {
      expect(readBuiltinProjectFacts("thread", "workspace")).toEqual({
        identity: "unavailable",
        facts: { state: "unavailable" }
      })
    } finally {
      stop()
    }
  })
})
