import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import type { BrowserWindow } from "electron"
import type { HostSkillExecutionContext } from "../harness-board/project-runtime/host-service"
import { HostProjectService } from "../harness-board/project-runtime/host-service"
import { HostProjectStore } from "../harness-board/project-runtime/host-store"
import { HostPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import { createHostProjectInputIdentity } from "../harness-board/project-runtime/package-input-identity"
import { FunctionModsManager } from "../mods/v2/manager"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { ModControlStore } from "../mods/control-store"
import { ClawStore } from "../mods/claw-store"
import { resolveClawThread } from "../mods/claw-scope"
import { prepareProjectActionSelection } from "../harness-board/project-action-selection"
import { createNativeProjectContextPlatformProvider } from "../mods/v2/platform-project-context-provider"
import { FlowManager } from "../mods/flows/manager"
import { FlowStore } from "../mods/flows/store"
import { publishOriginalFlowActionResult } from "../mods/flows/action-execution-facts"
import { readOriginalActionText } from "../mods/v2/action-result-text"
import { setProjectActionRuntime } from "../harness-board/project-action-runtime"
import { captureProjectActionContentGuard, projectActionFlowMetadata } from "../harness-board/project-action-scope"
import { ProjectAuthoringSessions } from "../mods/devtools/project-authoring-session"
import { readProjectSource } from "../mods/devtools/project-source"
import { runAutoBizNativeCodeFixture } from "./autobiz-native-code.test-helper"
import { createWorkflowPlatformProvider } from "../mods/v2/platform-workflow-provider"
import { createProjectRuntimePlatformProvider } from "../mods/v2/platform-project-runtime-provider"
import { resolveNativeProjectRuntimeScope } from "../mods/v2/platform-project-runtime-native"
import { loadWorkflowRunAsync } from "../agent/workflow/run-store"
import { observeWorkflowDeterministicActions } from "../agent/workflow/deterministic-action-native"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { issueRuntimePluginSourceToken } from "./runtime-source-scope"
import type { NativePlatformCapabilityProvider } from "../mods/v2/platform-capabilities-types"
import {
  compileNativeComposition,
  nativeCompositionSchema,
  readNativeCompositionFiles
} from "./native-composition"
import { businessInput } from "./autobiz-native-fixture.test-helper"
import { HostUserInputStore } from "../services/host-user-input-store"
import {
  bindHostUserInputScope,
  configureHostUserInputPersistence,
  prepareHostInputInterrupt,
  claimHostInputContinuation,
  requestUserInput,
  submitUserInputResponse,
  getHostInputWait
} from "../services/user-input"

const model = vi.hoisted(() => ({
  threads: new Map<string, { created_at: number; metadata: string }>(), execute: vi.fn(),
  readDatabase: vi.fn(() => { throw Error("UNEXPECTED_NATIVE_DATABASE_ACCESS") })
}))
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock("../db", () => ({
  getThreadCore: (id: string) => model.threads.get(id),
  getDb: model.readDatabase
}))
// Only model output and UI are deterministic. The service, snapshots, config, grants, guest,
// process, Python rules, Flow receipts and Host validation/approval all execute real code.
vi.mock("../harness-board/host-skill-executor", () => ({ executeHostProjectSkill: model.execute }))
import { executeHostProjectStage } from "../harness-board/project-action-executor"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  configureHostUserInputPersistence(undefined)
  model.threads.clear()
  expect(model.readDatabase).not.toHaveBeenCalled()
  for (const close of cleanup.splice(0).reverse()) await close()
})

it("saves and directly runs real AutoBiz checks through Host and approved Function Mods before result approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "autobiz-native-host-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, "workspace"),
    knowledge = join(root, "knowledge")
  mkdirSync(workspace)
  mkdirSync(knowledge)
  writeFileSync(join(knowledge, "AGENTS.md"), "订单领域边界。")
  writeFileSync(
    join(knowledge, "orders.md"),
    "---\ntype: Service Knowledge\ndeploy_unit: orders-api\ntitle: 订单服务\n---\n订单领域：性能要求必须保留。此处是隔离测试知识。"
  )
  const control = new ModControlStore(join(root, "mods.sqlite"))
  cleanup.push(() => control.close())
  const ruleInstall = join(root, "installed-rules")
  cpSync(resolve("resources/native-compositions/autobiz-rules"), ruleInstall, { recursive: true })
  const plugins = [
    { id: "business-rules", name: "autobiz-native-rules", path: ruleInstall, enabled: true }
  ]
  const knowledgeInstall = join(root, "installed-knowledge")
  cpSync(resolve("resources/native-compositions/autobiz-knowledge"), knowledgeInstall, {
    recursive: true
  })
  plugins.push({
    id: "knowledge-provider",
    name: "autobiz-native-knowledge",
    path: knowledgeInstall,
    enabled: true
  })
  let threadId = ""
  const operationThreads = new Map<string, string>()
  model.threads.set("creator", { created_at: 1, metadata: JSON.stringify({
    workspacePath: workspace, agentMode: "normal", cmb_thread_incarnation: "fixture"
  }) })
  const clawScope = (id: string) => resolveClawThread(id, key => model.threads.get(key) ?? null)
  const selectedProviders: Array<{ threadId: string; agentMode: string; plugins: string[] }> = []
  let workflowScopeChecked = false
  const incarnationFor = (id: string) => {
    const row = model.threads.get(id)
    return row ? JSON.stringify(captureThreadIncarnation(row)) : JSON.stringify({ token: null, legacyCreatedAt: 1 })
  }
  let codeRunning = false
  const evidenceReads: Array<{ callerThread: string; producerThread: string; runId: string }> = []
  const projectPlatform = () => createProjectRuntimePlatformProvider({
    resolve: context => resolveNativeProjectRuntimeScope(context, {
      thread: id => model.threads.get(id),
      runtime: () => host,
      authorize: project => {
        expect(plugins.some(plugin => plugin.id === project.installedPluginId && plugin.enabled)).toBe(true)
      },
      workflowEvidence: {
        assertSettled() { expect(codeRunning).toBe(false) },
        load: async (space, producerThread, runId) => {
          evidenceReads.push({ callerThread: context.threadId, producerThread, runId })
          return loadWorkflowRunAsync(space, producerThread, runId)
        },
        actions: observeWorkflowDeterministicActions
      }
    })
  })
  let processes = 0
  let codePlatform: NativePlatformCapabilityProvider | undefined
  const workflowPlatform = () => {
    const provider = createWorkflowPlatformProvider({
    active: async () => null,
    latest: async () => null,
    inspect: async () => null,
    changed: () => () => {},
    confirmCancel: async () => false,
    cancel: () => false,
    settled: async () => {}
  })
    provider.act = async (context, action, value) => {
      if (!codePlatform) throw Error("FIXTURE_CODE_RUN_NOT_STARTED")
      return codePlatform.act(context, action, value)
    }
    return provider
  }
  const functions = new FunctionModsManager(
    control,
    {
      plugins: () => plugins,
      enabled: () => true,
      clawApplicable: id => clawScope(id) !== null,
      clawScope,
      threadIncarnationKey: (_space, id) => incarnationFor(id),
      platformNativeProviders: () => [
        createNativeProjectContextPlatformProvider(),
        workflowPlatform(),
        projectPlatform()
      ],
      changed: () => {},
      publish: async (_workspace, value) => value,
      authorizeProcess: async (_workspace, _thread, grant, request) => {
        control.assertGrant(grant)
        expect(request.argv[0]).toBe("python")
        expect(request.argv).toContain("-I")
        processes++
      },
      runEffect: async (_workspace, _thread, grant, _method, _input, _signal, run) => {
        control.assertGrant(grant)
        return run()
      }
    },
    () => {
      const guests: FunctionGuestRuntime[] = []
      return {
        async load(code, options) {
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.push(guest)
          return guest
        },
        stop() {
          guests.forEach((guest) => guest.dispose())
        },
        async stopAndDrain() {
          guests.forEach((guest) => guest.dispose())
        }
      }
    }
  )
  cleanup.push(() => functions.close())
  const providers = await functions.status(workspace)
  expect(await functions.actionCatalog(workspace, "creator")).toEqual([])
  for (const provider of providers)
    await functions.approve(workspace, provider.pluginId, provider.digest!)
  const catalog = () => functions.actionCatalog(workspace, "creator")
  const source = await readProjectSource(resolve("resources/native-compositions/autobiz"))
  const sessions = new ProjectAuthoringSessions(catalog)
  const scope = {
    workspace,
    threadId: "creator",
    incarnation: { token: "fixture", legacyCreatedAt: 1 }
  }
  const draft = await sessions.save(
    scope,
    { id: "autobiz", name: "AutoBiz", revision: 0, files: source.bundle.files },
    () => {}
  )
  cleanup.push(() => rmSync(dirname(draft.directory), { recursive: true, force: true }))
  const compiled = await sessions.compile(scope, draft.id, draft.revision, () => {})
  expect("validation" in compiled && compiled.validation).toMatchObject({
    doctor: { valid: true },
    businessActionsExecuted: false
  })
  const metadata = JSON.parse(readFileSync(join(compiled.directory, "plugin.json"), "utf8"))
  plugins.push({ id: "saved-native", name: metadata.name, path: compiled.directory, enabled: true })
  const own = await functions.userConfig(
    workspace,
    "creator",
    "saved-native",
    new AbortController().signal,
    () => {}
  )
  await functions.saveUserConfig(
    workspace,
    "creator",
    own.pluginId,
    own.digest!,
    "knowledgeRoot",
    knowledge,
    0,
    new AbortController().signal,
    () => {}
  )
  await functions.saveUserConfig(
    workspace,
    "creator",
    own.pluginId,
    own.digest!,
    "selectedDeployUnits",
    JSON.stringify([{ deployUnitId: "orders-api", appType: "backend" }]),
    1,
    new AbortController().signal,
    () => {}
  )
  const input = createHostProjectInputIdentity(functions, { rules: () => [] })
  const settings = new Map<string, string>()
  const flowStore = new FlowStore({
    getSetting: (key, fallback = "") => settings.get(key) ?? fallback,
    setSetting: (key, value) => {
      settings.set(key, value)
    }
  })
  const flows = new FlowManager(flowStore, {
    assertScope: () => {},
    changed: () => {},
    prepare: async (_space, flowThreadId) => {
      const assertContent = captureProjectActionContentGuard()
      return {
        assertLive: () => {},
        fingerprint: async () => "fixture-owner",
        execute: async (step, context) => {
          const startedAt = Date.now()
          console.info(`[AutoBiz Host integration] action start ${step.id}`)
          try {
          assertContent?.()
          if (step.kind !== "plugin-action") throw Error("UNEXPECTED_STEP")
          const prepared = await functions.prepareAction(workspace, flowThreadId, step, context.signal)
          const result = await functions.runAction(
            workspace,
            flowThreadId,
            prepared,
            {
              version: 1,
              input: step.input,
              config: step.config ?? {},
              task: "隔离业务执行",
              runId: context.run.id,
              stepId: step.id,
              executionId: context.executionId
            },
            context.signal
          )
          console.info(`[AutoBiz Host integration] action settled ${step.id}: passed=${result.passed} (${Date.now() - startedAt}ms)`)
          assertContent?.()
          return publishOriginalFlowActionResult(
            {
              passed: result.passed ?? true,
              summary: result.text,
              source: "plugin-action",
              output: result.output,
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
          } catch (error) {
            console.error(`[AutoBiz Host integration] original action error ${step.id}: ${error instanceof Error ? error.message : String(error)}`)
            throw error
          }
        },
        finalize: async (_context, confirm) => {
          await confirm()
          return { passed: true, summary: "checks settled", source: "native-check" }
        },
        dispose: async () => {}
      }
    }
  })
  setProjectActionRuntime({
    ...input,
    captureOperationRetirement: (w, t) => functions.captureIdleThreadRetirement(w, t),
    flows,
    catalog: () => catalog(),
    prepareSelection: (w, t, bindings) => prepareProjectActionSelection(w, t, bindings, {
      store: new ClawStore(control),
      catalog: (space, id) => functions.actionCatalog(space, id),
      closeThread: id => functions.closeThread(id),
      assertScope: () => {
        const row = model.threads.get(t)
        const current = row ? JSON.parse(row.metadata) : undefined
        if (!current?.hostProjectRuntime || current.workspacePath !== w ||
          projectActionFlowMetadata(t, current) === current)
          throw Error("PROJECT_ACTION_SCOPE_CHANGED")
        const selected = clawScope(t)
        if (!selected || selected.threadId !== t) throw Error("PROJECT_ACTION_SCOPE_CHANGED")
        if (current.agentMode === "workflow" && !workflowScopeChecked) {
          for (const forbidden of [
            { parentThreadId: "parent" }, { workflowRunId: "other-run" },
            { remoteState: "historical" }, { remoteReadOnly: true }
          ]) expect(resolveClawThread(t, id => id === t
            ? { metadata: { ...current, ...forbidden } } : null)).toBeNull()
          workflowScopeChecked = true
        }
        // Record only scopes admitted by the same resolver used by the production IPC.
        selectedProviders.push({ threadId: t, agentMode: current.agentMode,
          plugins: bindings.map(binding => binding.ref.plugin) })
        return selected.identity
      }
    }),
    verifyReadOnlyContextProvider: (w, t, p, s) =>
      functions.verifyReadOnlyContextProvider(w, t, p, s),
    publishRequiredContext: async (_workspace, text) => text,
    readRuns: (w, t) => flowStore.runs(w, t),
    readActionResult: (w, t, run, execution) => flowStore.actionResult(w, t, run, execution)
  })
  const store = new HostProjectStore(join(root, "host.sqlite"))
  cleanup.push(() => store.close())
  const inputs = new HostUserInputStore(join(root, "inputs.sqlite"))
  cleanup.push(() => inputs.close())
  configureHostUserInputPersistence({ store: () => inputs, isCurrent: () => true })
  const host = new HostProjectService(store, new HostPackageSnapshots(join(root, "snapshots")), {
    resolveInstalledPlugin: async (id) =>
      id === "saved-native"
        ? {
            installedPluginId: id,
            root: compiled.directory,
            packageId: metadata.name,
            packageVersion: metadata.version,
            enabled: true
          }
        : undefined,
    authorize: async () => {},
    authorizePlanMigration: async () => {
      const grants = [...new Set((await catalog()).map((action) => action.plugin))].map((name) => {
        const grant = control.getGrant(workspace, "function:" + name)
        if (!grant) throw Error("FIXTURE_DEPENDENCY_GRANT_MISSING")
        return grant
      })
      return {
        assertCurrent: () => {
          expect(codePlatform).toBeUndefined()
          for (const id of operationThreads.values()) expect(flows.activeSummary(workspace, id)).toBeNull()
          expect([...operationThreads.values()].flatMap(id => flowStore.runs(workspace, id))
            .every(run => !["queued", "running", "waiting", "interrupted"].includes(run.status))
          ).toBe(true)
          for (const grant of grants) control.assertGrant(grant)
        }
      }
    },
    assertInputResumeSafe: async () => ({
      assertCurrent: () => {
        expect(flowStore.runs(workspace, threadId)).toHaveLength(1)
      }
    }),
    executeSkill: (context) => executeHostProjectStage(context, {} as BrowserWindow, () => {})
  })
  const fixtures = businessInput()
  let corruptPrd = true
  const questions = [
    {
      id: "scope",
      header: "Scope",
      question: "保留性能约束？",
      options: [
        { label: "保留", description: "保留订单查询2秒约束" },
        { label: "核对", description: "先核对输入" }
      ]
    }
  ]
  let conversionInvocations = 0
  model.execute.mockImplementation(async (context: HostSkillExecutionContext) => {
    const existingThread = operationThreads.get(context.operation.operationId)
    threadId = existingThread ?? "autobiz-host-" + context.operation.stageId + "-" + randomUUID()
    operationThreads.set(context.operation.operationId, threadId)
    const stage = context.project.manifest.stages[context.project.stageIndex]
    const threadMetadata = {
      workspacePath: workspace,
      agentMode: stage.executionMode ?? "normal",
      cmb_thread_incarnation: threadId,
      hostProjectRuntime: {
        projectId: context.project.projectId,
        operationId: context.operation.operationId,
        stageId: context.ticket.stageId,
        pluginDigest: context.project.pluginDigest
      }
    }
    const serializedMetadata = JSON.stringify(threadMetadata)
    if (existingThread) expect(model.threads.get(threadId)?.metadata).toBe(serializedMetadata)
    else model.threads.set(threadId, { created_at: 1, metadata: serializedMetadata })
    if (!context.recoveryInput) context.bindThread(threadId)
    else expect(context.operation.execution?.threadId).toBe(threadId)
    const prepared = context.recoveryInput
      ? {
          requiredContextText: context.recoveryInput.continuation?.requiredContextText,
          contextResumeProof: context.recoveryInput.continuation?.contextResumeProof
        }
      : await context.prepareThread?.(threadId)
    expect(prepared?.requiredContextText).toContain("隔离测试知识")
    expect(prepared?.requiredContextText).toContain("untrusted task data")
    if (stage.id === "code") {
      expect(threadMetadata.agentMode).toBe("workflow")
      expect(selectedProviders).toContainEqual(expect.objectContaining({
        threadId, agentMode: "workflow", plugins: expect.arrayContaining(["autobiz-native-knowledge"])
      }))
      // Projection is transient: the model and persisted owner retain the declared mode.
      expect(JSON.parse(model.threads.get(threadId)!.metadata).agentMode).toBe("workflow")
      expect(clawScope(threadId)).toBeNull()
    }
    if (stage.id === "convert") {
      conversionInvocations++
      const release = bindHostUserInputScope(
        threadId,
        {
          projectId: context.project.projectId,
          operationId: context.operation.operationId,
          stageId: stage.id,
          installedPluginId: context.project.installedPluginId,
          expectedVersion: context.project.version,
          pluginDigest: context.project.pluginDigest,
          inputFingerprint: context.operation.inputFingerprint,
          incarnationKey: threadId
        },
        () => context.assertInputsCurrent?.(),
        prepared?.requiredContextText,
        undefined,
        prepared?.contextResumeProof
      )
      try {
        if (!context.recoveryInput) {
          prepareHostInputInterrupt(threadId, "convert-input", questions)
          context.recordTerminal({ outcome: "unknown", code: "host_user_input_waiting" })
          return "unknown"
        }
        // This test controls the Skill boundary. The separate executor suite exercises a real
        // reopened LangGraph checkpoint; here all post-Skill Flow/guest/Python checks are real.
        context.assertInputResumeResourcesCurrent?.()
        claimHostInputContinuation(context.recoveryInput.request.requestId)
        await requestUserInput({ threadId, toolCallId: "convert-input", questions })
      } finally {
        release()
      }
    }
    const artifact = context.project.manifest.artifacts.find(
      (item) => item.id === stage.artifactIds[0]
    )!
    let value: unknown
    if (stage.id === "code") {
      const incarnation = incarnationFor(threadId)
      context.assertInputsCurrent?.()
      const hostSource = issueRuntimePluginSourceToken({
        mode: "host", threadId, incarnationKey: incarnation,
        projectId: context.project.projectId, operationId: context.operation.operationId,
        stageId: stage.id, workspace, packageDigest: context.project.pluginDigest,
        inputFingerprint: context.operation.inputFingerprint,
        plugin: { id: context.project.installedPluginId, name: context.project.packageId,
          version: context.project.packageVersion, description: "Host fixture retained source",
          author: "fixture", path: context.snapshotRoot, enabled: true,
          skillCount: 8, mcpServerCount: 0, createdAt: "fixture", updatedAt: "fixture" }
      }, () => context.assertInputsCurrent?.(), () => context.signal.throwIfAborted())
      codeRunning = true
      const code = await runAutoBizNativeCodeFixture({
        hostSource, projectPlatform,
        workspace,
        threadId,
        providerId: "business-rules",
        expectedProviderDigest: providers.find(
          (provider) => provider.pluginId === "business-rules"
        )!.digest!,
        rulesRoot: ruleInstall,
        profileRoot: context.snapshotRoot,
        incarnation,
        verifyOps: false,
        utFailure: "source_bug",
        cleanup,
        script: readFileSync(
          join(context.snapshotRoot, "workflows/native-code.workflow.js"),
          "utf8"
        ),
        onPlatform: (provider) => {
          codePlatform = provider
        }
      })
      codeRunning = false
      expect(code.evidenceRoute).toBe("host-project")
      const persisted = await loadWorkflowRunAsync(workspace, threadId, code.runId)
      expect(persisted?.hostExecution).toEqual({
        projectId: context.project.projectId, operationId: context.operation.operationId,
        stageId: "code", packageDigest: context.project.pluginDigest,
        inputFingerprint: context.operation.inputFingerprint, threadId, incarnationKey: incarnation
      })
      value = { feature: "orders", runId: code.runId }
    } else if (stage.id === "cicd") {
      const code = JSON.parse(readFileSync(join(workspace, "CODE_RESULT.json"), "utf8"))
      value = {
        feature: "orders",
        stage: "cicd",
        codeRunId: code.runId,
        publication: { mode: "not-requested", status: "prepared-only" },
        files: {
          "CICD_CHECKLIST.md":
            "## 交付范围\n订单查询；PRD.bundle.json / SPECS.bundle.json / DESIGN.bundle.json\n## 验证证据\n" +
            code.runId +
            "\n## 发布状态\n未请求外部发布 prepared-only\n## 已知阻断问题\n外部流水线未绑定\n## 回滚计划\n保留集成SHA并经用户确认后回滚\n",
          "PR_BODY.md": "订单查询：正常/缺失订单行为及2秒约束已经真实测试；尚未请求外部发布。"
        }
      }
    } else if (stage.id === "archive") {
      const files: Record<string, string> = {},
        artifactDigests: Record<string, string> = {}
      for (const name of [
        "NORMALIZED_REQUIREMENTS.json",
        "PRD.bundle.json",
        "SPECS.bundle.json",
        "DESIGN.bundle.json",
        "PLAN.bundle.json",
        "CODE_RESULT.json",
        "CICD.bundle.json"
      ]) {
        files[name] = readFileSync(join(workspace, name), "utf8")
        artifactDigests[name] = createHash("sha256").update(files[name]).digest("hex")
      }
      value = {
        feature: "orders",
        stage: "archive",
        publicationStatus: "prepared-only",
        files,
        artifactDigests
      }
    } else {
      value = structuredClone(
        fixtures[
          stage.id === "convert" ? "normalized" : (stage.id as "prd" | "specs" | "design" | "plan")
        ]
      )
      if (
        stage.id === "prd" &&
        corruptPrd &&
        value &&
        typeof value === "object" &&
        "files" in value
      )
        (value.files as Record<string, string>)["PRD.md"] = (value.files as Record<string, string>)[
          "PRD.md"
        ].replace("订单查询必须在2秒内返回", "订单查询")
    }
    writeFileSync(join(workspace, artifact.path), JSON.stringify(value))
    context.recordTerminal({ outcome: "success", code: "deterministic-model-output" })
    return "succeeded"
  })
  await host.localCreate({
    projectId: "orders",
    name: "订单需求",
    workspace,
    installedPluginId: "saved-native",
    goal: "订单查询必须在2秒内返回"
  })
  const run = async () => {
    const project = host.get("orders")!
    const operation = host.prepare({
      projectId: project.projectId,
      expectedVersion: project.version,
      idempotencyKey: randomUUID()
    })
    const began = Date.now()
    const watchdog = setInterval(() => console.info(`[AutoBiz Host integration] waiting ${operation.stageId}: ${Date.now() - began}ms; checks=${processes}; active=${JSON.stringify(flows.activeSummary(workspace, threadId))}`), 60_000)
    let finished
    try {
      finished = await host.start(operation.operationId)
    } finally {
      clearInterval(watchdog)
    }
    console.info(`[AutoBiz Host integration] stage settled ${operation.stageId}: ${finished.status} (${Date.now() - began}ms)`)
    if (finished.status === "unknown" && finished.stageId !== "convert") {
      console.error("[AutoBiz Host integration] original Flow attempts", JSON.stringify(
        flowStore.runs(workspace, finished.execution?.threadId ?? threadId).map(item => ({
          id: item.id, status: item.status, attempts: item.attempts.map(attempt => ({
            step: attempt.stepId, status: attempt.status, reason: attempt.reason,
            summary: attempt.result?.summary
          }))
        }))
      ))
      const invocation = model.execute.mock.results.at(-1)
      if (invocation?.type === "return") await invocation.value
    }
    return finished
  }
  for (const stage of ["convert", "prd", "specs", "design", "plan", "code", "cicd", "archive"]) {
    console.info(`[AutoBiz Host integration] entering ${stage}, checks started=${processes}`)
    if (stage === "prd") {
      const invalid = await run()
      expect(invalid.status).toBe("failed")
      expect(() => host.transition(invalid.operationId)).toThrow()
      expect(host.get("orders")!.stageIndex).toBe(1)
      corruptPrd = false
    }
    let operation = await run()
    if (stage === "convert") {
      expect(operation.status).toBe("unknown")
      expect(processes).toBe(0)
      expect(flowStore.runs(workspace, threadId)).toHaveLength(1)
      const pending = getHostInputWait(operation.operationId)!
      expect(
        pending,
        JSON.stringify({ operation, runs: flowStore.runs(workspace, threadId) })
      ).toBeDefined()
      expect(
        submitUserInputResponse({
          requestId: pending.request.requestId,
          answers: {
            scope: {
              questionId: "scope",
              type: "option",
              optionIndex: 0,
              label: "保留",
              description: "保留订单查询2秒约束"
            }
          }
        })
      ).toBe(true)
      const originalOperationId = operation.operationId
      console.info("[AutoBiz Host integration] resuming the original convert input checkpoint")
      operation = await host.resumeInput(operation.operationId, pending.request.requestId)
      console.info(
        `[AutoBiz Host integration] convert resumed: ${operation.status}, checks started=${processes}`
      )
      expect(operation.operationId).toBe(originalOperationId)
      expect(inputs.get(pending.request.requestId)?.status).toBe("consumed")
      expect(conversionInvocations).toBe(2)
      expect(processes).toBe(1)
      expect(flowStore.runs(workspace, threadId)).toHaveLength(2)
    }
    expect(operation.stageId).toBe(stage)
    expect(
      operation.status,
      JSON.stringify({
        operation,
        runs: flowStore.runs(workspace, threadId).map((run) => ({
          id: run.id,
          name: run.flow.definition.name,
          status: run.status,
          attempts: run.attempts.map((attempt) => ({
            step: attempt.stepId,
            status: attempt.status,
            reason: attempt.reason,
            result: attempt.result
          }))
        }))
      })
    ).toBe("succeeded")
    expect(operation.receipts).toContainEqual(
      expect.objectContaining({ checkId: stage + ".business", result: "passed" })
    )
    if (["design", "code", "cicd"].includes(stage)) {
      expect(() => host.transition(operation.operationId)).toThrow("RESULT_APPROVAL_REQUIRED")
      const review = host.resultReview(operation.operationId)
      host.decideResultApproval(operation.operationId, {
        ...review,
        decision: "approved",
        actorId: "fixture-human"
      })
    }
    host.transition(operation.operationId)
    if (stage === "plan") {
      const previous = host.get("orders")!
      const historical = structuredClone(host.operations("orders"))
      const candidate = nativeCompositionSchema.parse(
        JSON.parse(readFileSync(join(compiled.directory, "composition/source.json"), "utf8"))
      )
      const future = candidate.modules.find((module) => module.id === "code")!
      future.version = "0.1.1"
      const skillPath = join(compiled.directory, future.skill)
      writeFileSync(
        skillPath,
        readFileSync(skillPath, "utf8") +
          "\n使用已确认的需求与计划执行后续Code；不能修改已接受的上游产物。\n"
      )
      const rebuilt = compileNativeComposition(candidate, {
        files: readNativeCompositionFiles(compiled.directory, candidate),
        actionCatalog: await catalog()
      })
      for (const file of rebuilt.files) {
        const path = join(compiled.directory, file.path)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, file.bytes)
      }
      const review = await host.reviewPlanMigration("orders", previous.version)
      const migrated = await host.migratePlan(review)
      expect(migrated).toMatchObject({ stageIndex: 5, version: previous.version + 1 })
      expect(migrated.pluginDigest).not.toBe(previous.pluginDigest)
      expect(host.operations("orders")).toEqual(historical)
    }
  }
  expect(host.get("orders")!).toMatchObject({ status: "completed" })
  // Code, CI/CD and archive each read their bound Code selection through the fixed checker.
  expect(processes).toBe(14)
  expect([...operationThreads.values()].flatMap(id => flowStore.runs(workspace, id))).toHaveLength(18)
  expect(new Set(operationThreads.values()).size).toBe(9) // eight stages plus failed PRD operation
  const completed = host.operations("orders")
  const codeOperation = completed.find(op => op.stageId === "code")!
  expect(workflowScopeChecked).toBe(true)
  for (const stage of ["code", "cicd", "archive"]) {
    const consumer = completed.find(op => op.stageId === stage)!
    expect(evidenceReads).toContainEqual(expect.objectContaining({
      callerThread: consumer.execution!.threadId, producerThread: codeOperation.execution!.threadId
    }))
    if (stage !== "code") expect(consumer.execution!.threadId).not.toBe(codeOperation.execution!.threadId)
  }
  expect(readFileSync(join(workspace, "PRD.bundle.json"), "utf8")).toContain("2秒")
}, 600_000)

it("runs the independent supplier composition through the same Host from intake to approval and archive without Git or actions", async () => {
  const root = mkdtempSync(join(tmpdir(), "vendor-native-host-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, "workspace")
  mkdirSync(workspace)
  const source = await readProjectSource(resolve("tests/fixtures/native-compositions/vendor"))
  const sessions = new ProjectAuthoringSessions(async () => [])
  const scope = {
    workspace,
    threadId: "vendor-creator",
    incarnation: { token: "vendor", legacyCreatedAt: 1 }
  }
  const draft = await sessions.save(
    scope,
    { id: "vendor", name: "供应商准入", revision: 0, files: source.bundle.files },
    () => {}
  )
  cleanup.push(() => rmSync(dirname(draft.directory), { recursive: true, force: true }))
  const compiled = await sessions.compile(scope, draft.id, draft.revision, () => {})
  const forbiddenAction = vi.fn(async () => {
    throw Error("SUPPLIER_DOES_NOT_REQUIRE_ACTIONS_OR_GIT")
  })
  setProjectActionRuntime({
    catalog: forbiddenAction,
    prepareSelection: forbiddenAction,
    flows: {
      startSaved: forbiddenAction,
      waitForSettlement: forbiddenAction,
      run: () => {
        throw Error("SUPPLIER_DOES_NOT_REQUIRE_FLOW")
      },
      cancel: forbiddenAction
    }
  })
  const store = new HostProjectStore(join(root, "host.sqlite"))
  cleanup.push(() => store.close())
  const host = new HostProjectService(store, new HostPackageSnapshots(join(root, "snapshots")), {
    resolveInstalledPlugin: async (id) => ({
      installedPluginId: id,
      root: compiled.directory,
      packageId: "vendor-native-fixture",
      packageVersion: "1.0.0",
      enabled: true
    }),
    authorize: async () => {},
    executeSkill: (context) => executeHostProjectStage(context, {} as BrowserWindow, () => {})
  })
  const cases = JSON.parse(
    readFileSync(join(compiled.directory, "tests/project-contract.json"), "utf8")
  ).cases as Array<{
    stageId: string
    expected: string
    files: Array<{ path: string; text: string }>
  }>
  const consumed: string[] = []
  model.execute.mockImplementation(async (context: HostSkillExecutionContext) => {
    const stage = context.project.manifest.stages[context.project.stageIndex]
    for (const id of context.project.manifest.stages
      .slice(0, context.project.stageIndex)
      .flatMap((prior) => prior.artifactIds)) {
      const path = context.project.manifest.artifacts.find((item) => item.id === id)!.path
      consumed.push(readFileSync(join(workspace, path), "utf8"))
    }
    const fixture = cases.find((item) => item.stageId === stage.id && item.expected === "passed")!
    for (const file of fixture.files) writeFileSync(join(workspace, file.path), file.text)
    return "succeeded"
  })
  await host.localCreate({
    projectId: "vendor",
    name: "隔离供应商",
    workspace,
    installedPluginId: "vendor-native",
    goal: "核对确定性测试资料并归档"
  })
  for (const stage of ["normalize", "compliance", "risk", "approval", "archive"]) {
    const operation = host.prepare({
      projectId: "vendor",
      expectedVersion: host.get("vendor")!.version,
      idempotencyKey: randomUUID()
    })
    const result = await host.start(operation.operationId)
    expect(result.status).toBe("succeeded")
    expect(result.stageId).toBe(stage)
    if (stage === "approval") {
      expect(() => host.transition(operation.operationId)).toThrow("RESULT_APPROVAL_REQUIRED")
      host.decideResultApproval(operation.operationId, {
        ...host.resultReview(operation.operationId),
        decision: "approved",
        actorId: "fixture-human"
      })
    }
    host.transition(operation.operationId)
  }
  expect(host.get("vendor")!.status).toBe("completed")
  expect(consumed).toContain('{"risk": "medium"}')
  expect(readFileSync(join(workspace, "archive.json"), "utf8")).toContain("VENDOR-001")
  expect(forbiddenAction).not.toHaveBeenCalled()
}, 30_000)
