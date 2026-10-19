import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { assembleBusinessMods } from "../../plugins/business-mod-assembler"
import { businessModCatalog } from "../../plugins/business-mod-manifest"
import { snapshotDerivationSource, writeDerivationFiles } from "../../plugins/derivation-source"
import type { CompositionInternalProject } from "./composition-internal-projects"
import { runtimeDigest } from "./safe-files"
const state = vi.hoisted(() => ({ root: "" }))
vi.mock("../../storage", () => ({ getOpenworkDir: () => state.root }))
import {
  readAutobizCompositionContracts,
  transitionAutobizComposition
} from "./composition-autobiz-bridge"
const execute = promisify(execFile)

it.skipIf(!process.env.AUTOBIZ_BUSINESS_SOURCE)(
  "executes terminal PRD's real Biz check and freezes its named receipt before the physical commit",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "business-terminal-receipt-"))
    state.root = join(root, "app")
    const workspace = join(root, "workspace"),
      source = join(root, "package")
    await mkdir(workspace)
    await mkdir(source)
    try {
      const snapshot = await snapshotDerivationSource(process.env.AUTOBIZ_BUSINESS_SOURCE!)
      const assembled = assembleBusinessMods(
        [{ snapshot, catalog: businessModCatalog(snapshot), modIds: ["biz.prd"] }],
        { sources: [], name: "independent-prd-terminal", version: "1.0.0" }
      )
      await writeDerivationFiles(source, assembled.files)
      for (const mode of ["createProject", "createFeature"])
        await execute(
          "python",
          [
            "-B",
            "-X",
            "utf8",
            join(source, "hooks/init_workspace.py"),
            "--mode",
            mode,
            "--workspace",
            workspace,
            ...(mode === "createFeature" ? ["--feature", "demo"] : [])
          ],
          { cwd: source, windowsHide: true }
        )
      const record = {
        projectId: "internal",
        parentProjectId: "parent",
        compositionRunId: "run",
        unitId: "prd",
        featureId: "demo",
        workspace,
        plugin: { path: source },
        packageDigest: assembled.digest,
        goal: "Local document contract; no business acceptance claim"
      } as CompositionInternalProject
      const statePath = join(workspace, ".autobizdevops/state.json")
      const before = await readFile(statePath)
      const rejected = await transitionAutobizComposition(record, {
        checkpoint: "prd_done",
        expectedStateDigest: runtimeDigest(before),
        validateReceipts: async () => {
          throw Error("Missing original Biz artifacts must not reach receipt acknowledgement")
        }
      })
      expect(rejected.status).toBe("not-applied")
      expect(await readFile(statePath)).toEqual(before)
      const feature = join(workspace, ".autobizdevops/features/demo")
      await writeFile(
        join(feature, "PRD.md"),
        "# 本地订单导出需求\n\n本次仅核对真实文档结构。\n\n## 外部资料与实现约束\n无\n"
      )
      await writeFile(
        join(feature, "UI_CONTEXT.json"),
        JSON.stringify({
          version: 1,
          featureId: "demo",
          uiRequired: false,
          decisionStatus: "locked",
          decisionSource: "user_confirmed",
          notApplicableReason: "Local API-only contract example",
          lockedAtCheckpoint: "specs_done",
          pages: [],
          interactions: [],
          visualSources: [],
          capabilities: []
        })
      )
      const contracts = await readAutobizCompositionContracts(record)
      const committed = await transitionAutobizComposition(record, {
        checkpoint: "prd_done",
        expectedStateDigest: runtimeDigest(before),
        validateReceipts: async (receipts) => {
          expect(receipts.length).toBeGreaterThan(0)
          for (const receipt of receipts) {
            expect(
              contracts.find(
                (contract) =>
                  contract.nodeId === receipt.nodeId && contract.checkId === receipt.checkId
              )?.contractDigest
            ).toBe(receipt.contractDigest)
            for (const artifact of receipt.artifacts)
              expect(runtimeDigest(await readFile(join(workspace, artifact.path)))).toBe(
                artifact.digest
              )
          }
        }
      })
      expect(committed.status, JSON.stringify(committed)).toBe("committed")
      expect(
        committed.receipts.some(
          (receipt) => receipt.nodeId === "biz.prd" && receipt.checkId === "biz-prd-validate"
        )
      ).toBe(true)
      expect(committed.receipts.some((receipt) => receipt.checkId === "postcheck")).toBe(true)
      expect(JSON.parse(await readFile(statePath, "utf8")).features.demo.checkpoint).toBe(
        "prd_done"
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000
)
