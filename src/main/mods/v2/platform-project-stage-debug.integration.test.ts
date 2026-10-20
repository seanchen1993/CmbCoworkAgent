import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { ProjectStageDebugSessions } from "../devtools/project-stage-debug"
import { ProjectAuthoringSessions } from "../devtools/project-authoring-session"
import { ProjectPreviewRegistry } from "../devtools/project-preview-registry"
import { HostProjectStore } from "../../harness-board/project-runtime/host-store"
import { HostProjectService } from "../../harness-board/project-runtime/host-service"
import { HostPackageSnapshots } from "../../harness-board/project-runtime/package-snapshots"
import { ModControlStore } from "../control-store"
import type { DevelopmentScope } from "./development-session"
import { inspectHostProjectExecution } from "../../harness-board/project-runtime/host-execution-inspector"
import { compileFunctionPlugin } from "./loader"
import { analyzeFunctionSdk } from "../devtools/sdk-usage"
import { checkFunctionAuthorTypes } from "../devtools/authoring-check"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { FunctionUiNode } from "../../../shared/mods/v2/ui"
import { withFunctionExecution } from "./execution-context"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { createProjectStageDebugPlatformProvider } from "./platform-project-stage-debug-provider"
import { ProjectStageDebugReviewHub } from "./project-stage-debug-review-hub"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

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

it("ships a third-party Mod using only public platform and UI capabilities", async () => {
  const root = resolve("examples/sparks-stage-debugger")
  expect((await checkFunctionAuthorTypes(root)).diagnostics).toEqual([])
  const review = await analyzeFunctionSdk(await compileFunctionPlugin(root, { captureSources: true }))
  expect(review.diagnostics).toEqual([])
  expect(review.usages.map(item => item.method)).toEqual(expect.arrayContaining(["platform.read", "platform.act", "ui.open", "ui.invalidate"]))
  expect(review.usages.some(item => /^(?:fs|process|http|mcp|model|tool)\./.test(item.method))).toBe(false)
})

it("real QuickJS Pane prepares from real captured stage evidence and queues native readback after the action ends", async () => {
  const f = await fixture(true)
  // A normal failed original review can be retried without fabricating a snapshot. The second
  // original operation captures a distinct entry including the first attempt's actual outputs.
  const retry = f.service.prepare({ projectId: f.original.projectId,
    expectedVersion: f.original.version, idempotencyKey: "original-review-retry" })
  f.service.approve(retry.operationId, { expectedVersion: f.original.version,
    inputFingerprint: retry.inputFingerprint, decision: "approved", actorId: "native-user" })
  expect((await f.service.start(retry.operationId)).status).toBe("failed")
  const retriedSnapshots = f.debug.list(f.context).snapshots.filter(item => item.stageId === "review")
  expect(retriedSnapshots).toHaveLength(2)
  expect(new Set(retriedSnapshots.map(item => item.id)).size).toBe(2)
  expect(new Set(retriedSnapshots.map(item => item.sourceDigest)).size).toBe(1)
  const duplicate = await f.sessions.save(f.scope, { id: "same-title-candidate", name: f.draft.name,
    revision: 0, files: f.revised.source.files }, f.context.guard)
  const duplicateRevision = await f.sessions.save(f.scope, { id: duplicate.id, name: duplicate.name,
    revision: duplicate.revision, files: duplicate.source.files }, f.context.guard)
  expect(duplicateRevision.revision).toBe(f.revised.revision)
  const compiled = await compileFunctionPlugin(resolve("examples/sparks-stage-debugger"), { captureSources: true })
  let callerCurrent = true
  const hub = new ProjectStageDebugReviewHub(() => true, async intent => {
    f.context.guard()
    if (!callerCurrent || intent.caller.digest !== compiled.digest || intent.caller.name !== compiled.name)
      throw Error("NATIVE_CALLER_SOURCE_CHANGED")
    if (intent.threadId !== f.scope.threadId || intent.workspace !== f.scope.workspace ||
      JSON.stringify(intent.incarnation) !== JSON.stringify(f.scope.incarnation)) throw Error("NATIVE_CREATOR_CHANGED")
  })
  const provider = createProjectStageDebugPlatformProvider({
    creator: () => f.context,
    debug: () => f.debug,
    drafts: scope => f.sessions.list(scope).map(draft => ({ id: draft.id, name: draft.name,
      revision: draft.revision, digest: draft.source.digest })),
    openReview: input => hub.request(input)
  })
  const guest = await FunctionGuestRuntime.create(compiled.code, compiled.options)
  const plugin = { name: compiled.name, root: compiled.root, tier: "user" as const, guest,
    capabilities: [...SESSION_CAPABILITIES] }
  const session = new FunctionSession([plugin], {
    workspace: f.scope.workspace, threadId: f.scope.threadId,
    platformIncarnation: JSON.stringify(f.scope.incarnation),
    platformSource: () => ({ provider: compiled.name, digest: compiled.digest, generation: "actual-guest" }),
    platformNativeProviders: [provider], assertLive() { if (!callerCurrent) throw Error("CALLER_REMOVED") },
    publish: async value => value
  })
  cleanup.push(async () => { await session.close(true); hub.close() })
  const before = f.service.get(f.original.projectId), operations = f.service.operations(f.original.projectId)
  const listed = session.platformSurfaces.list()
  const entry = listed.entries.find(item => item.placement === "sidebar")!
  expect(entry).toBeDefined()
  const initial = { key: entry.key, revision: listed.revision }
  const opened = await session.platformSurfaces.open(initial, new AbortController().signal, "stage-debug-open")
  const address = { ...initial, openId: opened.openId }
  async function tree() {
    return (await session.platformSurfaces.read(address)).pane!
  }
  async function press(label: string) {
    const pane = await tree()
    const walk = (node: FunctionUiNode): FunctionUiNode[] => [node, ...(node.children ?? []).flatMap(child =>
      typeof child === "object" && child !== null && "type" in child ? walk(child as FunctionUiNode) : [])]
    const button = walk(pane.tree as FunctionUiNode).find(node => node.type === "Button" && String(node.props.label).includes(label))!
    expect(button, label).toBeDefined()
    const runId = randomUUID()
    claimLocalThreadRunLease({ threadId: f.scope.threadId, owner: "mods", runId })
    try {
      await withFunctionExecution({ workspace: f.scope.workspace, threadId: f.scope.threadId,
        userInitiated: true, leased: true, immediate: false }, () => session.platformSurfaces.act(address, {
          pane: pane.key, generation: pane.generation, plugin: button.press!.plugin,
          handle: button.press!.handle, intentId: randomUUID(), kind: "press"
        }))
    } finally { releaseLocalThreadRunLease(f.scope.threadId, "mods", runId) }
  }
  await press("刷新原生状态")
  const choices = JSON.stringify((await tree()).tree)
  for (const item of retriedSnapshots) expect(choices).toContain("快照 " + item.id.slice(0, 12))
  expect(choices).toContain("候选 " + f.draft.id + " ·")
  expect(choices).toContain("候选 " + duplicateRevision.id + " ·")
  await press("快照 " + f.snapshot.id.slice(0, 12))
  await press("候选 " + f.draft.id + " ·")
  const selected = JSON.stringify((await tree()).tree)
  expect(selected).toContain("已选输入快照：" + f.snapshot.id)
  expect(selected).toContain("已选候选：" + f.draft.id)
  await press("准备单阶段调试")
  const prepared = JSON.stringify((await tree()).tree)
  expect(prepared).toContain(f.revised.source.digest)
  expect(prepared).toContain("尚未创建、执行或批准")
  await press("前往原生复核")
  // Intentionally outside withFunctionExecution and after the real native UI action lease ended.
  const intent = await hub.current(f.scope.threadId, f.scope.workspace, f.scope.incarnation)
  expect(intent).toMatchObject({ snapshotId: f.snapshot.id, draftId: f.draft.id,
    revision: f.revised.revision, candidateDigest: f.revised.source.digest,
    caller: { name: compiled.name, digest: compiled.digest } })
  expect(f.debug.list(f.context).branches).toEqual([])
  expect(f.service.get(f.original.projectId)).toEqual(before)
  expect(f.service.operations(f.original.projectId)).toEqual(operations)
  expect(await hub.current("another-thread", f.scope.workspace, f.scope.incarnation)).toBeUndefined()
  callerCurrent = false
  expect(await hub.current(f.scope.threadId, f.scope.workspace, f.scope.incarnation)).toBeUndefined()
  // This added integration performs an original failed stage, a real retry/snapshot, authoring
  // and the QuickJS UI. Match the existing real project-stage-debug suite's 15s case budget.
}, 15000)
