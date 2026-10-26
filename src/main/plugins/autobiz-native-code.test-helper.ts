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
  sha256Hex
} from "../agent/workflow/run-store"
import { observeWorkflowRun } from "../agent/workflow/observation"
import { runWorkflowEngine } from "../agent/workflow/engine"
import { validateWorkflowScript } from "../agent/workflow/script"
import { businessInput } from "./autobiz-native-fixture.test-helper"
import {
  compileNativeComposition,
  nativeCompositionSchema,
  readNativeCompositionFiles
} from "./native-composition"
import { readRetainedExecutionResources } from "../harness-board/project-runtime/execution-resources"
import type { RuntimeExecutionResources } from "./runtime-source-scope"
import { parseRetainedAgentProfile } from "../agent/agent-registry"
import type { WorkflowSubagentRunner } from "../agent/workflow/types"

import type { NativePlatformCapabilityProvider } from "../mods/v2/platform-capabilities-types"
import { resolveFixtureExecutable } from "./native-fixture-executable.test-helper"

/** Actual engine/Git/Mods/process fixture; only model authoring and user approval are deterministic. */
export async function runAutoBizNativeCodeFixture(options: {
  rulesRoot?: string
  profileRoot?: string
  workspace?: string
  threadId?: string
  providerId?: string
  expectedProviderDigest?: string
  incarnation?: string
  script?: string
  verifyOps?: boolean
  verifyRelease?: boolean
  performanceOnly?: boolean
  utFailure?: "source_bug" | "test_bug"
  repositories?: "dependent" | "independent" | "unbound"
  onPlatform?(provider: NativePlatformCapabilityProvider): void
  /** Exact original Host provider; absent only for intentionally standalone workflow fixtures. */
  projectPlatform?: () => NativePlatformCapabilityProvider
  hostSource?: RuntimePluginSourceToken
  cleanup: Array<() => Promise<void> | void>
}) {
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
  await writeFile(
    join(workspace, "pom.xml"),
    `<project><modelVersion>4.0.0</modelVersion><groupId>fixture</groupId><artifactId>orders</artifactId><version>1</version><properties><maven.compiler.source>17</maven.compiler.source><maven.compiler.target>17</maven.compiler.target></properties></project>`
  )
  const names = [
    "NORMALIZED_REQUIREMENTS.json",
    "PRD.bundle.json",
    "SPECS.bundle.json",
    "DESIGN.bundle.json",
    "PLAN.bundle.json"
  ]
  if (!options.workspace)
    for (const [index, stage] of ["convert", "prd", "specs", "design", "plan"].entries())
      await writeFile(
        join(workspace, names[index]),
        JSON.stringify(
          businessInput()[
            stage === "convert" ? "normalized" : (stage as "prd" | "specs" | "design" | "plan")
          ]
        )
      )
  let secondary: string | undefined
  if (options.repositories) {
    await writeFile(
      join(workspace, "PLAN.bundle.json"),
      await readFile(
        resolve("tests/fixtures/native-compositions/autobiz-plan-" + options.repositories + ".json")
      )
    )
    secondary = join(root, "secondary")
    await mkdir(secondary)
    for (const name of [".gitignore", "pom.xml"])
      await writeFile(join(secondary, name), await readFile(join(workspace, name)))
    git(secondary, "init", "--initial-branch=main")
    git(secondary, "config", "user.name", "AutoBiz isolated test")
    git(secondary, "config", "user.email", "autobiz@example.test")
    git(secondary, "config", "core.autocrlf", "false")
    git(secondary, "add", ".")
    git(secondary, "commit", "-m", "isolated secondary baseline")
  }
  git(workspace, "add", ".")
  git(workspace, "commit", "-m", "isolated fixture baseline")
  const script =
    options.script ??
    (await readFile(
      resolve("resources/native-compositions/autobiz/workflows/native-code.workflow.js"),
      "utf8"
    ))
  const profileRoot = options.profileRoot ?? resolve("resources/native-compositions/autobiz")
  const composition = JSON.parse(
    await readFile(join(profileRoot, "composition/source.json"), "utf8")
  ) as { executionResources: { profiles: string[] } }
  let profiles = await Promise.all(
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
      workflowName: "autobiz-native-code",
      hostExecution: withRuntimePluginSource(options.hostSource, () => captureHostWorkflowExecution(threadId)),
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
    latest: async (space, thread) => space === workspace && thread === threadId ? observeWorkflowRun(runStore.state) : null,
    inspect: async (space, thread, runId, page) =>
      space === workspace && thread === threadId && runId === runStore.state.runId ? observeWorkflowRun(runStore.state, page) : null,
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
  const projectPlatform = options.projectPlatform ?? (() => createProjectRuntimePlatformProvider({
    resolve: context => {
      const scope = resolveNativeProjectRuntimeScope(context, {
      thread: id => id === threadId ? { created_at: 1, metadata: JSON.stringify({
        workspacePath: workspace, cmb_thread_incarnation: JSON.parse(incarnation).token
      }) } : undefined,
      runtime: () => undefined,
      authorize: () => { throw Error("STANDALONE_MUST_NOT_AUTHORIZE_A_PROJECT") }
      })
      expect(scope).toBeUndefined()
      unboundProjectReads++
      return scope
    }
  }))
  const evidenceRoute = options.projectPlatform ? "host-project" : "standalone-unbound"
  const ruleInstall = options.rulesRoot ?? join(root, "installed-rules")
  if (!options.rulesRoot)
    await cp(resolve("resources/native-compositions/autobiz-rules"), ruleInstall, {
      recursive: true
    })
  const providerPlugins = [
    {
      id: options.providerId ?? "rules",
      name: "autobiz-native-rules",
      path: ruleInstall,
      enabled: true
    }
  ]
  if (options.repositories) {
    const knowledgeInstall = join(root, "installed-knowledge")
    await cp(resolve("resources/native-compositions/autobiz-knowledge"), knowledgeInstall, {
      recursive: true
    })
    providerPlugins.push({
      id: "knowledge",
      name: "autobiz-native-knowledge",
      path: knowledgeInstall,
      enabled: true
    })
  }
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
  let executionResources: RuntimeExecutionResources | undefined
  if (options.repositories) {
    const source = nativeCompositionSchema.parse(
      JSON.parse(
        await readFile(
          resolve("resources/native-compositions/autobiz-variants/multirepo-source.json"),
          "utf8"
        )
      )
    )
    const compiled = compileNativeComposition(source, {
      files: readNativeCompositionFiles(profileRoot, source),
      actionCatalog: await manager.actionCatalog(workspace, threadId)
    })
    const retained = join(root, "retained-multirepo")
    for (const file of compiled.files) {
      const path = join(retained, file.path)
      await mkdir(resolve(path, ".."), { recursive: true })
      await writeFile(path, file.bytes)
    }
    executionResources = readRetainedExecutionResources(retained, (binding) => {
      expect(binding).toBe("secondaryRepository")
      return secondary!
    })
    profiles = executionResources!.profiles
  }
  const descriptor = (await manager.actionCatalog(workspace, threadId)).find(
    (action) => action.actionId === "plan"
  )!
  if (options.expectedProviderDigest) expect(descriptor.digest).toBe(options.expectedProviderDigest)
  const rulesProvider = {
    pluginId: descriptor.pluginId,
    plugin: descriptor.plugin,
    digest: descriptor.digest
  }
  const args = { rulesProvider },
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
  if (options.performanceOnly) {
    const receipts: Array<Awaited<ReturnType<typeof runner>>> = []
    const worktree = createWorkflowWorktreeResourceRunner(ledger, parentIdentity, () =>
      controller.signal.throwIfAborted()
    )
    for (const blocked of [true, false]) {
      const resourceId = blocked ? "performance-blocked" : "performance-clean"
      const resource = await worktree({ op: "acquire", resourceId }, undefined, controller.signal)
      if (typeof resource.handle !== "string" || typeof resource.headCommit !== "string")
        throw Error("PERFORMANCE_FIXTURE_RESOURCE_INVALID")
      const handle = resource.handle
      const baselineCommit = resource.headCommit
      await ledger.useResource(handle, async (info) => {
        await writeFile(
          join(info.workspaceDirectory, "test_performance.js"),
          blocked
            ? "fetch('fixture-private-url')\nfetch('fixture-private-url')\n"
            : "export const value = 42\n"
        )
        await writeFile(
          join(info.workspaceDirectory, "test_performance.py"),
          "import unittest\nclass PerformanceBoundary(unittest.TestCase):\n def test_value(self):\n  self.assertEqual(2 + 2, 4)\n"
        )
      })
      await ledger.commitResourceChanges(handle, baselineCommit)
      const current = await worktree({ op: "inspect", resourceId }, undefined, controller.signal)
      const argv = ["python", "-B", "-m", "unittest", "test_performance.py"]
      const request = {
        stepId: blocked ? "performance-blocked" : "performance-clean",
        resourceHandle: handle,
        provider: { ...rulesProvider, actionId: "validate-command" },
        input: {
          phase: "test",
          workspaceRef: "default",
          taskIds: ["T001"],
          baselineCommit,
          expectedCommit: current.headCommit,
          argv
        }
      }
      const before = processes.length
      const receipt = await runner(request, undefined, controller.signal)
      expect(receipt, JSON.stringify(receipt)).toMatchObject({
        status: blocked ? "failed" : "succeeded",
        output: { passed: !blocked, performance: { passed: !blocked } }
      })
      const output = receipt.output as {
        performance: {
          errors: Array<{ code: string; path: string; line: number }>
          files: Array<{ path: string; sha256: string; bytes: number }>
        }
      }
      expect(output.performance.files).toEqual([
        expect.objectContaining({ path: "test_performance.js", sha256: expect.any(String) })
      ])
      if (blocked) {
        expect(output.performance.errors).toEqual([
          { code: "FRONT-RULE007", path: "test_performance.js", line: 1 },
          { code: "FRONT-RULE007", path: "test_performance.js", line: 2 }
        ])
      } else expect(output.performance.errors).toEqual([])
      expect(JSON.stringify(receipt)).not.toContain("fixture-private-url")
      expect(JSON.stringify(receipt)).not.toContain("fetch(")
      expect(
        processes.slice(before).filter((value) => JSON.stringify(value) === JSON.stringify(argv))
      ).toHaveLength(blocked ? 0 : 1)
      const after = processes.length
      expect(await runner(request, undefined, controller.signal)).toEqual(receipt)
      expect(processes).toHaveLength(after)
      receipts.push(receipt)
    }
    return { runId: runStore.state.runId, result: receipts, evidenceRoute }
  }
  const maven = resolveFixtureExecutable({
    name: "Maven",
    overrideEnv: "AUTOBIZ_TEST_MAVEN",
    homeEnvs: ["MAVEN_HOME", "M2_HOME"],
    commands: process.platform === "win32" ? ["mvn.cmd", "mvn.bat", "mvn.exe"] : ["mvn"]
  }).replace(/\\/g, "/")
  const authored: Array<{ label: string; handle: string; cwd: string }> = []
  const author: WorkflowSubagentRunner = async (request) =>
    ledger.useResource(
      request.resourceHandle!,
      async (info) => {
        const cwd = info.workspaceDirectory
        authored.push({ label: request.label, handle: request.resourceHandle!, cwd })
        const batchId = /^B\d{3}/.exec(request.label)?.[0]
        const className = options.repositories && batchId ? "Orders" + batchId : "Orders"
        expect(request.shellAccess).toBe("none")
        expect(request.toolAllowlist).toBeDefined()
        let structured: Record<string, unknown>
        if (request.label.endsWith("-ut-diagnosis-1")) {
          expect(request.prompt).toContain("failedExecutionId")
          expect(request.prompt).toContain("taskDigest")
          structured = {
            kind: options.utFailure,
            reason: "Deterministic fixture diagnosis of the actual nonzero test receipt"
          }
        } else if (
          request.label.endsWith("-implement") ||
          request.label.endsWith("-source-repair")
        ) {
          await mkdir(join(cwd, "src/main/java"), { recursive: true })
          await writeFile(
            join(cwd, "src/main/java/" + className + ".java"),
            "public class " +
              className +
              ' { public static void main(String[] args) { if(args.length != 1 || !args[0].equals("42")) { System.err.println("ORDER_NOT_FOUND"); System.exit(' +
              (options.utFailure === "source_bug" && request.label.endsWith("-implement")
                ? "1"
                : "2") +
              '); } System.out.println("42"); } }'
          )
          structured = {
            compileArgv: [maven, "-q", "-o", "compile"]
          }
        } else if (request.label.endsWith("-review")) structured = { verdict: "pass", findings: [] }
        else {
          const final = request.label.endsWith("-e2e-author"),
            name = final
              ? "test_e2e.py"
              : options.repositories
                ? "test_" + batchId!.toLowerCase() + ".py"
                : "test_orders.py"
          const classes =
            final && options.repositories
              ? [
                  ...new Set(
                    authored
                      .filter((item) => item.cwd === cwd && item.label.endsWith("-implement"))
                      .map((item) => "Orders" + /^B\d{3}/.exec(item.label)![0])
                  )
                ]
              : [className]
          await writeFile(
            join(cwd, name),
            `import unittest,subprocess,time\nCLASSES=${JSON.stringify(classes)}\nclass OrdersTests(unittest.TestCase):\n def test_each_task(self):\n  for class_name in CLASSES:\n   with self.subTest(task=class_name):\n    started=time.monotonic()\n    result=subprocess.run(["java","-cp","target/classes",class_name,"42"],capture_output=True,text=True)\n    self.assertEqual(result.returncode,0)\n    self.assertEqual(result.stdout.strip(),"42")\n    self.assertLess(time.monotonic()-started,2)\n    result=subprocess.run(["java","-cp","target/classes",class_name,"missing"],capture_output=True,text=True)\n    self.assertEqual(result.returncode,${options.utFailure === "test_bug" && request.label.endsWith("-test-author") ? 1 : 2})\n    self.assertIn("ORDER_NOT_FOUND",result.stderr)\n`
          )
          structured = {
            argv: ["python", "-B", "-m", "unittest", name]
          }
        }
        return { text: JSON.stringify(structured), structured, outputTokens: 1 }
      },
      request.deadlineBudgetId
    )
  const began = Date.now()
  console.info(
    `[AutoBiz Code integration] start ${options.repositories ?? "single"}/${options.utFailure ?? "passing"}`
  )
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
  if (options.repositories === "unbound") {
    expect(outcome.status, JSON.stringify(outcome)).toBe("error")
    expect(JSON.stringify(outcome)).toContain("UNAUTHORIZED")
    expect(authored).toHaveLength(0)
    expect(approvals).toHaveLength(0)
    expect(git(workspace, "ls-files")).not.toContain("Orders")
    expect(git(secondary!, "ls-files")).not.toContain("Orders")
    return { runId: runStore.state.runId, result: outcome.result, evidenceRoute }
  }
  const repositoryCount = options.repositories ? 2 : 1
  const batchCount = options.repositories === "dependent" ? 3 : options.repositories ? 2 : 1
  expect(outcome, JSON.stringify(outcome)).toMatchObject({
    status: "completed",
    result: { status: "succeeded" }
  })
  expect(approvals).toHaveLength(repositoryCount)
  expect(processes.filter((argv) => argv[0] === maven)).toHaveLength(
    batchCount + repositoryCount + (options.utFailure === "source_bug" ? 1 : 0)
  )
  expect(
    processes.filter((argv) => argv.includes("unittest") && !argv.includes("test_e2e.py"))
  ).toHaveLength(batchCount + (options.utFailure ? 1 : 0))
  expect(processes.filter((argv) => argv.includes("test_e2e.py"))).toHaveLength(repositoryCount)
  if (options.repositories) {
    const first = authored.find((item) => item.label === "B001-implement")!
    const second = authored.find((item) => item.label === "B002-implement")!
    expect(first.handle).not.toBe(second.handle)
    expect(first.cwd).not.toBe(second.cwd)
    // A different repository's real promoted SHA cannot authorize this repository's scope.
    await expect(
      ledger.useVerificationResource(
        first.handle,
        git(secondary!, "rev-parse", "HEAD"),
        () => controller.signal.throwIfAborted(),
        async () => {
          throw Error("CROSS_REPOSITORY_VERIFICATION_MUST_NOT_DISPATCH")
        }
      )
    ).rejects.toThrow("WORKTREE_VERIFICATION_NOT_PROMOTED")
    expect(git(workspace, "ls-files")).toContain("OrdersB001.java")
    expect(git(workspace, "ls-files")).not.toContain("OrdersB002.java")
    expect(git(secondary!, "ls-files")).toContain("OrdersB002.java")
    expect(git(secondary!, "ls-files")).not.toContain("OrdersB001.java")
    if (options.repositories === "dependent") {
      const third = authored.find((item) => item.label === "B003-implement")!
      expect(third.handle).toBe(first.handle)
      expect(authored.indexOf(first)).toBeLessThan(authored.indexOf(second))
      expect(authored.indexOf(second)).toBeLessThan(authored.indexOf(third))
      expect(git(workspace, "ls-files")).toContain("OrdersB003.java")
      expect(git(secondary!, "ls-files")).not.toContain("OrdersB003.java")
    }
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
  if (options.verifyOps === false) return { runId: runStore.state.runId, result: outcome.result, evidenceRoute }
  const codeRunner = createWorkflowDeterministicActionRunner(dependencies, {
    workspace,
    threadId,
    incarnation,
    runId: runStore.state.runId + "_check",
    scriptSha256: parentIdentity,
    signal: controller.signal,
    assertCurrent: () => {}
  })
  const code = await codeRunner(
    {
      stepId: "host-code-evidence",
      provider: { ...rulesProvider, actionId: "code" },
      config: { nativeCompositionProvider: { ...rulesProvider, actionId: "code" } },
      input: { feature: "orders", runId: runStore.state.runId }
    },
    undefined,
    controller.signal
  )
  console.info(`[AutoBiz Code integration] evidence ${code.status} after ${Date.now() - began}ms`)
  expect(code).toMatchObject({ status: "succeeded", output: { passed: true } })
  if (!options.projectPlatform) expect(unboundProjectReads).toBeGreaterThan(0)
  if (options.verifyRelease === false)
    return { runId: runStore.state.runId, result: outcome.result, evidenceRoute }
  await writeFile(
    join(workspace, "CODE_RESULT.json"),
    JSON.stringify({ feature: "orders", runId: runStore.state.runId })
  )
  const cicd = {
    feature: "orders",
    stage: "cicd",
    codeRunId: runStore.state.runId,
    publication: { mode: "not-requested", status: "prepared-only" },
    files: {
      "CICD_CHECKLIST.md":
        "## 交付范围\n订单查询；PRD.bundle.json / SPECS.bundle.json / DESIGN.bundle.json\n## 验证证据\n" +
        runStore.state.runId +
        "\n## 发布状态\n未请求外部发布 prepared-only\n## 已知阻断问题\n外部流水线未绑定\n## 回滚计划\n保留集成SHA并经用户确认后回滚\n",
      "PR_BODY.md": "订单查询：正常/缺失订单行为及2秒约束已经真实测试；尚未请求外部发布。"
    }
  }
  const checkOps = (stepId: string, actionId: string, input: Record<string, unknown>) =>
    codeRunner(
      {
        stepId,
        provider: { ...rulesProvider, actionId },
        config: { nativeCompositionProvider: { ...rulesProvider, actionId } },
        input
      },
      undefined,
      controller.signal
    )
  expect(await checkOps("cicd-check", "cicd", cicd)).toMatchObject({
    status: "succeeded",
    output: { passed: true, publicationStatus: "prepared-only" }
  })
  expect(
    await checkOps("cicd-external-unknown", "cicd", {
      ...cicd,
      publication: { mode: "external", status: "unknown" }
    })
  ).toMatchObject({ status: "failed", output: { passed: false } })
  await writeFile(join(workspace, "CICD.bundle.json"), JSON.stringify(cicd))
  const files: Record<string, string> = {},
    artifactDigests: Record<string, string> = {}
  for (const name of [...names, "CODE_RESULT.json", "CICD.bundle.json"]) {
    files[name] = await readFile(join(workspace, name), "utf8")
    artifactDigests[name] = createHash("sha256").update(files[name]).digest("hex")
  }
  const archive = {
    feature: "orders",
    stage: "archive",
    publicationStatus: "prepared-only",
    files,
    artifactDigests
  }
  expect(await checkOps("archive-check", "archive", archive)).toMatchObject({
    status: "succeeded",
    output: { passed: true }
  })
  expect(
    await checkOps("archive-source-changed", "archive", {
      ...archive,
      files: { ...files, "PRD.bundle.json": "{}" }
    })
  ).toMatchObject({ status: "failed", output: { passed: false } })

  return { runId: runStore.state.runId, result: outcome.result, evidenceRoute }
}
