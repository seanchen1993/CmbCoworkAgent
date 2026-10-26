import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import type { BrowserWindow } from "electron"
import type { HostSkillExecutionContext } from "../../harness-board/project-runtime/host-service"
import { HostProjectService } from "../../harness-board/project-runtime/host-service"
import { HostProjectStore } from "../../harness-board/project-runtime/host-store"
import { HostPackageSnapshots } from "../../harness-board/project-runtime/package-snapshots"
import { executeHostProjectStage } from "../../harness-board/project-action-executor"
import { setProjectActionRuntime } from "../../harness-board/project-action-runtime"
import {
  captureProjectActionContentGuard,
  projectActionFlowMetadata
} from "../../harness-board/project-action-scope"
import { ProjectStageDebugSessions } from "./project-stage-debug"
import { ProjectAuthoringSessions } from "./project-authoring-session"
import { ProjectPreviewRegistry } from "./project-preview-registry"
import { ModControlStore } from "../control-store"
import { FunctionModsManager } from "../v2/manager"
import { FunctionGuestRuntime } from "../v2/guest-runtime"
import { readOriginalActionText } from "../v2/action-result-text"
import { FlowManager } from "../flows/manager"
import { FlowStore } from "../flows/store"
import { publishOriginalFlowActionResult } from "../flows/action-execution-facts"
import { isOrdinaryFlowMetadata } from "../../../shared/mods/flows/scope"
import type { NativeComposition } from "../../plugins/native-composition"

const threads = vi.hoisted(() => new Map<string, { created_at: number; metadata: string }>())
vi.mock("../../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db")>()),
  getThreadCore: (id: string) => threads.get(id)
}))
vi.mock("../../harness-board/host-skill-executor", () => ({
  // Only model generation is deterministic. Host, snapshots, Flow, Guest, grants and checks are real.
  executeHostProjectSkill: async (context: HostSkillExecutionContext) => {
    const id = randomUUID()
    threads.set(id, {
      created_at: 1,
      metadata: JSON.stringify({
        workspacePath: context.project.workspace,
        cmb_thread_incarnation: id,
        hostProjectRuntime: {
          projectId: context.project.projectId,
          operationId: context.operation.operationId,
          stageId: context.operation.stageId,
          pluginDigest: context.project.pluginDigest
        }
      })
    })
    context.bindThread(id)
    await context.prepareThread?.(id)
    const path = context.project.stageIndex === 0 ? "document.json" : "review.json"
    writeFileSync(
      join(context.project.workspace, path),
      JSON.stringify(
        context.project.stageIndex === 0
          ? { content: "Original retained document" }
          : { summary: "Read the actual prior document", accepted: true }
      )
    )
    context.recordTerminal({ outcome: "success", code: "controlled-model-terminal" })
    return "succeeded"
  }
}))

it("creates and accepts a native isolated branch using fresh real Guest checks and independent result approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-debug-check-"))
  const settings = new ModControlStore(join(root, "settings.sqlite"))
  const store = new HostProjectStore(join(root, "host.sqlite"))
  const provider = join(root, "provider")
  mkdirSync(join(provider, "hooks"), { recursive: true })
  writeFileSync(
    join(provider, "plugin.json"),
    JSON.stringify({
      name: "pure-review",
      version: "1.0.0",
      claw: {
        actions: [
          {
            id: "check",
            name: "Check review",
            inputSchema: { type: "object" },
            platform: { id: "review", version: "1.0.0", action: "check" }
          }
        ]
      }
    })
  )
  writeFileSync(join(provider, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  writeFileSync(
    join(provider, "hooks/register.ts"),
    `export function register(on) {
    on.capability({apiVersion:"devclaw.capability/v1",id:"review",version:"1.0.0",title:"Review",
      scope:"conversation",stateSchema:{type:"object"},actions:[{id:"check",title:"Check",
      inputSchema:{type:"object"},outputSchema:{type:"object"},requiredPermissions:[],cancellable:true,idempotency:"keyed"}]},
      {act:async($,event)=>{const value=event.input.input;
        return {status:value.accepted===true&&value.summary?"succeeded":"failed",text:"Actual review verified"}}})
  }`
  )
  const guests: FunctionGuestRuntime[] = []
  const functions = new FunctionModsManager(
    settings,
    {
      plugins: () => [{ id: "checks-install", name: "pure-review", path: provider, enabled: true }],
      enabled: () => true,
      clawApplicable: () => true,
      changed: () => {},
      publish: async (_workspace, value) => value
    },
    () => ({
      load: async (code, options) => {
        const guest = await FunctionGuestRuntime.create(code, options)
        guests.push(guest)
        return guest
      },
      stop: () => guests.forEach((guest) => guest.dispose()),
      stopAndDrain: async () => guests.forEach((guest) => guest.dispose())
    })
  )
  const flowStore = new FlowStore(settings)
  let executions = 0
  const flows = new FlowManager(flowStore, {
    assertScope: (_workspace, id) => {
      const metadata = JSON.parse(threads.get(id)!.metadata)
      if (!isOrdinaryFlowMetadata(projectActionFlowMetadata(id, metadata)))
        throw Error("UNADMITTED_FLOW")
    },
    changed: () => {},
    prepare: async (workspace, threadId) => {
      const guard = captureProjectActionContentGuard()
      return {
        assertLive: () => {},
        fingerprint: async () => "stable",
        execute: async (step, execution) => {
          guard?.()
          if (step.kind !== "plugin-action") throw Error("EXPECTED_ACTION")
          const selected = await functions.prepareAction(
            workspace,
            threadId,
            step,
            execution.signal
          )
          const result = await functions.runAction(
            workspace,
            threadId,
            selected,
            {
              version: 1,
              input: step.input,
              config: step.config ?? {},
              task: "Verify review",
              runId: execution.run.id,
              stepId: step.id,
              executionId: execution.executionId
            },
            execution.signal
          )
          executions++
          guard?.()
          return publishOriginalFlowActionResult(
            {
              passed: result.passed ?? true,
              source: "plugin-action",
              summary: result.text,
              provider: {
                pluginId: step.pluginId,
                plugin: step.plugin,
                digest: step.digest,
                actionId: step.actionId
              }
            },
            async (value) => value,
            readOriginalActionText(result)
          )
        },
        finalize: async (_context, confirm) => {
          await confirm()
          return { passed: true, source: "native-check", summary: "settled" }
        },
        dispose: async () => {}
      }
    }
  })
  try {
    const [status] = await functions.status(root)
    await functions.approve(root, status.pluginId, status.digest!)
    const catalog = () => functions.actionCatalog(root, "creator")
    setProjectActionRuntime({
      flows,
      catalog: (workspace, id) => functions.actionCatalog(workspace, id),
      prepareSelection: async () => {},
      verifyReadOnlyCheckProvider: (...args) => functions.verifyReadOnlyCheckProvider(...args),
      readRuns: (workspace, id) => flowStore.runs(workspace, id),
      readActionResult: (workspace, id, run, execution) =>
        flowStore.actionResult(workspace, id, run, execution)
    })
    const scope = {
      threadId: "creator",
      workspace: root,
      incarnation: { token: "creator", legacyCreatedAt: 1 }
    }
    const guard = () => {}
    const sessions = new ProjectAuthoringSessions()
    sessions.configurePersistence(settings, join(root, "sources"))
    let draft = await sessions.scaffold(scope, "documents", "Documents", guard, "native-modular")
    const source = JSON.parse(
      draft.source.files.find((file) => file.path === "composition/source.json")!.text
    ) as NativeComposition
    source.modules[1].checks.push({
      id: "review-business",
      kind: "action",
      artifactId: "review",
      provider: { plugin: "pure-review", actionId: "check" },
      format: "json"
    })
    draft = await sessions.save(
      scope,
      {
        id: draft.id,
        revision: draft.revision,
        name: draft.name,
        files: draft.source.files.map((file) => {
          if (file.path === "composition/source.json")
            return { ...file, text: JSON.stringify(source) }
          if (file.path === "tests/project-contract.json") {
            const contract = JSON.parse(file.text)
            // Isolated fixtures have no real business action receipt; only the trial can pass it.
            contract.cases.forEach((item: { stageId: string; expected: string }) => {
              if (item.stageId === "review") item.expected = "failed"
            })
            return { ...file, text: JSON.stringify(contract) }
          }
          return file
        })
      },
      guard
    )
    await sessions.compile(scope, draft.id, draft.revision, guard)
    draft = sessions.read(scope, draft.id)
    await sessions.requestTrial(
      scope,
      draft.id,
      draft.revision,
      "Read and review",
      guard,
      await catalog()
    )
    const registry = new ProjectPreviewRegistry()
    registry.configurePersistence(settings)
    const packages = new HostPackageSnapshots(join(root, "packages"))
    const service = new HostProjectService(store, packages, {
      resolveInstalledPlugin: async (id) => {
        const plugin = registry.resolve(id)!
        return {
          installedPluginId: id,
          root: plugin.path,
          packageId: plugin.name,
          packageVersion: plugin.version,
          enabled: true
        }
      },
      authorize: async (project) => {
        registry.assertProject(project)
      },
      beforeExecuteStage: (context) => debug.beforeExecute(context),
      authorizeStageBranch: async (context) => debug.authorizeBranch(context),
      assertCommand: (project, kind) => debug.assertCommand(project, kind),
      executeSkill: (context) =>
        executeHostProjectStage(
          { ...context, stageDebug: debug.executionPolicy(context.project) },
          {} as BrowserWindow,
          guard
        )
    })
    const debug: ProjectStageDebugSessions = new ProjectStageDebugSessions({
      root: join(root, "debug"),
      settings,
      sessions,
      registry,
      platform: () => service,
      retainedRoot: (project) => packages.read(project.pluginDigest).root,
      assertWorkspaceIdle: () => {},
      authorizeResources: async (workspace) => flows.assertWorkspaceResourcesSettled(workspace)
    })
    const lease = sessions.acquireDevelopment(scope, draft.id, draft.revision, guard)
    const originalId = randomUUID()
    const plugin = await registry.register({
      projectId: originalId,
      scope,
      snapshot: lease.snapshot,
      guard,
      release: lease.release,
      actions: await catalog()
    })
    let original = await service.localCreate({
      projectId: originalId,
      installedPluginId: plugin.id,
      workspace: lease.snapshot.workspace,
      name: "Original",
      goal: "Read and review"
    })
    await registry.bind(original, packages.read(original.pluginDigest).root)
    await functions.approve(original.workspace, status.pluginId, status.digest!)
    const run = async (projectId: string) => {
      const project = service.get(projectId)!
      const operation = service.prepare({
        projectId,
        expectedVersion: project.version,
        idempotencyKey: randomUUID()
      })
      const result = await service.start(operation.operationId)
      expect(result.status, JSON.stringify(result)).toBe("succeeded")
      if (project.manifest.stages[project.stageIndex].resultApproval === "human") {
        expect(result.resultApproval).toBeNull()
        expect(() => service.transition(operation.operationId)).toThrow(
          projectId === originalId ? "RESULT_APPROVAL_REQUIRED" : "SINGLE_STAGE_ONLY"
        )
        service.decideResultApproval(operation.operationId, {
          ...service.resultReview(operation.operationId),
          decision: "approved",
          actorId: "new-desktop-user"
        })
      }
      return operation.operationId
    }
    original = service.transition(await run(originalId))
    original = service.transition(await run(originalId))
    expect(original.status).toBe("completed")
    expect(executions).toBe(1)
    const originalBytes = readFileSync(join(original.workspace, "review.json"))
    const snapshot = debug
      .list({ scope, guard })
      .snapshots.find((snapshot) => snapshot.stageId === "review")!
    expect(snapshot).toBeDefined()
    draft = sessions.read(scope, draft.id)
    draft = await sessions.save(
      scope,
      {
        id: draft.id,
        revision: draft.revision,
        name: draft.name,
        files: draft.source.files.map((file) =>
          file.path === "modules/review/SKILL.md"
            ? { ...file, text: file.text + "\nReview the same retained document carefully.\n" }
            : file
        )
      },
      guard
    )
    await sessions.compile(scope, draft.id, draft.revision, guard)
    draft = sessions.read(scope, draft.id)
    const plan = await debug.prepare(
      { scope, guard },
      {
        threadId: scope.threadId,
        snapshotId: snapshot.id,
        draftId: draft.id,
        revision: draft.revision,
        expectedDigest: draft.source.digest,
        mode: "stage"
      }
    )
    const created = await debug.create(
      { scope, guard },
      { threadId: scope.threadId, preparationId: plan.id, expectedDigest: plan.candidateDigest }
    )
    const branch = service.get(created.projectId)!
    expect(branch.workspace).not.toBe(original.workspace)
    expect(service.operations(branch.projectId)).toEqual([])
    expect(settings.getGrant(branch.workspace, "function:pure-review")).toBeNull()
    // Provider execution is authorized afresh in this independent workspace.
    await functions.approve(branch.workspace, status.pluginId, status.digest!)
    const operationId = await run(branch.projectId)
    const operation = store.getOperation(operationId)!
    expect(operation.resultApproval?.decision).toBe("approved")
    expect(
      operation.receipts.some(
        (receipt) => receipt.checkId === "review-business" && receipt.result === "passed"
      )
    ).toBe(true)
    expect(executions).toBe(2)
    expect(debug.list({ scope, guard }).branches[0].status).toBe("passed")
    expect(() => service.transition(operationId)).toThrow("SINGLE_STAGE_ONLY")
    expect(service.get(originalId)).toEqual(original)
    expect(readFileSync(join(original.workspace, "review.json"))).toEqual(originalBytes)
  } finally {
    functions.close()
    guests.forEach((guest) => guest.dispose())
    store.close()
    settings.close()
    threads.clear()
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
