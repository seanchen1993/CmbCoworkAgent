import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, it, vi } from "vitest"
import type { HookConfig, HookEvent } from "../../hooks/types"
import type { PluginMetadata } from "../../types"
import { snapshotDerivationSource } from "../../plugins/derivation-source"
import { parsePluginHooks } from "../../storage"
import { runHooks } from "../../hooks/runner"
import { createAutobizSampleContext } from "../../../../tests/support/autobiz-creator-context-sample"
import { runAutobizSampleWorkflow } from "../../../../tests/support/autobiz-creator-workflow-sample"
import { closeRequiredPromptFixtures } from "../../agent/required-prompt-context.test-helper"
import { readAutobizCompositionContracts } from "./composition-autobiz-bridge"
import type { CompositionInternalProject } from "./composition-internal-projects"
import { runOriginalAutobizFixedWorkflow } from "../../../../tests/support/autobiz-original-fixed-workflow"

import { createAutobizFunctionStateGuest } from "../../../../tests/support/autobiz-function-state-guest"

const activeStateGuests: Array<Awaited<ReturnType<typeof createAutobizFunctionStateGuest>>> = []
const local = vi.hoisted(() => ({ data: "" }))
vi.mock("../../storage", async (original) => ({
  ...(await original<typeof import("../../storage")>()),
  getOpenworkDir: () => local.data,
  getHookLoggingConfig: () => ({ diagnostic: false }),
  getUserInfo: () => undefined
}))
vi.mock("../../mods/manager", () => ({ getModsManager: () => undefined }))
vi.mock("../../hooks/log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../../services/event-reporter", () => ({ trackEvent: vi.fn() }))
const execute = promisify(execFile)
const delivery = resolve(
  process.env.AUTOBIZ_FUNCTION_STATE_DELIVERY ??
    "output/deliveries/autobiz-function-state-20261021-root-r7"
)
afterEach(async () => {
  for (const guest of activeStateGuests.splice(0)) await guest.close()
  await closeRequiredPromptFixtures()
  vi.unstubAllEnvs()
})

/** Genuine original scripts, native Hooks, stage CAS, validators, knowledge and Git worktrees.
 * Sample artifacts and model responses are deterministic; no remote model quality is claimed.
 */
it.runIf(
  process.env.RUN_AUTOBIZ_FUNCTION_STATE_FULL_GRAPH === "1" &&
    existsSync(join(delivery, "complete-plugin/plugin.json"))
)(
  "runs the new Function state adapter across the full original fixed workflow and real artifact gates",
  async () => {
    const source = join(delivery, "complete-plugin")
    const sourceBefore = await snapshotDerivationSource(source)
    const report = JSON.parse(
      await readFile(join(delivery, "function-state-conversion.json"), "utf8")
    )
    expect(sourceBefore.digest).toBe(report.packageDigest)
    const root = resolve("output/autobiz-function-state-journey", randomUUID())
    await mkdir(root, { recursive: true })
    // Keep real Git/Python paths short; preserve evidence instead of deleting the accepted run.
    local.data = await mkdtemp(join(tmpdir(), "abo-"))
    vi.stubEnv("CMB_COWORK_AGENT_HOME", local.data)
    vi.stubEnv("PYTHONDONTWRITEBYTECODE", "1")
    const parent = join(local.data, "projects"),
      workspace = join(parent, "sample")
    await mkdir(workspace, { recursive: true })
    const metadata = JSON.parse(await readFile(join(source, "plugin.json"), "utf8"))
    const plugin = {
      id: "actual-original-zip",
      path: source,
      name: metadata.name,
      version: metadata.version,
      enabled: true
    } as PluginMetadata
    const hooks = parsePluginHooks(plugin)
    expect(hooks.length).toBeGreaterThan(10)
    const observations: unknown[] = [],
      hookResults: unknown[] = []
    const save = async () =>
      writeFile(
        join(root, "progress.json"),
        JSON.stringify(
          { workspace, packageDigest: sourceBefore.digest, observations, hookResults },
          null,
          2
        )
      )
    const runHook = async (
      event: HookEvent,
      toolName: string,
      toolArgs: Record<string, unknown>,
      toolResult?: string,
      extra: HookConfig[] = []
    ) => {
      const result = await runHooks(
        [...hooks, ...extra],
        event,
        {
          sessionId: "original-234-stage-journey",
          workspacePath: workspace,
          hookSourceType: "plugin",
          hookSourceRoot: source,
          pluginRoot: source,
          pluginId: plugin.id,
          pluginName: plugin.name,
          pluginWorkspace: parent,
          projectDir: "sample",
          featureId: "alpha",
          toolName,
          toolArgs,
          ...(toolResult !== undefined ? { toolResult } : {})
        },
        (seenEvent, hook, outcome) => {
          hookResults.push({
            event: seenEvent,
            id: hook.id,
            command: hook.command,
            exitCode: outcome.exitCode,
            stdout: outcome.rawStdout ?? outcome.stdout,
            stderr: outcome.stderr
          })
        }
      )
      await save()
      if (
        result?.blocked ||
        result?.decision === "block" ||
        result?.continue === false ||
        (result?.exitCode !== undefined && result.exitCode !== null && result.exitCode !== 0)
      )
        throw Error(`ORIGINAL_NATIVE_HOOK_REJECTED:${event}:${toolName}:${JSON.stringify(result)}`)
      return result
    }
    const python = async (args: string[], nativeHooks = false) => {
      const toolArgs = {
        command: ["python -I -B -X utf8", ...args.map((arg) => JSON.stringify(arg))].join(" ")
      }
      if (nativeHooks) await runHook("PreToolUse", "execute", toolArgs)
      const result = await execute("python", ["-I", "-B", "-X", "utf8", ...args], {
        cwd: source,
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: "1",
          PLUGIN_WORKSPACE: parent,
          PROJECT_DIR: "sample",
          FEATURE_ID: "alpha",
          SESSION_WORKSPACE_PATH: workspace
        }
      }).catch(async (error: Error & { stdout?: string; stderr?: string }) => {
        await writeFile(
          join(root, `python-failure-${randomUUID()}.json`),
          JSON.stringify({ args, stdout: error.stdout, stderr: error.stderr }, null, 2)
        )
        throw error
      })
      if (nativeHooks) await runHook("PostToolUse", "execute", toolArgs, result.stdout)
      return result
    }
    for (const [mode, extra] of [
      ["createProject", []],
      ["createFeature", ["--feature", "alpha"]]
    ] as const)
      await python([
        join(source, "hooks/init_workspace.py"),
        "--mode",
        mode,
        "--workspace",
        parent,
        "--project",
        "sample",
        ...extra
      ])
    const knowledge = await createAutobizSampleContext(source, workspace, root)
    const note = join(workspace, "acceptance-notes.md")
    const noteArgs = {
      file_path: note,
      content: "Controlled acceptance; preserve original checks.\n"
    }
    await runHook("PreToolUse", "write_file", noteArgs)
    await writeFile(note, noteArgs.content)
    await runHook("PostToolUse", "write_file", noteArgs, "Written")
    await runHook("PreToolUse", "read_file", { file_path: knowledge.file })
    await runHook("PostToolUse", "read_file", { file_path: knowledge.file }, knowledge.text)
    // Deterministic read-only child work crosses the original task Hook contract.
    const exploration = {
      subagent_type: "Explore-autodev-spec",
      description: "Read the supplied knowledge and report its actual rules; perform no writes."
    }
    await runHook("PreToolUse", "task", exploration)
    const explored = await readFile(join(root, "knowledge/LA64/AGENTS.md"), "utf8")
    expect(explored).toContain("CREATOR_KNOWLEDGE_MUST_SURVIVE")
    await runHook(
      "PostToolUse",
      "task",
      exploration,
      JSON.stringify({ source: "LA64/AGENTS.md", actualRules: explored, writes: false })
    )
    const state = join(workspace, ".autobizdevops/state.json")
    const record = {
      projectId: "original234",
      parentProjectId: "native",
      compositionRunId: "sample234",
      unitId: "whole",
      featureId: "alpha",
      workspace,
      packageDigest: sourceBefore.digest,
      plugin,
      goal: "Two integer functions with actual original gates"
    } as CompositionInternalProject
    const contracts = await readAutobizCompositionContracts(record)
    expect(contracts.length).toBeGreaterThan(5)
    const stateGuest = await createAutobizFunctionStateGuest(source, workspace, {
      designAnswer: () => "确认技术设计并推进"
    })
    activeStateGuests.push(stateGuest)
    let operationSequence = 0
    const adapter = async (request: Record<string, unknown>) => {
      const args = [
        "-I",
        "-B",
        "-X",
        "utf8",
        join(source, "mods/business/autobiz.state-machine/adapter.py")
      ]
      const toolArgs = {
        command: ["python", ...args.map((value) => JSON.stringify(value))].join(" "),
        stdin: JSON.stringify({
          apiVersion: "autobiz.function-state/v1",
          feature: "alpha",
          ...request
        })
      }
      await runHook("PreToolUse", "execute", toolArgs)
      const operation = String(request.operation)
      const command =
        operation === "read"
          ? "autobiz-state-read"
          : operation === "prepare"
            ? "autobiz-state-check"
            : operation === "reconcile"
              ? "autobiz-state-reconcile"
              : "autobiz-state-advance"
      const commandArgs =
        operation === "read"
          ? "alpha"
          : operation === "reconcile"
            ? "alpha " + request.requestKey
            : operation === "prepare"
              ? "alpha " + request.to
              : ["alpha", request.to, request.expectedStateDigest, request.requestKey].join(" ")
      const value = await stateGuest.command(command, commandArgs)
      await runHook("PostToolUse", "execute", toolArgs, JSON.stringify(value))
      return value
    }
    const advance = async (checkpoint: string) => {
      const before = await adapter({ operation: "read" })
      const record = before.record
      if (
        !record ||
        typeof record !== "object" ||
        Array.isArray(record) ||
        typeof record.checkpoint !== "string"
      )
        throw Error("AUTOBIZ_STATE_READ_CHECKPOINT_REQUIRED")
      const request = {
        operation: "advance",
        from: record.checkpoint,
        to: checkpoint,
        expectedStateDigest: before.stateDigest,
        requestKey: "full-graph-" + ++operationSequence
      }
      const result = await adapter(request)
      if (result.status === "committed") {
        const after = await readFile(state)
        expect(await adapter(request)).toMatchObject({ status: "committed", duplicate: true })
        expect(
          await adapter({ operation: "reconcile", requestKey: request.requestKey })
        ).toMatchObject({ status: "committed" })
        expect(await readFile(state)).toEqual(after)
      }
      observations.push({ checkpoint, result })
      await save()
      return result
    }
    const prepare = async (action: string) => {
      const result = await python(
        [
          resolve("tests/support/autobiz-creator-lifecycle-sample.py"),
          action,
          "--plugin-root",
          source,
          "--workspace",
          workspace,
          "--feature",
          "alpha"
        ],
        true
      )
      expect(result.stdout).toContain('"checksApproved": false')
    }
    for (const stage of ["prd", "specs", "design"]) {
      const checkpoint = JSON.parse(await readFile(state, "utf8")).features.alpha.checkpoint
      if (checkpoint !== `${stage}_in_progress`)
        expect(await advance(`${stage}_in_progress`)).toMatchObject({ status: "committed" })
      const unchanged = await readFile(state)
      expect(await advance(`${stage}_done`)).toMatchObject({ status: "not-applied" })
      expect(await readFile(state)).toEqual(unchanged)
      await prepare(stage)
      expect(await advance(`${stage}_done`)).toMatchObject({ status: "committed" })
    }
    expect(await advance("plan_in_progress")).toMatchObject({ status: "committed" })
    expect(await advance("plan_done")).toMatchObject({ status: "not-applied" })
    const code = async (action: string, batch?: string) => {
      const task = {
        subagent_type: "general-purpose",
        description: `Controlled original Code task ${batch}; keep actual compile, review and test gates`
      }
      if (action === "run-batch") await runHook("PreToolUse", "task", task)
      const receipt = JSON.parse(
        (
          await python([
            resolve("tests/support/autobiz-creator-code-sample.py"),
            action,
            "--plugin-root",
            source,
            "--workspace",
            workspace,
            "--feature",
            "alpha",
            "--knowledge-text-file",
            knowledge.file,
            "--expect-observer",
            "false",
            "--production-compile",
            "maven-java",
            ...(batch ? ["--batch-id", batch] : [])
          ])
        ).stdout
      )
      if (action === "run-batch")
        await runHook("PostToolUse", "task", task, JSON.stringify(receipt))
      return receipt
    }
    const planned = await code("prepare")
    expect(planned.knowledgeSha256).toBe(createHash("sha256").update(knowledge.text).digest("hex"))
    expect(await advance("plan_done")).toMatchObject({ status: "committed" })
    expect(await advance("code_in_progress")).toMatchObject({ status: "committed" })
    expect(await advance("code_done")).toMatchObject({ status: "not-applied" })
    let codeResult: unknown
    if (process.env.AUTOBIZ_ORIGINAL_WORKFLOW === "sample") {
      const executed = await runAutobizSampleWorkflow({
        workspace,
        text: knowledge.text,
        evidence: join(root, "workflow.json"),
        code
      })
      expect(executed.passed).toBe(true)
      codeResult = executed
    } else {
      const executed = await runOriginalAutobizFixedWorkflow({
        source,
        workspace,
        feature: "alpha",
        knowledge: knowledge.text,
        evidence: join(root, "original-fixed-workflow.json"),
        python,
        hook: (event, tool, args, result) => runHook(event, tool, args, result)
      })
      const verification = executed.terminal.verification as Record<string, unknown>
      const negative = JSON.parse(
        (
          await python([
            resolve("tests/support/autobiz-original-run-negative.py"),
            "--plugin-root",
            source,
            "--workspace",
            workspace,
            "--feature",
            "alpha",
            "--run-id",
            String(executed.terminal.runId)
          ])
        ).stdout
      )
      expect(negative).toMatchObject({ passed: true, originalNativeInputsUnchanged: true })
      expect(negative.results).toHaveLength(2)
      observations.push({ actualNativeBaselineTamperRejection: negative })
      const promotion = verification.mainPromotion as Record<string, unknown>
      expect(promotion.approvalDigest).toMatch(/^[a-f0-9]{64}$/)
      const confirmed = await python(
        [
          join(source, "hooks/parallel_integration.py"),
          "promote",
          "--workspace",
          workspace,
          "--feature",
          "alpha",
          "--run-id",
          String(executed.terminal.runId),
          "--approval-digest",
          String(promotion.approvalDigest),
          "--approved-by",
          "explicit-native-acceptance-fixture",
          "--confirm"
        ],
        true
      )
      const promoted = JSON.parse(confirmed.stdout)
      expect(promoted).toMatchObject({ success: true, status: "succeeded" })
      observations.push({
        nativeExplicitPromotion: promoted,
        approvalScope: "Controlled local test fixture only; no inherited user grant"
      })
      codeResult = { workflow: executed.terminal, promotion: promoted }
    }
    expect(await advance("code_done")).toMatchObject({ status: "committed" })
    expect(await advance("cicd_in_progress")).toMatchObject({ status: "committed" })
    expect(await advance("cicd_done")).toMatchObject({ status: "not-applied" })
    await prepare("cicd")
    expect(await advance("cicd_done")).toMatchObject({ status: "committed" })
    expect(await advance("archived")).toMatchObject({ status: "committed" })
    const archived = await python(
      [
        resolve("tests/support/autobiz-full-app-sample.py"),
        "archive",
        "--plugin-root",
        source,
        "--workspace",
        workspace,
        "--feature",
        "alpha"
      ],
      true
    )
    expect(archived.stdout).toContain('"sourceRemoved": true')
    expect(existsSync(join(workspace, ".autobizdevops/archive/alpha-iter1/PRD.md"))).toBe(true)
    expect(existsSync(join(workspace, ".autobizdevops/features/alpha"))).toBe(false)
    expect(stateGuest.questions).toHaveLength(1)
    const designQuestion = JSON.stringify(stateGuest.questions[0])
    expect(designQuestion).toContain("alpha")
    expect(designQuestion).toContain("design_done")
    expect(designQuestion).toMatch(/[a-f0-9]{64}/)
    const seen = new Set(hookResults.map((item) => (item as { id: string }).id))
    // Preserve each original declaration; conditional legacy CLI Hooks are reported separately,
    // not falsely attributed to the new adapter command.
    const conditionalUnseen = hooks
      .filter((hook) => !seen.has(hook.id))
      .map((hook) => {
        if (typeof hook.command !== "string") throw Error("AUTOBIZ_ORIGINAL_HOOK_COMMAND_REQUIRED")
        return hook.command
      })
    expect(
      conditionalUnseen.filter((command) => !command.includes("human_gate_design_done.py"))
    ).toEqual([])
    observations.push({ conditionalLegacyHooksNotInvokedByNewAdapter: conditionalUnseen })
    expect((await snapshotDerivationSource(source)).digest).toBe(sourceBefore.digest)
    await writeFile(
      join(root, "evidence.json"),
      JSON.stringify(
        {
          passed: true,
          packageDigest: sourceBefore.digest,
          sourceZipSha256: "df77bc7f59c77732586cbbf05582cad7447de3027818ad59734715108e89f184",
          workspace,
          observations,
          hookResults,
          stateModGuest: {
            processRequests: stateGuest.processRequests,
            designQuestions: stateGuest.questions,
            digest: stateGuest.digest
          },
          codeResult,
          knowledgeSha256: planned.knowledgeSha256,
          stage: "archived",
          limits:
            "Deterministic sample authorship/model responses and external app metadata; original scripts, native Hook runner, stage checks, real local Git worktrees and tests. No remote-model/enterprise acceptance claim."
        },
        null,
        2
      )
    )
  },
  900000
)
