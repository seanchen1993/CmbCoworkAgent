import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, it } from "vitest"
import profile from "./autobiz-business-kernel-original-234-reviewed.json"
import repairedProfile from "./autobiz-business-kernel-original-234-delivery-reviewed.json"
import { snapshotDerivationSource } from "./derivation-source"
import { isReviewedAutobizProtocol } from "./autobiz-composition-protocol"
import { readNativeCapabilityCatalog } from "./capability-catalog"
import { reviewedAutobizRequiredHookIds } from "./autobiz-required-hooks"
import { preflightLegacyCompositionSource } from "../harness-board/project-runtime/composition-legacy-preflight"
import { prepareOriginalAutobizModsDelivery } from "../../../scripts/prepare-autobiz-original-mods-delivery"
import type { PluginMetadata } from "../types"

const temporary: string[] = []
afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true })
})
const delivery = resolve(
  process.env.AUTOBIZ_ORIGINAL_BASELINE_DELIVERY ??
    "output/deliveries/autobiz-original-recovery-20261021-r2"
)
const available = existsSync(join(delivery, "complete-plugin/plugin.json"))
const repairedDelivery = resolve(
  process.env.AUTOBIZ_ORIGINAL_MODS_DELIVERY ??
    "output/deliveries/autobiz-original-recovery-20261021-final-r8"
)

it.runIf(existsSync(join(repairedDelivery, "complete-plugin/plugin.json")))(
  "retains real Git and evidence checks after baseline repair and accepts only proven frontend skip",
  async () => {
    const source = join(repairedDelivery, "complete-plugin")
    const snapshot = await snapshotDerivationSource(source)
    expect(isReviewedAutobizProtocol(snapshot)).toBe(true)
    const report = JSON.parse(
      await readFile(join(repairedDelivery, "conversion-verification.json"), "utf8")
    )
    expect(report.changedOriginalScripts.map((row: { path: string }) => row.path).sort()).toEqual([
      "hooks/evidence_integrity_gate.py",
      "hooks/parallel_batch_stage.py",
      "hooks/parallel_evidence_aggregate.py",
      "hooks/plan_writer.py"
    ])
    expect(repairedProfile.version).toBe("1.0.3")
    const manifest = JSON.parse(await readFile(join(source, "plugin.json"), "utf8"))
    const installed = {
      id: "exact-repaired-original",
      path: source,
      name: manifest.name,
      version: manifest.version,
      enabled: true
    } as PluginMetadata
    expect(await readNativeCapabilityCatalog(installed, "project")).toMatchObject({
      status: "declared",
      legacyAdapter: "autobiz-v1"
    })
    if (process.platform === "win32") await preflightLegacyCompositionSource(installed)
    const result = await promisify(execFile)(
      "python",
      [
        "-B",
        "-X",
        "utf8",
        resolve("tests/support/autobiz-original-projection-regression.py"),
        source
      ],
      {
        windowsHide: true,
        timeout: 30000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
      }
    )
    expect(JSON.parse(result.stdout)).toMatchObject({ passed: true })
    expect(JSON.parse(result.stdout).assertions).toHaveLength(8)
  },
  45000
)

it("rejects another archive before creating any delivery or claiming a reviewed source", async () => {
  const root = await mkdtemp(join(tmpdir(), "ab-original-reject-"))
  temporary.push(root)
  await writeFile(join(root, "unknown.zip"), "not the supplied original")
  await expect(
    prepareOriginalAutobizModsDelivery({
      archive: join(root, "unknown.zip"),
      output: join(root, "delivery"),
      name: "unknown",
      version: "1"
    })
  ).rejects.toThrow("Exact supplied original ZIP")
  expect(existsSync(join(root, "delivery"))).toBe(false)
})

it.runIf(available)(
  "pins all original 234 resources and admits the independent version without weakening other package admission",
  async () => {
    const original = await snapshotDerivationSource(join(delivery, "original-read-only")),
      composed = await snapshotDerivationSource(join(delivery, "complete-plugin"))
    expect(original.files).toHaveLength(234)
    expect(profile.id).toBe("autobiz.original-234-kernel")
    expect(profile.version).toBe("1.0.1")
    const pinned = new Map([
      ...profile.files.map((file) => [file.path, file.digest] as const),
      ...Object.values(profile.modules).flatMap((mod) => Object.entries(mod.files))
    ])
    expect(pinned.size).toBe(232)
    for (const file of original.files) {
      if (["plugin.json", "board_core/board_config.json"].includes(file.path)) continue
      expect(pinned.get(file.path), file.path).toBe(file.digest)
      expect(composed.files.find((row) => row.path === file.path)?.digest, file.path).toBe(
        file.digest
      )
    }
    const board = JSON.parse(
      original.files
        .find((file) => file.path === "board_core/board_config.json")!
        .bytes.toString("utf8")
    )
    expect(profile.workflow).toEqual(board.workflow)
    expect(isReviewedAutobizProtocol(composed)).toBe(true)
    const identity = JSON.parse(
      composed.files.find((file) => file.path === "plugin.json")!.bytes.toString("utf8")
    )
    const metadata = {
      id: "precise-user-original",
      path: composed.root,
      name: identity.name,
      version: identity.version,
      enabled: true
    } as PluginMetadata
    const native = await readNativeCapabilityCatalog(metadata, "project")
    expect(native).toMatchObject({ status: "declared", legacyAdapter: "autobiz-v1" })
    if (process.platform === "win32") await preflightLegacyCompositionSource(metadata)
    const hooks = JSON.parse(
      original.files.find((file) => file.path === "hooks/hooks.json")!.bytes.toString("utf8")
    )
    expect(reviewedAutobizRequiredHookIds(hooks, profile)).toHaveLength(13)
    hooks.PreToolUse[0].hooks = []
    expect(() => reviewedAutobizRequiredHookIds(hooks, profile)).toThrow("INCOMPLETE")
  }
)

it.runIf(available)(
  "rejects re-signed unknown scripts, changed environment templates and changed stage definitions",
  async () => {
    const composed = await snapshotDerivationSource(join(delivery, "complete-plugin"))
    for (const change of ["python", "environment", "definition"] as const) {
      const files = composed.files.map((file) => ({
        path: file.path,
        bytes: Buffer.from(file.bytes)
      }))
      if (change === "python")
        files.push({ path: "hooks/unreviewed.py", bytes: Buffer.from("print('unreviewed')\n") })
      if (change === "environment") {
        const file = files.find((row) => row.path === "board_core/board_config.json")!
        const board = JSON.parse(file.bytes.toString("utf8"))
        board.inspectCommands.win32.session_context_inject += " --different-context-policy"
        file.bytes = Buffer.from(JSON.stringify(board))
      }
      if (change === "definition") {
        const file = files.find((row) => row.path === "mods/business/manifest.json")!
        const catalog = JSON.parse(file.bytes.toString("utf8"))
        catalog.modules[0].node.validators = []
        file.bytes = Buffer.from(JSON.stringify(catalog))
      }
      const lockFile = files.find((row) => row.path === "devclaw.business-assembly.json")!
      const lock = JSON.parse(lockFile.bytes.toString("utf8"))
      lock.files = files
        .filter((row) => row !== lockFile)
        .map((file) => ({
          path: file.path,
          digest: createHash("sha256").update(file.bytes).digest("hex")
        }))
      lockFile.bytes = Buffer.from(JSON.stringify(lock))
      expect(isReviewedAutobizProtocol({ files }), change).toBe(false)
    }
  }
)
