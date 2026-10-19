/** Real pinned local lifecycle. No model, network, external repo, or business acceptance. */
import { expect, it, vi } from "vitest"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { withPinnedAutobiz } from "../../mods/v2/autobiz-source"
import type { CompositionInternalProject } from "./composition-internal-projects"
import type {
  StageCheckContract,
  StageCheckReceipt
} from "../../../shared/project-runtime/stage-check-receipt"
import { normalizeHarnessAdapterRun } from "../adapter-run-normalizer"
import { proveLegacyCompositionCompletion } from "./composition-legacy-proof"
import type {
  HarnessProjectMetadata,
  HarnessRunDetailViewModel,
  ManagedRunSnapshot,
  ManagedRunEvent
} from "../../../shared/harness-board-types"
import type { CompositionExecutionContext } from "./composition-coordinator"
import { runtimeDigest } from "./safe-files"
const storage = vi.hoisted(() => ({ root: "" }))
vi.mock("../../storage", () => ({ getOpenworkDir: () => storage.root }))
import {
  AUTOBIZ_STAGE_CHECK_DECLARATION,
  readAutobizCompositionContracts,
  transitionAutobizComposition
} from "./composition-autobiz-bridge"
const execute = promisify(execFile)
const python = async (source: string, args: string[]) =>
  execute("python", ["-I", "-B", "-X", "utf8", ...args], {
    cwd: source,
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 1024 * 1024
  })

async function proveTerminal(
  source: string,
  root: string,
  workspace: string,
  record: CompositionInternalProject,
  contracts: StageCheckContract[],
  receipts: StageCheckReceipt[]
) {
  const project = {
    projectId: "internal",
    projectDir: "project",
    workspacePath: root,
    projectCode: "project",
    name: "fixture",
    "harness-adapter": { id: "fixture", name: "fixture" }
  } as HarnessProjectMetadata
  const inspected = await python(source, [
    "-c",
    "import runpy,sys; sys.path.insert(0,sys.argv.pop(1)); sys.argv=sys.argv[1:]; runpy.run_path(sys.argv[0],run_name='__main__')",
    source,
    join(source, "inspect_state.py"),
    "--mode",
    "run",
    "--workspace",
    root,
    "--project",
    "project",
    "--feature",
    "demo"
  ])
  const projection = normalizeHarnessAdapterRun(
    Buffer.from(inspected.stdout),
    project,
    "demo"
  ).result
  // Only the journal is a fixture here. Original inspector, normalizer, contracts,
  // filesystem and receipts are real; this does not claim ManagedRun/UI acceptance.
  const context = {
    runId: "run",
    parentProjectId: "parent",
    workspace,
    executionWorkspace: workspace,
    attemptId: "attempt",
    idempotencyKey: "unit",
    inputs: [],
    unit: {
      id: "unit",
      kind: "flow",
      source: { pluginId: "fixture", capabilityId: "flow", packageDigest: record.packageDigest },
      inputs: [],
      outputs: []
    }
  } as CompositionExecutionContext
  return proveLegacyCompositionCompletion(context, {
    projectId: "internal",
    featureId: "demo",
    journalHealthy: true,
    managed: {
      runId: "managed",
      projectId: "internal",
      featureId: "demo",
      status: "completed"
    } as ManagedRunSnapshot,
    events: [
      { runId: "managed", type: "run_completed", eventId: "completed" }
    ] as ManagedRunEvent[],
    detail: {
      ...projection,
      project: { projectId: "internal", projectRootPath: workspace },
      adapterSnapshot: { mock: false },
      sessions: []
    } as unknown as HarnessRunDetailViewModel,
    stageChecks: {
      contracts,
      receipts: receipts.map((receipt) => ({
        runId: "run",
        unitId: "unit",
        engineRunId: "managed",
        packageDigest: record.packageDigest,
        threadId: "fixture-child",
        incarnationKey: "fixture",
        hookId: "project-checkpoint",
        receipt
      }))
    }
  })
}

it("runs original project initialization, lean feature creation and every legal checked transition", async () => {
  const root = await mkdtemp(join(tmpdir(), "composition-autobiz-lifecycle-"))
  storage.root = join(root, "app")
  const workspace = join(root, "project")
  await mkdir(workspace)
  try {
    await withPinnedAutobiz(undefined, async (source) => {
      const originalPaths = [
        "hooks/init_workspace.py",
        "hooks/state_checkpoint.py",
        "hooks/update_checkpoint.py",
        "board_core/board_config.json",
        "skills/autodev/hooks/artifact_check.py"
      ]
      const originals = await Promise.all(originalPaths.map((path) => readFile(join(source, path))))
      await writeFile(
        join(source, "devclaw.stage-checks.json"),
        JSON.stringify(AUTOBIZ_STAGE_CHECK_DECLARATION)
      )
      await python(source, [
        join(source, "hooks/init_workspace.py"),
        "--mode",
        "createProject",
        "--workspace",
        root,
        "--project",
        "project"
      ])
      await python(source, [
        join(source, "hooks/init_workspace.py"),
        "--mode",
        "createFeature",
        "--workspace",
        root,
        "--project",
        "project",
        "--feature",
        "demo",
        "--workflow-template",
        "lean"
      ])
      const record = {
        projectId: "internal",
        parentProjectId: "parent",
        compositionRunId: "run",
        unitId: "unit",
        featureId: "demo",
        workspace,
        packageDigest: "a".repeat(64),
        plugin: { path: source },
        goal: "Local fixture"
      } as CompositionInternalProject
      const statePath = join(workspace, ".autobizdevops/state.json")
      const initial = JSON.parse(await readFile(statePath, "utf8"))
      expect(initial.features.demo.checkpoint).toBe("specs_in_progress")
      const contracts = await readAutobizCompositionContracts(record)
      expect(contracts.map((item) => item.nodeId)).toEqual(["dev.specs", "dev.code"])
      let stateDigest = runtimeDigest(await readFile(statePath))
      const receipts: StageCheckReceipt[] = []
      const advance = async (checkpoint: string) => {
        const result = await transitionAutobizComposition(record, {
          checkpoint,
          expectedStateDigest: stateDigest,
          validateReceipts: async (values) => {
            for (const receipt of values) {
              const contract = contracts.find(
                (item) => item.nodeId === receipt.nodeId && item.checkId === receipt.checkId
              )!
              expect(receipt.contractDigest).toBe(contract.contractDigest)
              for (const artifact of receipt.artifacts)
                expect(runtimeDigest(await readFile(join(workspace, artifact.path)))).toBe(
                  artifact.digest
                )
            }
          }
        })
        return result
      }
      // Original required-file check must refuse the first completion before real files exist.
      const refused = await advance("specs_done")
      expect(refused.status).toBe("not-applied")
      expect(runtimeDigest(await readFile(statePath))).toBe(stateDigest)
      expect(refused.receipts).toEqual([])
      await python(source, [
        "-c",
        `import runpy,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
v=runpy.run_path(str(Path(sys.argv[1])/'tests/test_artifact_contracts.py'))
f=Path(sys.argv[2])/'.autobizdevops/features/demo'
(f/'specs/order-export').mkdir(parents=True,exist_ok=True)
(f/'proposal.md').write_text(v['PROPOSAL_OK'],encoding='utf-8')
(f/'specs/order-export/spec.md').write_text(v['SPEC_OK'],encoding='utf-8')`,
        source,
        workspace
      ])
      for (const checkpoint of ["specs_done", "code_in_progress", "code_done", "archived"]) {
        const result = await advance(checkpoint)
        expect(result, JSON.stringify(result)).toMatchObject({ status: "committed" })
        stateDigest = result.stateDigest!
        receipts.push(...result.receipts)
        expect(JSON.parse(await readFile(statePath, "utf8")).features.demo.checkpoint).toBe(
          checkpoint
        )
      }
      expect(receipts.map((item) => item.nodeId)).toEqual(["dev.specs", "dev.code"])
      expect(receipts[0].artifacts.length).toBeGreaterThan(0)
      expect(receipts[1].artifacts).toEqual([])
      expect(contracts.find((item) => item.nodeId === "dev.code")?.checkOnly).toBe(true)
      expect((await proveTerminal(source, root, workspace, record, contracts, receipts)).kind).toBe(
        "flow-completed"
      )
      expect(await Promise.all(originalPaths.map((path) => readFile(join(source, path))))).toEqual(
        originals
      )
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 90000)

it("verifies default-chain original Biz checks and full terminal proof with historical stage evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "composition-autobiz-full-lifecycle-"))
  storage.root = join(root, "app")
  const workspace = join(root, "project")
  await mkdir(workspace)
  try {
    await withPinnedAutobiz(undefined, async (source) => {
      await writeFile(
        join(source, "devclaw.stage-checks.json"),
        JSON.stringify(AUTOBIZ_STAGE_CHECK_DECLARATION)
      )
      await python(source, [
        join(source, "hooks/init_workspace.py"),
        "--mode",
        "createProject",
        "--workspace",
        root,
        "--project",
        "project"
      ])
      await python(source, [
        join(source, "hooks/init_workspace.py"),
        "--mode",
        "createFeature",
        "--workspace",
        root,
        "--project",
        "project",
        "--feature",
        "demo"
      ])
      const record = {
        projectId: "internal",
        parentProjectId: "parent",
        compositionRunId: "run",
        unitId: "unit",
        featureId: "demo",
        workspace,
        packageDigest: "a".repeat(64),
        plugin: { path: source },
        goal: "Local fixture"
      } as CompositionInternalProject
      const statePath = join(workspace, ".autobizdevops/state.json")
      const contracts = await readAutobizCompositionContracts(record)
      const prepare = `import json,runpy,sys
from pathlib import Path
source=Path(sys.argv[1]); root=Path(sys.argv[2]); sys.path.insert(0,str(source))
from board_core.contracts import load_record_workflow_contracts
record=json.loads((root/'.autobizdevops/state.json').read_text(encoding='utf-8'))['features']['demo']
w=load_record_workflow_contracts(source,record,workspace=root)
v=runpy.run_path(str(source/'tests/test_artifact_contracts.py'))
f=root/'.autobizdevops/features/demo'
for c in w.skill_contracts.values():
    for a in c.outputs:
        if '*' not in a.path:
            p=f/a.path; p.parent.mkdir(parents=True,exist_ok=True); p.write_text('Local contract fixture only',encoding='utf-8')
(f/'specs/order-export').mkdir(parents=True,exist_ok=True)
(f/'proposal.md').write_text(v['PROPOSAL_OK'],encoding='utf-8')
(f/'specs/order-export/spec.md').write_text(v['SPEC_OK'],encoding='utf-8')
(f/'design.md').write_text(v['DESIGN_OK'],encoding='utf-8')
(f/'PLAN.md').write_text(v['PLAN_OK'].replace('API-01','API-01, D-01'),encoding='utf-8')
(f/'PRD.md').write_text('''# 需求正式稿
## 用户故事
Local fixture only
## 验收口径
Local fixture only
## 验收标准
Local fixture only
## 关键约束
No external systems''',encoding='utf-8')
(f/'REQUIREMENTS_EVAL.md').write_text('verdict: PASS',encoding='utf-8')
(f/'UNIT_TEST_REPORT.md').write_text('Test Plan; Execution Summary; Coverage Matrix; Failure Analysis; Fix Attempts; Commands; Handoff; verdict: PASS; test-output.log; | Source | Requirement | Test | Result |; | ID | Classification | Files Changed |',encoding='utf-8')
print(json.dumps({'initial':record['checkpoint'],'checkpoints':[p for c in w.skill_contracts.values() for p in c.checkpoints]}))`
      const lifecycle = JSON.parse(
        (await python(source, ["-c", prepare, source, workspace])).stdout
      )
      let stateDigest = runtimeDigest(await readFile(statePath))
      const receipts: StageCheckReceipt[] = []
      for (const checkpoint of lifecycle.checkpoints.filter(
        (value: string) => value !== lifecycle.initial
      )) {
        if (checkpoint === "prd_in_progress") {
          const before = await readFile(statePath)
          const rejected = await transitionAutobizComposition(record, {
            checkpoint,
            expectedStateDigest: stateDigest,
            validateReceipts: async () => {
              throw Error("Invalid Biz artifact must never reach host acknowledgement")
            }
          })
          expect(rejected.status).toBe("not-applied")
          expect(await readFile(statePath)).toEqual(before)
          expect(JSON.parse(before.toString("utf8")).features.demo.checkpoint).toBe("discuss_done")
          await writeFile(
            join(workspace, ".autobizdevops/features/demo/PRD_DISCUSS.md"),
            "# Local contract fixture\n## 需求摘要\n## 已确认结论\n## 问题清单\n## 待确认事项\n## 假设与风险\n"
          )
        }
        if (checkpoint === "code_done")
          await python(source, [
            "-c",
            `import runpy,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
v=runpy.run_path(str(Path(sys.argv[1])/'tests/test_artifact_contracts.py'))
(Path(sys.argv[2])/'.autobizdevops/features/demo/PLAN.md').write_text(v['PLAN_DONE'].replace('API-01','API-01, D-01'),encoding='utf-8')`,
            source,
            workspace
          ])
        const result = await transitionAutobizComposition(record, {
          checkpoint,
          expectedStateDigest: stateDigest,
          validateReceipts: async (values) => {
            for (const receipt of values)
              expect(receipt.contractDigest).toBe(
                contracts.find(
                  (item) => item.nodeId === receipt.nodeId && item.checkId === receipt.checkId
                )?.contractDigest
              )
          }
        })
        expect(result, checkpoint + " " + JSON.stringify(result)).toMatchObject({
          status: "committed"
        })
        stateDigest = result.stateDigest!
        receipts.push(...result.receipts)
      }
      expect(JSON.parse(await readFile(statePath, "utf8")).features.demo.checkpoint).toBe(
        "archived"
      )
      expect(new Set(receipts.map((item) => item.nodeId))).toEqual(
        new Set(contracts.map((item) => item.nodeId))
      )
      // The mutable initial plan is revalidated at code completion; do not replay the
      // initial-todo validator after the original finished-task validator has passed.
      const plan = receipts
        .flatMap((item) => item.artifacts)
        .filter((item) => item.path.endsWith("/PLAN.md"))
        .at(-1)
      expect(plan?.digest).toBe(
        runtimeDigest(await readFile(join(workspace, ".autobizdevops/features/demo/PLAN.md")))
      )
      expect((await proveTerminal(source, root, workspace, record, contracts, receipts)).kind).toBe(
        "flow-completed"
      )
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 120000)
