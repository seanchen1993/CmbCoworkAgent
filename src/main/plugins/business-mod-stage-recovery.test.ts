import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { BUSINESS_MOD_MANIFEST } from "../../shared/business-mods"
import { businessModCatalog, parseBusinessModCatalog } from "./business-mod-manifest"
import { assertBusinessModCatalogShape } from "./business-mod-catalog-schema"
import { assembleBusinessMods } from "./business-mod-assembler"
import { snapshotDerivationSource, writeDerivationFiles } from "./derivation-source"
import { readNativeCapabilityCatalog } from "./capability-catalog"
import { portableBusinessModFiles } from "./business-mod-portable-source"
import { assertBusinessModStageRecoveryProjection } from "./business-mod-stage-recovery"
import { readPluginStageRecoveryAdapter } from "../mods/devtools/plugin-stage-recovery-adapter"
import { prepareAutobizKnowledgeMod } from "../../../scripts/prepare-autobiz-knowledge-mod"
import { prepareAutobizStageRecoverySource } from "../../../scripts/prepare-autobiz-stage-recovery-source"

const cleanup: string[] = []
afterEach(async () => {
  for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true })
})
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "business-stage-adapter-"))
  cleanup.push(root)
  return root
}
const adapter = (entry: string) => ({
  apiVersion: "devclaw.plugin-stage-recovery/v1" as const,
  entry,
  runtime: "python" as const,
  isolation: "private-output-copy" as const,
  codeSource: "keep" as const,
  externalEffects: "network-requires-confirmation" as const
})

it("packages an independently authored vendor adapter only through its selected extension and exact lock", async () => {
  const root = await temporary(),
    source = join(root, "source"),
    output = join(root, "output")
  await cp(resolve("examples/vendor-onboarding-mods"), source, { recursive: true })
  const original = await snapshotDerivationSource(source),
    catalog = businessModCatalog(original)
  const owner = catalog.extensions![0],
    entry = `mods/business/${owner.id}/recovery.py`
  owner.stageRecoveryAdapter = adapter(entry)
  owner.resources.push(entry)
  await writeFile(join(source, BUSINESS_MOD_MANIFEST), JSON.stringify(catalog))
  await mkdir(dirname(join(source, entry)), { recursive: true })
  await writeFile(join(source, entry), "# Independently authored vendor-state recovery protocol\n")
  assertBusinessModCatalogShape(catalog)
  const snapshot = await snapshotDerivationSource(source)
  const result = assembleBusinessMods(
    [
      {
        snapshot,
        catalog: businessModCatalog(snapshot),
        modIds: catalog.modules.map((mod) => mod.id)
      }
    ],
    { name: "vendor-recoverable", version: "1.0.0", sources: [] }
  )
  await mkdir(output)
  await writeDerivationFiles(output, result.files)
  const read = readPluginStageRecoveryAdapter(output)
  expect(read.declaration).toEqual(adapter(entry))
  read.assertCurrent()
  const unselectedCatalog = structuredClone(catalog)
  for (const mod of unselectedCatalog.modules)
    mod.dependencies.required = mod.dependencies.required.filter((id) => id !== owner.id)
  const unselected = assembleBusinessMods(
    [
      {
        snapshot,
        catalog: unselectedCatalog,
        modIds: unselectedCatalog.modules.map((mod) => mod.id)
      }
    ],
    { name: "vendor-without-recovery", version: "1.0.0", sources: [] }
  )
  expect(
    unselected.files.some(
      (file) => file.path === entry || file.path === "devclaw.stage-recovery-adapter.json"
    )
  ).toBe(false)
  const native = await readNativeCapabilityCatalog(
    { id: "vendor", path: output, name: "vendor-recoverable", version: "1.0.0", enabled: true },
    "project"
  )
  expect(native.status).toBe("declared")
  expect(native.capabilities.find((capability) => capability.kind === "flow")?.runtimeMode).toBe(
    "host"
  )
  const portable = portableBusinessModFiles(await snapshotDerivationSource(output))
  expect(portable.some((file) => file.path === entry)).toBe(true)
  expect(portable.some((file) => file.path === "devclaw.stage-recovery-adapter.json")).toBe(true)
  const bytes = new Map(result.files.map((file) => [file.path, file.bytes]))
  bytes.set(
    "devclaw.stage-recovery-adapter.json",
    Buffer.from(JSON.stringify(adapter("hooks/rollback.py")))
  )
  expect(() => assertBusinessModStageRecoveryProjection(catalog, bytes)).toThrow("ADAPTER_CHANGED")
  const withoutDeclaration = structuredClone(catalog)
  delete withoutDeclaration.extensions![0].stageRecoveryAdapter
  expect(() => assertBusinessModStageRecoveryProjection(withoutDeclaration, bytes)).toThrow(
    "ADAPTER_UNDECLARED"
  )
  const omitted = structuredClone(catalog)
  omitted.extensions![0].resources = []
  expect(() => assertBusinessModStageRecoveryProjection(omitted, bytes)).toThrow("RESOURCE_MISSING")
  const conflict = structuredClone(catalog)
  conflict.extensions!.push({ ...structuredClone(owner), id: "second.adapter" })
  expect(() => assertBusinessModStageRecoveryProjection(conflict, bytes)).toThrow(
    "ADAPTER_CONFLICT"
  )
})

it("refuses recovery declaration escapes and authority changes before writing a package", async () => {
  const snapshot = await snapshotDerivationSource(resolve("examples/vendor-onboarding-mods"))
  for (const invalid of [
    adapter("../escape.py"),
    { ...adapter("mods/business/vendor.settings/recovery.py"), codeSource: "git-reset" },
    adapter("mods/business/another/recovery.py")
  ]) {
    const catalog = businessModCatalog(snapshot)
    catalog.extensions![0].stageRecoveryAdapter = invalid as never
    expect(() => parseBusinessModCatalog(catalog)).toThrow()
  }
})

const original = resolve(process.env.AUTOBIZ_BUSINESS_SOURCE ?? "C:/ai/autobiz_kanban")
it.runIf(existsSync(join(original, BUSINESS_MOD_MANIFEST)))(
  "rebuilds an actual assembled AutoBiz source with original business bytes and fresh native admission",
  async () => {
    const root = await temporary(),
      knowledge = join(root, "knowledge"),
      assembled = join(root, "assembled"),
      rebuilt = join(root, "rebuilt")
    const main = await snapshotDerivationSource(original),
      catalog = businessModCatalog(main)
    await prepareAutobizKnowledgeMod(knowledge, catalog.kernel!.version)
    const extra = await snapshotDerivationSource(knowledge),
      extraCatalog = businessModCatalog(extra)
    const result = assembleBusinessMods(
      [
        { snapshot: main, catalog, modIds: catalog.modules.map((mod) => mod.id) },
        {
          snapshot: extra,
          catalog: extraCatalog,
          modIds: extraCatalog.extensions!.map((mod) => mod.id)
        }
      ],
      { name: "explicit-recovery-base", version: "1.0.0", sources: [], acceptFixedWorkflow: true }
    )
    await mkdir(assembled)
    await writeDerivationFiles(assembled, result.files)
    const receipt = await prepareAutobizStageRecoverySource(assembled, rebuilt, {
      extensionId: extraCatalog.extensions![0].id,
      name: "explicit-recovery-output"
    })
    expect(receipt).toMatchObject({
      assemblyLockRebuilt: true,
      nativeCapabilityStatus: "declared",
      nativeRuntimeAdapter: "autobiz-v1",
      originalUnchanged: true
    })
    expect(readPluginStageRecoveryAdapter(rebuilt).declaration.entry).toBe(
      `mods/business/${extraCatalog.extensions![0].id}/stage-recovery/adapter.py`
    )
    for (const file of result.files.filter((file) => /^(?:hooks|board_core)\//.test(file.path)))
      expect(await readFile(join(rebuilt, file.path)), file.path).toEqual(file.bytes)
    // A self-written lock must not grant an undeclared extra executable in the original Hook area.
    const unexpected = "hooks/unreviewed-recovery.py",
      payload = Buffer.from("print('not reviewed')\n")
    await writeFile(join(rebuilt, unexpected), payload)
    const lockPath = join(rebuilt, "devclaw.business-assembly.json")
    const lock = JSON.parse(await readFile(lockPath, "utf8"))
    lock.files.push({
      path: unexpected,
      digest: createHash("sha256").update(payload).digest("hex")
    })
    await writeFile(lockPath, JSON.stringify(lock))
    const rejected = await readNativeCapabilityCatalog(
      {
        id: "rebuilt",
        path: rebuilt,
        name: "explicit-recovery-output",
        version: "1.0.0",
        enabled: true
      },
      "project"
    )
    expect(rejected.legacyAdapter).toBeUndefined()
  },
  30000
)
