import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import AdmZip from "adm-zip"
import { afterEach, expect, it, vi } from "vitest"
import { snapshotDerivationSource, writeDerivationFiles } from "../../plugins/derivation-source"
import type { CompositionInternalProject } from "./composition-internal-projects"
import {
  AUTOBIZ_STAGE_CHECK_DECLARATION,
  readAutobizCompositionContracts,
  transitionAutobizComposition
} from "./composition-autobiz-bridge"
import { runtimeDigest } from "./safe-files"
import { createAutobizSampleContext } from "../../../../tests/support/autobiz-creator-context-sample"
import { runAutobizSampleWorkflow } from "../../../../tests/support/autobiz-creator-workflow-sample"
import { closeRequiredPromptFixtures } from "../../agent/required-prompt-context.test-helper"

const storage = vi.hoisted(() => ({ root: "" }))
vi.mock("../../storage", () => ({ getOpenworkDir: () => storage.root }))
const execute = promisify(execFile)
const original = process.env.AUTOBIZ_BUSINESS_SOURCE
const library = resolve(
  process.env.AUTOBIZ_CREATOR_DEMO_LIBRARY ?? "output/deliveries/mods-creator-accepted-20261017"
)
const archive = join(library, "10-完整AutoBiz+并行进度+知识版.zip")
const sample = resolve("tests/support/autobiz-creator-lifecycle-sample.py")
const codeSample = resolve("tests/support/autobiz-creator-code-sample.py")
afterEach(async () => {
  await closeRequiredPromptFixtures()
  vi.unstubAllEnvs()
})

// Original Python, stage checks, source CAS and two-file state commits are real.
// Sample authorship is controlled; it does not claim enterprise/model acceptance.
it.skipIf(!original || !existsSync(archive))(
  "keeps actual current AutoBiz stage inputs and original checks continuous in the full composed plugin",
  async () => {
    const root = resolve("output/mods-s2-s5-20261017/autobiz-full-journey", `run-${randomUUID()}`)
    await mkdir(root, { recursive: true })
    // Keep native Python staging under a normal short application-data path on Windows.
    storage.root = await mkdtemp(join(tmpdir(), "abj-"))
    vi.stubEnv("CMB_COWORK_AGENT_HOME", storage.root)
    const upstream = await snapshotDerivationSource(original!)
    const results: unknown[] = []
    for (const kind of ["original", "composed"] as const) {
      const caseRoot = join(storage.root, kind)
      const source = join(caseRoot, "plugin")
      if (kind === "original") await writeDerivationFiles(source, upstream.files)
      else {
        const entries = new AdmZip(archive).getEntries().filter((entry) => !entry.isDirectory)
        const manifest = entries.find((entry) => /(?:^|\/)plugin\.json$/.test(entry.entryName))!
        const prefix = manifest.entryName.slice(0, -"plugin.json".length)
        await writeDerivationFiles(
          source,
          entries.map((entry) => {
            expect(entry.entryName.startsWith(prefix)).toBe(true)
            const bytes = entry.getData()
            return {
              path: entry.entryName.slice(prefix.length),
              bytes,
              mode: 0o644,
              digest: createHash("sha256").update(bytes).digest("hex")
            }
          })
        )
      }
      if (!existsSync(join(source, "devclaw.stage-checks.json")))
        await writeFile(
          join(source, "devclaw.stage-checks.json"),
          JSON.stringify(AUTOBIZ_STAGE_CHECK_DECLARATION)
        )
      const before = await snapshotDerivationSource(source)
      const parent = join(caseRoot, "workspace")
      const workspace = join(parent, "project")
      await mkdir(workspace, { recursive: true })
      const python = async (args: string[]) =>
        execute("python", ["-I", "-B", "-X", "utf8", ...args], {
          cwd: source,
          windowsHide: true,
          timeout: 120_000,
          maxBuffer: 2 * 1024 * 1024,
          env: {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: "1",
            PLUGIN_WORKSPACE: parent,
            PROJECT_DIR: "project",
            FEATURE_ID: "alpha",
            SESSION_WORKSPACE_PATH: workspace
          }
        })
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
          "project",
          ...extra
        ])
      const knowledge = await createAutobizSampleContext(source, workspace, caseRoot)
      const code = async (action: string, batch?: string) => {
        const result = await python([
          codeSample,
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
          kind === "composed" ? "true" : "false",
          ...(batch ? ["--batch-id", batch] : [])
        ])
        return JSON.parse(result.stdout)
      }
      const prepare = async (action: string) => {
        const result = await python([
          sample,
          action,
          "--plugin-root",
          source,
          "--workspace",
          workspace,
          "--feature",
          "alpha"
        ])
        const marker = result.stdout
          .split(/\r?\n/)
          .find((line) => line.startsWith("SAMPLE_RESULT="))
        if (!marker) throw Error(result.stdout + result.stderr)
        return JSON.parse(marker.slice("SAMPLE_RESULT=".length))
      }
      const metadata = await prepare("metadata")
      expect(metadata.nodes).toEqual([
        "biz.prd",
        "dev.specs",
        "dev.design",
        "dev.plan",
        "dev.code",
        "ops.cicd",
        "ops.archive"
      ])
      const record = {
        projectId: kind,
        parentProjectId: "parent",
        compositionRunId: kind,
        unitId: "unit",
        featureId: "alpha",
        workspace,
        packageDigest: before.digest,
        plugin: { path: source },
        goal: "Controlled backend-only computation"
      } as CompositionInternalProject
      const contracts = await readAutobizCompositionContracts(record)
      const state = join(workspace, ".autobizdevops/state.json")
      const observed: unknown[] = []
      const advance = async (checkpoint: string) => {
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
        observed.push({ checkpoint, ...result })
        await writeFile(join(root, `${kind}-progress.json`), JSON.stringify(observed, null, 2))
        return result
      }
      for (const [id, action] of [
        ["prd", "prd"],
        ["specs", "specs"],
        ["design", "design"]
      ]) {
        const current = JSON.parse(await readFile(state, "utf8")).features.alpha.checkpoint
        if (current !== `${id}_in_progress`)
          expect(await advance(`${id}_in_progress`)).toMatchObject({ status: "committed" })
        const prior = await readFile(state)
        expect(await advance(`${id}_done`)).toMatchObject({ status: "not-applied" })
        expect(await readFile(state)).toEqual(prior)
        await prepare(action)
        const completed = await advance(`${id}_done`)
        expect(completed, JSON.stringify(completed)).toMatchObject({ status: "committed" })
        expect(completed.receipts.length).toBeGreaterThan(0)
      }
      expect(await advance("plan_in_progress")).toMatchObject({ status: "committed" })
      const missingPlan = await readFile(state)
      expect(await advance("plan_done")).toMatchObject({ status: "not-applied" })
      expect(await readFile(state)).toEqual(missingPlan)
      const planned = await code("prepare")
      expect(planned.knowledgeSha256).toBe(
        createHash("sha256").update(knowledge.text).digest("hex")
      )
      const planDone = await advance("plan_done")
      expect(planDone, JSON.stringify(planDone)).toMatchObject({ status: "committed" })
      // An explicit controlled choice uses the original dynamic-choice command, not a
      // flattened route or a manually edited state. S6 rollback is not involved.
      await python([
        join(source, "hooks/update_checkpoint.py"),
        "--feature",
        "alpha",
        "--checkpoint",
        "code_in_progress",
        "--workflow-decision",
        "detail_design_before_code=skipped",
        "--json"
      ])
      const chosen = JSON.parse(await readFile(state, "utf8")).features.alpha
      expect(chosen.checkpoint).toBe("code_in_progress")
      expect(chosen.workflowDecisions.detail_design_before_code).toBe("skipped")
      const beforeCode = await readFile(state)
      expect(await advance("code_done")).toMatchObject({ status: "not-applied" })
      expect(await readFile(state)).toEqual(beforeCode)
      const executed = await runAutobizSampleWorkflow({
        workspace,
        text: knowledge.text,
        evidence: join(root, `${kind}-workflow.json`),
        code
      })
      expect(executed.passed).toBe(true)
      expect(executed.deliveries).toHaveLength(2)
      if (kind === "original")
        expect(
          executed.observerSnapshots.every(
            (snapshot) =>
              !!snapshot &&
              typeof snapshot === "object" &&
              "available" in snapshot &&
              snapshot.available === false
          )
        ).toBe(true)
      else expect(executed.observerSnapshots.length).toBeGreaterThan(3)
      const codeDone = await advance("code_done")
      if (kind === "original") {
        // Keep the discovered upstream defect reproducible. The portable corrected
        // kernel is a separately reviewed version; do not waive the old Code gate.
        expect(codeDone).toMatchObject({ status: "not-applied" })
        expect(codeDone.message).toContain("plan_json_status_not_done")
        expect(JSON.parse(await readFile(state, "utf8")).features.alpha.checkpoint).toBe(
          "code_in_progress"
        )
        expect((await snapshotDerivationSource(source)).digest).toBe(before.digest)
        results.push({
          kind,
          sourceDigest: before.digest,
          knowledgeSha256: planned.knowledgeSha256,
          nativeWorkflowEvidence: `${kind}-workflow.json`,
          expectedOriginalDefect: codeDone,
          observed
        })
        continue
      }
      expect(codeDone, JSON.stringify(codeDone)).toMatchObject({ status: "committed" })
      expect(await advance("cicd_in_progress")).toMatchObject({ status: "committed" })
      expect(await advance("cicd_done")).toMatchObject({ status: "not-applied" })
      await prepare("cicd")
      expect(await advance("cicd_done")).toMatchObject({ status: "committed" })
      const archived = await advance("archived")
      expect(archived, JSON.stringify(archived)).toMatchObject({ status: "committed" })
      expect(JSON.parse(await readFile(state, "utf8")).features.alpha.checkpoint).toBe("archived")
      expect((await snapshotDerivationSource(source)).digest).toBe(before.digest)
      results.push({
        kind,
        sourceDigest: before.digest,
        knowledgeSha256: planned.knowledgeSha256,
        nativeWorkflowEvidence: `${kind}-workflow.json`,
        observed
      })
    }
    expect((await snapshotDerivationSource(original!)).digest).toBe(upstream.digest)
    await writeFile(
      join(root, "evidence.json"),
      JSON.stringify(
        {
          passed: true,
          scope:
            "Original reproducible Code completion refusal and separately reviewed corrected composed kernel PRD to Archive, protected knowledge, actual native workflow and two real worktrees",
          results,
          originalSourceUnchanged: true,
          stageDebugDeveloped: false,
          limits:
            "Controlled sample authorship, model responses and source review; real original writers, checks, Git, tests and evidence. No enterprise business acceptance or remote model quality claim."
        },
        null,
        2
      )
    )
  },
  300_000
)
