import { describe, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { withPinnedAutobiz } from "../../mods/v2/autobiz-source"
import { runtimeDigest } from "./safe-files"
import type { CompositionInternalProject } from "./composition-internal-projects"
const state = vi.hoisted(() => ({ root: "" }))
vi.mock("../../storage", () => ({ getOpenworkDir: () => state.root }))
import {
  AUTOBIZ_STAGE_CHECK_DECLARATION,
  autobizBridgeResourcePath,
  readAutobizCompositionContracts,
  transitionAutobizComposition,
  validateAutobizCompositionAdapterDeclaration
} from "./composition-autobiz-bridge"
import { stageCheckArtifactAllowed } from "../../../shared/project-runtime/stage-check-receipt"

const execute = promisify(execFile)
const setup = `
import json,sys
from pathlib import Path
source,workspace=sys.argv[1:]; sys.path.insert(0,source)
from board_core.contracts import load_repo_workflow_contracts
from board_core.state_store import write_state_records,check_or_fix_state_sync
root=Path(workspace); workflow=load_repo_workflow_contracts(Path(source),workspace=root)
contract=next(item for item in reversed(list(workflow.skill_contracts.values())) if item.outputs and not item.validators)
records={'demo':{'checkpoint':contract.checkpoints[0],'workflowProfile':workflow.profile}}
write_state_records(root,records)
sync=check_or_fix_state_sync(root,fix=False); assert not sync.errors,sync.errors
feature=root/'.autobizdevops'/'features'/'demo'; feature.mkdir(parents=True)
for item in contract.outputs:
    file=feature/item.path; file.parent.mkdir(parents=True,exist_ok=True); file.write_text('Verified local fixture',encoding='utf-8')
print(json.dumps({'node':contract.node_id,'checkpoint':contract.checkpoints[-1]}))
`

describe("original AutoBiz composition evidence bridge", () => {
  it("uses a real unpacked Python resource in packaged builds and the built resource in development", async () => {
    expect(autobizBridgeResourcePath(join("installed", "app.asar", "out", "main"))).toBe(
      join(
        "installed",
        "app.asar.unpacked",
        "out",
        "resources",
        "project-composition",
        "autobiz",
        "devclaw_stage_checks.py"
      )
    )
    expect(autobizBridgeResourcePath(join("development", "out", "main"))).toBe(
      join(
        "development",
        "out",
        "resources",
        "project-composition",
        "autobiz",
        "devclaw_stage_checks.py"
      )
    )
    const config = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"))
    expect(config.build.asarUnpack).toContain("out/resources/project-composition/**")
  })

  it("keeps original files intact, freezes contracts and captures checks inside the real locked transition", async () => {
    const root = await mkdtemp(join(tmpdir(), "composition-autobiz-"))
    state.root = join(root, "app")
    const workspace = join(root, "project")
    await mkdir(workspace)
    try {
      await withPinnedAutobiz(undefined, async (source) => {
        await expect(
          validateAutobizCompositionAdapterDeclaration({ path: source })
        ).rejects.toThrow("ADAPTER_REQUIRED")
        await writeFile(
          join(source, "devclaw.stage-checks.json"),
          JSON.stringify(AUTOBIZ_STAGE_CHECK_DECLARATION)
        )
        const originals = await Promise.all(
          [
            "hooks/state_checkpoint.py",
            "hooks/update_checkpoint.py",
            "skills/autodev/hooks/artifact_check.py"
          ].map((path) => readFile(join(source, path)))
        )
        const seeded = JSON.parse(
          (
            await execute("python", ["-I", "-B", "-X", "utf8", "-c", setup, source, workspace], {
              windowsHide: true,
              timeout: 20000
            })
          ).stdout
        )
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
        const before = await readFile(join(workspace, ".autobizdevops/state.json"))
        const contracts = await readAutobizCompositionContracts(record)
        expect(contracts.some((item) => item.nodeId === seeded.node)).toBe(true)
        expect(await readFile(join(workspace, ".autobizdevops/state.json"))).toEqual(before)
        const markdownBefore = await readFile(join(workspace, ".autobizdevops/STATE.md"))
        const rejectReceipts = vi.fn(async () => {
          throw Error("fixture rejects untrusted evidence")
        })
        const refused = await transitionAutobizComposition(record, {
          checkpoint: seeded.checkpoint,
          expectedStateDigest: runtimeDigest(before),
          validateReceipts: rejectReceipts
        })
        expect(refused).toMatchObject({ status: "not-applied", receipts: [] })
        expect(rejectReceipts).toHaveBeenCalledOnce()
        expect(await readFile(join(workspace, ".autobizdevops/state.json"))).toEqual(before)
        expect(await readFile(join(workspace, ".autobizdevops/STATE.md"))).toEqual(markdownBefore)
        const validateReceipts = vi.fn(async (receipts) => {
          expect(receipts.some((receipt) => receipt.nodeId === seeded.node)).toBe(true)
          for (const receipt of receipts) {
            const contract = contracts.find((item) => item.nodeId === receipt.nodeId)!
            expect(receipt.contractDigest).toBe(contract.contractDigest)
            for (const artifact of receipt.artifacts) {
              expect(stageCheckArtifactAllowed(contract, artifact)).toBe(true)
              expect(runtimeDigest(await readFile(join(workspace, artifact.path)))).toBe(
                artifact.digest
              )
            }
          }
        })
        const result = await transitionAutobizComposition(record, {
          checkpoint: seeded.checkpoint,
          expectedStateDigest: runtimeDigest(before),
          validateReceipts
        })
        expect(result, JSON.stringify(result)).toMatchObject({ status: "committed" })
        expect(validateReceipts).toHaveBeenCalledOnce()
        expect(result.receipts.length).toBeGreaterThan(0)
        expect(
          JSON.parse(await readFile(join(workspace, ".autobizdevops/state.json"), "utf8")).features
            .demo.checkpoint
        ).toBe(seeded.checkpoint)
        const validateEmpty = vi.fn(async (receipts) => {
          expect(receipts).toEqual([])
        })
        const archived = await transitionAutobizComposition(record, {
          checkpoint: "archived",
          expectedStateDigest: result.stateDigest!,
          validateReceipts: validateEmpty
        })
        expect(archived).toMatchObject({ status: "committed", receipts: [] })
        expect(validateEmpty).toHaveBeenCalledOnce()
        const stale = await transitionAutobizComposition(record, {
          checkpoint: seeded.checkpoint,
          expectedStateDigest: runtimeDigest(before),
          validateReceipts
        })
        expect(stale.status).toBe("not-applied")
        expect(validateReceipts).toHaveBeenCalledOnce()
        expect(
          await Promise.all(
            [
              "hooks/state_checkpoint.py",
              "hooks/update_checkpoint.py",
              "skills/autodev/hooks/artifact_check.py"
            ].map((path) => readFile(join(source, path)))
          )
        ).toEqual(originals)
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)
})
