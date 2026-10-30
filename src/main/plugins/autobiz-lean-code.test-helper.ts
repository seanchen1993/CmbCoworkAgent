import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { cp, mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { expect } from "vitest"
import { FunctionModsManager } from "../mods/v2/manager"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { ModControlStore } from "../mods/control-store"
import { ModCommandQueue } from "../mods/command-queue"
import { runPlatformUserAction } from "../mods/v2/platform-user-action"
import { createWorkflowPlatformProvider } from "../mods/v2/platform-workflow-provider"
import { createProjectRuntimePlatformProvider } from "../mods/v2/platform-project-runtime-provider"
import { resolveNativeProjectRuntimeScope } from "../mods/v2/platform-project-runtime-native"
import { captureHostWorkflowExecution } from "../agent/workflow/host-execution"
import { withRuntimePluginSource, type RuntimePluginSourceToken } from "./runtime-source-scope"
import { createWorkflowDeterministicActionRunner } from "../agent/workflow/deterministic-action"
import {
  configureWorkflowDeterministicActions,
  observeWorkflowDeterministicActions,
  nativeWorkflowDeadlineReceiptVerifier
} from "../agent/workflow/deterministic-action-native"
import { WorkflowWorktreeLedger } from "../agent/workflow/worktree-lease"
import { createWorkflowWorktreeResourceRunner } from "../agent/workflow/worktree-resource"
import {
  withWorkflowWorktreeActionScope,
  currentWorkflowWorktreeActionScope
} from "../agent/workflow/worktree-action-scope"
import { resolveWorkflowWorktreeIsolationBoundary } from "../services/git-worktree"
import {
  createWorkflowRunStore,
  generateWorkflowRunId,
  loadWorkflowRunAsync,
  sha256Hex
} from "../agent/workflow/run-store"
import { observeWorkflowRun } from "../agent/workflow/observation"
import { runWorkflowEngine } from "../agent/workflow/engine"
import { validateWorkflowScript } from "../agent/workflow/script"
import { resolveFixtureExecutable } from "./native-fixture-executable.test-helper"
import { businessInput } from "./autobiz-native-fixture.test-helper"
import { baselineFixture, baselineDefinitionFields } from "./autobiz-lean-baseline.test-helper"
import type { RuntimeExecutionResources } from "./runtime-source-scope"
import { parseRetainedAgentProfile } from "../agent/agent-registry"
import type { WorkflowSubagentRunner } from "../agent/workflow/types"

import type { NativePlatformCapabilityProvider } from "../mods/v2/platform-capabilities-types"

/** Actual engine/Git/Mods/process fixture; only model authoring and user approval are deterministic. */
export async function runAutoBizLeanCodeFixture(options: {
  utFailure?: "source_bug" | "test_bug"
  executionAdapter?: string
  productionPaths?: string[]
  authorFixture?: (
    request: Parameters<WorkflowSubagentRunner>[0],
    cwd: string
  ) => Promise<Record<string, unknown>>
  rulesRoot?: string
  deliveryRoot?: string
  deliveryProviderId?: string
  expectedDeliveryDigest?: string
  profileRoot?: string
  workspace?: string
  threadId?: string
  providerId?: string
  expectedProviderDigest?: string
  incarnation?: string
  script?: string
  verifyOps?: boolean
  verifyRelease?: boolean
  onPlatform?(provider: NativePlatformCapabilityProvider): void
  /** Exact original Host provider; absent only for intentionally standalone workflow fixtures. */
  projectPlatform?: () => NativePlatformCapabilityProvider
  hostSource?: RuntimePluginSourceToken
  cleanup: Array<() => Promise<void> | void>
}) {
  const selected = options.executionAdapter ?? "node-test/v1"
  const java = selected === "python-unittest/v1"
  const maven = java
    ? resolveFixtureExecutable({
        name: "Maven",
        overrideEnv: "AUTOBIZ_TEST_MAVEN",
        homeEnvs: ["MAVEN_HOME", "M2_HOME"],
        commands: process.platform === "win32" ? ["mvn.cmd", "mvn.bat", "mvn.exe"] : ["mvn"]
      }).replace(/\\/g, "/")
    : ""
  const cleanup = options.cleanup
  const root = await mkdtemp(join(tmpdir(), "autobiz-code-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = options.workspace ?? join(root, "repo")
  if (!options.workspace) await mkdir(workspace)
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim()
  git(workspace, "init", "--initial-branch=main")
  git(workspace, "config", "user.name", "AutoBiz isolated test")
  git(workspace, "config", "user.email", "autobiz@example.test")
  git(workspace, "config", "core.autocrlf", "false")
  // Fixture initialization only. Production never adds ignores or commits user content.
  await writeFile(
    join(workspace, ".gitignore"),
    "target/\n__pycache__/\n.devclaw/\n.cmbcoworkagent/\n"
  )
  if (java)
    await writeFile(
      join(workspace, "pom.xml"),
      "<project><modelVersion>4.0.0</modelVersion><groupId>fixture</groupId><artifactId>orders</artifactId><version>1</version><properties><maven.compiler.source>17</maven.compiler.source><maven.compiler.target>17</maven.compiler.target></properties></project>"
    )
  if (!options.workspace) {
    const inputs = leanCodeBusinessFixture(options.productionPaths)
    await writeFile(join(workspace, "RequestBaseline.json"), JSON.stringify(inputs.baseline))
    await writeFile(join(workspace, "Definition.json"), JSON.stringify(inputs.definition))
    await writeFile(join(workspace, "Solution.json"), JSON.stringify(inputs.solution))
  }
  git(workspace, "add", ".")
  git(workspace, "commit", "-m", "isolated fixture baseline")
  const originalWorkspaceHead = git(workspace, "rev-parse", "HEAD")
  const script =
    options.script ??
    (await readFile(
      resolve("resources/native-compositions/autobiz-lean/project/workflows/lean-code.workflow.js"),
      "utf8"
    ))
  const profileRoot =
    options.profileRoot ?? resolve("resources/native-compositions/autobiz-lean/project")
  const composition = JSON.parse(
    await readFile(join(profileRoot, "composition/source.json"), "utf8")
  ) as { executionResources: { profiles: string[] } }
  const profiles = await Promise.all(
    composition.executionResources.profiles.map(async (path) =>
      parseRetainedAgentProfile(path, await readFile(join(profileRoot, path), "utf8"))
    )
  )
  const now = new Date().toISOString(),
    threadId = options.threadId ?? "code-thread",
    incarnation = options.incarnation ?? JSON.stringify({ token: null, legacyCreatedAt: 1 })
  const runStore = createWorkflowRunStore({
    workspacePath: workspace,
    threadId,
    initial: {
      version: 1,
      runId: generateWorkflowRunId(),
      threadId,
      workflowName: "autobiz-lean-code",
      hostExecution: withRuntimePluginSource(options.hostSource, () =>
        captureHostWorkflowExecution(threadId)
      ),
      script,
      scriptSha256: sha256Hex(script),
      status: "running",
      phases: [],
      currentPhase: null,
      agents: [],
      logs: [],
      journal: [],
      stats: { agentsTotal: 0, agentsCached: 0, agentsFailed: 0, outputTokens: 0, durationMs: 0 },
      startedAt: now,
      updatedAt: now
    }
  })
  await runStore.whenInitialPersisted
  const controller = new AbortController()
  const control = new ModControlStore(join(root, "mods.sqlite")),
    queue = new ModCommandQueue(control, () => {})
  cleanup.push(() => control.close())
  cleanup.push(() => queue.close())
  const guests: FunctionGuestRuntime[] = []
  const processes: string[][] = []
  const platform = () => {
    const provider = createWorkflowPlatformProvider({
      active: async () => null,
      latest: async (space, thread) =>
        space === workspace && thread === threadId ? observeWorkflowRun(runStore.state) : null,
      inspect: async (space, thread, runId, page) =>
        space === workspace && thread === threadId && runId === runStore.state.runId
          ? observeWorkflowRun(runStore.state, page)
          : null,
      inspectActions: observeWorkflowDeterministicActions,
      changed: () => () => {},
      confirmCancel: async () => false,
      cancel: () => false,
      settled: async () => {}
    })
    options.onPlatform?.(provider)
    return provider
  }
  // Even standalone tests use the actual public resolver. Absence of Host metadata is the
  // reason it returns UNBOUND; this is not a mocked capability result or error fallback.
  let unboundProjectReads = 0
  const projectPlatform =
    options.projectPlatform ??
    (() =>
      createProjectRuntimePlatformProvider({
        resolve: (context) => {
          const scope = resolveNativeProjectRuntimeScope(context, {
            thread: (id) =>
              id === threadId
                ? {
                    created_at: 1,
                    metadata: JSON.stringify({
                      workspacePath: workspace,
                      cmb_thread_incarnation: JSON.parse(incarnation).token
                    })
                  }
                : undefined,
            runtime: () => undefined,
            authorize: () => {
              throw Error("STANDALONE_MUST_NOT_AUTHORIZE_A_PROJECT")
            }
          })
          expect(scope).toBeUndefined()
          unboundProjectReads++
          return scope
        }
      }))
  const evidenceRoute = options.projectPlatform ? "host-project" : "standalone-unbound"
  const ruleInstall = options.rulesRoot ?? join(root, "installed-rules")
  if (!options.rulesRoot)
    await cp(resolve("resources/native-compositions/autobiz-lean/providers/rules"), ruleInstall, {
      recursive: true
    })
  const providerPlugins = [
    {
      id: options.providerId ?? "rules",
      name: JSON.parse(await readFile(join(ruleInstall, "plugin.json"), "utf8")).name as string,
      path: ruleInstall,
      enabled: true
    }
  ]
  const deliveryInstall =
    options.deliveryRoot ?? resolve("resources/native-compositions/autobiz-lean/providers/delivery")
  providerPlugins.push({
    id: options.deliveryProviderId ?? "delivery",
    name: JSON.parse(await readFile(join(deliveryInstall, "plugin.json"), "utf8")).name as string,
    path: deliveryInstall,
    enabled: true
  })
  const manager = new FunctionModsManager(
    control,
    {
      plugins: () => providerPlugins,
      enabled: () => true,
      clawApplicable: () => true,
      changed: () => {},
      threadIncarnationKey: () => incarnation,
      platformNativeProviders: () => [platform(), projectPlatform()],
      publish: async (_workspace, value) => value,
      fileScope: (space, thread) => {
        const scope = currentWorkflowWorktreeActionScope(space, thread)
        return {
          workspace: scope?.boundary.workspaceRoot ?? workspace,
          assertLive: () => scope?.assertCurrent(),
          queryTool: async () => ({ decision: "allow" as const })
        }
      },
      authorizeProcess: async (space, thread, grant, request) => {
        control.assertGrant(grant)
        currentWorkflowWorktreeActionScope(space, thread)?.assertCurrent()
        processes.push([...request.argv])
      },
      runEffect: async (_space, _thread, grant, _method, _input, _signal, run) => {
        control.assertGrant(grant)
        return run()
      }
    },
    () => ({
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
    })
  )
  cleanup.push(() => manager.close())
  for (const status of await manager.status(workspace)) {
    expect(status.state, JSON.stringify(status)).not.toBe("invalid")
    await manager.approve(workspace, status.pluginId, status.digest!)
  }
  const executionResources: RuntimeExecutionResources | undefined = undefined
  const descriptor = (await manager.actionCatalog(workspace, threadId)).find(
    (action) => action.actionId === "solution.inspect"
  )!
  if (options.expectedProviderDigest) expect(descriptor.digest).toBe(options.expectedProviderDigest)
  const rulesProvider = {
    pluginId: descriptor.pluginId,
    plugin: descriptor.plugin,
    digest: descriptor.digest
  }
  const deliveryDescriptor = (await manager.actionCatalog(workspace, threadId)).find(
    (action) => action.actionId === "code.verify"
  )!
  if (options.expectedDeliveryDigest)
    expect(deliveryDescriptor.digest).toBe(options.expectedDeliveryDigest)
  const deliveryProvider = {
    pluginId: deliveryDescriptor.pluginId,
    plugin: deliveryDescriptor.plugin,
    digest: deliveryDescriptor.digest
  }
  const args = { rulesProvider, deliveryProvider, executionAdapter: selected },
    parentIdentity = sha256Hex(script)
  const approvals: unknown[] = []
  const ledger = new WorkflowWorktreeLedger({
    workspacePath: workspace,
    executionResources,
    runId: runStore.state.runId,
    threadId,
    parentIdentity,
    signal: controller.signal,
    appDataRoot: join(root, "app"),
    integrate: (_root, work) => work(),
    approveMerge: async (plan) => {
      approvals.push(plan)
      return true
    },
    onRecordChange: (record) =>
      runStore.update((run) => {
        run.worktrees = [...(run.worktrees ?? []).filter((item) => item.id !== record.id), record]
      }),
    onRecordDelete: (record) =>
      runStore.update((run) => {
        run.worktrees = run.worktrees?.filter((item) => item.id !== record.id)
      })
  })
  cleanup.push(() => ledger.reclaimAll())
  const dependencies = {
    functions: manager,
    store: control.functionState,
    runOwned: <T>(
      scope: { workspace: string; threadId: string; signal: AbortSignal; assertCurrent(): void },
      work: (signal: AbortSignal) => Promise<T>
    ) =>
      runPlatformUserAction(
        queue,
        { functionUserScope: () => ({}) },
        scope.workspace,
        scope.threadId,
        scope.signal,
        scope.assertCurrent,
        work
      )
  }
  cleanup.push(
    configureWorkflowDeterministicActions({
      ...dependencies,
      workspaceKey: (value) => value,
      thread: () => ({
        created_at: 1,
        metadata: JSON.stringify({ cmb_thread_incarnation: JSON.parse(incarnation).token })
      })
    })
  )
  const runner = createWorkflowDeterministicActionRunner(dependencies, {
    workspace,
    threadId,
    incarnation,
    runId: runStore.state.runId,
    scriptSha256: parentIdentity,
    args,
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
    runVerificationResource: (request, work) =>
      ledger.useVerificationResource(
        request.handle,
        request.expectedCommit,
        () => controller.signal.throwIfAborted(),
        (scope) =>
          withWorkflowWorktreeActionScope(
            { ...scope, workspace, threadId, runId: runStore.state.runId },
            work
          )
      ),
    runDeadlineResource: (handle, budgetId, work) => ledger.useResource(handle, work, budgetId),
    runResource: (handle, work, budgetId) =>
      ledger.useResource(
        handle,
        async (info) =>
          withWorkflowWorktreeActionScope(
            {
              workspace,
              threadId,
              runId: runStore.state.runId,
              boundary: await resolveWorkflowWorktreeIsolationBoundary(info, join(root, "app")),
              assertCurrent: () => controller.signal.throwIfAborted()
            },
            work
          ),
        budgetId
      )
  })
  const deadlineReceiptVerifier = nativeWorkflowDeadlineReceiptVerifier({
    workspacePath: workspace,
    threadId,
    runId: runStore.state.runId
  })
  const authored: Array<{ label: string; handle: string; cwd: string }> = []
  const author: WorkflowSubagentRunner = async (request) =>
    ledger.useResource(
      request.resourceHandle!,
      async (info) => {
        const cwd = info.workspaceDirectory
        authored.push({ label: request.label, handle: request.resourceHandle!, cwd })
        expect(request.shellAccess).toBe("none")
        expect(request.toolAllowlist).toBeDefined()
        let structured: Record<string, unknown>
        if (options.authorFixture) structured = await options.authorFixture(request, cwd)
        else if (request.label.endsWith("-ut-diagnosis-1")) {
          expect(["source_bug", "test_bug"]).toContain(options.utFailure)
          expect(request.prompt).toContain("failedExecutionId")
          expect(request.prompt).toContain("taskDigest")
          structured = {
            kind: options.utFailure,
            reason:
              options.utFailure === "test_bug"
                ? "真实Node失败断言把已有订单42错误期望为wrong-test-expectation；生产实现仍返回42，需人工审查测试变更"
                : "实际生产代码对已有订单返回了错误ID；原Node断言失败，保留测试和已确认规格"
          }
        } else if (
          request.label.endsWith("-implement") ||
          request.label.endsWith("-source-repair")
        ) {
          if (java) {
            await mkdir(join(cwd, "src/main/java"), { recursive: true })
            await writeFile(
              join(cwd, "src/main/java/Orders.java"),
              'public class Orders { public static void main(String[] args) { if(args.length != 1 || !args[0].equals("42")) { System.err.println("ORDER_NOT_FOUND"); System.exit(2); } System.out.println("42"); } }'
            )
            structured = { compileArgv: [maven, "-q", "-o", "compile"] }
          } else {
            await mkdir(join(cwd, "src"), { recursive: true })
            await writeFile(
              join(cwd, "src/orders.cjs"),
              "const normalize=require('./normalize.cjs'); module.exports = id => { id=normalize(id); if (id !== '42') throw Error('ORDER_NOT_FOUND'); return { id: " +
                (options.utFailure === "source_bug" && request.label.endsWith("-implement")
                  ? "'wrong-order'"
                  : "id") +
                " } }\n"
            )
            await writeFile(
              join(cwd, "src/normalize.cjs"),
              "module.exports = id => String(id).trim()\n"
            )
            structured = { compileArgv: ["node", "--check", "src/orders.cjs"] }
          }
        } else if (request.label.endsWith("-review")) structured = { verdict: "pass", findings: [] }
        else if (java) {
          const name = request.label.endsWith("-e2e-author") ? "test_e2e.py" : "test_orders.py"
          await writeFile(
            join(cwd, name),
            `import unittest,subprocess,time
class OrdersTests(unittest.TestCase):
 def test_found(self):
  start=time.monotonic()
  result=subprocess.run(['java','-cp','target/classes','Orders','42'],capture_output=True,text=True)
  self.assertEqual(result.returncode,0)
  self.assertEqual(result.stdout.strip(),'42')
  self.assertLess(time.monotonic()-start,2)
 def test_missing(self):
  result=subprocess.run(['java','-cp','target/classes','Orders','missing'],capture_output=True,text=True)
  self.assertEqual(result.returncode,2)
  self.assertIn('ORDER_NOT_FOUND',result.stderr)
`
          )
          structured = {
            testInput: {
              files: [name],
              subjects: ["pom.xml", "src/main/java/Orders.java"],
              timeoutMs: 10000
            }
          }
        } else {
          await mkdir(join(cwd, "test"), { recursive: true })
          const name = request.label.endsWith("-e2e-author")
            ? "test/orders-e2e.test.cjs"
            : "test/orders.test.cjs"
          await writeFile(
            join(cwd, name),
            "const test=require('node:test'); const assert=require('node:assert/strict'); const query=require('../src/orders.cjs');\n" +
              "test('existing order and latency',()=>{const start=performance.now();assert.deepEqual(query('42'),{id:'" +
              (options.utFailure === "test_bug" ? "wrong-test-expectation" : "42") +
              "'});assert.ok(performance.now()-start<2000)});\n" +
              "test('missing order',()=>assert.throws(()=>query('missing'),/ORDER_NOT_FOUND/));\n"
          )
          structured = {
            testInput: {
              files: [name],
              subjects: ["src/orders.cjs", "src/normalize.cjs"],
              timeoutMs: 10000
            }
          }
        }
        return { text: JSON.stringify(structured), structured, outputTokens: 1 }
      },
      request.deadlineBudgetId
    )
  const began = Date.now()
  const readActionFacts = () => {
    const rows: Array<{ stepId: string; status: string; output: Record<string, unknown> }> = []
    let offset = 0
    while (offset <= 256) {
      const page = observeWorkflowDeterministicActions(
        { workspace, threadId, incarnation, assertCurrent: () => {} },
        runStore.state.runId,
        offset,
        32
      )
      rows.push(...(page.deterministicActions as typeof rows))
      if (page.nextActionOffset === null) return rows
      expect(page.nextActionOffset).toBeGreaterThan(offset)
      offset = page.nextActionOffset as number
    }
    throw Error("FIXTURE_ACTION_PAGE_LIMIT")
  }
  console.info(`[AutoBiz Code integration] start controlled-model/actual-${selected}-tests`)
  const outcome = await runWorkflowEngine({
    parsed: validateWorkflowScript(script),
    runStore,
    workspacePath: workspace,
    args,
    agentProfiles: profiles,
    signal: controller.signal,
    emit: () => {},
    resourceJournal: {
      commit: (handle, parent, budgetId) => ledger.commitResourceChanges(handle, parent, budgetId),
      capture: (handle) => ledger.captureResourceJournalCheckpoint(handle),
      validate: (handle, checkpoint) => ledger.validateResourceJournalCheckpoint(handle, checkpoint)
    },
    actionRunner: runner,
    worktreeRunner: createWorkflowWorktreeResourceRunner(
      ledger,
      parentIdentity,
      () => {},
      deadlineReceiptVerifier
    ),
    subagentRunner: author
  })
  console.info(
    `[AutoBiz Code integration] workflow ${outcome.status} after ${Date.now() - began}ms`
  )
  if (options.utFailure === "test_bug") {
    expect(outcome).toMatchObject({
      status: "error",
      error: expect.stringContaining("LEAN_TEST_CHANGE_REVIEW_REQUIRED:")
    })
    expect(outcome.error).toContain("创建新运行")
    const facts = readActionFacts()
    const failed = facts.find((item) => item.stepId === "B001-test")
    if (!failed) throw Error("ORIGINAL_FAILED_TEST_RECEIPT_REQUIRED")
    expect(failed).toMatchObject({
      status: "failed",
      output: {
        passed: false,
        phase: "test",
        exitCode: 1,
        test: { counts: { total: 2, passed: 1, failed: 1, skipped: 0 } }
      }
    })
    expect(facts.find((item) => item.stepId === "B001-repair-evidence-1")).toMatchObject({
      status: "succeeded",
      output: { passed: true }
    })
    expect(authored.map((item) => item.label)).toEqual([
      "B001-implement",
      "B001-review",
      "B001-test-author",
      "B001-ut-diagnosis-1"
    ])
    expect(
      facts.filter((item) => ["test", "e2e"].includes(String(item.output.phase)))
    ).toHaveLength(1)
    expect(facts.some((item) => /test-rerun|source-repair|final/.test(item.stepId))).toBe(false)
    expect(approvals).toHaveLength(0)
    expect(git(workspace, "rev-parse", "HEAD")).toBe(originalWorkspaceHead)
    const failedCommit = String(failed.output.headCommit)
    expect(failedCommit).toMatch(/^[a-f0-9]{40,64}$/)
    const originalTest = git(workspace, "show", failedCommit + ":test/orders.test.cjs")
    expect(originalTest).toContain("{id:'wrong-test-expectation'}")
    const originalProduction = git(workspace, "show", failedCommit + ":src/orders.cjs")
    expect(originalProduction).toContain("return { id: id }")
    expect(originalProduction).not.toContain("wrong-order")
    expect(runStore.state.worktrees?.some((item) => item.status === "merged")).toBe(false)
    const failedSnapshot = JSON.stringify(failed)
    const processCount = processes.length
    await ledger.reclaimAll()
    await runStore.flush()
    expect(processes).toHaveLength(processCount)
    expect(JSON.stringify(readActionFacts().find((item) => item.stepId === "B001-test"))).toBe(
      failedSnapshot
    )
    expect(git(workspace, "show", failedCommit + ":test/orders.test.cjs")).toBe(originalTest)
    expect(git(workspace, "rev-parse", "HEAD")).toBe(originalWorkspaceHead)
    const persisted = await loadWorkflowRunAsync(workspace, threadId, runStore.state.runId)
    expect(persisted).toMatchObject({
      status: "error",
      error: expect.stringContaining("LEAN_TEST_CHANGE_REVIEW_REQUIRED:")
    })
    return {
      runId: runStore.state.runId,
      result: outcome.result,
      evidenceRoute,
      actionFacts: readActionFacts(),
      processes,
      stoppedForTestReview: true,
      authoredLabels: authored.map((item) => item.label),
      failureMessage: outcome.error
    }
  }
  if (outcome.status !== "completed") {
    console.error(
      "LEAN_ORIGINAL_FAILED_ACTIONS",
      JSON.stringify(readActionFacts().filter((item) => item.status !== "succeeded"))
    )
  }
  expect(outcome, JSON.stringify(outcome)).toMatchObject({
    status: "completed",
    result: { status: "succeeded" }
  })
  const repositoryCount = 1
  expect(approvals).toHaveLength(1)
  if (!options.authorFixture) {
    expect(processes.filter((argv) => argv[0] === "node" && argv[1] === "--check")).toHaveLength(
      java ? 0 : options.utFailure ? 6 : 4
    )
    expect(
      processes.filter(
        (argv) =>
          argv[0] === "node" && argv[1] === "-" && !argv[2]?.includes('"mode":"fingerprint"')
      )
    ).toHaveLength(options.utFailure ? 3 : 2)
  } else {
    const facts = readActionFacts()
    for (const phase of ["compile", "test", "e2e"])
      expect(
        facts.some((fact) => fact.output?.phase === phase && fact.status === "succeeded")
      ).toBe(true)
  }
  if (java) expect(processes.filter((argv) => argv[0] === maven)).toHaveLength(2)
  if (options.utFailure) {
    expect(outcome.result).toMatchObject({
      repairs: [
        {
          batchId: "B001",
          attempt: 1,
          kind: "source_bug",
          failedExecutionId: expect.any(String),
          attestationExecutionId: expect.any(String),
          rerunExecutionId: expect.any(String)
        }
      ]
    })
    expect(authored.filter((item) => item.label.endsWith("-source-repair"))).toHaveLength(1)
    expect(authored.filter((item) => item.label.endsWith("-test-author"))).toHaveLength(1)
    const facts = readActionFacts()
    expect(facts.find((item) => item.stepId === "B001-test")).toMatchObject({
      status: "failed",
      output: { exitCode: 1, test: { counts: { total: 2, passed: 1, failed: 1, skipped: 0 } } }
    })
    expect(facts.find((item) => item.stepId === "B001-test-rerun-1")).toMatchObject({
      status: "succeeded",
      output: { exitCode: 0, test: { counts: { total: 2, passed: 2, failed: 0, skipped: 0 } } }
    })
  }
  const beforeReplay = processes.length
  const replay = await runWorkflowEngine({
    parsed: validateWorkflowScript(script),
    runStore,
    workspacePath: workspace,
    args,
    agentProfiles: profiles,
    signal: controller.signal,
    emit: () => {},
    resourceJournal: {
      commit: (handle, parent, budgetId) => ledger.commitResourceChanges(handle, parent, budgetId),
      capture: (handle) => ledger.captureResourceJournalCheckpoint(handle),
      validate: (handle, checkpoint) => ledger.validateResourceJournalCheckpoint(handle, checkpoint)
    },
    actionRunner: runner,
    worktreeRunner: createWorkflowWorktreeResourceRunner(
      ledger,
      parentIdentity,
      () => {},
      deadlineReceiptVerifier
    ),
    subagentRunner: async () => {
      throw Error("MODEL_REPLAY_MUST_USE_JOURNAL")
    }
  })
  console.info(`[AutoBiz Code integration] replay ${replay.status} after ${Date.now() - began}ms`)
  expect(replay, JSON.stringify(replay)).toMatchObject({
    status: "completed",
    result: outcome.result
  })
  expect(processes).toHaveLength(beforeReplay)
  expect(approvals).toHaveLength(repositoryCount)
  // Complete actual resource reclamation and original durable flush before the Host adapter
  // records Skill success. A terminal string alone is not the physical-settlement boundary.
  await ledger.reclaimAll()
  await runStore.flush()
  if (options.hostSource) {
    expect(runStore.state.hostExecution).toMatchObject({ threadId, incarnationKey: incarnation })
  } else {
    expect(runStore.state.hostExecution).toBeUndefined()
  }
  if (options.verifyOps === false)
    return { runId: runStore.state.runId, result: outcome.result, evidenceRoute }
  const codeRunner = createWorkflowDeterministicActionRunner(dependencies, {
    workspace,
    threadId,
    incarnation,
    runId: runStore.state.runId + "_check",
    scriptSha256: parentIdentity,
    signal: controller.signal,
    assertCurrent: () => {}
  })
  await writeFile(
    join(workspace, "Code.json"),
    JSON.stringify({ feature: "orders", runId: runStore.state.runId })
  )
  const reference = async () => {
    const rows = await Promise.all(
      ["RequestBaseline.json", "Definition.json", "Solution.json", "Code.json"].map(
        async (path) => {
          const bytes = await readFile(join(workspace, path))
          return {
            artifactId:
              path === "RequestBaseline.json" ? "baseline" : path.split(".")[0].toLowerCase(),
            path,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            maxBytes: path === "Code.json" ? 28000 : 131072
          }
        }
      )
    )
    return {
      protocol: "devclaw.artifact-input/v1",
      projectId: "isolated-fixture",
      stageId: "code",
      version: 1,
      pluginDigest: "a".repeat(64),
      workspaceIdentity: "fixture",
      current: rows[3],
      sources: rows.slice(0, 3),
      configuration: { executionAdapter: selected }
    }
  }
  const verify = async (stepId: string, adapter = selected) =>
    codeRunner(
      {
        stepId,
        provider: { ...deliveryProvider, actionId: "code.verify" },
        config: {
          nativeCompositionProvider: { ...deliveryProvider, actionId: "code.verify" },
          rulesProvider: { ...rulesProvider, actionId: "solution.inspect" },
          workflowSha256: parentIdentity,
          artifactRoles: {
            baseline: "baseline",
            definition: "definition",
            solution: "solution",
            code: "code"
          }
        },
        input: { ...(await reference()), configuration: { executionAdapter: adapter } }
      },
      undefined,
      controller.signal
    )
  const code = await verify("host-code-evidence")
  console.info(`[AutoBiz Lean integration] evidence ${code.status} after ${Date.now() - began}ms`)
  expect(code, JSON.stringify(code)).toMatchObject({
    status: "succeeded",
    output: { passed: true }
  })
  await expect(
    verify("changed-adapter", java ? "node-test/v1" : "python-unittest/v1")
  ).rejects.toThrow("LEAN_EXECUTION_ADAPTER_CHANGED")
  if (!options.projectPlatform) expect(unboundProjectReads).toBeGreaterThan(0)
  const before = await readFile(join(workspace, "Solution.json"), "utf8")
  await writeFile(join(workspace, "Solution.json"), before + "\n")
  await expect(verify("upstream-byte-change")).rejects.toThrow("LEAN_CODE_INPUT_CHANGED")
  await writeFile(join(workspace, "Solution.json"), before)
  return {
    runId: runStore.state.runId,
    result: outcome.result,
    evidenceRoute,
    actionFacts: readActionFacts(),
    processes
  }
}

export function leanCodeBusinessFixture(productionPaths?: string[]) {
  const old = businessInput()
  const baseline = baselineFixture(old.normalized.feature, old.normalized.requirements)
  const specs = { "order-query": old.specs.files["specs/order-query/spec.md"] }
  const definition = {
    ...baselineDefinitionFields(baseline, specs),
    feature: old.normalized.feature,
    requirements: old.normalized.requirements,
    prd: old.prd.files["PRD.md"].replace(
      "来源：NORMALIZED_REQUIREMENTS.json",
      "来源：Definition.json.requirements"
    ),
    scope: JSON.parse(old.prd.files["IMPLEMENTATION_SCOPE.json"]),
    ui: JSON.parse(old.specs.files["UI_CONTEXT.json"]),
    proposal: old.specs.files["proposal.md"],
    specs
  }
  const solution = {
    feature: definition.feature,
    design: old.design.files["design.md"],
    designLock: JSON.parse(old.design.files[".design-contract.lock.json"]),
    plan: JSON.parse(old.plan.files["plan.json"]),
    batches: Object.fromEntries(
      Object.entries(old.plan.files)
        .filter(([path]) => path.startsWith("plans/"))
        .map(([path, text]) => [path.split("/")[1], JSON.parse(text as string)])
    )
  }
  if (productionPaths) {
    for (const batch of Object.values(solution.batches) as Array<{
      tasks: Array<{ expectedFiles: string[] }>
    }>)
      for (const task of batch.tasks) task.expectedFiles = [...productionPaths]
  }
  return { baseline, definition, solution }
}
