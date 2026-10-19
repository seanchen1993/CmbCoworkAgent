import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { assembleBusinessMods } from "./business-mod-assembler"
import { businessModCatalog } from "./business-mod-manifest"
import { snapshotDerivationSource, writeDerivationFiles } from "./derivation-source"
import { verifyReviewedBusinessAssembly } from "./autobiz-business-assembly-protocol"
import { readBusinessModSelectionPolicy } from "./business-mod-selection"
import reviewed from "./autobiz-business-kernel-reviewed.json"
import reviewedWorkflow from "./autobiz-business-routing-reviewed.json"

it.skipIf(!process.env.AUTOBIZ_BUSINESS_SOURCE)(
  "executes the actual unchanged AutoBiz compiler for pending, enabled, skipped and custom routes, then rejects rehashed route replacement",
  async () => {
    const original = await snapshotDerivationSource(process.env.AUTOBIZ_BUSINESS_SOURCE!)
    const catalog = businessModCatalog(original)
    const assembled = assembleBusinessMods(
      [{ snapshot: original, catalog, modIds: catalog.modules.map((mod) => mod.id) }],
      {
        name: "actual-dynamic-business-routing",
        version: "1.0.0",
        sources: []
      }
    )
    expect(assembled.requiresFixedWorkflowAcknowledgement, assembled.diagnostics.join(";")).toBe(
      false
    )
    expect(verifyReviewedBusinessAssembly(assembled, reviewed)).toBe(true)
    const board = assembled.files.find((file) => file.path === "board_core/board_config.json")!
    const config = JSON.parse(board.bytes.toString("utf8"))
    expect(config.workflow.dynamicStages).toEqual(reviewedWorkflow.dynamicStages)
    const policy = readBusinessModSelectionPolicy(assembled)!
    expect(policy.nodes.map((node) => node.id)).not.toContain("dev.detail_design")
    expect(policy.nodes.flatMap((node) => node.requires)).not.toContain("dev.detail_design")
    const root = await mkdtemp(join(tmpdir(), "autobiz-route-regression-"))
    try {
      await writeDerivationFiles(root, assembled.files)
      const python = spawnSync(
        "python",
        [
          "-B",
          "-c",
          `
import json,sys
from pathlib import Path
root=Path(sys.argv[1])
sys.path.insert(0,str(root))
from board_core.workflow_compiler import compile_board_config,compile_node_subset
base=json.loads((root/'board_core/board_config.json').read_text(encoding='utf8'))
results={}
for decision in ('pending','enabled','skipped'):
    decisions={} if decision=='pending' else {'detail_design_before_code':decision}
    effective=compile_board_config(base,repo_root=root,workflow_decisions=decisions)
    results[decision]={'nodes':[node['id'] for node in effective['workflow']['nodes']], 'checkpoints':effective['workflow']['checkpoints']['transitions']}
custom=compile_node_subset(base,['biz.prd','dev.specs'])
results['custom']={'nodes':[node['id'] for node in custom['workflow']['nodes']]}
print(json.dumps(results))
`,
          root
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 20_000,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
        }
      )
      expect(python.error).toBeUndefined()
      expect(python.status, python.stderr).toBe(0)
      const results = JSON.parse(python.stdout)
      const baseIds = reviewedWorkflow.nodes.map((node) => node.id)
      expect(results.pending.nodes).toEqual(baseIds)
      expect(results.skipped.nodes).toEqual(baseIds)
      const enabledIds = [...baseIds]
      enabledIds.splice(4, 0, "dev.detail_design")
      expect(results.enabled.nodes).toEqual(enabledIds)
      expect(results.enabled.nodes.filter((id: string) => id === "dev.detail_design")).toHaveLength(
        1
      )
      expect(results.enabled.checkpoints.plan_done).toContain("detail_design_in_progress")
      expect(results.enabled.checkpoints.detail_design_done).toContain("code_in_progress")
      expect(results.skipped.checkpoints.plan_done).toEqual(["code_in_progress"])
      expect(results.custom.nodes).toEqual(["biz.prd", "dev.specs"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
    const mutations = [
      (workflow: typeof config.workflow) => {
        workflow.dynamicStages[0].skipTargetCheckpoint = "archived"
      },
      (workflow: typeof config.workflow) => {
        workflow.dynamicStages[0].nodes[0].validators.push("author-added")
      },
      (workflow: typeof config.workflow) => {
        workflow.templates.lean.nodes = ["ops.archive"]
      },
      (workflow: typeof config.workflow) => {
        workflow.nodes.push(structuredClone(workflow.dynamicStages[0].nodes[0]))
      }
    ]
    for (const mutate of mutations) {
      const files = assembled.files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) }))
      const changedBoard = files.find((file) => file.path === board.path)!
      const changed = JSON.parse(changedBoard.bytes.toString("utf8"))
      mutate(changed.workflow)
      changedBoard.bytes = Buffer.from(JSON.stringify(changed))
      const lockFile = files.find((file) => file.path === "devclaw.business-assembly.json")!
      const lock = JSON.parse(lockFile.bytes.toString("utf8"))
      lock.files = files
        .filter((file) => file.path !== lockFile.path)
        .map((file) => ({
          path: file.path,
          digest: createHash("sha256").update(file.bytes).digest("hex")
        }))
      lockFile.bytes = Buffer.from(JSON.stringify(lock))
      expect(verifyReviewedBusinessAssembly({ files }, reviewed)).toBe(false)
    }
  },
  30_000
)
