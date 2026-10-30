import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
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
import { leanCodeBusinessFixture } from "./autobiz-lean-code.test-helper"
import {
  developmentDependencyCatalogPage,
  readDevelopmentDependencySource
} from "../mods/devtools/development-dependency-catalog"
import { dependencySourceIndex } from "../mods/devtools/dependency-source-index"
import { createAuthoringSourceBundle } from "../mods/devtools/authoring-bundle"
import { nativeCompositionSchema } from "./native-composition"
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
// Controlled Skill text only: real compilation, grants, QuickJS checks, Flow facts, SQLite and approvals.
vi.mock("../harness-board/host-skill-executor", () => ({ executeHostProjectSkill: model.execute }))
import { executeHostProjectStage } from "../harness-board/project-action-executor"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  model.threads.clear()
  expect(model.readDatabase).not.toHaveBeenCalled()
  for (const close of cleanup.splice(0).reverse()) await close()
})

it.each(["lean-prefix", "incident-report"])(
  "runs %s with real Host approvals, scoped knowledge and independent end checks",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "lean-composition-host-"))
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
    const plugins = [
      { id: "business-rules", name: "autobiz-lean-rules", path: ruleInstall, enabled: true }
    ]
    const knowledgeInstall = join(root, "installed-knowledge")
    // Cold discovery resolves the nested provider's opaque Host source ID, never an invented path.
    const location = dependencySourceIndex(resolve("resources/native-compositions")).find(
      (entry) => entry.relative === "autobiz-lean/providers/knowledge"
    )!
    const page = developmentDependencyCatalogPage({
      mainDirectory: resolve("main"),
      assetPath: location.sourceId
    })
    expect(page).toMatchObject({ installed: false, grantsAuthority: false, executed: false })
    const bundle = readDevelopmentDependencySource({
      mainDirectory: resolve("main"),
      sourceId: location.sourceId
    })
    for (const file of bundle.files) {
      mkdirSync(dirname(join(knowledgeInstall, file.path)), { recursive: true })
      writeFileSync(join(knowledgeInstall, file.path), file.text)
    }
    if (mode === "incident-report") plugins.splice(0, 1)
    plugins.push({
      id: "knowledge-provider",
      name: "autobiz-lean-knowledge",
      path: knowledgeInstall,
      enabled: true
    })
    plugins.push({
      id: "report-checks",
      name: "evidence-validation",
      path: resolve("resources/native-compositions/evidence-validation"),
      enabled: true
    })
    for (const stage of ["convert", "baseline", "definition", "collect", "summarize", "e2e"])
      writeFileSync(
        join(knowledge, stage + ".md"),
        "---\ntype: Service Knowledge\ndeploy_unit: orders-api\nautobiz_stages: [" +
          stage +
          "]\n---\nONLY_" +
          stage
      )
    let threadId = ""
    model.threads.set("creator", {
      created_at: 1,
      metadata: JSON.stringify({
        workspacePath: workspace,
        agentMode: "normal",
        cmb_thread_incarnation: "fixture"
      })
    })
    const clawScope = (id: string) => resolveClawThread(id, (key) => model.threads.get(key) ?? null)
    const functions = new FunctionModsManager(
      control,
      {
        plugins: () => plugins,
        enabled: () => true,
        clawApplicable: (id) => clawScope(id) !== null,
        clawScope,
        threadIncarnationKey: (_space, id) => id,
        platformNativeProviders: () => [createNativeProjectContextPlatformProvider()],
        changed: () => {},
        publish: async (_workspace, value) => value,
        authorizeProcess: async (_workspace, _thread, grant, request) => {
          control.assertGrant(grant)
          expect(request.argv[0]).toBe("python")
          expect(request.argv).toContain("-I")
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
    for (const provider of providers) {
      try {
        await functions.approve(workspace, provider.pluginId, provider.digest!)
      } catch (error) {
        throw new Error(provider.pluginId + ": " + String(error))
      }
    }
    const catalog = () => functions.actionCatalog(workspace, "creator")
    const originalSource = await readProjectSource(
      resolve("resources/native-compositions/autobiz-lean/project")
    )
    const spec = nativeCompositionSchema.parse(
      JSON.parse(
        originalSource.bundle.files.find((file) => file.path === "composition/source.json")!.text
      )
    )
    spec.plugin = {
      id: mode === "lean-prefix" ? "extended-definition" : "incident-report",
      version: "1.0.0",
      title: "Composable review",
      description: "Independent modules using public composition contracts"
    }
    spec.resources = ["knowledge/method.md", "tests/project-contract.json"]
    delete spec.executionResources
    delete spec.configuration!.userConfig.executionAdapter
    const contract = (artifactId: string) => ({
      artifactId,
      contract: "incident." + artifactId + "/v1"
    })
    const artifact = (id: string) => ({
      id,
      path: id + ".json",
      contract: "incident." + id + "/v1"
    })
    const module = (id: string, inputs: string[], outputs: string[], checks: unknown[]) => ({
      id,
      version: "1.0.0",
      title: id,
      skill: "modules/" + id + "/SKILL.md",
      inputs: inputs.map(contract),
      contextArtifactIds: inputs.slice(-1),
      outputs: outputs.map(artifact),
      checks,
      approval: "none",
      resultApproval: "human"
    })
    const json = (artifactId: string) => ({
      id: artifactId + ".shape",
      kind: "json-schema",
      artifactId,
      schema: {
        type: "object",
        required: artifactId === "originals" ? ["sources"] : ["summary", "citations"]
      }
    })
    const check = (id: string, actionId: string, artifactId: string) => ({
      id,
      kind: "action",
      artifactId,
      provider: { plugin: "evidence-validation", actionId },
      format: "artifact-reference-v1",
      maxBytes: 28000,
      config: {
        sourceArtifactId: "originals",
        ...(actionId === "check-report" ? { summaryArtifactId: "abstract" } : {})
      }
    })
    const start = mode === "lean-prefix" ? "convert" : "collect"
    const first = module(
      start,
      [],
      ["originals", "abstract"],
      [json("originals"), json("abstract")]
    )
    const end = module(
      "e2e",
      ["originals", "abstract"],
      ["report"],
      [check("e2e.independent", "check-report", "report")]
    )
    if (mode === "lean-prefix") {
      const [baseline, definition] = spec.modules
      baseline.inputs.push(contract("originals"), contract("abstract"))
      baseline.contextArtifactIds = ["abstract"]
      definition.inputs.push(contract("originals"), contract("abstract"))
      end.inputs.push(
        ...baseline.outputs.map(({ id, contract }) => ({ artifactId: id, contract })),
        ...definition.outputs.map(({ id, contract }) => ({ artifactId: id, contract }))
      )
      spec.modules = nativeCompositionSchema.shape.modules.parse([first, baseline, definition, end])
    } else {
      first.outputs = [artifact("originals")]
      first.checks = [json("originals")]
      const summarize = module(
        "summarize",
        ["originals"],
        ["abstract"],
        [check("summary.citations", "check-citations", "abstract")]
      )
      spec.modules = nativeCompositionSchema.shape.modules.parse([first, summarize, end])
    }
    spec.contextAction!.config = {
      stageTags: Object.fromEntries(
        ["convert", "baseline", "definition", "collect", "summarize", "e2e"].map((id) => [id, [id]])
      )
    }
    const files = [
      { path: "composition/source.json", text: JSON.stringify(spec) },
      {
        path: "knowledge/method.md",
        text: "Read declared inputs and retain exact source quotations."
      },
      {
        path: "tests/project-contract.json",
        text: JSON.stringify({
          apiVersion: "devclaw.project-contract/v1",
          cases: [{ id: "missing", stageId: start, files: [], expected: "failed" }]
        })
      },
      ...spec.modules.map(({ skill, id }) => ({
        path: skill,
        text:
          "---\nname: " +
          id +
          "\ndescription: Compose declared artifacts\n---\nWrite the declared output using the declared inputs."
      }))
    ]
    const source = { bundle: createAuthoringSourceBundle(files) }
    const sessions = new ProjectAuthoringSessions(catalog)
    const scope = {
      workspace,
      threadId: "creator",
      incarnation: { token: "fixture", legacyCreatedAt: 1 }
    }
    const draft = await sessions.save(
      scope,
      { id: spec.plugin.id, name: spec.plugin.title, revision: 0, files: source.bundle.files },
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
                `[Composition Host integration] action settled ${step.id}: passed=${result.passed} (${Date.now() - startedAt}ms)`
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
                `[Composition Host integration] original action error ${step.id}: ${error instanceof Error ? error.message : String(error)}`
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
    const business = leanCodeBusinessFixture()
    const originals = {
      sources: [
        {
          id: "A",
          text:
            mode === "lean-prefix"
              ? business.baseline.request.text
              : "09:00 service restarted; 09:10 recovered"
        }
      ]
    }
    const abstract = {
      summary:
        mode === "lean-prefix" ? business.baseline.request.text : "Restart followed by recovery",
      citations: [
        {
          sourceId: "A",
          quote: mode === "lean-prefix" ? business.baseline.request.text : "09:10 recovered"
        }
      ]
    }
    let badReport = false
    const observedContext = new Map<string, string>()
    model.execute.mockImplementation(async (context: HostSkillExecutionContext) => {
      const stage = context.project.manifest.stages[context.project.stageIndex]
      threadId = "composition-" + randomUUID()
      model.threads.set(threadId, {
        created_at: 1,
        metadata: JSON.stringify({
          workspacePath: workspace,
          agentMode: "normal",
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
      const text = prepared?.requiredContextText ?? ""
      observedContext.set(stage.id, text)
      expect(text).toContain("ONLY_" + stage.id)
      for (const other of spec.modules)
        if (other.id !== stage.id) expect(text).not.toContain("ONLY_" + other.id)
      expect(text).toContain("订单领域边界")
      expect(text).toContain("隔离测试知识")
      if (stage.id === "baseline")
        expect(JSON.parse(readFileSync(join(workspace, "abstract.json"), "utf8")).summary).toBe(
          context.project.goal
        )
      for (const id of stage.artifactIds) {
        const value =
          id === "originals"
            ? originals
            : id === "abstract"
              ? abstract
              : id === "report"
                ? {
                    ...abstract,
                    summary: badReport
                      ? "Changed without preserving approved summary"
                      : abstract.summary
                  }
                : business[id as "baseline" | "definition"]
        const artifact = context.project.manifest.artifacts.find((item) => item.id === id)!
        writeFileSync(join(workspace, artifact.path), JSON.stringify(value))
      }
      context.recordTerminal({ outcome: "success", code: "controlled-skill-output" })
      return "succeeded"
    })
    await host.localCreate({
      projectId: "orders",
      name: spec.plugin.title,
      workspace,
      installedPluginId: "saved-native",
      goal: business.baseline.request.text
    })
    const run = async () => {
      const project = host.get("orders")!
      const operation = host.prepare({
        projectId: project.projectId,
        expectedVersion: project.version,
        idempotencyKey: randomUUID()
      })
      return host.start(operation.operationId)
    }
    const approve = (operationId: string) =>
      host.decideResultApproval(operationId, {
        ...host.resultReview(operationId),
        decision: "approved",
        actorId: "fixture-human"
      })
    for (const stage of spec.modules.slice(0, -1)) {
      const operation = await run()
      expect(operation.status, JSON.stringify(operation)).toBe("succeeded")
      expect(operation.stageId).toBe(stage.id)
      if (stage.resultApproval === "human") {
        expect(() => host.transition(operation.operationId)).toThrow("RESULT_APPROVAL_REQUIRED")
        approve(operation.operationId)
      }
      if (stage.id === "baseline") {
        // The business Mod selects baseline only, while the Host invalidates *all* extra inputs.
        const path = join(workspace, "originals.json"),
          original = readFileSync(path, "utf8")
        writeFileSync(path, original + "\n")
        expect(() => host.transition(operation.operationId)).toThrow()
        expect(host.get("orders")!.stageIndex).toBe(1)
        writeFileSync(path, original)
      }
      host.transition(operation.operationId)
    }
    badReport = true
    const failed = await run()
    expect(failed.status).toBe("failed")
    expect(() => host.transition(failed.operationId)).toThrow()
    expect(host.get("orders")!.stageIndex).toBe(spec.modules.length - 1)
    badReport = false
    const passed = await run()
    expect(passed.status, JSON.stringify(passed)).toBe("succeeded")
    expect(passed.receipts).toContainEqual(
      expect.objectContaining({ checkId: "e2e.independent", result: "passed" })
    )
    expect(() => host.transition(passed.operationId)).toThrow("RESULT_APPROVAL_REQUIRED")
    approve(passed.operationId)
    const report = join(workspace, "report.json"),
      original = readFileSync(report, "utf8")
    writeFileSync(report, original.replace(abstract.summary, "changed after acceptance"))
    expect(() => host.transition(passed.operationId)).toThrow()
    writeFileSync(report, original)
    expect(() => host.transition(failed.operationId)).toThrow()
    host.transition(passed.operationId)
    expect(host.get("orders")!.status).toBe("completed")
    expect(observedContext.size).toBe(spec.modules.length)
    expect(store.get("orders")!.status).toBe("completed")
  },
  120000
)
