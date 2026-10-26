import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HostProjectService, type HostProjectServiceDependencies } from "./host-service"
import { HostPackageSnapshots } from "./package-snapshots"
import { HostProjectStore } from "./host-store"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import { inspectHostProjectExecution } from "./host-execution-inspector"
import { ProjectLibrary } from "./project-library"
import type { ProjectRuntimeManifest } from "../../../shared/project-runtime"
import { readRuntimeScopedFile, runtimeDigest, runtimeDirectoryIdentity } from "./safe-files"

const cleanup: Array<() => void> = []
async function fixture(
  overrides: Partial<HostProjectServiceDependencies> = {},
  configureManifest?: (manifest: ProjectRuntimeManifest) => void
) {
  const root = mkdtempSync(join(tmpdir(), "host-project-service-"))
  const workspace = join(root, "workspace")
  const plugin = join(root, "installed")
  mkdirSync(workspace)
  mkdirSync(plugin)
  const manifest = hostProjectFixture(workspace).manifest
  configureManifest?.(manifest)
  writeFileSync(join(plugin, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "docs", version: "1.0.0" }))
  for (const stage of manifest.stages) {
    mkdirSync(join(plugin, "skills", stage.id), { recursive: true })
    writeFileSync(join(plugin, stage.skill!), `---\nname: ${stage.id}\n---\nOriginal instructions`)
  }
  const store = new HostProjectStore(join(root, "projects.sqlite"))
  cleanup.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const snapshots = new HostPackageSnapshots(join(root, "snapshots"))
  const dependencies: HostProjectServiceDependencies = {
    resolveInstalledPlugin: async () => ({
      installedPluginId: "installation-uuid",
      root: plugin,
      packageId: "docs",
      packageVersion: "1.0.0",
      enabled: true
    }),
    authorize: vi.fn(async () => {}),
    executeSkill: vi.fn(async (context) => {
      expect(context.snapshotRoot).not.toBe(plugin)
      expect(readFileSync(join(context.snapshotRoot, context.skillPath), "utf8")).toContain(
        "Original instructions"
      )
      if (context.operation.stageId === "draft")
        writeFileSync(join(workspace, "document.md"), "A real document")
      return "succeeded" as const
    }),
    ...overrides
  }
  const service = new HostProjectService(store, snapshots, dependencies)
  const project = await service.localCreate({
    projectId: "local-docs",
    name: "Local",
    workspace,
    installedPluginId: "installation-uuid",
    goal: "Write a document"
  })
  return { root, workspace, plugin, project, service, store, snapshots, dependencies }
}
afterEach(() => cleanup.splice(0).forEach((run) => run()))

async function prepareReview(setup: Awaited<ReturnType<typeof fixture>>) {
  const draft = setup.service.prepare({
    projectId: "local-docs",
    expectedVersion: 1,
    idempotencyKey: "draft"
  })
  expect((await setup.service.start(draft.operationId)).status).toBe("succeeded")
  setup.service.transition(draft.operationId)
  const review = setup.service.prepare({
    projectId: "local-docs",
    expectedVersion: 2,
    idempotencyKey: "review"
  })
  setup.service.approve(review.operationId, {
    expectedVersion: 2,
    inputFingerprint: review.inputFingerprint,
    decision: "approved",
    actorId: "user"
  })
  return { draft: setup.store.getOperation(draft.operationId)!, review }
}

describe("production host project adapter", () => {
  it.each(["authorize", "execute"])("rejects stage instructions replaced after the %s await", async phase => {
    const setup = await fixture()
    const operation = setup.service.prepare({ projectId: "local-docs", expectedVersion: 1,
      idempotencyKey: "explicit-instructions", stageInstructions: "  Keep the original boundary  " })
    expect(operation.stageInstructions).toBe("Keep the original boundary")
    expect(() => setup.service.prepare({ projectId: "local-docs", expectedVersion: 1,
      idempotencyKey: "explicit-instructions", stageInstructions: "Changed" }))
      .toThrow("IDEMPOTENCY_CONFLICT")
    const replace = async () => {
      await Promise.resolve()
      const connection = new DatabaseSync(join(setup.root, "projects.sqlite"))
      try {
        const row = connection.prepare("SELECT data FROM host_operations WHERE id=?").get(operation.operationId)!
        const changed = JSON.parse(String(row.data))
        changed.stageInstructions = "Substituted after await"
        connection.prepare("UPDATE host_operations SET data=? WHERE id=?")
          .run(JSON.stringify(changed), operation.operationId)
      } finally { connection.close() }
    }
    let invoked = false
    setup.dependencies.authorize = phase === "authorize" ? replace : async () => {}
    setup.dependencies.executeSkill = async context => {
      invoked = true
      expect(context.stageInstructions).toBe("Keep the original boundary")
      expect(context.project.goal).toBe("Write a document")
      await replace()
      expect(() => context.assertAuthorityCurrent!()).toThrow("STAGE_INSTRUCTIONS_CHANGED")
      context.assertInputsCurrent!()
      return "succeeded"
    }
    if (phase === "authorize") {
      await expect(setup.service.start(operation.operationId)).rejects.toThrow("STAGE_INSTRUCTIONS_CHANGED")
      expect(invoked).toBe(false)
    } else {
      const result = await setup.service.start(operation.operationId)
      expect(result.status).toBe("unknown")
      expect(result.receipts).toEqual([])
      expect(invoked).toBe(true)
    }
    expect(setup.store.get("local-docs")?.goal).toBe("Write a document")
  })

  it.each(["feedback", "decision", "receipt", "target"])(
    "rejects a changed revision %s across the original async authorization boundary", async change => {
      const setup = await fixture({ executeSkill: async context => {
        context.bindThread(`thread-${context.operation.operationId}`)
        writeFileSync(join(context.project.workspace, "document.md"), "Original output")
        context.recordTerminal({ outcome: "success", code: "physical-success" })
        return "succeeded"
      } }, manifest => { manifest.stages[0].resultApproval = "human" })
      const first = setup.service.prepare({ projectId: "local-docs", expectedVersion: 1, idempotencyKey: "first" })
      await setup.service.start(first.operationId)
      setup.service.decideResultApproval(first.operationId, { ...setup.service.resultReview(first.operationId),
        decision: "rejected", actorId: "desktop-user", feedback: "Revise the boundary" })
      setup.service.cancel(first.operationId)
      const retry = setup.service.prepare({ projectId: "local-docs", expectedVersion: 1, idempotencyKey: "retry" })
      let invoked = false
      setup.dependencies.executeSkill = async () => { invoked = true; return "succeeded" }
      setup.dependencies.authorize = async () => {
        await Promise.resolve()
        const connection = new DatabaseSync(join(setup.root, "projects.sqlite"))
        try {
          const id = change === "target" ? retry.operationId : first.operationId
          const row = connection.prepare("SELECT data FROM host_operations WHERE id=?").get(id)!
          const operation = JSON.parse(String(row.data))
          if (change === "feedback") operation.resultApproval.feedback = "Substituted opinion"
          else if (change === "decision") operation.resultApproval.decision = "approved"
          else if (change === "receipt") operation.receipts[0].artifactFingerprint = "f".repeat(64)
          else delete operation.resultFeedbackSource
          connection.prepare("UPDATE host_operations SET data=? WHERE id=?").run(JSON.stringify(operation), id)
        } finally { connection.close() }
      }
      await expect(setup.service.start(retry.operationId)).rejects.toThrow(
        change === "decision" ? "RESULT_FEEDBACK_INVALID" : change === "receipt"
          ? "RESULT_APPROVAL_MISMATCH" : "RESULT_FEEDBACK_CHANGED")
      expect(invoked).toBe(false)
    }
  )

  it("keeps the native revision binding live across Skill awaits and fails closed on a replaced rejection", async () => {
    let running = false
    let databasePath = ""
    const setup = await fixture({ executeSkill: async context => {
      context.bindThread(`thread-${context.operation.operationId}`)
      if (running) {
        expect(context.previousResultFeedback?.feedback).toBe("Use the original source")
        expect(Object.isFrozen(context.previousResultFeedback)).toBe(true)
        await Promise.resolve()
        const connection = new DatabaseSync(databasePath)
        try {
          const id = context.previousResultFeedback!.operationId
          const row = connection.prepare("SELECT data FROM host_operations WHERE id=?").get(id)!
          const original = JSON.parse(String(row.data))
          original.resultApproval.feedback = "Changed while running"
          connection.prepare("UPDATE host_operations SET data=? WHERE id=?").run(JSON.stringify(original), id)
        } finally { connection.close() }
        expect(() => context.assertAuthorityCurrent!()).toThrow("RESULT_FEEDBACK_CHANGED")
        context.assertAuthorityCurrent!()
      }
      writeFileSync(join(context.project.workspace, "document.md"), "Original output")
      context.recordTerminal({ outcome: "success", code: "physical-success" })
      return "succeeded"
    } }, manifest => { manifest.stages[0].resultApproval = "human" })
    databasePath = join(setup.root, "projects.sqlite")
    const first = setup.service.prepare({ projectId: "local-docs", expectedVersion: 1, idempotencyKey: "first" })
    await setup.service.start(first.operationId)
    setup.service.decideResultApproval(first.operationId, { ...setup.service.resultReview(first.operationId),
      decision: "rejected", actorId: "desktop-user", feedback: "Use the original source" })
    setup.service.cancel(first.operationId)
    const retry = setup.service.prepare({ projectId: "local-docs", expectedVersion: 1, idempotencyKey: "retry" })
    running = true
    const result = await setup.service.start(retry.operationId)
    expect(result.status).toBe("unknown")
    expect(result.receipts).toEqual([])
  })

  it.each(["destroyed", "replaced"])("does not start validation after its desktop window is %s during authorization", async change => {
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const owner = { destroyed: false }
    let mainWindow = owner
    const setup = await fixture({ authorize: async () => {
      entered()
      await new Promise<void>(resolve => { release = resolve })
    } })
    const operation = setup.service.prepare({ projectId: "local-docs", expectedVersion: 1,
      idempotencyKey: "window-validation" })
    const before = setup.store.getOperation(operation.operationId)
    const running = setup.service.validate(operation.operationId, () => {
      if (mainWindow !== owner || owner.destroyed) throw Error("WINDOW_REVOKED")
    })
    await waiting
    if (change === "destroyed") owner.destroyed = true
    else mainWindow = { destroyed: false }
    release()
    await expect(running).rejects.toThrow("WINDOW_REVOKED")
    expect(setup.store.getOperation(operation.operationId)).toEqual(before)
    expect(setup.dependencies.executeSkill).not.toHaveBeenCalled()
  })

  it("keeps post-execution approval separate, durable and bound to the actual output", async () => {
    const setup = await fixture({}, (manifest) => {
      manifest.stages[0].approval = "human"
      manifest.stages[0].resultApproval = "human"
    })
    const operation = setup.service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "result"
    })
    setup.service.approve(operation.operationId, {
      expectedVersion: 1,
      inputFingerprint: operation.inputFingerprint,
      decision: "approved",
      actorId: "user"
    })
    expect((await setup.service.start(operation.operationId)).status).toBe("succeeded")
    expect(() => setup.service.transition(operation.operationId)).toThrow(
      "RESULT_APPROVAL_REQUIRED"
    )
    const review = setup.service.resultReview(operation.operationId)
    const decision = { ...review, decision: "approved" as const, actorId: "reviewer" }
    setup.service.decideResultApproval(operation.operationId, decision)
    expect(
      setup.service.decideResultApproval(operation.operationId, decision).resultApproval
    ).toMatchObject(decision)
    const cold = new HostProjectStore(join(setup.root, "projects.sqlite"))
    try {
      expect(cold.getOperation(operation.operationId)?.resultApproval).toMatchObject(decision)
    } finally {
      cold.close()
    }
    writeFileSync(join(setup.workspace, "document.md"), "Revised after approval")
    expect(() => setup.service.transition(operation.operationId)).toThrow("EVIDENCE_STALE")
    expect(setup.service.get("local-docs")?.version).toBe(1)
  })

  it("binds optional unchecked outputs too and refuses stale or conflicting decisions", async () => {
    const setup = await fixture({}, (manifest) => {
      manifest.stages[0].resultApproval = "human"
      manifest.artifacts.push({ id: "note", path: "note.md", required: false })
      manifest.stages[0].artifactIds.push("note")
    })
    const result = await setup.service.continue("local-docs")
    expect(result.reason).toBe("result_approval_required")
    const operation = result.operations[0]
    const review = setup.service.resultReview(operation.operationId)
    writeFileSync(join(setup.workspace, "note.md"), "Additional output")
    expect(() =>
      setup.service.decideResultApproval(operation.operationId, {
        ...review,
        decision: "approved",
        actorId: "user"
      })
    ).toThrow("RESULT_APPROVAL_MISMATCH")
    const current = setup.service.resultReview(operation.operationId)
    setup.service.decideResultApproval(operation.operationId, {
      ...current,
      decision: "rejected",
      actorId: "user"
    })
    expect(setup.store.getOperation(operation.operationId)?.status).toBe("succeeded")
    expect((await setup.service.continue("local-docs")).reason).toBe("result_rejected")
    expect(() =>
      setup.service.decideResultApproval(operation.operationId, {
        ...current,
        decision: "approved",
        actorId: "user"
      })
    ).toThrow("RESULT_APPROVAL_ALREADY_DECIDED")
    expect(setup.dependencies.executeSkill).toHaveBeenCalledTimes(1)
  })

  it("continues with per-stage authorization, stops at budgets, and resumes without replay", async () => {
    const setup = await fixture({}, (manifest) => {
      manifest.stages.forEach((stage) => {
        stage.approval = "none"
      })
    })
    const beforeStart = vi.fn()
    expect((await setup.service.continue("local-docs", { maxSteps: 1, beforeStart })).reason).toBe(
      "budget"
    )
    expect(setup.service.get("local-docs")?.version).toBe(2)
    expect((await setup.service.continue("local-docs", { beforeStart })).reason).toBe("completed")
    expect(beforeStart).toHaveBeenCalledTimes(2)
    expect(setup.dependencies.authorize).toHaveBeenCalledTimes(2)
    expect(setup.dependencies.executeSkill).toHaveBeenCalledTimes(2)
    expect((await setup.service.continue("local-docs")).operations).toEqual([])
  })

  it("does not commit an already approved result after caller revocation during input preparation", async () => {
    let revoked = false, revokeDuringPreparation = false
    const setup = await fixture({
      prepareInputIdentity: async () => {
        if (revokeDuringPreparation) {
          await Promise.resolve()
          revoked = true
        }
      }
    }, manifest => { manifest.stages[0].resultApproval = "human" })
    const first = await setup.service.continue("local-docs")
    const operation = first.operations[0]
    setup.service.decideResultApproval(operation.operationId, {
      ...setup.service.resultReview(operation.operationId), decision: "approved", actorId: "user"
    })
    revokeDuringPreparation = true
    const beforeStart = vi.fn()
    const result = await setup.service.continue("local-docs", {
      beforeStart, assertAuthority: () => { if (revoked) throw Error("CALLER_REVOKED") }
    })
    expect(result.reason).toBe("blocked")
    expect(result.error).toBe("CALLER_REVOKED")
    expect(setup.service.get("local-docs")?.version).toBe(1)
    expect(setup.store.getOperation(operation.operationId)?.status).toBe("succeeded")
    expect(beforeStart).not.toHaveBeenCalled()
    expect(setup.dependencies.executeSkill).toHaveBeenCalledTimes(1)
  })

  it("rechecks caller authority after the asynchronous beforeStart callback", async () => {
    const setup = await fixture()
    let revoked = false
    const result = await setup.service.continue("local-docs", {
      beforeStart: async () => { await Promise.resolve(); revoked = true },
      assertAuthority: () => { if (revoked) throw Error("CALLER_REVOKED") }
    })
    expect(result.reason).toBe("blocked")
    expect(result.error).toBe("CALLER_REVOKED")
    expect(setup.dependencies.executeSkill).not.toHaveBeenCalled()
    expect(setup.service.get("local-docs")?.version).toBe(1)
  })

  it("retains an uncertain execution without committing when the caller is revoked during work", async () => {
    let revoked = false
    const setup = await fixture({ executeSkill: async context => {
      context.assertInputsCurrent!()
      writeFileSync(join(context.project.workspace, "document.md"), "Execution actually wrote this")
      revoked = true
      await Promise.resolve()
      context.assertInputsCurrent!()
      return "succeeded"
    } })
    const result = await setup.service.continue("local-docs", {
      assertAuthority: () => { if (revoked) throw Error("CALLER_REVOKED") }
    })
    expect(result.reason).toBe("blocked")
    expect(setup.service.get("local-docs")?.version).toBe(1)
    expect(readFileSync(join(setup.workspace, "document.md"), "utf8")).toBe("Execution actually wrote this")
    expect(setup.service.operations("local-docs")[0].status).toBe("unknown")
  })

  it("stops before human authorization and continues after an explicit result decision", async () => {
    const setup = await fixture({}, (manifest) => {
      manifest.stages[0].resultApproval = "human"
    })
    const first = await setup.service.continue("local-docs")
    expect(first.reason).toBe("result_approval_required")
    const operation = first.operations[0]
    setup.service.decideResultApproval(operation.operationId, {
      ...setup.service.resultReview(operation.operationId),
      decision: "approved",
      actorId: "user"
    })
    const next = await setup.service.continue("local-docs")
    expect(next.reason).toBe("approval_required")
    expect(next.project.version).toBe(2)
    expect(next.operations.at(-1)?.approval).toBeNull()
    expect(setup.dependencies.executeSkill).toHaveBeenCalledTimes(1)
  })

  it.each(["failed", "unknown", "cancelled"] as const)(
    "never replays a %s operation during continuation",
    async (outcome) => {
      const executeSkill = vi.fn(async () => outcome)
      const setup = await fixture({ executeSkill })
      expect((await setup.service.continue("local-docs")).reason).toBe(outcome)
      expect((await setup.service.continue("local-docs")).reason).toBe(outcome)
      expect(executeSkill).toHaveBeenCalledTimes(1)
      expect(setup.service.get("local-docs")?.version).toBe(1)
    }
  )

  it("stops when authorization is revoked between stages", async () => {
    const authorize = vi.fn(async () => {
      if (authorize.mock.calls.length === 2) throw new Error("AUTHORITY_REVOKED")
    })
    const setup = await fixture({ authorize }, (manifest) => {
      manifest.stages.forEach((stage) => {
        stage.approval = "none"
      })
    })
    const result = await setup.service.continue("local-docs")
    expect(result.reason).toBe("blocked")
    expect(result.error).toContain("AUTHORITY_REVOKED")
    expect(result.project.version).toBe(2)
    expect(setup.dependencies.executeSkill).toHaveBeenCalledTimes(1)
  })

  it("resumes a persisted result decision without executing the completed stage again", async () => {
    const setup = await fixture({}, (manifest) => {
      manifest.stages[0].resultApproval = "human"
      manifest.stages[1].approval = "none"
    })
    const waiting = await setup.service.continue("local-docs")
    expect(waiting.reason).toBe("result_approval_required")
    const id = waiting.operations[0].operationId
    const coldStore = new HostProjectStore(join(setup.root, "projects.sqlite"))
    try {
      const cold = new HostProjectService(coldStore, setup.snapshots, setup.dependencies)
      expect((await cold.continue("local-docs")).reason).toBe("result_approval_required")
      cold.decideResultApproval(id, {
        ...cold.resultReview(id),
        decision: "approved",
        actorId: "user"
      })
      expect((await cold.continue("local-docs")).reason).toBe("completed")
      expect(setup.dependencies.executeSkill).toHaveBeenCalledTimes(2)
    } finally {
      coldStore.close()
    }
  })

  it("admits only one continuation while a stage is physically executing", async () => {
    let release!: () => void
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const executeSkill = vi.fn(async (context) => {
      markEntered()
      await pending
      writeFileSync(join(context.project.workspace, "document.md"), "Actual result")
      return "succeeded" as const
    })
    const setup = await fixture({ executeSkill })
    const running = setup.service.continue("local-docs", { maxSteps: 1 })
    await entered
    expect((await setup.service.continue("local-docs")).reason).toBe("busy")
    release()
    expect((await running).reason).toBe("budget")
    expect(executeSkill).toHaveBeenCalledTimes(1)
  })

  it("keeps routine authority free of package and knowledge reads while rechecking full inputs at execution settlement", async () => {
    let revision = 1, contentRevision = 1
    const inputIdentity = vi.fn(() => `content:${contentRevision}`)
    const inputAuthorityIdentity = vi.fn(() => `configuration:${revision}`)
    const setup = await fixture({ inputIdentity, captureInputAuthorityIdentity: () => inputAuthorityIdentity, executeSkill: async context => {
      const fullReads = inputIdentity.mock.calls.length
      for (let i = 0; i < 50; i++) context.assertAuthorityCurrent!()
      expect(inputIdentity).toHaveBeenCalledTimes(fullReads)
      revision = 2
      expect(() => context.assertAuthorityCurrent!()).toThrow("INPUT_CHANGED")
      revision = 1
      contentRevision = 2
      expect(() => context.assertAuthorityCurrent!()).not.toThrow()
      expect(() => context.assertInputsCurrent!()).toThrow("INPUT_CHANGED")
      return "succeeded"
    } })
    const operation = setup.service.prepare({ projectId: "local-docs", expectedVersion: 1, idempotencyKey: "authority-content" })
    expect((await setup.service.start(operation.operationId)).status).toBe("unknown")
    expect(setup.service.operations("local-docs")[0].receipts).toEqual([])
  })
  it.each(["configuration", "rules", "knowledge"])("binds %s versions through approval, execution and transition", async (kind) => {
    let revision = 1
    let captured: (() => void) | undefined
    const prepareInputIdentity=vi.fn(async()=>{})
    const setup=await fixture({prepareInputIdentity,inputIdentity:()=>`${kind}:${revision}`,
      executeSkill:async(context)=>{
        captured=context.assertInputsCurrent
        captured!()
        writeFileSync(join(context.project.workspace,"document.md"),"actual document")
        return "succeeded"
      }})
    const prepare=(id:string)=>setup.service.prepare({projectId:"local-docs",expectedVersion:1,idempotencyKey:id})
    const stale=prepare("stale")
    revision++
    expect(()=>setup.service.approve(stale.operationId,{expectedVersion:1,inputFingerprint:stale.inputFingerprint,
      decision:"approved",actorId:"user"})).toThrow("INPUT_CHANGED")
    await expect(setup.service.start(stale.operationId)).rejects.toThrow("INPUT_CHANGED")
    expect(setup.store.getOperation(stale.operationId)?.status).toBe("failed")
    const current=prepare("current")
    const completed=await setup.service.start(current.operationId)
    expect(completed.status).toBe("succeeded")
    expect(()=>captured!()).toThrow("OPERATION_SCOPE_CHANGED")
    revision++
    expect(()=>setup.service.transition(current.operationId)).toThrow("EVIDENCE_STALE")
    expect(setup.service.get("local-docs")?.stageIndex).toBe(0)
    expect(prepareInputIdentity).toHaveBeenCalledTimes(3)
  })
  it("does not publish a receipt when a captured configuration changes during the original Skill",async()=>{
    let revision=1
    const setup=await fixture({inputIdentity:()=>`configuration:${revision}`,executeSkill:async(context)=>{
      context.assertInputsCurrent!()
      writeFileSync(join(context.project.workspace,"document.md"),"actual write")
      revision++
      expect(()=>context.assertInputsCurrent!()).toThrow("INPUT_CHANGED")
      return "succeeded"
    }})
    const operation=setup.service.prepare({projectId:"local-docs",expectedVersion:1,idempotencyKey:"config-race"})
    const result=await setup.service.start(operation.operationId)
    expect(result).toMatchObject({status:"unknown",receipts:[]})
  })

  it("revokes a main-only input fence after the physical stage has settled", async () => {
    let captured: (() => void) | undefined
    let authority: (() => void) | undefined
    const fence = vi.fn()
    const setup = await fixture({ executeSkill: async (context) => {
      captured = context.assertInputsCurrent
      authority = context.assertAuthorityCurrent
      captured!()
      writeFileSync(join(context.project.workspace, "document.md"), "actual stage output")
      return "succeeded"
    } })
    const operation = setup.service.prepare({ projectId: "local-docs", expectedVersion: 1,
      idempotencyKey: "native-fence" })
    await expect(setup.service.start(operation.operationId, { assertInputsCurrent: fence }))
      .resolves.toMatchObject({ status: "succeeded" })
    expect(fence).toHaveBeenCalled()
    expect(() => captured!()).toThrow("PROJECT_HOST_OPERATION_SCOPE_CHANGED")
    expect(() => authority!()).toThrow("PROJECT_HOST_OPERATION_SCOPE_CHANGED")
  })
  it("retains the caller fence in routine authority checks before any later input read", async () => {
    let current = true
    const inputIdentity = vi.fn(() => "unchanged-inputs")
    const setup = await fixture({ inputIdentity, executeSkill: async context => {
      const fullReads = inputIdentity.mock.calls.length
      context.assertAuthorityCurrent!()
      current = false
      expect(() => context.assertAuthorityCurrent!()).toThrow("CALLER_REVOKED")
      expect(inputIdentity).toHaveBeenCalledTimes(fullReads)
      return "succeeded"
    } })
    const operation = setup.service.prepare({ projectId: "local-docs", expectedVersion: 1,
      idempotencyKey: "caller-authority" })
    const result = await setup.service.start(operation.operationId, { assertInputsCurrent: () => {
      if (!current) throw Error("CALLER_REVOKED")
    } })
    expect(result).toMatchObject({ status: "unknown", receipts: [] })
  })
  it.each(["unchanged", "configuration", "knowledge", "explicit-input"])(
    "checks %s at cancellation settlement without restoring ordinary authority",
    async (change) => {
      let configuration = 1
      let knowledge = 1
      let explicitInput = true
      let settledGuard: (() => void) | undefined
      const entered = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      const setup = await fixture({
        inputIdentity: () => `knowledge:${knowledge}`,
        captureInputAuthorityIdentity: () => () => `configuration:${configuration}`,
        executeSkill: async (context) => {
          settledGuard = context.assertSettlementCurrent
          entered.resolve()
          await released.promise
          expect(context.signal.aborted).toBe(true)
          expect(() => context.assertAuthorityCurrent!()).toThrow("OPERATION_SCOPE_CHANGED")
          expect(() => context.assertInputsCurrent!()).toThrow("OPERATION_SCOPE_CHANGED")
          if (change === "unchanged") expect(() => settledGuard!()).not.toThrow()
          else expect(() => settledGuard!()).toThrow()
          return "cancelled"
        }
      })
      const operation = setup.service.prepare({
        projectId: "local-docs", expectedVersion: 1, idempotencyKey: `cancel-${change}`
      })
      const completion = setup.service.start(operation.operationId, { assertInputsCurrent: () => {
        if (!explicitInput) throw Error("COMPOSITION_INPUTS_CHANGED")
      } })
      await entered.promise
      expect(setup.service.cancel(operation.operationId).status).toBe("cancel_requested")
      if (change === "configuration") configuration++
      if (change === "knowledge") knowledge++
      if (change === "explicit-input") explicitInput = false
      released.resolve()
      const result = await completion
      expect(result.status).toBe(change === "unchanged" ? "cancelled" : "unknown")
      expect(result.receipts).toEqual([])
      expect(setup.service.get("local-docs")?.version).toBe(1)
      expect(() => settledGuard!()).toThrow("OPERATION_SCOPE_CHANGED")
    }
  )
  it("retains an uncertain stage when explicit input changes during execution", async () => {
    let current = true
    const setup = await fixture({ executeSkill: async (context) => {
      writeFileSync(join(context.project.workspace, "document.md"), "effect already happened")
      current = false
      return "succeeded"
    } })
    const operation = setup.service.prepare({ projectId: "local-docs", expectedVersion: 1,
      idempotencyKey: "changed-native-input" })
    const settled = await setup.service.start(operation.operationId, { assertInputsCurrent: () => {
      if (!current) throw Error("COMPOSITION_INPUTS_CHANGED")
    } })
    expect(settled.status).toBe("unknown")
    expect(settled.receipts).toEqual([])
    expect(() => setup.service.transition(operation.operationId)).toThrow()
  })
  it.each([false, true])(
    "safely releases a retained old prepared fingerprint (approved=%s)",
    async (approved) => {
      const setup = await fixture()
      const draft = setup.service.prepare({
        projectId: "local-docs",
        expectedVersion: 1,
        idempotencyKey: "draft"
      })
      await setup.service.start(draft.operationId)
      const project = setup.service.transition(draft.operationId)
      // Previous builds included the current editable output in the prepared input digest.
      const oldFingerprint = runtimeDigest(
        JSON.stringify({
          goal: project.goal,
          projectId: project.projectId,
          workspace: runtimeDirectoryIdentity(project.workspace),
          version: project.version,
          stage: "review",
          pluginDigest: project.pluginDigest,
          files: [
            ["document.md", readRuntimeScopedFile(project.workspace, "document.md").fingerprint]
          ]
        })
      )
      const old = setup.store.prepare({
        projectId: project.projectId,
        expectedVersion: 2,
        stageId: "review",
        idempotencyKey: "retained-old-review",
        inputFingerprint: oldFingerprint
      })
      const approval = {
        expectedVersion: 2,
        inputFingerprint: oldFingerprint,
        decision: "approved" as const,
        actorId: "user"
      }
      if (approved) {
        setup.store.decideApproval(old.operationId, approval)
        await expect(setup.service.start(old.operationId)).rejects.toThrow("INPUT_CHANGED")
        expect(setup.store.getOperation(old.operationId)?.status).toBe("failed")
      } else {
        expect(() => setup.service.approve(old.operationId, approval)).toThrow("INPUT_CHANGED")
        expect(setup.service.cancel(old.operationId).status).toBe("cancelled")
      }
      const retry = setup.service.prepare({
        projectId: project.projectId,
        expectedVersion: 2,
        idempotencyKey: "explicit-new-review"
      })
      expect(retry.status).toBe("prepared")
      expect(retry.inputFingerprint).not.toBe(oldFingerprint)
      expect(setup.service.get(project.projectId)?.version).toBe(2)
    }
  )
  it("validates review edits with new receipts without upgrading old evidence or knowledge", async () => {
    const original = "Original draft"
    const revised = "Reviewed and corrected draft"
    const setup = await fixture({
      executeSkill: async (context) => {
        writeFileSync(
          join(context.project.workspace, "document.md"),
          context.operation.stageId === "draft" ? original : revised
        )
        return "succeeded"
      }
    })
    const { draft, review } = await prepareReview(setup)
    const receiptsBeforeReview = structuredClone(draft.receipts)
    const result = await setup.service.start(review.operationId)
    expect(result.status).toBe("succeeded")
    expect(result.receipts[0].artifactFingerprint).not.toBe(draft.receipts[0].artifactFingerprint)
    expect(setup.store.getOperation(draft.operationId)?.receipts).toEqual(receiptsBeforeReview)
    const library = new ProjectLibrary(join(setup.root, "library.sqlite"))
    try {
      const project = setup.service.get("local-docs")!
      expect(() =>
        library.capture(project, draft, {
          kind: "knowledge",
          title: "Old draft",
          note: ""
        })
      ).toThrow("EVIDENCE_STALE")
      const captured = library.capture(project, result, {
        kind: "knowledge",
        title: "Corrected draft",
        note: ""
      })
      expect(library.read(project.projectId, captured.id, "document.md").text).toBe(revised)
      writeFileSync(join(setup.workspace, "document.md"), "Changed after review validation")
      expect(() => setup.service.transition(review.operationId)).toThrow("EVIDENCE_STALE")
      expect(setup.service.get("local-docs")?.version).toBe(2)
      writeFileSync(join(setup.workspace, "document.md"), revised)
      expect(setup.service.transition(review.operationId).status).toBe("completed")
      expect(setup.service.transition(review.operationId).status).toBe("completed")
      expect(() =>
        setup.service.prepare({
          projectId: project.projectId,
          expectedVersion: 3,
          idempotencyKey: "after-completion"
        })
      ).toThrow("PROJECT_COMPLETED")
      await expect(setup.service.start(review.operationId)).rejects.toThrow(
        "OPERATION_NOT_PREPARED"
      )
      await expect(setup.service.validate(review.operationId)).rejects.toThrow("PROJECT_COMPLETED")
      expect(() =>
        setup.service.approve(review.operationId, {
          expectedVersion: 2,
          inputFingerprint: review.inputFingerprint,
          decision: "approved",
          actorId: "user"
        })
      ).toThrow("INPUT_CHANGED")
      expect(setup.store.getOperation(draft.operationId)?.receipts).toEqual(receiptsBeforeReview)
    } finally {
      library.close()
    }
  })

  it("keeps changed preceding inputs unknown even when the review also has editable outputs", async () => {
    const setup = await fixture(
      {
        executeSkill: async (context) => {
          context.bindThread(`thread-${context.operation.stageId}`)
          writeFileSync(join(context.project.workspace, "document.md"), context.operation.stageId)
          writeFileSync(join(context.project.workspace, "source.md"), context.operation.stageId)
          context.recordTerminal({ outcome: "success", code: "normal" })
          return "succeeded"
        },
        inspectOperation: inspectHostProjectExecution
      },
      (manifest) => {
        manifest.artifacts.push({ id: "source", path: "source.md", required: true })
        manifest.checks.push({
          id: "source-exists",
          artifactId: "source",
          kind: "file-exists",
          sideEffect: "read"
        })
        manifest.stages[0].artifactIds.push("source")
        manifest.stages[0].checkIds.push("source-exists")
      }
    )
    const { review } = await prepareReview(setup)
    expect((await setup.service.start(review.operationId)).status).toBe("unknown")
    expect((await setup.service.reconcile(review.operationId)).status).toBe("unknown")
    expect(() => setup.service.transition(review.operationId)).toThrow()
    expect(setup.service.get("local-docs")?.version).toBe(2)
  })

  it("reconciles persisted terminal evidence for revised checked outputs without rerunning", async () => {
    const executeSkill = vi.fn<HostProjectServiceDependencies["executeSkill"]>(async (context) => {
      context.bindThread(`thread-${context.operation.stageId}`)
      writeFileSync(join(context.project.workspace, "document.md"), context.operation.stageId)
      context.recordTerminal({ outcome: "success", code: "normal" })
      if (context.operation.stageId === "review") throw Error("lost result after confirmed write")
      return "succeeded"
    })
    const setup = await fixture({ executeSkill, inspectOperation: inspectHostProjectExecution })
    const { review } = await prepareReview(setup)
    expect((await setup.service.start(review.operationId)).status).toBe("unknown")
    const reopened = new HostProjectStore(join(setup.root, "projects.sqlite"))
    try {
      const recovered = new HostProjectService(reopened, setup.snapshots, setup.dependencies)
      expect((await recovered.reconcile(review.operationId)).status).toBe("succeeded")
      expect(recovered.transition(review.operationId).status).toBe("completed")
      expect(executeSkill).toHaveBeenCalledTimes(2)
    } finally {
      reopened.close()
    }
  })
  it("cannot validate files instead of executing a required action", async () => {
    const setup = await fixture()
    const input = hostProjectFixture(setup.workspace)
    input.projectId = "action-project"
    input.manifest.stages[0].actionIds = ["publish"]
    input.manifest.actions = [
      {
        id: "publish",
        ref: {
          pluginId: "provider-install",
          plugin: "provider",
          digest: "a".repeat(64),
          actionId: "publish"
        }
      }
    ]
    const project = setup.store.create(input)
    const operation = setup.store.prepare({
      projectId: project.projectId,
      stageId: "draft",
      expectedVersion: 1,
      idempotencyKey: "file-only",
      inputFingerprint: "b".repeat(64)
    })
    writeFileSync(join(setup.workspace, "document.md"), "Already exists")
    await expect(setup.service.validate(operation.operationId)).rejects.toThrow(
      "ACTION_EXECUTION_REQUIRED"
    )
    expect(setup.store.getOperation(operation.operationId)?.startedAt).toBeNull()
  })
  it("does not release cancelled unknown writes merely because an unknown terminal exists", async () => {
    const setup = await fixture({
      executeSkill: async (context) => {
        context.bindThread("uncertain-thread")
        context.recordTerminal({ outcome: "unknown", code: "unobserved" })
        return "unknown" as const
      },
      inspectOperation: inspectHostProjectExecution
    })
    const operation = setup.service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "uncertain"
    })
    await setup.service.start(operation.operationId)
    setup.service.cancel(operation.operationId)
    expect((await setup.service.reconcile(operation.operationId)).status).toBe("unknown")
    expect(() =>
      setup.service.prepare({
        projectId: "local-docs",
        expectedVersion: 1,
        idempotencyKey: "retry"
      })
    ).toThrow("OPERATION_ACTIVE")
  })
  it("keeps unknown results unresolved if the caller is revoked while inspecting them", async () => {
    let revoked = false
    const inspect = vi.fn(async () => {
      await Promise.resolve()
      revoked = true
      return "succeeded" as const
    })
    const setup = await fixture({
      executeSkill: async context => {
        writeFileSync(join(context.project.workspace, "document.md"), "Existing output")
        return "unknown"
      },
      inspectOperation: inspect
    })
    const operation = setup.service.prepare({
      projectId: "local-docs", expectedVersion: 1, idempotencyKey: "revoked-inspection"
    })
    await setup.service.start(operation.operationId)
    await expect(setup.service.reconcile(operation.operationId, () => {
      if (revoked) throw Error("CALLER_REVOKED")
    })).rejects.toThrow("CALLER_REVOKED")
    expect(setup.store.getOperation(operation.operationId)?.status).toBe("unknown")
    expect(setup.service.get("local-docs")?.version).toBe(1)
    revoked = false
    inspect.mockResolvedValue("succeeded")
    expect((await setup.service.reconcile(operation.operationId)).status).toBe("succeeded")
  })

  it("reconciles a persisted original terminal after reopening without executing again", async () => {
    const setup = await fixture({
      executeSkill: vi.fn(async (context) => {
        context.bindThread("durable-thread")
        writeFileSync(join(context.project.workspace, "document.md"), "Actual output")
        context.recordTerminal({ outcome: "success", code: "normal" })
        throw Error("interrupted before result transaction")
      }),
      inspectOperation: inspectHostProjectExecution
    })
    const operation = setup.service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "original"
    })
    expect((await setup.service.start(operation.operationId)).status).toBe("unknown")
    const reopened = new HostProjectStore(join(setup.root, "projects.sqlite"))
    try {
      const recovered = new HostProjectService(reopened, setup.snapshots, setup.dependencies)
      recovered.recoverInterrupted()
      expect((await recovered.reconcile(operation.operationId)).status).toBe("succeeded")
      expect(setup.dependencies.executeSkill).toHaveBeenCalledTimes(1)
      expect(recovered.get("local-docs")?.version).toBe(1)
      expect(recovered.transition(operation.operationId).version).toBe(2)
    } finally {
      reopened.close()
    }
  })

  it("keeps missing original terminal unknown even if output files exist", async () => {
    const setup = await fixture({
      executeSkill: vi.fn(async (context) => {
        context.bindThread("unsettled-thread")
        writeFileSync(join(context.project.workspace, "document.md"), "Partial output")
        return "unknown" as const
      }),
      inspectOperation: inspectHostProjectExecution
    })
    const operation = setup.service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "original"
    })
    await setup.service.start(operation.operationId)
    expect((await setup.service.reconcile(operation.operationId)).status).toBe("unknown")
    expect(setup.dependencies.executeSkill).toHaveBeenCalledTimes(1)
    expect(() => setup.service.transition(operation.operationId)).toThrow()
  })
  it("creates and prepares without a model then executes fixed Skills, validates files and completes approval", async () => {
    const { service, dependencies, plugin } = await fixture()
    const draft = service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "draft"
    })
    expect(dependencies.executeSkill).not.toHaveBeenCalled()
    writeFileSync(join(plugin, "skills/draft/SKILL.md"), "Updated mutable installation")
    expect((await service.start(draft.operationId)).status).toBe("succeeded")
    const next = service.transition(draft.operationId)
    expect(next).toMatchObject({
      stageIndex: 1,
      version: 2,
      installedPluginId: "installation-uuid",
      packageId: "docs"
    })
    expect(
      service.prepare({ projectId: "local-docs", expectedVersion: 1, idempotencyKey: "draft" })
        .status
    ).toBe("transitioned")
    const review = service.prepare({
      projectId: "local-docs",
      expectedVersion: 2,
      idempotencyKey: "review"
    })
    await expect(service.start(review.operationId)).rejects.toThrow("APPROVAL_REQUIRED")
    service.approve(review.operationId, {
      expectedVersion: 2,
      inputFingerprint: review.inputFingerprint,
      decision: "approved",
      actorId: "user"
    })
    expect((await service.start(review.operationId)).status).toBe("succeeded")
    expect(service.transition(review.operationId).status).toBe("completed")
    expect(dependencies.executeSkill).toHaveBeenCalledTimes(2)
  })

  it("rejects stale receipts after validation and allows explicit cancelled retry", async () => {
    const { service, workspace } = await fixture()
    const draft = service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "draft"
    })
    await service.start(draft.operationId)
    writeFileSync(join(workspace, "document.md"), "Modified after validation")
    expect(() => service.transition(draft.operationId)).toThrow("EVIDENCE_STALE")
    expect(service.get("local-docs")?.version).toBe(1)
    expect(service.cancel(draft.operationId).status).toBe("cancelled")
    const retry = service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "retry"
    })
    expect((await service.validate(retry.operationId)).status).toBe("succeeded")
    expect(service.transition(retry.operationId).version).toBe(2)
  })

  it("reports missing artifacts as failed without model calls or stage progress", async () => {
    const { service, dependencies } = await fixture()
    const operation = service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "validate"
    })
    const result = await service.validate(operation.operationId)
    expect(result.status).toBe("failed")
    expect(result.receipts[0].result).toBe("failed")
    expect(dependencies.executeSkill).not.toHaveBeenCalled()
    expect(() => service.transition(operation.operationId)).toThrow()
  })

  it("does not turn missing reconciliation capability into an automatic retry", async () => {
    const { service } = await fixture({ executeSkill: async () => "unknown" })
    const operation = service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "run"
    })
    expect((await service.start(operation.operationId)).status).toBe("unknown")
    await expect(service.reconcile(operation.operationId)).rejects.toThrow("RECONCILE_UNSUPPORTED")
    expect(() =>
      service.prepare({ projectId: "local-docs", expectedVersion: 1, idempotencyKey: "retry" })
    ).toThrow("OPERATION_ACTIVE")
  })
})
