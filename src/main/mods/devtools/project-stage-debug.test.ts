import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { ProjectStageDebugSessions } from "./project-stage-debug"
import { ProjectStageSnapshots } from "./project-stage-snapshots"
import { ProjectAuthoringSessions } from "./project-authoring-session"
import { ProjectPreviewRegistry } from "./project-preview-registry"
import { HostProjectStore } from "../../harness-board/project-runtime/host-store"
import { HostProjectService } from "../../harness-board/project-runtime/host-service"
import { HostPackageSnapshots } from "../../harness-board/project-runtime/package-snapshots"
import { ModControlStore } from "../control-store"
import type { DevelopmentScope } from "../v2/development-session"
import { hostProjectFixture } from "../../harness-board/project-runtime/host-fixtures.test-helper"
import type { HostSkillExecutionContext } from "../../harness-board/project-runtime/host-service"
import { inspectHostProjectExecution } from "../../harness-board/project-runtime/host-execution-inspector"
import {
  captureRuntimePluginSourceToken,
  currentStageDebugSourcePolicy,
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../../plugins/runtime-source-scope"
import { assertStageDebugToolCall } from "../../harness-board/project-runtime/stage-debug-policy"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it("keeps an unavailable snapshot store from changing ordinary command or execution decisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "creator-stage-debug-"))
  cleanup.push(async () => {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("creator-stage-debug-")
    )
      throw Error("Unsafe cleanup")
    await rm(root, { recursive: true, force: true })
  })
  const blocked = join(root, "not-a-directory")
  await writeFile(blocked, "private snapshot storage is unavailable")
  const scope: DevelopmentScope = {
    threadId: "creator",
    workspace: root,
    incarnation: { token: "optional-capture", legacyCreatedAt: 1 }
  }
  const project = {
    ...hostProjectFixture(root),
    schemaVersion: 1 as const,
    stateOwner: "host" as const,
    version: 1,
    stageIndex: 0,
    status: "active" as const,
    createdAt: 1,
    updatedAt: 1
  }
  let checked = 0
  const debug = new ProjectStageDebugSessions({
    root: blocked,
    settings: { getSetting: (_key, fallback = "") => fallback, compareAndSetSetting: () => true },
    registry: { scopeForProject: () => scope } as unknown as ProjectPreviewRegistry,
    sessions: {} as ProjectAuthoringSessions,
    platform: () => ({}) as HostProjectService,
    retainedRoot: () => root,
    assertWorkspaceIdle: () => {}
  })
  expect(() => debug.assertCommand(project, "start")).not.toThrow()
  expect(debug.executionPolicy(project)).toBeUndefined()
  await expect(
    debug.beforeExecute({
      project,
      inputIdentity: "native-inputs",
      signal: new AbortController().signal,
      assertInputsCurrent: () => {
        checked++
      }
    } as HostSkillExecutionContext & { inputIdentity: string })
  ).resolves.toBeUndefined()
  expect(checked).toBeGreaterThan(0)
  expect(project.stageIndex).toBe(0)
})

async function fixture(
  failedReview = false,
  interruptedBranch?: "terminal" | "missing",
  nativeOwnerGuard: () => void = () => {}
) {
  const root = await mkdtemp(join(tmpdir(), "creator-stage-debug-"))
  const settings = new ModControlStore(join(root, "controls.sqlite"))
  const store = new HostProjectStore(join(root, "projects.sqlite"))
  cleanup.push(async () => {
    store.close()
    settings.close()
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("creator-stage-debug-")
    )
      throw Error("Unsafe cleanup")
    await rm(root, { recursive: true, force: true })
  })
  const scope: DevelopmentScope = {
    threadId: "creator",
    workspace: root,
    incarnation: { token: "debug", legacyCreatedAt: 1 }
  }
  const context = { scope, guard: nativeOwnerGuard }
  const sessions = new ProjectAuthoringSessions()
  sessions.configurePersistence(settings, join(root, "sources"))
  const draft = await sessions.scaffold(scope, "docs", "受控文档", () => {}, "harness-lite")
  await sessions.requestTrial(scope, draft.id, draft.revision, "起草并审查文档", () => {})
  const registry = new ProjectPreviewRegistry()
  registry.configurePersistence(settings)
  const packages = new HostPackageSnapshots(join(root, "packages"))
  const observed: Array<{ projectId: string; stage: string; upstream: string | null }> = []
  const serviceDependencies = {
    resolveInstalledPlugin: async (id) => {
      const plugin = registry.resolve(id)
      return (
        plugin && {
          installedPluginId: id,
          root: plugin.path,
          packageId: plugin.name,
          packageVersion: plugin.version,
          enabled: true
        }
      )
    },
    authorize: async (project) => {
      registry.assertProject(project)
    },
    assertCommand: (project, kind) => debug.assertCommand(project, kind),
    beforeExecuteStage: (input) => debug.beforeExecute(input),
    authorizeStageBranch: async (input) => debug.authorizeBranch(input),
    inspectOperation: inspectHostProjectExecution,
    executeSkill: async (input) => {
      input.bindThread(randomUUID())
      const stage = input.project.manifest.stages[input.project.stageIndex]
      const upstream =
        input.project.stageIndex > 0
          ? await readFile(join(input.project.workspace, "draft.md"), "utf8")
          : null
      observed.push({ projectId: input.project.projectId, stage: stage.id, upstream })
      for (const artifactId of stage.artifactIds) {
        const artifact = input.project.manifest.artifacts.find((item) => item.id === artifactId)!
        if (artifact.path === "draft.md" && upstream) continue
        await mkdir(dirname(join(input.project.workspace, artifact.path)), { recursive: true })
        await writeFile(
          join(input.project.workspace, artifact.path),
          artifact.path.endsWith(".json")
            ? JSON.stringify({
                summary: "读取原上游",
                checked: !failedReview || input.project.projectId !== originalId
              })
            : "original-upstream-bytes"
        )
      }
      if (input.project.projectId === originalId || interruptedBranch !== "missing")
        input.recordTerminal({ outcome: "success", code: "controlled-native-execution" })
      if (input.project.projectId !== originalId && interruptedBranch)
        throw Error("native result lost after actual execution")
      return "succeeded"
    }
  } satisfies ConstructorParameters<typeof HostProjectService>[2]
  const service = new HostProjectService(store, packages, serviceDependencies)
  const dependencies = {
    root: join(root, "debug"),
    settings,
    sessions,
    registry,
    platform: () => service,
    retainedRoot: (project) => packages.read(project.pluginDigest).root,
    assertInspectionScope: (value) => {
      if (JSON.stringify(value) !== JSON.stringify(scope)) throw Error("CREATOR_SCOPE_REVOKED")
    },
    assertWorkspaceIdle: () => {}
  } satisfies ConstructorParameters<typeof ProjectStageDebugSessions>[0]
  const debug: ProjectStageDebugSessions = new ProjectStageDebugSessions(dependencies)
  const lease = sessions.acquireDevelopment(scope, draft.id, draft.revision, () => {})
  const originalId = randomUUID()
  const plugin = await registry.register({
    projectId: originalId,
    scope,
    snapshot: lease.snapshot,
    guard: () => {},
    release: lease.release,
    actions: []
  })
  let original = await service.localCreate({
    projectId: originalId,
    name: draft.name,
    workspace: lease.snapshot.workspace,
    installedPluginId: plugin.id,
    goal: "起草并审查文档"
  })
  await registry.bind(original, packages.read(original.pluginDigest).root)
  for (const stage of original.manifest.stages) {
    const operation = service.prepare({
      projectId: originalId,
      expectedVersion: original.version,
      idempotencyKey: stage.id
    })
    if (stage.approval === "human")
      service.approve(operation.operationId, {
        expectedVersion: original.version,
        inputFingerprint: operation.inputFingerprint,
        decision: "approved",
        actorId: "native-user"
      })
    const result = await service.start(operation.operationId)
    if (result.status === "failed") break
    expect(result.status).toBe("succeeded")
    original = service.transition(operation.operationId)
  }
  const snapshot = debug.list(context).snapshots.find((item) => item.stageId === "review")!
  expect(snapshot).toBeDefined()
  const source = sessions.read(scope, draft.id)
  const revised = await sessions.save(
    scope,
    {
      id: draft.id,
      name: draft.name,
      revision: source.revision,
      files: source.source.files.map((file) =>
        file.path === "skills/review/SKILL.md"
          ? { ...file, text: `${file.text}\nRevised isolated review only\n` }
          : file
      )
    },
    () => {}
  )
  const prepare = (mode: "stage" | "downstream" = "stage") =>
    debug.prepare(context, {
      threadId: scope.threadId,
      snapshotId: snapshot.id,
      draftId: draft.id,
      revision: revised.revision,
      expectedDigest: revised.source.digest,
      mode
    })
  return {
    root,
    debug,
    service,
    registry,
    settings,
    sessions,
    context,
    scope,
    draft,
    original,
    snapshot,
    revised,
    prepare,
    observed,
    packages,
    serviceDependencies,
    dependencies
  }
}

it("reuses actual stage-entry bytes in a new project and keeps original output and results", async () => {
  const f = await fixture()
  const originalBytes = await readFile(join(f.original.workspace, "review.json"))
  const original = f.service.get(f.original.projectId)
  const plan = await f.prepare()
  expect(plan.affectedStageIds).toEqual(["review"])
  const result = await f.debug.create(f.context, {
    threadId: f.scope.threadId,
    preparationId: plan.id,
    expectedDigest: plan.candidateDigest
  })
  const branch = f.service.get(result.projectId)!
  expect(branch.stageIndex).toBe(1)
  expect(branch.workspace).not.toBe(f.original.workspace)
  expect(await readFile(join(branch.workspace, "draft.md"), "utf8")).toBe("original-upstream-bytes")
  await expect(readFile(join(branch.workspace, "review.json"))).rejects.toThrow()
  expect(f.service.operations(branch.projectId)).toEqual([])
  const operation = f.service.prepare({
    projectId: branch.projectId,
    expectedVersion: branch.version,
    idempotencyKey: "new-review"
  })
  await expect(f.service.start(operation.operationId)).rejects.toThrow("APPROVAL_REQUIRED")
  f.service.approve(operation.operationId, {
    expectedVersion: branch.version,
    inputFingerprint: operation.inputFingerprint,
    decision: "approved",
    actorId: "new-native-user"
  })
  expect((await f.service.start(operation.operationId)).status).toBe("succeeded")
  expect(f.observed.filter((item) => item.projectId === branch.projectId)).toEqual([
    { projectId: branch.projectId, stage: "review", upstream: "original-upstream-bytes" }
  ])
  expect(f.debug.list(f.context).branches[0]).toMatchObject({ status: "passed", mode: "stage" })
  expect(() => f.debug.assertCommand(branch, "advance")).toThrow("SINGLE_STAGE_ONLY")
  f.registry.finish(
    branch,
    f.scope,
    f.service.operations(branch.projectId),
    (id) => f.service.cancel(id),
    f.debug.finishOptions(branch)
  )
  f.debug.end(branch)
  expect(f.service.operations(branch.projectId)[0].status).toBe("succeeded")
  expect(f.debug.list(f.context).branches[0].status).toBe("passed")
  expect(() =>
    f.service.prepare({
      projectId: branch.projectId,
      expectedVersion: branch.version,
      idempotencyKey: "cannot-resume-finished-debug"
    })
  ).toThrow("RECONFIRMATION_REQUIRED")
  expect(await readFile(join(f.original.workspace, "review.json"))).toEqual(originalBytes)
  expect(f.service.get(f.original.projectId)).toEqual(original)
  const cold = new ProjectStageDebugSessions(f.dependencies)
  expect(() => cold.assertCommand(branch, "start")).toThrow("RECONFIRMATION_REQUIRED")
  expect(() => cold.executionPolicy(branch)).toThrow("RECONFIRMATION_REQUIRED")
  expect(() => cold.assertCommand(branch, "cancel")).not.toThrow()
  await expect(
    f.debug.create(f.context, {
      threadId: f.scope.threadId,
      preparationId: plan.id,
      expectedDigest: plan.candidateDigest
    })
  ).rejects.toThrow("PREPARATION_EXPIRED")
}, 15000)

it("can start at a physically settled failed stage without completing the old workflow", async () => {
  const f = await fixture(true)
  expect(f.original.status).toBe("active")
  const plan = await f.prepare("downstream")
  const result = await f.debug.create(f.context, {
    threadId: f.scope.threadId,
    preparationId: plan.id,
    expectedDigest: plan.candidateDigest
  })
  expect(f.service.get(result.projectId)).toMatchObject({ stageIndex: 1, status: "active" })
  expect(f.service.get(f.original.projectId)?.status).toBe("active")
}, 15000)

it("checks the native creator owner outside a debug child scope without relaxing its policy", async () => {
  let ownerCurrent = true
  const nativeOwnerGuard = () => {
    // The creator's canRun predicate reads its own Mods enablement. A debug child policy must
    // not reinterpret that native identity check as an attempt to execute the author's Mods.
    if (currentStageDebugSourcePolicy()) throw Error("PROJECT_STAGE_DEBUG_MODS_UNSUPPORTED")
    if (!ownerCurrent) throw Error("DEVELOPMENT_SCOPE_CHANGED")
  }
  const f = await fixture(false, undefined, nativeOwnerGuard)
  const plan = await f.prepare()
  const result = await f.debug.create(f.context, {
    threadId: f.scope.threadId,
    preparationId: plan.id,
    expectedDigest: plan.candidateDigest
  })
  const branch = f.service.get(result.projectId)!
  const snapshotRoot = f.packages.read(branch.pluginDigest).root
  const plugin = { ...f.registry.assertProject(branch), path: snapshotRoot }
  const token = issueRuntimePluginSourceToken({
    threadId: "native-debug-stage",
    incarnationKey: "native-debug-incarnation",
    projectId: branch.projectId,
    operationId: "native-debug-operation",
    workspace: branch.workspace,
    packageDigest: branch.pluginDigest,
    stageId: branch.manifest.stages[branch.stageIndex].id,
    mode: "host",
    stageDebug: { workspace: branch.workspace, baselineId: f.snapshot.id },
    plugin
  })
  expect(currentStageDebugSourcePolicy()).toBeUndefined()
  withRuntimePluginSource(token, () => {
    const policy = currentStageDebugSourcePolicy()!
    expect(() => nativeOwnerGuard()).toThrow("PROJECT_STAGE_DEBUG_MODS_UNSUPPORTED")
    expect(() => f.registry.assertProject(branch)).not.toThrow()
    expect(captureRuntimePluginSourceToken()).toBe(token)
    expect(currentStageDebugSourcePolicy()).toEqual(policy)
    expect(() => assertStageDebugToolCall(policy, "execute", { command: "forbidden" }))
      .toThrow("PROJECT_STAGE_DEBUG_TOOL_UNSUPPORTED")
    ownerCurrent = false
    expect(() => f.registry.assertProject(branch)).toThrow("DEVELOPMENT_SCOPE_CHANGED")
    expect(captureRuntimePluginSourceToken()).toBe(token)
    expect(currentStageDebugSourcePolicy()).toEqual(policy)
    expect(() => nativeOwnerGuard()).toThrow("PROJECT_STAGE_DEBUG_MODS_UNSUPPORTED")
    expect(() => assertStageDebugToolCall(policy, "mod_function", {}))
      .toThrow("PROJECT_STAGE_DEBUG_TOOL_UNSUPPORTED")
  })
  expect(captureRuntimePluginSourceToken()).toBeUndefined()
  expect(currentStageDebugSourcePolicy()).toBeUndefined()
}, 15000)

it("does not accept another creator's snapshot or a late plan after candidate changes", async () => {
  const f = await fixture()
  const foreign = { scope: { ...f.scope, threadId: "another-creator" }, guard: () => {} }
  expect(f.debug.list(foreign).snapshots).toEqual([])
  await expect(
    f.debug.prepare(foreign, {
      threadId: foreign.scope.threadId,
      snapshotId: f.snapshot.id,
      draftId: f.draft.id,
      revision: f.revised.revision,
      expectedDigest: f.revised.source.digest,
      mode: "stage"
    })
  ).rejects.toThrow()
  const plan = await f.prepare()
  await f.sessions.save(
    f.scope,
    {
      id: f.draft.id,
      name: f.draft.name,
      revision: f.revised.revision,
      files: f.revised.source.files.map((file) =>
        file.path === "skills/review/SKILL.md"
          ? { ...file, text: file.text + "\nLater version" }
          : file
      )
    },
    () => {}
  )
  await expect(
    f.debug.create(f.context, {
      threadId: f.scope.threadId,
      preparationId: plan.id,
      expectedDigest: plan.candidateDigest
    })
  ).rejects.toThrow("CANDIDATE_CHANGED")
  expect(f.service.list()).toHaveLength(1)
}, 15000)

it("requires actual downstream transitions before reporting the full debug scope passed", async () => {
  const f = await fixture()
  const plan = await f.prepare("downstream")
  const result = await f.debug.create(f.context, {
    threadId: f.scope.threadId,
    preparationId: plan.id,
    expectedDigest: plan.candidateDigest
  })
  const branch = f.service.get(result.projectId)!
  const operation = f.service.prepare({
    projectId: branch.projectId,
    expectedVersion: 1,
    idempotencyKey: "new-downstream"
  })
  f.service.approve(operation.operationId, {
    expectedVersion: 1,
    inputFingerprint: operation.inputFingerprint,
    decision: "approved",
    actorId: "new-native-user"
  })
  expect((await f.service.start(operation.operationId)).status).toBe("succeeded")
  expect(f.debug.list(f.context).branches[0].status).toBe("ready")
  f.service.transition(operation.operationId)
  expect(f.debug.list(f.context).branches[0].status).toBe("passed")
}, 15000)

async function interruptedColdBranch(terminal: "terminal" | "missing") {
  const f = await fixture(false, terminal)
  const plan = await f.prepare()
  const result = await f.debug.create(f.context, {
    threadId: f.scope.threadId,
    preparationId: plan.id,
    expectedDigest: plan.candidateDigest
  })
  const branch = f.service.get(result.projectId)!
  const operation = f.service.prepare({
    projectId: branch.projectId, expectedVersion: branch.version, idempotencyKey: "interrupted-review"
  })
  f.service.approve(operation.operationId, {
    expectedVersion: branch.version, inputFingerprint: operation.inputFingerprint,
    decision: "approved", actorId: "new-native-user"
  })
  const lost = await f.service.start(operation.operationId)
  expect(lost.status).toBe("unknown")
  expect(Boolean(lost.execution?.terminal)).toBe(terminal === "terminal")
  const executions = f.observed.length
  // A cold registry has only persisted provenance, with no preview entries or live grants.
  const registry = new ProjectPreviewRegistry()
  registry.configurePersistence(f.settings)
  const store = new HostProjectStore(join(f.root, "projects.sqlite"))
  cleanup.push(async () => store.close())
  let scopeCurrent = true
  let executionAuthorizations = 0
  const debug: ProjectStageDebugSessions = new ProjectStageDebugSessions({
    ...f.dependencies, registry, platform: () => service,
    assertInspectionScope: (scope) => {
      if (!scopeCurrent || JSON.stringify(scope) !== JSON.stringify(f.scope))
        throw Error("CREATOR_SCOPE_REVOKED")
    }
  })
  const service = new HostProjectService(store, f.packages, {
    ...f.serviceDependencies,
    assertCommand: (project, kind) => debug.assertCommand(project, kind),
    authorize: async () => {
      executionAuthorizations++
      throw Error("NO_LIVE_PREVIEW")
    },
    authorizeInspection: async (project, value) => {
      const inspection = await debug.authorizeInspection(project, value)
      if (!inspection) throw Error("NO_LIVE_PREVIEW")
      return inspection
    }
  })
  // prepareRuntimeInputs is also used by the native command before reconcile. It must not
  // resolve the live preview or use the mutable current creator draft.
  await service.prepareRuntimeInputs(branch.projectId)
  return {
    ...f, cold: service, coldRegistry: registry, branch, operation, executions,
    revokeScope: () => { scopeCurrent = false },
    executionAuthorizations: () => executionAuthorizations
  }
}

it("cold-reconciles a real terminal and pinned file checks without reviving debug execution", async () => {
  const f = await interruptedColdBranch("terminal")
  // Changing the current draft must not substitute code into historical result inspection.
  const current = f.sessions.read(f.scope, f.draft.id)
  await f.sessions.save(f.scope, {
    id: current.id, name: current.name, revision: current.revision,
    files: current.source.files.map((file) => file.path === "skills/review/SKILL.md"
      ? { ...file, text: `${file.text}\nA later mutable draft\n` } : file)
  }, () => {})
  const reconciled = await f.cold.reconcile(f.operation.operationId)
  expect(reconciled.status).toBe("succeeded")
  expect(reconciled.receipts.length).toBeGreaterThan(0)
  expect(reconciled.receipts.every((receipt) => receipt.result === "passed")).toBe(true)
  expect(f.observed).toHaveLength(f.executions)
  expect(f.executionAuthorizations()).toBe(0)
  expect(() => f.coldRegistry.resolve(f.branch.installedPluginId)).toThrow("PREVIEW_EXPIRED")
  expect(() => f.cold.start(f.operation.operationId)).toThrow("RECONFIRMATION_REQUIRED")
  expect(() => f.cold.transition(f.operation.operationId)).toThrow("RECONFIRMATION_REQUIRED")
  // Inspection does not reinterpret already settled operations or mint another receipt.
  await expect(f.cold.reconcile(f.operation.operationId)).rejects.toThrow("RECONCILE_NOT_UNKNOWN")
}, 15000)

it("keeps cold missing-terminal outcomes unknown even when all output files exist", async () => {
  const f = await interruptedColdBranch("missing")
  const result = await f.cold.reconcile(f.operation.operationId)
  expect(result.status).toBe("unknown")
  expect(result.receipts).toEqual([])
  expect(result.execution?.terminal).toBeNull()
  expect(f.observed).toHaveLength(f.executions)
  expect(f.executionAuthorizations()).toBe(0)
  expect(() => f.cold.start(f.operation.operationId)).toThrow("RECONFIRMATION_REQUIRED")
}, 15000)

it("rejects cold inspection after native creator incarnation authority is revoked", async () => {
  const f = await interruptedColdBranch("terminal")
  f.revokeScope()
  await expect(f.cold.reconcile(f.operation.operationId)).rejects.toThrow("CREATOR_SCOPE_REVOKED")
  expect(f.cold.operations(f.branch.projectId)[0].status).toBe("unknown")
  expect(f.observed).toHaveLength(f.executions)
}, 15000)

it("rejects altered pinned packages instead of reading the current draft as replacement evidence", async () => {
  const f = await interruptedColdBranch("terminal")
  const root = f.packages.read(f.branch.pluginDigest).root
  await writeFile(join(root, "skills/review/SKILL.md"), "altered historical source")
  await expect(f.cold.reconcile(f.operation.operationId)).rejects.toThrow()
  expect(f.cold.operations(f.branch.projectId)[0].status).toBe("unknown")
  expect(f.observed).toHaveLength(f.executions)
}, 15000)

it("compares the complete immutable stage inputs with current branch bytes without granting execution or PASS", async () => {
  const f = await fixture()
  const plan = await f.prepare()
  const created = await f.debug.create(f.context, { threadId: f.scope.threadId,
    preparationId: plan.id, expectedDigest: plan.candidateDigest })
  const branch = f.service.get(created.projectId)!
  const originalOperations = f.service.operations(f.original.projectId)
  const unchanged = await f.debug.compare(f.context, { threadId: f.scope.threadId, projectId: branch.projectId })
  expect(unchanged.status).toBe("available")
  expect(unchanged.counts).toEqual({ added: 0, deleted: 0, modified: 0, unchanged: 1 })
  await writeFile(join(branch.workspace, "extra.bin"), Buffer.from([0, 1]))
  await writeFile(join(branch.workspace, "draft.md"), "changed branch input")
  const comparison = await f.debug.compare(f.context, { threadId: f.scope.threadId, projectId: branch.projectId })
  expect(comparison.status).toBe("available")
  expect(comparison.counts).toEqual({ added: 1, deleted: 0, modified: 1, unchanged: 0 })
  expect(JSON.stringify(comparison)).not.toContain(f.root)
  expect(JSON.stringify(comparison)).not.toContain("changed branch input")
  expect(f.service.operations(branch.projectId)).toEqual([])
  expect(f.service.operations(f.original.projectId)).toEqual(originalOperations)
  expect(f.debug.list(f.context).branches[0].status).toBe("ready")
  f.registry.finish(branch, f.scope, [], undefined, f.debug.finishOptions(branch)); f.debug.end(branch)
  const cold = new ProjectStageDebugSessions(f.dependencies)
  expect((await cold.compare(f.context, { threadId: f.scope.threadId, projectId: branch.projectId })).status).toBe("available")
  expect(() => cold.assertCommand(branch, "prepare")).toThrow("RECONFIRMATION_REQUIRED")
  await expect(cold.compare({ scope: { ...f.scope, threadId: "other" }, guard: () => {} },
    { threadId: "other", projectId: branch.projectId })).rejects.toThrow("COMPARISON_SCOPE_CHANGED")
}, 15000)

it("does not return a partial comparison for a changed immutable baseline or new secret file", async () => {
  const f = await fixture()
  const plan = await f.prepare()
  const created = await f.debug.create(f.context, { threadId: f.scope.threadId,
    preparationId: plan.id, expectedDigest: plan.candidateDigest })
  const branch = f.service.get(created.projectId)!
  await writeFile(join(branch.workspace, ".env"), "credential-value-never-publish")
  const blocked = await f.debug.compare(f.context, { threadId: f.scope.threadId, projectId: branch.projectId })
  expect(blocked).toMatchObject({ status: "unavailable", files: [] })
  expect(JSON.stringify(blocked)).not.toContain("credential-value-never-publish")
  await rm(join(branch.workspace, ".env"))
  await writeFile(join(f.dependencies.root, "inputs", f.snapshot.id, "files", "draft.md"), "tampered input snapshot")
  expect(await f.debug.compare(f.context, { threadId: f.scope.threadId, projectId: branch.projectId }))
    .toMatchObject({ status: "unavailable", files: [] })
}, 15000)

it("refuses file comparison while native branch outcomes remain unknown", async () => {
  const f = await interruptedColdBranch("missing")
  expect(await f.debug.compare(f.context, { threadId: f.scope.threadId, projectId: f.branch.projectId }))
    .toMatchObject({ status: "unavailable", files: [] })
  expect(f.service.operations(f.branch.projectId)[0].status).toBe("unknown")
  expect(f.observed).toHaveLength(f.executions)
}, 15000)

it("refuses file comparison during an actual native branch execution", async () => {
  const f = await fixture()
  const plan = await f.prepare()
  const created = await f.debug.create(f.context, { threadId: f.scope.threadId,
    preparationId: plan.id, expectedDigest: plan.candidateDigest })
  const branch = f.service.get(created.projectId)!
  const operation = f.service.prepare({ projectId: branch.projectId, expectedVersion: branch.version,
    idempotencyKey: "comparison-running" })
  f.service.approve(operation.operationId, { expectedVersion: branch.version,
    inputFingerprint: operation.inputFingerprint, decision: "approved", actorId: "fresh-native-user" })
  let entered!: () => void, resume!: () => void
  const active = new Promise<void>(resolve => { entered = resolve })
  const paused = new Promise<void>(resolve => { resume = resolve })
  const execute = f.serviceDependencies.executeSkill
  f.serviceDependencies.executeSkill = async input => {
    entered()
    await paused
    return execute(input)
  }
  const execution = f.service.start(operation.operationId)
  try {
    await active
    expect(f.service.operations(branch.projectId)[0].status).toBe("started")
    expect(await f.debug.compare(f.context, { threadId: f.scope.threadId, projectId: branch.projectId }))
      .toMatchObject({ status: "unavailable", files: [] })
  } finally { resume(); await execution }
}, 15000)

it("projects fixed branch candidate provenance without treating an edited candidate as the historical branch", async () => {
  const f = await fixture()
  const plan = await f.prepare()
  const created = await f.debug.create(f.context, { threadId: f.scope.threadId,
    preparationId: plan.id, expectedDigest: plan.candidateDigest })
  const before = f.debug.list(f.context).branches.find(branch => branch.projectId === created.projectId)!
  expect(before).toMatchObject({ candidateDigest: plan.candidateDigest, currentCandidateMatches: true, status: "ready" })
  // End the native branch lease before saving another creator revision.
  const project = f.service.get(created.projectId)!
  f.registry.finish(project, f.scope, [], undefined, f.debug.finishOptions(project)); f.debug.end(project)
  const current = f.sessions.read(f.scope, f.draft.id)
  await f.sessions.save(f.scope, { id: current.id, name: current.name, revision: current.revision,
    files: current.source.files.map(file => file.path === "skills/review/SKILL.md"
      ? { ...file, text: file.text + "\nA later source version\n" } : file) }, () => {})
  expect(f.debug.list(f.context).branches.find(branch => branch.projectId === created.projectId))
    .toMatchObject({ candidateDigest: plan.candidateDigest, currentCandidateMatches: false, status: "ready" })
}, 15000)

it.each(["branch", "source"] as const)("rejects a changed pinned %s package while keeping cold comparison read-only", async (target) => {
  const f = await fixture()
  const plan = await f.prepare()
  const created = await f.debug.create(f.context, {
    threadId: f.scope.threadId,
    preparationId: plan.id,
    expectedDigest: plan.candidateDigest
  })
  const branch = f.service.get(created.projectId)!
  const original = f.service.get(f.original.projectId)
  const originalOperations = f.service.operations(f.original.projectId)
  const originalBytes = await readFile(join(f.original.workspace, "review.json"))
  f.registry.finish(branch, f.scope, [], undefined, f.debug.finishOptions(branch))
  f.debug.end(branch)
  const cold = new ProjectStageDebugSessions(f.dependencies)
  const input = { threadId: f.scope.threadId, projectId: branch.projectId }
  expect((await cold.compare(f.context, input)).status).toBe("available")
  const pinned = f.packages.read(target === "branch" ? branch.pluginDigest : f.original.pluginDigest).root
  const path = join(pinned, "skills/review/SKILL.md")
  const bytes = await readFile(path)
  await writeFile(path, "changed-pinned-source-never-publish")
  const rejected = await cold.compare(f.context, input)
  expect(rejected).toMatchObject({ status: "unavailable", files: [] })
  expect(JSON.stringify(rejected)).not.toContain("changed-pinned-source-never-publish")
  expect(JSON.stringify(rejected)).not.toContain(pinned)
  expect(f.service.get(f.original.projectId)).toEqual(original)
  expect(f.service.operations(f.original.projectId)).toEqual(originalOperations)
  expect(await readFile(join(f.original.workspace, "review.json"))).toEqual(originalBytes)
  expect(f.service.operations(branch.projectId)).toEqual([])
  await writeFile(path, bytes)
  expect((await cold.compare(f.context, input)).status).toBe("available")
  expect(() => cold.assertCommand(branch, "prepare")).toThrow("RECONFIRMATION_REQUIRED")
}, 15000)

it("discards the file comparison if a pinned package changes during the asynchronous observation", async () => {
  const f = await fixture()
  const plan = await f.prepare()
  const created = await f.debug.create(f.context, {
    threadId: f.scope.threadId,
    preparationId: plan.id,
    expectedDigest: plan.candidateDigest
  })
  const branch = f.service.get(created.projectId)!
  const root = f.packages.read(branch.pluginDigest).root
  const path = join(root, "skills/review/SKILL.md")
  const original = f.service.get(f.original.projectId)
  const originalOperations = f.service.operations(f.original.projectId)
  const inspect = ProjectStageSnapshots.prototype.inspectFiles
  let changed = false
  const intercepted = vi.spyOn(ProjectStageSnapshots.prototype, "inspectFiles")
  intercepted.mockImplementation(async function (this: ProjectStageSnapshots, ...args) {
    const result = await inspect.apply(this, args)
    if (!changed) {
      changed = true
      await writeFile(path, "changed-during-baseline-observation")
    }
    return result
  })
  try {
    const result = await f.debug.compare(f.context, { threadId: f.scope.threadId, projectId: branch.projectId })
    expect(changed).toBe(true)
    expect(result).toMatchObject({ status: "unavailable", files: [] })
    expect(f.service.get(f.original.projectId)).toEqual(original)
    expect(f.service.operations(f.original.projectId)).toEqual(originalOperations)
    expect(f.service.operations(branch.projectId)).toEqual([])
  } finally { intercepted.mockRestore() }
}, 15000)
