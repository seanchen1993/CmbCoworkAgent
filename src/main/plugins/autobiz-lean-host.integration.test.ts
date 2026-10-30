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
import {
  captureProjectActionContentGuard,
  projectActionFlowMetadata
} from "../harness-board/project-action-scope"
import { ProjectAuthoringSessions } from "../mods/devtools/project-authoring-session"
import { readProjectSource } from "../mods/devtools/project-source"
import { nativeCompositionSchema } from "./native-composition"
import { runAutoBizLeanCodeFixture, leanCodeBusinessFixture } from "./autobiz-lean-code.test-helper"
import { createWorkflowPlatformProvider } from "../mods/v2/platform-workflow-provider"
import { createProjectRuntimePlatformProvider } from "../mods/v2/platform-project-runtime-provider"
import { resolveNativeProjectRuntimeScope } from "../mods/v2/platform-project-runtime-native"
import { loadWorkflowRunAsync } from "../agent/workflow/run-store"
import { observeWorkflowDeterministicActions } from "../agent/workflow/deterministic-action-native"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { issueRuntimePluginSourceToken } from "./runtime-source-scope"
import type { NativePlatformCapabilityProvider } from "../mods/v2/platform-capabilities-types"
const model = vi.hoisted(() => ({
  threads: new Map<string, { created_at: number; metadata: string }>(),
  execute: vi.fn(),
  readDatabase: vi.fn(() => {
    throw Error("UNEXPECTED_NATIVE_DATABASE_ACCESS")
  })
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
  model.threads.clear()
  expect(model.readDatabase).not.toHaveBeenCalled()
  for (const close of cleanup.splice(0).reverse()) await close()
})

it.each([
  {
    scenario: "English delivery policy replacement",
    utFailure: undefined,
    executionAdapter: "node-test/v1" as const,
    englishPolicy: true
  },
  {
    scenario: "Java Maven Python workflow",
    utFailure: undefined,
    executionAdapter: "python-unittest/v1" as const
  },
  {
    scenario: "real failed Node test and bounded source repair",
    utFailure: "source_bug" as const,
    executionAdapter: "node-test/v1" as const
  }
])(
  "runs five Host stages with $scenario, original checks and approvals",
  async ({ utFailure, executionAdapter, englishPolicy }) => {
    const root = mkdtempSync(join(tmpdir(), "autobiz-lean-host-"))
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
    cpSync(resolve("resources/native-compositions/autobiz-lean/providers/rules"), ruleInstall, {
      recursive: true
    })
    const deliveryHeadings = [
      ["## 交付范围", "## Delivery scope"],
      ["## 验证证据", "## Verification evidence"],
      ["## 发布状态", "## Publication status"],
      ["## 已知阻断问题", "## Known blockers"],
      ["## 回滚计划", "## Rollback plan"],
      ["未请求外部发布", "External publication was not requested"]
    ]
    const deliveryTemplate = (text: string) =>
      englishPolicy
        ? deliveryHeadings.reduce((value, [before, after]) => value.replaceAll(before, after), text)
        : text
    if (englishPolicy) {
      // A genuinely different business policy, locked before source selection and installation.
      // The independent execution provider must not re-run the original Chinese template rules.
      const program = join(ruleInstall, "mods/check-program.ts")
      writeFileSync(program, deliveryTemplate(readFileSync(program, "utf8")))
      expect(readFileSync(program, "utf8")).not.toContain("## 交付范围")
    }
    const plugins = [
      { id: "business-rules", name: "autobiz-lean-rules", path: ruleInstall, enabled: true }
    ]
    const knowledgeInstall = join(root, "installed-knowledge")
    cpSync(
      resolve("resources/native-compositions/autobiz-lean/providers/knowledge"),
      knowledgeInstall,
      {
        recursive: true
      }
    )
    plugins.push({
      id: "knowledge-provider",
      name: "autobiz-lean-knowledge",
      path: knowledgeInstall,
      enabled: true
    })
    const deliveryInstall = join(root, "installed-delivery")
    cpSync(
      resolve("resources/native-compositions/autobiz-lean/providers/delivery"),
      deliveryInstall,
      { recursive: true }
    )
    plugins.push({
      id: "delivery-proof",
      name: "autobiz-lean-delivery",
      path: deliveryInstall,
      enabled: true
    })
    if (englishPolicy)
      plugins.push({
        id: "independent-report-check",
        name: "evidence-validation",
        path: resolve("resources/native-compositions/evidence-validation"),
        enabled: true
      })
    let threadId = ""
    const operationThreads = new Map<string, string>()
    model.threads.set("creator", {
      created_at: 1,
      metadata: JSON.stringify({
        workspacePath: workspace,
        agentMode: "normal",
        cmb_thread_incarnation: "fixture"
      })
    })
    const clawScope = (id: string) => resolveClawThread(id, (key) => model.threads.get(key) ?? null)
    const selectedProviders: Array<{ threadId: string; agentMode: string; plugins: string[] }> = []
    let workflowScopeChecked = false
    const incarnationFor = (id: string) => {
      const row = model.threads.get(id)
      return row
        ? JSON.stringify(captureThreadIncarnation(row))
        : JSON.stringify({ token: null, legacyCreatedAt: 1 })
    }
    let codeRunning = false
    const evidenceReads: Array<{ callerThread: string; producerThread: string; runId: string }> = []
    const projectPlatform = () =>
      createProjectRuntimePlatformProvider({
        resolve: (context) =>
          resolveNativeProjectRuntimeScope(context, {
            thread: (id) => model.threads.get(id),
            runtime: () => host,
            authorize: (project) => {
              expect(
                plugins.some((plugin) => plugin.id === project.installedPluginId && plugin.enabled)
              ).toBe(true)
            },
            workflowEvidence: {
              assertSettled() {
                expect(codeRunning).toBe(false)
              },
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
        clawApplicable: (id) => clawScope(id) !== null,
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
    const source = await readProjectSource(
      resolve("resources/native-compositions/autobiz-lean/project")
    )
    if (englishPolicy) {
      const declaration = source.bundle.files.find(
        (file) => file.path === "composition/source.json"
      )!
      const composition = nativeCompositionSchema.parse(JSON.parse(declaration.text))
      const delivery = composition.modules.find((module) => module.id === "delivery")!
      for (const [id, path, property] of [
        ["delivery-sources", "DeliverySources.json", "sources"],
        ["delivery-summary", "DeliverySummary.json", "summary"]
      ]) {
        delivery.outputs.push({ id, path, contract: "report." + id + "/v1" })
        delivery.checks.push({
          id: id + ".shape",
          kind: "json-schema",
          artifactId: id,
          schema: { type: "object", required: [property] }
        })
      }
      // Seven declared upstream artifacts plus the E2E output meet the unchanged eight-file bound.
      composition.modules.push({
        id: "e2e",
        version: "1.0.0",
        title: "Independent delivery quotation review",
        skill: "modules/e2e/SKILL.md",
        inputs: composition.modules.flatMap((module) =>
          module.outputs.map(({ id, contract }) => ({ artifactId: id, contract }))
        ),
        contextArtifactIds: ["delivery", "delivery-summary"],
        outputs: [{ id: "e2e-report", path: "EndReview.json", contract: "report.end-review/v1" }],
        checks: [
          {
            id: "e2e.independent",
            kind: "action",
            artifactId: "e2e-report",
            provider: { plugin: "evidence-validation", actionId: "check-report" },
            format: "artifact-reference-v1",
            maxBytes: 131072,
            config: { sourceArtifactId: "delivery-sources", summaryArtifactId: "delivery-summary" }
          }
        ],
        approval: "none",
        resultApproval: "human"
      })
      composition.contextAction!.config!.stageTags = {
        ...(composition.contextAction!.config!.stageTags as Record<string, string[]>),
        e2e: ["e2e"]
      }
      declaration.text = JSON.stringify(composition)
      source.bundle.files.push({
        path: "modules/e2e/SKILL.md",
        text: "---\nname: e2e\ndescription: Independently review delivery quotations\n---\nRead approved delivery sources and summary. Preserve exact quotations in EndReview.json. This is a quotation check, not a replacement for code E2E."
      })
      writeFileSync(
        join(knowledge, "end-review.md"),
        "---\ntype: Service Knowledge\ndeploy_unit: orders-api\nautobiz_stages: [e2e]\n---\nEND_REVIEW_ONLY"
      )
    }
    const sessions = new ProjectAuthoringSessions(catalog)
    const scope = {
      workspace,
      threadId: "creator",
      incarnation: { token: "fixture", legacyCreatedAt: 1 }
    }
    const draft = await sessions.save(
      scope,
      { id: "autobiz-lean", name: "AutoBiz Lean", revision: 0, files: source.bundle.files },
      () => {}
    )
    cleanup.push(() => rmSync(dirname(draft.directory), { recursive: true, force: true }))
    const compiled = await sessions.compile(scope, draft.id, draft.revision, () => {})
    expect("validation" in compiled && compiled.validation).toMatchObject({
      doctor: { valid: true },
      businessActionsExecuted: false
    })
    const metadata = JSON.parse(readFileSync(join(compiled.directory, "plugin.json"), "utf8"))
    plugins.push({
      id: "saved-native",
      name: metadata.name,
      path: compiled.directory,
      enabled: true
    })
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
    await functions.saveUserConfig(
      workspace,
      "creator",
      own.pluginId,
      own.digest!,
      "executionAdapter",
      executionAdapter,
      2,
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
              const prepared = await functions.prepareAction(
                workspace,
                flowThreadId,
                step,
                context.signal
              )
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
              console.info(
                `[AutoBiz Host integration] action settled ${step.id}: passed=${result.passed} (${Date.now() - startedAt}ms)`
              )
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
              console.error(
                `[AutoBiz Host integration] original action error ${step.id}: ${error instanceof Error ? error.message : String(error)}`
              )
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
      prepareSelection: (w, t, bindings) =>
        prepareProjectActionSelection(w, t, bindings, {
          store: new ClawStore(control),
          catalog: (space, id) => functions.actionCatalog(space, id),
          closeThread: (id) => functions.closeThread(id),
          assertScope: () => {
            const row = model.threads.get(t)
            const current = row ? JSON.parse(row.metadata) : undefined
            if (
              !current?.hostProjectRuntime ||
              current.workspacePath !== w ||
              projectActionFlowMetadata(t, current) === current
            )
              throw Error("PROJECT_ACTION_SCOPE_CHANGED")
            const selected = clawScope(t)
            if (!selected || selected.threadId !== t) throw Error("PROJECT_ACTION_SCOPE_CHANGED")
            if (current.agentMode === "workflow" && !workflowScopeChecked) {
              for (const forbidden of [
                { parentThreadId: "parent" },
                { workflowRunId: "other-run" },
                { remoteState: "historical" },
                { remoteReadOnly: true }
              ])
                expect(
                  resolveClawThread(t, (id) =>
                    id === t ? { metadata: { ...current, ...forbidden } } : null
                  )
                ).toBeNull()
              workflowScopeChecked = true
            }
            // Record only scopes admitted by the same resolver used by the production IPC.
            selectedProviders.push({
              threadId: t,
              agentMode: current.agentMode,
              plugins: bindings.map((binding) => binding.ref.plugin)
            })
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
      executeSkill: (context) => executeHostProjectStage(context, {} as BrowserWindow, () => {})
    })
    const fixture = leanCodeBusinessFixture()
    let corruptDefinition = true
    let corruptEndReview = true
    model.execute.mockImplementation(async (context: HostSkillExecutionContext) => {
      threadId = "lean-host-" + context.operation.stageId + "-" + randomUUID()
      operationThreads.set(context.operation.operationId, threadId)
      const stage = context.project.manifest.stages[context.project.stageIndex]
      model.threads.set(threadId, {
        created_at: 1,
        metadata: JSON.stringify({
          workspacePath: workspace,
          agentMode: stage.executionMode ?? "normal",
          cmb_thread_incarnation: threadId,
          hostProjectRuntime: {
            projectId: context.project.projectId,
            operationId: context.operation.operationId,
            stageId: stage.id,
            pluginDigest: context.project.pluginDigest
          }
        })
      })
      context.bindThread(threadId)
      const prepared = await context.prepareThread?.(threadId)
      expect(prepared?.requiredContextText).toContain("隔离测试知识")
      expect(prepared?.requiredContextText).toContain("订单领域边界")
      if (englishPolicy) {
        if (stage.id === "e2e") expect(prepared?.requiredContextText).toContain("END_REVIEW_ONLY")
        else expect(prepared?.requiredContextText).not.toContain("END_REVIEW_ONLY")
      }
      let value: unknown
      if (stage.id === "code") {
        const incarnation = incarnationFor(threadId)
        const hostSource = issueRuntimePluginSourceToken(
          {
            mode: "host",
            threadId,
            incarnationKey: incarnation,
            projectId: context.project.projectId,
            operationId: context.operation.operationId,
            stageId: stage.id,
            workspace,
            packageDigest: context.project.pluginDigest,
            inputFingerprint: context.operation.inputFingerprint,
            plugin: {
              id: context.project.installedPluginId,
              name: context.project.packageId,
              version: context.project.packageVersion,
              description: "Host fixture retained source",
              author: "fixture",
              path: context.snapshotRoot,
              enabled: true,
              skillCount: 4,
              mcpServerCount: 0,
              createdAt: "fixture",
              updatedAt: "fixture"
            }
          },
          () => context.assertInputsCurrent?.(),
          () => context.signal.throwIfAborted()
        )
        codeRunning = true
        let code
        try {
          code = await runAutoBizLeanCodeFixture({
            utFailure,
            executionAdapter,
            hostSource,
            projectPlatform,
            workspace,
            threadId,
            providerId: "business-rules",
            expectedProviderDigest: providers.find((p) => p.pluginId === "business-rules")!.digest!,
            rulesRoot: ruleInstall,
            deliveryProviderId: "delivery-proof",
            expectedDeliveryDigest: providers.find((p) => p.pluginId === "delivery-proof")!.digest!,
            deliveryRoot: deliveryInstall,
            profileRoot: context.snapshotRoot,
            incarnation,
            verifyOps: false,
            cleanup,
            script: readFileSync(
              join(context.snapshotRoot, "workflows/lean-code.workflow.js"),
              "utf8"
            ),
            onPlatform: (provider) => {
              codePlatform = provider
            }
          })
        } finally {
          codeRunning = false
        }
        const persisted = await loadWorkflowRunAsync(workspace, threadId, code.runId)
        expect(persisted?.hostExecution).toMatchObject({
          projectId: context.project.projectId,
          operationId: context.operation.operationId,
          stageId: "code",
          packageDigest: context.project.pluginDigest,
          inputFingerprint: context.operation.inputFingerprint,
          threadId,
          incarnationKey: incarnation
        })
        value = { feature: "orders", runId: code.runId }
      } else if (stage.id === "delivery") {
        const code = JSON.parse(readFileSync(join(workspace, "Code.json"), "utf8"))
        const archive = Object.fromEntries(
          ["RequestBaseline.json", "Definition.json", "Solution.json", "Code.json"].map((name) => {
            const text = readFileSync(join(workspace, name), "utf8")
            return [name, { text, sha256: createHash("sha256").update(text).digest("hex") }]
          })
        )
        value = {
          feature: "orders",
          codeRunId: code.runId,
          publication: { mode: "not-requested", status: "prepared-only" },
          checklist: deliveryTemplate(
            "## 交付范围\nRequestBaseline.json Definition.json Solution.json\n## 验证证据\nCode.json " +
              code.runId +
              "\n## 发布状态\n未请求外部发布 prepared-only\n## 已知阻断问题\n无\n## 回滚计划\n回滚实际提交"
          ),
          prBody: "待审核交付；未请求外部发布",
          archive
        }
        if (englishPolicy) {
          const delivery = value as { checklist: string }
          writeFileSync(
            join(workspace, "DeliverySources.json"),
            JSON.stringify({ sources: [{ id: "delivery", text: delivery.checklist }] })
          )
          writeFileSync(
            join(workspace, "DeliverySummary.json"),
            JSON.stringify({
              summary: "Delivery prepared for review without external publication",
              citations: [{ sourceId: "delivery", quote: "## Delivery scope" }]
            })
          )
        }
      } else if (stage.id === "e2e") {
        const summary = JSON.parse(readFileSync(join(workspace, "DeliverySummary.json"), "utf8"))
        value = {
          ...summary,
          summary: corruptEndReview ? "Rewritten approved summary" : summary.summary
        }
      } else {
        value = structuredClone(fixture[stage.id as "baseline" | "definition" | "solution"])
        if (stage.id === "baseline" && corruptDefinition)
          (value as typeof fixture.baseline).request.text += "模型替换原始请求"
        if (stage.id === "definition" && corruptDefinition)
          (value as typeof fixture.definition).prd = fixture.definition.prd.replace(
            "订单查询必须在2秒内返回",
            "遗漏性能约束"
          )
      }
      const artifact = context.project.manifest.artifacts.find(
        (a) => a.id === stage.artifactIds[0]
      )!
      writeFileSync(join(workspace, artifact.path), JSON.stringify(value))
      context.recordTerminal({ outcome: "success", code: "controlled-model-authoring" })
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
      const finished = await host.start(operation.operationId)
      if (finished.status === "unknown") {
        console.error(JSON.stringify({ finished, runs: flowStore.runs(workspace, threadId) }))
        const invocation = model.execute.mock.results.at(-1)
        if (invocation?.type === "return") await invocation.value
      }
      return finished
    }
    const invalid = await run()
    expect(invalid.status).toBe("failed")
    expect(() => host.transition(invalid.operationId)).toThrow()
    expect(host.get("orders")!.stageIndex).toBe(0)
    corruptDefinition = false
    for (const stage of ["baseline", "definition", "solution", "code", "delivery"]) {
      if (stage === "definition") {
        corruptDefinition = true
        const missingRequirement = await run()
        expect(missingRequirement.status).toBe("failed")
        expect(() => host.transition(missingRequirement.operationId)).toThrow()
        corruptDefinition = false
      }
      const operation = await run()
      expect(operation.stageId).toBe(stage)
      expect(operation.status, JSON.stringify(operation)).toBe("succeeded")
      expect(operation.receipts).toContainEqual(
        expect.objectContaining({
          checkId: stage + (stage === "code" ? ".evidence" : ".business"),
          result: "passed"
        })
      )
      if (stage !== "definition") {
        expect(() => host.transition(operation.operationId)).toThrow("RESULT_APPROVAL_REQUIRED")
        host.decideResultApproval(operation.operationId, {
          ...host.resultReview(operation.operationId),
          decision: "approved",
          actorId: "fixture-human"
        })
      }
      if (stage === "solution") {
        const path = join(workspace, "Definition.json"),
          original = readFileSync(path, "utf8")
        writeFileSync(path, original + "\n")
        expect(() => host.transition(operation.operationId)).toThrow(
          "PROJECT_ACTION_NATIVE_FACTS_SCOPE_CHANGED"
        )
        expect(host.get("orders")!.stageIndex).toBe(2)
        writeFileSync(path, original)
      }
      if (stage === "baseline") {
        const path = join(workspace, "RequestBaseline.json"),
          original = readFileSync(path, "utf8")
        writeFileSync(path, original + "\n")
        expect(() => host.transition(operation.operationId)).toThrow()
        writeFileSync(path, original)
      }
      host.transition(operation.operationId)
      if (stage === "baseline") {
        const path = join(workspace, "RequestBaseline.json"),
          original = readFileSync(path, "utf8")
        writeFileSync(path, original + "\n")
        expect(() =>
          host.prepare({
            projectId: "orders",
            expectedVersion: host.get("orders")!.version,
            idempotencyKey: "changed-accepted-baseline"
          })
        ).toThrow()
        expect(host.get("orders")!.stageIndex).toBe(1)
        writeFileSync(path, original)
      }
    }
    if (englishPolicy) {
      expect(host.get("orders")!.status).toBe("active")
      expect(host.get("orders")!.stageIndex).toBe(5)
      const failed = await run()
      expect(failed.stageId).toBe("e2e")
      expect(failed.status).toBe("failed")
      expect(() => host.transition(failed.operationId)).toThrow()
      expect(host.get("orders")!.stageIndex).toBe(5)
      corruptEndReview = false
      const accepted = await run()
      expect(accepted.status, JSON.stringify(accepted)).toBe("succeeded")
      expect(accepted.receipts).toContainEqual(
        expect.objectContaining({
          checkId: "e2e.independent",
          result: "passed"
        })
      )
      expect(() => host.transition(accepted.operationId)).toThrow("RESULT_APPROVAL_REQUIRED")
      host.decideResultApproval(accepted.operationId, {
        ...host.resultReview(accepted.operationId),
        decision: "approved",
        actorId: "fixture-human"
      })
      const deliveryPath = join(workspace, "Delivery.json"),
        original = readFileSync(deliveryPath, "utf8")
      writeFileSync(deliveryPath, original + "\n")
      expect(() => host.transition(accepted.operationId)).toThrow()
      writeFileSync(deliveryPath, original)
      expect(() => host.transition(failed.operationId)).toThrow()
      host.transition(accepted.operationId)
      expect(store.get("orders")!.status).toBe("completed")
    }
    expect(host.get("orders")!.status).toBe("completed")
    if (englishPolicy) {
      const delivered = JSON.parse(readFileSync(join(workspace, "Delivery.json"), "utf8"))
      expect(delivered.checklist).toContain("## Delivery scope")
      expect(delivered.checklist).not.toContain("## 交付范围")
    }
    expect(new Set(operationThreads.values()).size).toBe(englishPolicy ? 9 : 7)
    expect(processes).toBeGreaterThanOrEqual(5)
    expect(workflowScopeChecked).toBe(true)
    const completed = host.operations("orders")
    const codeOperation = completed.find((op) => op.stageId === "code")!
    for (const stage of ["code", "delivery"]) {
      const consumer = completed.find((op) => op.stageId === stage)!
      expect(evidenceReads).toContainEqual(
        expect.objectContaining({
          callerThread: consumer.execution!.threadId,
          producerThread: codeOperation.execution!.threadId
        })
      )
    }
  },
  600_000
)
