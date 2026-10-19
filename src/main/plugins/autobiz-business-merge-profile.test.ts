import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import reviewed from "./autobiz-business-kernel-reviewed.json"
import mergeReviewed from "./autobiz-business-kernel-merge-reviewed.json"
import wakeupReviewed from "./autobiz-business-kernel-wakeup-reviewed.json"
import specRoleReviewed from "./autobiz-business-kernel-spec-role-reviewed.json"
import utestLiteralReviewed from "./autobiz-business-kernel-utest-literal-reviewed.json"
import { isReviewedAutobizBusinessAssembly } from "./autobiz-business-assembly-protocol"
import { isReviewedAutobizProtocol } from "./autobiz-composition-protocol"
import { isReviewedAutobizKernelIdentity } from "./autobiz-required-hooks"
import { businessModCatalog } from "./business-mod-manifest"
import { assembleBusinessMods } from "./business-mod-assembler"
import { snapshotDerivationSource, writeDerivationFiles } from "./derivation-source"
import { EXTENSION_BOARD_API_VERSION } from "../../shared/project-runtime"
import { readNativeCapabilityCatalog } from "./capability-catalog"
import { readRuntimeRequiredHooks } from "./runtime-required-hooks"
import type { PluginMetadata } from "../types"

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const json = (value: unknown) => Buffer.from(JSON.stringify(value))
const writerPath = "hooks/plan_writer.py"
const aggregatePath = "hooks/parallel_evidence_aggregate.py"
const lockPath = "devclaw.business-assembly.json"

it("pins the independently reviewed Plan and evidence compatibility changes without changing the old profile", async () => {
  const oldBytes = await readFile(
    new URL("./autobiz-business-kernel-reviewed.json", import.meta.url)
  )
  expect(digest(oldBytes)).toBe("cfa60099de35bd8901c8a251e9747cab0e71fa868cfd13cec84d07067e156a27")
  const expected = structuredClone(reviewed)
  expected.version = "1.0.1"
  for (const path of [writerPath, aggregatePath]) {
    expected.files.find((file) => file.path === path)!.digest = mergeReviewed.files.find(
      (file) => file.path === path
    )!.digest
    expect(mergeReviewed.files.find((file) => file.path === path)!.digest).not.toBe(
      reviewed.files.find((file) => file.path === path)!.digest
    )
  }
  expect(mergeReviewed).toEqual(expected)
  expect(isReviewedAutobizKernelIdentity(reviewed)).toBe(true)
  expect(isReviewedAutobizKernelIdentity(mergeReviewed)).toBe(true)
  expect(isReviewedAutobizKernelIdentity({ id: mergeReviewed.id, version: "1.0.5" })).toBe(false)
})

it("classifies only the five exact independently reviewed kernel identities", () => {
  const profiles = [reviewed, mergeReviewed, wakeupReviewed, specRoleReviewed, utestLiteralReviewed]
  expect(profiles.map((profile) => profile.version)).toEqual([
    "1.0.0",
    "1.0.1",
    "1.0.2",
    "1.0.3",
    "1.0.4"
  ])
  for (const profile of profiles) {
    expect(isReviewedAutobizKernelIdentity(profile)).toBe(true)
    expect(isReviewedAutobizKernelIdentity({ ...profile, id: "foreign.python-kernel" })).toBe(false)
  }
  for (const version of ["1.0.5", "1.0.2-suffix", "1.0.20", "^1.0.2"])
    expect(isReviewedAutobizKernelIdentity({ id: reviewed.id, version })).toBe(false)
})

it.skipIf(!process.env.AUTOBIZ_BUSINESS_MERGE_SOURCE)(
  "admits the actual reviewed merge-aware source with the original dynamic routing and twelve mandatory Hooks",
  async () => {
    const source = await snapshotDerivationSource(process.env.AUTOBIZ_BUSINESS_MERGE_SOURCE!)
    const catalog = businessModCatalog(source)
    expect(catalog.kernel?.version).toBe("1.0.1")
    const assembled = assembleBusinessMods(
      [{ snapshot: source, catalog, modIds: catalog.modules.map((mod) => mod.id) }],
      { name: "reviewed-merge-profile", version: "1.0.0", sources: [] }
    )
    expect(assembled.requiresFixedWorkflowAcknowledgement).toBe(false)
    expect(isReviewedAutobizBusinessAssembly(assembled)).toBe(true)
    expect(isReviewedAutobizProtocol(assembled)).toBe(true)
    const files = new Map(assembled.files.map((file) => [file.path, file.bytes]))
    const board = JSON.parse(files.get("board_core/board_config.json")!.toString("utf8"))
    const originalBoard = JSON.parse(
      source.files
        .find((file) => file.path === "board_core/board_config.json")!
        .bytes.toString("utf8")
    )
    expect(board.apiVersion).toBe(EXTENSION_BOARD_API_VERSION)
    expect(board.knowledge_config).toEqual(originalBoard.knowledge_config)
    expect(board.inspectCommands).toEqual(originalBoard.inspectCommands)
    const capabilities = JSON.parse(files.get("devclaw.capabilities.json")!.toString("utf8"))
    expect(capabilities.capabilities[0].requiredHooks).toHaveLength(12)
    const installedRoot = await mkdtemp(join(tmpdir(), "reviewed-plan-merge-"))
    try {
      await writeDerivationFiles(installedRoot, assembled.files)
      const plugin = {
        id: "reviewed-merge-install",
        name: "reviewed-merge-profile",
        version: "1.0.0",
        path: installedRoot,
        enabled: true
      } as PluginMetadata
      const native = await readNativeCapabilityCatalog(plugin, "project")
      expect(native.status, native.reasons.join(";")).toBe("declared")
      expect(native.legacyAdapter).toBe("autobiz-v1")
      expect(readRuntimeRequiredHooks(plugin, { legacy: true }).length).toBeGreaterThanOrEqual(12)
    } finally {
      await rm(installedRoot, { recursive: true, force: true })
    }

    // Recompute every author-controlled digest after each attack. Only the host's fixed
    // reviewed profile may authorize executable source, original definitions and routing.
    function attack(change: (files: Map<string, Buffer>) => void) {
      const changed = new Map(files)
      change(changed)
      const lock = JSON.parse(changed.get(lockPath)!.toString("utf8"))
      for (const row of lock.kernel.files) row.digest = digest(changed.get(row.path)!)
      lock.files = [...changed]
        .filter(([path]) => path !== lockPath)
        .map(([path, bytes]) => ({ path, digest: digest(bytes) }))
      changed.set(lockPath, json(lock))
      return { files: [...changed].map(([path, bytes]) => ({ path, bytes })) }
    }
    const attacks: Array<(files: Map<string, Buffer>) => void> = [
      (files) =>
        files.set(
          writerPath,
          Buffer.concat([files.get(writerPath)!, Buffer.from("\n# unreviewed edit\n")])
        ),
      (files) =>
        files.set(
          aggregatePath,
          Buffer.concat([files.get(aggregatePath)!, Buffer.from("\n# unreviewed edit\n")])
        ),
      (files) => files.set("hooks/unreviewed.py", Buffer.from("print('unreviewed')")),
      (files) => {
        const manifest = JSON.parse(files.get("mods/business/manifest.json")!.toString("utf8"))
        manifest.kernel.version = "1.0.2"
        files.set("mods/business/manifest.json", json(manifest))
        const lock = JSON.parse(files.get(lockPath)!.toString("utf8"))
        lock.kernel.version = "1.0.2"
        files.set(lockPath, json(lock))
        files.set("author-provided-profile.json", json({ ...mergeReviewed, version: "1.0.2" }))
      },
      (files) => {
        const manifest = JSON.parse(files.get("mods/business/manifest.json")!.toString("utf8"))
        manifest.modules[0].checks.validators = []
        files.set("mods/business/manifest.json", json(manifest))
      },
      (files) => {
        const changedBoard = JSON.parse(files.get("board_core/board_config.json")!.toString("utf8"))
        changedBoard.workflow.templates.standard.requiredNodes = []
        files.set("board_core/board_config.json", json(changedBoard))
      }
    ]
    for (const change of attacks) expect(isReviewedAutobizProtocol(attack(change))).toBe(false)
  }
)
