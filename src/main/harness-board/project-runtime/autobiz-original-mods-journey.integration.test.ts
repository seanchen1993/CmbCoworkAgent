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
import {
  readAutobizCompositionContracts,
  transitionAutobizComposition
} from "./composition-autobiz-bridge"
import type { CompositionInternalProject } from "./composition-internal-projects"
import { runtimeDigest } from "./safe-files"
import { runOriginalAutobizFixedWorkflow } from "../../../../tests/support/autobiz-original-fixed-workflow"

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
  process.env.AUTOBIZ_ORIGINAL_MODS_DELIVERY ??
    "output/deliveries/autobiz-original-recovery-20261021-final-r8"
)
afterEach(async () => {
  await closeRequiredPromptFixtures()
  vi.unstubAllEnvs()
})

/** Genuine original scripts, native Hooks, stage CAS, validators, knowledge and Git worktrees.
 * Sample artifacts and model responses are deterministic; no remote model quality is claimed.
 */
it.runIf(existsSync(join(delivery, "complete-plugin/plugin.json")))(
  "runs the exact supplied 234-file AutoBiz through its original gates and composed Mods",
  async () => {
    const source = join(delivery, "complete-plugin")
    const sourceBefore = await snapshotDerivationSource(source)
    const report = JSON.parse(
      await readFile(join(delivery, "conversion-verification.json"), "utf8")
    )
    expect(report.sourceZipSha256).toBe(
      "df77bc7f59c77732586cbbf05582cad7447de3027818ad59734715108e89f184"
    )
    expect(sourceBefore.digest).toBe(report.packageDigest)
    const root = resolve("output/autobiz-original-journey", randomUUID())
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
    const advance = async (checkpoint: string) => {
      await python([join(source, "read_state_json.py"), "--feature", "alpha"], true)
      const toolArgs = {
        command: `python -X utf8 ${JSON.stringify(join(source, "hooks/update_checkpoint.py"))} --feature alpha --checkpoint ${checkpoint} --json`
      }
      const pre = await runHook("PreToolUse", "execute", toolArgs)
      if (checkpoint === "design_done") {
        expect(pre?.decision).toBe("human_gate")
        observations.push({
          checkpoint,
          humanGate: "requested",
          approval: "explicit deterministic test approval; no stored grant"
        })
      } else expect(pre?.decision).not.toBe("human_gate")
      const result = await transitionAutobizComposition(record, {
        checkpoint,
        expectedStateDigest: runtimeDigest(await readFile(state)),
        validateReceipts: async (receipts) => {
          for (const receipt of receipts) {
            expect(
              contracts.some(
                (contract) =>
                  contract.nodeId === receipt.nodeId &&
                  contract.checkId === receipt.checkId &&
                  contract.contractDigest === receipt.contractDigest
              )
            ).toBe(true)
            for (const artifact of receipt.artifacts)
              expect(runtimeDigest(await readFile(join(workspace, artifact.path)))).toBe(
                artifact.digest
              )
          }
        }
      })
      await runHook("PostToolUse", "execute", toolArgs, JSON.stringify(result))
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
    await python(
      [
        join(source, "hooks/update_checkpoint.py"),
        "--feature",
        "alpha",
        "--checkpoint",
        "code_in_progress",
        "--workflow-decision",
        "detail_design_before_code=skipped",
        "--json"
      ],
      true
    )
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
    const seen = new Set(hookResults.map((item) => (item as { id: string }).id))
    expect(hooks.filter((hook) => !seen.has(hook.id)).map((hook) => hook.command)).toEqual([])
    expect((await snapshotDerivationSource(source)).digest).toBe(sourceBefore.digest)
    await writeFile(
      join(root, "evidence.json"),
      JSON.stringify(
        {
          passed: true,
          packageDigest: sourceBefore.digest,
          sourceZipSha256: report.sourceZipSha256,
          workspace,
          observations,
          hookResults,
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
