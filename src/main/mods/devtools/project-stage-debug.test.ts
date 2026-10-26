import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import {
  ProjectStageDebugSessions,
  configureProjectStageDebugResolver
} from "./project-stage-debug"
import { ProjectStageSnapshots } from "./project-stage-snapshots"
import { inspectProjectSource } from "./project-doctor"
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
import type { StageRecoveryPolicy } from "../../harness-board/project-runtime/stage-recovery-policy"
import { StageRecoveryHookJournal } from "../../hooks/stage-recovery-journal"
import { StageRecoveryInputs } from "./stage-recovery-inputs"
import { FunctionModsManager } from "../v2/manager"
import { FunctionUserConfigValues } from "../v2/user-config-values"
import { parseFunctionUserConfig } from "../../../shared/mods/v2/user-config"
import { testSecretProtector } from "../../../../tests/support/mods-secret-protector"
import { createHostProjectInputIdentity } from "../../harness-board/project-runtime/package-input-identity"
import { executeStageRecoveryContextProvider } from "../../harness-board/project-runtime/stage-recovery-context-provider"
import {
  wrapProjectRuntimeManifest,
  CONTEXT_HANDOFF_PROTOCOL
} from "../../../shared/project-runtime"

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

it.each(["absent", "settled"])(
  "does not add recovery package or settlement gates to an ordinary Host reconciliation with %s Hook intents",
  async (history) => {
    const root = await mkdtemp(join(tmpdir(), "ordinary-host-recovery-"))
    cleanup.push(async () => {
      await rm(root, { recursive: true, force: true })
    })
    const settings = new ModControlStore(join(root, "controls.sqlite"))
    cleanup.push(async () => {
      settings.close()
    })
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
    if (history === "settled")
      new StageRecoveryHookJournal(settings)
        .begin(
          {
            projectId: project.projectId,
            operationId: "historical",
            threadId: "original-thread",
            baselineId: "original-baseline",
            packageDigest: project.pluginDigest,
            stageId: "draft",
            policyDigest: "a".repeat(64),
            hookDigest: "b".repeat(64)
          },
          vi.fn()
        )
        .settle(0, false)
    const platform = vi.fn(() => {
      throw Error("ORDINARY_RECONCILE_MUST_NOT_READ_S6_OPERATIONS")
    })
    const retainedRoot = vi.fn(() => {
      throw Error("ORDINARY_RECONCILE_MUST_NOT_READ_S6_PACKAGE")
    })
    const assertWorkspaceIdle = vi.fn(() => {
      throw Error("ORDINARY_RECONCILE_MUST_NOT_ADD_IDLE_GATE")
    })
    const debug = new ProjectStageDebugSessions({
      root: join(root, "snapshots"),
      settings,
      registry: {} as ProjectPreviewRegistry,
      sessions: {} as ProjectAuthoringSessions,
      platform,
      retainedRoot,
      assertWorkspaceIdle
    })
    await expect(debug.reconcileNativeHookFacts(project)).resolves.toBeUndefined()
    expect(platform).not.toHaveBeenCalled()
    expect(retainedRoot).not.toHaveBeenCalled()
    expect(assertWorkspaceIdle).not.toHaveBeenCalled()
  }
)

it("retains the physical settlement gate when a real recovery Hook intent is still pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "pending-host-recovery-"))
  cleanup.push(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const settings = new ModControlStore(join(root, "controls.sqlite"))
  cleanup.push(async () => {
    settings.close()
  })
  const packageRoot = join(root, "package")
  await mkdir(packageRoot)
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
  new StageRecoveryHookJournal(settings).begin(
    {
      projectId: project.projectId,
      operationId: "pending",
      threadId: "original-thread",
      baselineId: "original-baseline",
      packageDigest: project.pluginDigest,
      stageId: "draft",
      policyDigest: "a".repeat(64),
      hookDigest: "b".repeat(64)
    },
    vi.fn()
  )
  const platform = { get: () => project, operations: () => [{ status: "started" }] }
  const debug = new ProjectStageDebugSessions({
    root: join(root, "snapshots"),
    settings,
    registry: {} as ProjectPreviewRegistry,
    sessions: {} as ProjectAuthoringSessions,
    platform: () => platform as unknown as HostProjectService,
    retainedRoot: () => packageRoot,
    assertWorkspaceIdle: vi.fn()
  })
  await expect(debug.reconcileNativeHookFacts(project)).rejects.toThrow("SOURCE_UNSETTLED")
  expect(new StageRecoveryHookJournal(settings).hasUnresolved(project.projectId)).toBe(true)
})

async function fixture(
  failedReview = false,
  interruptedBranch?: "terminal" | "missing",
  nativeOwnerGuard: () => void = () => {},
  recovery?: StageRecoveryPolicy,
  nativeConfiguration = false,
  providerScript?: string
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
  let draft = await sessions.scaffold(scope, "docs", "受控文档", () => {}, "harness-lite")
  const userConfig = parseFunctionUserConfig({
    audience: {
      type: "string",
      title: "目标读者",
      description: "生成文档的实际读者",
      default: "default readers"
    }
  })!
  if (nativeConfiguration) {
    draft = await sessions.save(
      scope,
      {
        id: draft.id,
        revision: draft.revision,
        name: draft.name,
        files: draft.source.files.map((file) =>
          /(?:^|\/)plugin\.json$/.test(file.path)
            ? { ...file, text: JSON.stringify({ ...JSON.parse(file.text), userConfig }) }
            : file
        )
      },
      () => {}
    )
  }
  if (providerScript) {
    draft = await sessions.save(
      scope,
      {
        id: draft.id,
        revision: draft.revision,
        name: draft.name,
        files: [
          ...draft.source.files.map((file) =>
            file.path === "devclaw.project-runtime.json"
              ? {
                  ...file,
                  text: JSON.stringify(
                    wrapProjectRuntimeManifest(JSON.parse(file.text), {
                      apiVersion: "devclaw.extension-contract/v1",
                      requires: [CONTEXT_HANDOFF_PROTOCOL],
                      context: {
                        sourceAccess: "read-only",
                        mutableData: "host",
                        configuration: "host-resolved",
                        knowledge: { required: false },
                        provider: { entry: "hooks/context.py", operations: ["session-context"] }
                      }
                    })
                  )
                }
              : file
          ),
          { path: "hooks/context.py", text: providerScript }
        ]
      },
      () => {}
    )
  }
  if (recovery) {
    const hook = {
      id: "required",
      event: "PostSkillUse",
      type: "prompt",
      prompt: "Check actual stage artifacts",
      fallback: "block"
    }
    draft = await sessions.save(
      scope,
      {
        id: draft.id,
        revision: draft.revision,
        name: draft.name,
        files: [
          ...draft.source.files,
          { path: "devclaw.stage-recovery.json", text: JSON.stringify(recovery) },
          { path: "hooks/hooks.json", text: JSON.stringify([hook]) }
        ]
      },
      () => {}
    )
  }
  if (providerScript) {
    const { report } = inspectProjectSource(draft.source)
    expect(report.valid, JSON.stringify(report.diagnostics)).toBe(true)
  }
  await sessions.requestTrial(scope, draft.id, draft.revision, "起草并审查文档", () => {})
  const registry = new ProjectPreviewRegistry()
  registry.configurePersistence(settings)
  const packages = new HostPackageSnapshots(join(root, "packages"))
  const manager = nativeConfiguration
    ? new FunctionModsManager(settings, {
        plugins: () => [],
        enabled: () => false,
        secretProtector: testSecretProtector(),
        publish: async (_workspace, value) => value,
        changed: () => {}
      })
    : undefined
  const recoveryInputs = manager
    ? new StageRecoveryInputs({
        root: join(root, "recovery-inputs"),
        contextDataRoot: join(root, "plugin-data"),
        manager
      })
    : undefined
  if (recoveryInputs && manager)
    cleanup.push(async () => {
      recoveryInputs.close()
      manager.close()
    })
  const observed: Array<{ projectId: string; stage: string; upstream: string | null }> = []
  const providerErrors: string[] = []
  const serviceDependencies = {
    ...(manager
      ? createHostProjectInputIdentity(manager, {
          rules: () => [],
          contextDataRoot: join(root, "plugin-data")
        })
      : {}),
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
      const threadId = randomUUID()
      input.bindThread(threadId)
      if (providerScript) {
        input.stageDebug = debug.executionPolicy(input.project)
        const text = await executeStageRecoveryContextProvider(input, threadId, () => {}).catch(
          (error) => {
            providerErrors.push(error instanceof Error ? error.message : "unknown provider failure")
            throw error
          }
        )
        expect(text).toContain("REAL_NATIVE_PROVIDER_CONTEXT")
      }
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
    ...(recoveryInputs ? { recoveryInputs } : {}),
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
  if (providerScript) configureProjectStageDebugResolver(() => debug)
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
  if (manager)
    new FunctionUserConfigValues(settings, testSecretProtector()).save(
      original.workspace,
      original.packageId,
      userConfig,
      "audience",
      "native original editors",
      0,
      () => {}
    )
  for (const stage of original.manifest.stages) {
    const operation = service.prepare({
      projectId: originalId,
      expectedVersion: original.version,
      idempotencyKey: stage.id
    })
    if (stage.approval === "human" || operation.contextProvider)
      service.approve(operation.operationId, {
        expectedVersion: original.version,
        inputFingerprint: operation.inputFingerprint,
        decision: "approved",
        actorId: "native-user",
        ...(operation.contextProvider
          ? {
              contextProviderApproval: {
                policyDigest: operation.contextProvider.policyDigest,
                allowNetworkSideEffects: true as const
              }
            }
          : {})
      })
    const result = await service.start(operation.operationId)
    if (result.status === "failed") break
    expect(result.status, providerErrors.join(",")).toBe("succeeded")
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
    dependencies,
    manager,
    recoveryInputs,
    userConfig
  }
}

it("requires the original baseline for child branches while preserving repeated original-baseline iteration", async () => {
  const f = await fixture()
  const plan = await f.prepare("downstream")
  const created = await f.debug.create(f.context, {
    threadId: f.scope.threadId, preparationId: plan.id, expectedDigest: plan.candidateDigest
  })
  const branch = f.service.get(created.projectId)!
  const workspace = join(f.root, "rebranch")
  await mkdir(workspace)
  const input = {
    baselineId: f.snapshot.id, sourceProjectId: branch.projectId,
    expectedSourceVersion: branch.version, stageId: branch.manifest.stages[0].id,
    projectId: randomUUID(), name: "Cannot reset inherited prefix", workspace,
    installedPluginId: branch.installedPluginId, goal: branch.goal
  }
  await expect(f.service.createBranchAtStage(input)).rejects.toThrow("ORIGINAL_BASELINE_REQUIRED")
  expect(f.service.get(input.projectId)).toBeUndefined()
  const cold = new ProjectStageDebugSessions(f.dependencies)
  expect(() => cold.authorizeBranch({
    input, source: branch, candidate: { ...branch, projectId: input.projectId, workspace },
    sourceSnapshotRoot: f.packages.read(branch.pluginDigest).root,
    candidateSnapshotRoot: f.packages.read(branch.pluginDigest).root
  })).toThrow("ORIGINAL_BASELINE_REQUIRED")
  // End the inactive preview before acquiring another lease for the same draft.
  expect(f.service.operations(branch.projectId)).toEqual([])
  f.registry.finish(branch, f.scope, f.service.operations(branch.projectId))
  f.debug.end(branch)
  const next = await f.prepare("downstream")
  const iterated = await f.debug.create(f.context, {
    threadId: f.scope.threadId, preparationId: next.id, expectedDigest: next.candidateDigest
  })
  expect(iterated.projectId).not.toBe(branch.projectId)
  expect(f.debug.list(f.context).branches.map(value => value.sourceProjectId))
    .toEqual([f.original.projectId, f.original.projectId])
  expect(f.service.get(f.original.projectId)).toEqual(f.original)
}, 15000)

it("creates a native prompt-Hook branch without borrowing original approvals or dropping the declaration", async () => {
  const f = await fixture(false, undefined, () => {}, {
    apiVersion: "devclaw.stage-recovery/v1",
    hookExecution: "prompt-only",
    externalEffects: "deny"
  })
  const plan = await f.prepare()
  expect(plan.recovery).toMatchObject({ profile: "prompt-only", requiresNetworkApproval: false })
  const result = await f.debug.create(f.context, {
    threadId: f.scope.threadId,
    preparationId: plan.id,
    expectedDigest: plan.candidateDigest
  })
  const branch = f.service.get(result.projectId)!
  expect(f.debug.executionPolicy(branch)).toMatchObject({ allowPromptHooks: true })
  expect(f.service.operations(branch.projectId)).toEqual([])
  expect(
    await readFile(join(f.packages.read(branch.pluginDigest).root, "hooks/hooks.json"), "utf8")
  ).toContain("Check actual stage artifacts")
}, 15000)

it("forks a real configuration-only Host package through the complete native snapshot and branch service", async () => {
  const f = await fixture(
    false,
    undefined,
    () => {},
    {
      apiVersion: "devclaw.stage-recovery/v1",
      hookExecution: "prompt-only",
      externalEffects: "deny"
    },
    true
  )
  const plan = await f.prepare()
  const result = await f.debug.create(f.context, {
    threadId: f.scope.threadId,
    preparationId: plan.id,
    expectedDigest: plan.candidateDigest
  })
  const branch = f.service.get(result.projectId)!
  const values = new FunctionUserConfigValues(f.settings, testSecretProtector())
  expect(values.resolve(branch.workspace, branch.packageId, f.userConfig)).toMatchObject({
    audience: "native original editors"
  })
  expect(f.settings.getGrant(branch.workspace, `function:${branch.packageId}`)).toBeNull()
  expect(f.debug.executionPolicy(branch)).toMatchObject({ baselineId: f.snapshot.id })
  expect(f.debug.executionPolicy(branch)?.allowPromptHooks).toBe(true)
  expect(
    await readFile(join(f.packages.read(branch.pluginDigest).root, "hooks/hooks.json"), "utf8")
  ).toContain("Check actual stage artifacts")
  const operation = f.service.prepare({
    projectId: branch.projectId,
    expectedVersion: branch.version,
    idempotencyKey: "native-config-stage"
  })
  f.service.approve(operation.operationId, {
    expectedVersion: branch.version,
    inputFingerprint: operation.inputFingerprint,
    decision: "approved",
    actorId: "new-native-user"
  })
  expect((await f.service.start(operation.operationId)).status).toBe("succeeded")
  values.save(
    f.original.workspace,
    f.original.packageId,
    f.userConfig,
    "audience",
    "later original readers",
    1,
    () => {}
  )
  f.recoveryInputs!.assertBranchCurrent(branch.projectId)
  expect(values.resolve(branch.workspace, branch.packageId, f.userConfig)).toMatchObject({
    audience: "native original editors"
  })
  expect(f.service.get(f.original.projectId)).toEqual(f.original)
}, 25000)

it.runIf(process.platform === "win32")(
  "runs an independently approved real context script on the first trial and again on a frozen stage branch",
  async () => {
    const f = await fixture(
      false,
      undefined,
      () => {},
      {
        apiVersion: "devclaw.stage-recovery/v1",
        hookExecution: "windows-sandbox",
        externalEffects: "network-requires-confirmation",
        contextProvider: {
          protocol: "devclaw.context-text/v1",
          args: ["--stage", "${stageId}"]
        }
      },
      true,
      "import json, sys\nvalue=json.load(sys.stdin)\nassert value['configuration']['audience']=='native original editors'\nprint('REAL_NATIVE_PROVIDER_CONTEXT '+value['stageId'])\n"
    )
    const originalOperations = f.service.operations(f.original.projectId)
    expect(
      originalOperations.every(
        (operation) => operation.approval?.contextProviderApproval?.allowNetworkSideEffects
      )
    ).toBe(true)
    const plan = await f.prepare()
    const created = await f.debug.create(f.context, {
      threadId: f.scope.threadId,
      preparationId: plan.id,
      expectedDigest: plan.candidateDigest,
      recoveryApproval: { policyDigest: plan.recovery!.policyDigest, allowNetworkSideEffects: true }
    })
    const branch = f.service.get(created.projectId)!
    const operation = f.service.prepare({
      projectId: branch.projectId,
      expectedVersion: branch.version,
      idempotencyKey: "fresh-context-provider"
    })
    expect(operation.contextProvider?.protocol).toBe("devclaw.context-text/v1")
    const approval = {
      expectedVersion: branch.version,
      inputFingerprint: operation.inputFingerprint,
      decision: "approved" as const,
      actorId: "new-stage-user"
    }
    expect(() => f.service.approve(operation.operationId, approval)).toThrow(
      "CONTEXT_PROVIDER_APPROVAL_REQUIRED"
    )
    expect(() =>
      f.service.approve(operation.operationId, {
        ...approval,
        contextProviderApproval: { policyDigest: "a".repeat(64), allowNetworkSideEffects: true }
      })
    ).toThrow("CONTEXT_PROVIDER_APPROVAL_REQUIRED")
    await expect(f.service.start(operation.operationId)).rejects.toThrow("APPROVAL_REQUIRED")
    f.service.approve(operation.operationId, {
      ...approval,
      contextProviderApproval: {
        policyDigest: operation.contextProvider!.policyDigest,
        allowNetworkSideEffects: true
      }
    })
    expect((await f.service.start(operation.operationId)).status).toBe("succeeded")
    expect(f.service.operations(f.original.projectId)).toEqual(originalOperations)
    expect(new StageRecoveryHookJournal(f.settings).list(branch.projectId)).toMatchObject([
      { phase: "settled", exitCode: 0 }
    ])
  },
  40000
)

it.runIf(process.platform === "win32")(
  "requires a distinct exact-policy native confirmation before creating a command recovery branch",
  async () => {
    const f = await fixture(false, undefined, () => {}, {
      apiVersion: "devclaw.stage-recovery/v1",
      hookExecution: "windows-sandbox",
      externalEffects: "network-requires-confirmation"
    })
    const plan = await f.prepare()
    expect(plan.recovery).toMatchObject({
      profile: "windows-sandbox",
      requiresNetworkApproval: true
    })
    const input = {
      threadId: f.scope.threadId,
      preparationId: plan.id,
      expectedDigest: plan.candidateDigest
    }
    await expect(f.debug.create(f.context, input)).rejects.toThrow("RECOVERY_APPROVAL_REQUIRED")
    await expect(
      f.debug.create(f.context, {
        ...input,
        recoveryApproval: {
          policyDigest: "b".repeat(64),
          allowNetworkSideEffects: true
        }
      })
    ).rejects.toThrow("RECOVERY_APPROVAL_REQUIRED")
    expect(f.debug.list(f.context).branches).toHaveLength(0)
    const result = await f.debug.create(f.context, {
      ...input,
      recoveryApproval: {
        policyDigest: plan.recovery!.policyDigest,
        allowNetworkSideEffects: true
      }
    })
    const branch = f.service.get(result.projectId)!
    expect(f.debug.executionPolicy(branch)).toMatchObject({
      commandHooks: {
        networkAccess: "explicitly-approved",
        readOnlyRoots: expect.arrayContaining([f.original.workspace])
      }
    })
    expect(f.service.operations(branch.projectId)).toEqual([])
    expect(() => new ProjectStageDebugSessions(f.dependencies).executionPolicy(branch)).toThrow(
      "RECONFIRMATION_REQUIRED"
    )
  },
  15000
)

it.runIf(process.platform === "win32")(
  "keeps a lost command publication unknown and cold-reconciles its exact native close without inheriting execution",
  async () => {
    const f = await fixture(false, undefined, () => {}, {
      apiVersion: "devclaw.stage-recovery/v1",
      hookExecution: "windows-sandbox",
      externalEffects: "network-requires-confirmation"
    })
    const plan = await f.prepare()
    const created = await f.debug.create(f.context, {
      threadId: f.scope.threadId,
      preparationId: plan.id,
      expectedDigest: plan.candidateDigest,
      recoveryApproval: {
        policyDigest: plan.recovery!.policyDigest,
        allowNetworkSideEffects: true
      }
    })
    const branch = f.service.get(created.projectId)!
    const operation = f.service.prepare({
      projectId: branch.projectId,
      expectedVersion: branch.version,
      idempotencyKey: "exact-command-intent"
    })
    f.service.approve(operation.operationId, {
      expectedVersion: branch.version,
      inputFingerprint: operation.inputFingerprint,
      decision: "approved",
      actorId: "fresh-user"
    })
    const execute = f.serviceDependencies.executeSkill
    f.serviceDependencies.executeSkill = async (input) => {
      const result = await execute(input)
      const current = f.service
        .operations(branch.projectId)
        .find((value) => value.operationId === operation.operationId)!
      const source = {
        mode: "host" as const,
        projectId: branch.projectId,
        operationId: operation.operationId,
        threadId: current.execution!.threadId!,
        incarnationKey: "native-actual-execution",
        workspace: branch.workspace,
        stageId: "review",
        packageDigest: branch.pluginDigest,
        stageDebug: f.debug.executionPolicy(input.project),
        plugin: { id: branch.installedPluginId, path: input.snapshotRoot }
      } as Parameters<typeof f.debug.beginHookExecution>[0]
      expect(() =>
        f.debug.beginHookExecution({ ...source, operationId: "forged" }, {} as never)
      ).toThrow("HOOK_SCOPE_CHANGED")
      const receipt = f.debug.beginHookExecution(source, {
        id: "retained-command",
        type: "command",
        event: "PostSkillUse",
        command: "original retained check",
        enabled: true,
        createdAt: "",
        updatedAt: ""
      })
      const originalCas = f.settings.compareAndSetSetting.bind(f.settings)
      const publish = vi
        .spyOn(f.settings, "compareAndSetSetting")
        .mockImplementation((key, before, next) =>
          key.startsWith("project-stage-recovery-hooks-v1:")
            ? false
            : originalCas(key, before, next)
        )
      try {
        expect(() => receipt.settle(0, false, "d".repeat(64))).toThrow("HOOK_JOURNAL_CHANGED")
      } finally {
        publish.mockRestore()
      }
      return result
    }
    const result = await f.service.start(operation.operationId)
    expect(result.status).toBe("unknown")
    expect(new StageRecoveryHookJournal(f.settings).hasUnresolved(branch.projectId)).toBe(true)
    await expect(f.prepare()).rejects.toThrow("OUTCOME_UNCONFIRMED")
    await expect(f.service.reconcile(operation.operationId)).rejects.toThrow("OUTCOME_UNCONFIRMED")
    const cold = new ProjectStageDebugSessions(f.dependencies)
    await expect(
      cold.reconcileHooks(f.context, {
        threadId: f.scope.threadId,
        projectId: branch.projectId,
        approveNetworkInspection: false
      } as never)
    ).rejects.toThrow("HOOK_SCOPE_CHANGED")
    await expect(
      cold.reconcileHooks(f.context, {
        threadId: f.scope.threadId,
        projectId: branch.projectId
        // Exact host completion facts are local; no network permission is needed.
      })
    ).resolves.toMatchObject({ remaining: 0 })
    expect(f.service.operations(branch.projectId)[0].status).toBe("unknown")
    expect(() => cold.executionPolicy(f.service.get(branch.projectId)!)).toThrow(
      "RECONFIRMATION_REQUIRED"
    )
    const verified = await f.service.reconcile(operation.operationId)
    expect(verified.status).toBe("succeeded")
    expect(verified.receipts.length).toBeGreaterThan(0)
    expect(verified.receipts.every((receipt) => receipt.result === "passed")).toBe(true)
    f.registry.finish(
      f.service.get(branch.projectId)!,
      f.scope,
      f.service.operations(branch.projectId),
      undefined,
      f.debug.finishOptions(branch)
    )
    f.debug.end(branch)
    f.serviceDependencies.executeSkill = execute
    const next = await f.prepare()
    const nextCreated = await f.debug.create(f.context, {
      threadId: f.scope.threadId,
      preparationId: next.id,
      expectedDigest: next.candidateDigest,
      recoveryApproval: {
        policyDigest: next.recovery!.policyDigest,
        allowNetworkSideEffects: true
      }
    })
    const nextBranch = f.service.get(nextCreated.projectId)!
    expect(nextBranch.projectId).not.toBe(branch.projectId)
    expect(f.service.operations(nextBranch.projectId)).toEqual([])
    const nextOperation = f.service.prepare({
      projectId: nextBranch.projectId,
      expectedVersion: nextBranch.version,
      idempotencyKey: "fresh-approved-recovery"
    })
    const executions = f.observed.length
    await expect(f.service.start(nextOperation.operationId)).rejects.toThrow()
    expect(f.observed).toHaveLength(executions)
    f.service.approve(nextOperation.operationId, {
      expectedVersion: nextBranch.version,
      inputFingerprint: nextOperation.inputFingerprint,
      decision: "approved",
      actorId: "fresh-native-user"
    })
    expect((await f.service.start(nextOperation.operationId)).status).toBe("succeeded")
    expect(f.observed).toHaveLength(executions + 1)
    expect(f.service.get(f.original.projectId)).toEqual(f.original)
  },
  15000
)

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
    expect(() => assertStageDebugToolCall(policy, "execute", { command: "forbidden" })).toThrow(
      "PROJECT_STAGE_DEBUG_TOOL_UNSUPPORTED"
    )
    ownerCurrent = false
    expect(() => f.registry.assertProject(branch)).toThrow("DEVELOPMENT_SCOPE_CHANGED")
    expect(captureRuntimePluginSourceToken()).toBe(token)
    expect(currentStageDebugSourcePolicy()).toEqual(policy)
    expect(() => nativeOwnerGuard()).toThrow("PROJECT_STAGE_DEBUG_MODS_UNSUPPORTED")
    expect(() => assertStageDebugToolCall(policy, "mod_function", {})).toThrow(
      "PROJECT_STAGE_DEBUG_TOOL_UNSUPPORTED"
    )
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
    projectId: branch.projectId,
    expectedVersion: branch.version,
    idempotencyKey: "interrupted-review"
  })
  f.service.approve(operation.operationId, {
    expectedVersion: branch.version,
    inputFingerprint: operation.inputFingerprint,
    decision: "approved",
    actorId: "new-native-user"
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
    ...f.dependencies,
    registry,
    platform: () => service,
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
    ...f,
    cold: service,
    coldRegistry: registry,
    branch,
    operation,
    executions,
    revokeScope: () => {
      scopeCurrent = false
    },
    executionAuthorizations: () => executionAuthorizations
  }
}

it("cold-reconciles a real terminal and pinned file checks without reviving debug execution", async () => {
  const f = await interruptedColdBranch("terminal")
  // Changing the current draft must not substitute code into historical result inspection.
  const current = f.sessions.read(f.scope, f.draft.id)
  await f.sessions.save(
    f.scope,
    {
      id: current.id,
      name: current.name,
      revision: current.revision,
      files: current.source.files.map((file) =>
        file.path === "skills/review/SKILL.md"
          ? { ...file, text: `${file.text}\nA later mutable draft\n` }
          : file
      )
    },
    () => {}
  )
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
  const created = await f.debug.create(f.context, {
    threadId: f.scope.threadId,
    preparationId: plan.id,
    expectedDigest: plan.candidateDigest
  })
  const branch = f.service.get(created.projectId)!
  const originalOperations = f.service.operations(f.original.projectId)
  const unchanged = await f.debug.compare(f.context, {
    threadId: f.scope.threadId,
    projectId: branch.projectId
  })
  expect(unchanged.status).toBe("available")
  expect(unchanged.counts).toEqual({ added: 0, deleted: 0, modified: 0, unchanged: 1 })
  await writeFile(join(branch.workspace, "extra.bin"), Buffer.from([0, 1]))
  await writeFile(join(branch.workspace, "draft.md"), "changed branch input")
  const comparison = await f.debug.compare(f.context, {
    threadId: f.scope.threadId,
    projectId: branch.projectId
  })
  expect(comparison.status).toBe("available")
  expect(comparison.counts).toEqual({ added: 1, deleted: 0, modified: 1, unchanged: 0 })
  expect(JSON.stringify(comparison)).not.toContain(f.root)
  expect(JSON.stringify(comparison)).not.toContain("changed branch input")
  expect(f.service.operations(branch.projectId)).toEqual([])
  expect(f.service.operations(f.original.projectId)).toEqual(originalOperations)
  expect(f.debug.list(f.context).branches[0].status).toBe("ready")
  f.registry.finish(branch, f.scope, [], undefined, f.debug.finishOptions(branch))
  f.debug.end(branch)
  const cold = new ProjectStageDebugSessions(f.dependencies)
  expect(
    (await cold.compare(f.context, { threadId: f.scope.threadId, projectId: branch.projectId }))
      .status
  ).toBe("available")
  expect(() => cold.assertCommand(branch, "prepare")).toThrow("RECONFIRMATION_REQUIRED")
  await expect(
    cold.compare(
      { scope: { ...f.scope, threadId: "other" }, guard: () => {} },
      { threadId: "other", projectId: branch.projectId }
    )
  ).rejects.toThrow("COMPARISON_SCOPE_CHANGED")
}, 15000)

it("does not return a partial comparison for a changed immutable baseline or new secret file", async () => {
  const f = await fixture()
  const plan = await f.prepare()
  const created = await f.debug.create(f.context, {
    threadId: f.scope.threadId,
    preparationId: plan.id,
    expectedDigest: plan.candidateDigest
  })
  const branch = f.service.get(created.projectId)!
  await writeFile(join(branch.workspace, ".env"), "credential-value-never-publish")
  const blocked = await f.debug.compare(f.context, {
    threadId: f.scope.threadId,
    projectId: branch.projectId
  })
  expect(blocked).toMatchObject({ status: "unavailable", files: [] })
  expect(JSON.stringify(blocked)).not.toContain("credential-value-never-publish")
  await rm(join(branch.workspace, ".env"))
  await writeFile(
    join(f.dependencies.root, "inputs", f.snapshot.id, "files", "draft.md"),
    "tampered input snapshot"
  )
  expect(
    await f.debug.compare(f.context, { threadId: f.scope.threadId, projectId: branch.projectId })
  ).toMatchObject({ status: "unavailable", files: [] })
}, 15000)

it("refuses file comparison while native branch outcomes remain unknown", async () => {
  const f = await interruptedColdBranch("missing")
  expect(
    await f.debug.compare(f.context, { threadId: f.scope.threadId, projectId: f.branch.projectId })
  ).toMatchObject({ status: "unavailable", files: [] })
  expect(f.service.operations(f.branch.projectId)[0].status).toBe("unknown")
  expect(f.observed).toHaveLength(f.executions)
}, 15000)

it("refuses file comparison during an actual native branch execution", async () => {
  const f = await fixture()
  const plan = await f.prepare()
  const created = await f.debug.create(f.context, {
    threadId: f.scope.threadId,
    preparationId: plan.id,
    expectedDigest: plan.candidateDigest
  })
  const branch = f.service.get(created.projectId)!
  const operation = f.service.prepare({
    projectId: branch.projectId,
    expectedVersion: branch.version,
    idempotencyKey: "comparison-running"
  })
  f.service.approve(operation.operationId, {
    expectedVersion: branch.version,
    inputFingerprint: operation.inputFingerprint,
    decision: "approved",
    actorId: "fresh-native-user"
  })
  let entered!: () => void, resume!: () => void
  const active = new Promise<void>((resolve) => {
    entered = resolve
  })
  const paused = new Promise<void>((resolve) => {
    resume = resolve
  })
  const execute = f.serviceDependencies.executeSkill
  f.serviceDependencies.executeSkill = async (input) => {
    entered()
    await paused
    return execute(input)
  }
  const execution = f.service.start(operation.operationId)
  try {
    await active
    expect(f.service.operations(branch.projectId)[0].status).toBe("started")
    expect(
      await f.debug.compare(f.context, { threadId: f.scope.threadId, projectId: branch.projectId })
    ).toMatchObject({ status: "unavailable", files: [] })
  } finally {
    resume()
    await execution
  }
}, 15000)

it("projects fixed branch candidate provenance without treating an edited candidate as the historical branch", async () => {
  const f = await fixture()
  const plan = await f.prepare()
  const created = await f.debug.create(f.context, {
    threadId: f.scope.threadId,
    preparationId: plan.id,
    expectedDigest: plan.candidateDigest
  })
  const before = f.debug
    .list(f.context)
    .branches.find((branch) => branch.projectId === created.projectId)!
  expect(before).toMatchObject({
    candidateDigest: plan.candidateDigest,
    currentCandidateMatches: true,
    status: "ready"
  })
  // End the native branch lease before saving another creator revision.
  const project = f.service.get(created.projectId)!
  f.registry.finish(project, f.scope, [], undefined, f.debug.finishOptions(project))
  f.debug.end(project)
  const current = f.sessions.read(f.scope, f.draft.id)
  await f.sessions.save(
    f.scope,
    {
      id: current.id,
      name: current.name,
      revision: current.revision,
      files: current.source.files.map((file) =>
        file.path === "skills/review/SKILL.md"
          ? { ...file, text: file.text + "\nA later source version\n" }
          : file
      )
    },
    () => {}
  )
  expect(
    f.debug.list(f.context).branches.find((branch) => branch.projectId === created.projectId)
  ).toMatchObject({
    candidateDigest: plan.candidateDigest,
    currentCandidateMatches: false,
    status: "ready"
  })
}, 15000)

it.each(["branch", "source"] as const)(
  "rejects a changed pinned %s package while keeping cold comparison read-only",
  async (target) => {
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
    const pinned = f.packages.read(
      target === "branch" ? branch.pluginDigest : f.original.pluginDigest
    ).root
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
  },
  15000
)

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
    const result = await f.debug.compare(f.context, {
      threadId: f.scope.threadId,
      projectId: branch.projectId
    })
    expect(changed).toBe(true)
    expect(result).toMatchObject({ status: "unavailable", files: [] })
    expect(f.service.get(f.original.projectId)).toEqual(original)
    expect(f.service.operations(f.original.projectId)).toEqual(originalOperations)
    expect(f.service.operations(branch.projectId)).toEqual([])
  } finally {
    intercepted.mockRestore()
  }
}, 15000)
