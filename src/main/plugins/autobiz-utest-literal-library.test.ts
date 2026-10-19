import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import AdmZip from "adm-zip"
import { beforeAll, expect, it } from "vitest"
import {
  packageAutobizUtestLiteralLibrary,
  AUTOBIZ_UTEST_LIBRARY_DEFAULTS,
  AUTOBIZ_UTEST_LIBRARY_CONSUMER_SHA256
} from "../../../scripts/package-autobiz-utest-literal-library"
import { prepareAutobizKnowledgeMod } from "../../../scripts/prepare-autobiz-knowledge-mod"
import {
  AUTOBIZ_UTEST_LITERAL_PATH,
  AUTOBIZ_UTEST_LITERAL_TO_SHA256,
  AUTOBIZ_UTEST_LITERAL_WORKFLOW_SHA256
} from "../../../scripts/prepare-autobiz-utest-literal-source"
import { snapshotDerivationSource } from "./derivation-source"
import { businessModCatalog } from "./business-mod-manifest"
import { isReviewedAutobizProtocol } from "./autobiz-composition-protocol"

const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex")
let root: string, output: string
let receipt: Awaited<ReturnType<typeof packageAutobizUtestLiteralLibrary>>
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "autobiz-utest-library-"))
  output = join(root, "fresh-library")
  receipt = await packageAutobizUtestLiteralLibrary(output)
}, 120000)

it("packages both original flows under exact v104 admission with complete ZIP byte roundtrips", async () => {
  expect(receipt.kernelVersion).toBe("1.0.4")
  expect(receipt.packages).toHaveLength(3)
  for (const item of receipt.packages.slice(0, 2)) {
    const snapshot = await snapshotDerivationSource(item.directory)
    expect(isReviewedAutobizProtocol(snapshot), item.name).toBe(true)
    const bytes = readFileSync(join(output, item.file)),
      zip = new AdmZip(bytes)
    expect(hash(bytes)).toBe(item.sha256)
    expect(zip.getEntries().filter((entry) => !entry.isDirectory)).toHaveLength(
      snapshot.files.length
    )
    for (const file of snapshot.files)
      expect(zip.readFile(file.path)?.equals(file.bytes), file.path).toBe(true)
    expect(hash(zip.readFile(AUTOBIZ_UTEST_LITERAL_PATH)!)).toBe(AUTOBIZ_UTEST_LITERAL_TO_SHA256)
    const workflow = zip.readFile("workflows/code-batched-execution.workflow.js")
    if (item.file.startsWith("10-"))
      expect(hash(workflow!)).toBe(AUTOBIZ_UTEST_LITERAL_WORKFLOW_SHA256)
    else expect(workflow).toBeNull() // The independent five-stage producer does not select dev.code.
    const catalog = businessModCatalog(snapshot)
    expect(catalog.kernel?.version).toBe("1.0.4")
    expect(catalog.extensions?.map((extension) => extension.id).sort()).toEqual([
      "autobiz.knowledge",
      "autobiz.worktree-progress"
    ])
    const metadata = JSON.parse(zip.readAsText("plugin.json"))
    expect(metadata.version).toBe("1.0.4")
    expect(metadata.name).toBe(item.name)
  }
  const producer = new AdmZip(readFileSync(join(output, receipt.packages[1].file)))
  const runtime = JSON.parse(producer.readAsText("devclaw.project-runtime.json"))
  expect(runtime.extensionContract.verifiedArtifacts.artifactIds).toEqual([
    "warehouse_sql_results",
    "warehouse_quality"
  ])
}, 30000)

it("retains every generic consumer ZIP byte and all observer implementation bytes", async () => {
  const original = readFileSync(AUTOBIZ_UTEST_LIBRARY_DEFAULTS.consumerArchive)
  expect(readFileSync(join(output, "13-通用JSON产物消费Mod.zip")).equals(original)).toBe(true)
  expect(hash(original)).toBe(AUTOBIZ_UTEST_LIBRARY_CONSUMER_SHA256)
  const before = await snapshotDerivationSource(AUTOBIZ_UTEST_LIBRARY_DEFAULTS.observer)
  const after = await snapshotDerivationSource(join(output, "Mods来源/Worktree进度Mod"))
  expect(after.files).toHaveLength(before.files.length)
  const changed = after.files.filter(
    (file) => file.digest !== before.files.find((prior) => prior.path === file.path)?.digest
  )
  expect(changed.map((file) => file.path).sort()).toEqual([
    "mods/business/manifest.json",
    "plugin.json"
  ])
  expect(receipt.consumerByteIdentical).toBe(true)
  expect(receipt.immutableInputsUnchanged).toBe(true)
})

it("does not overwrite the fresh library or touch an immutable source directory", async () => {
  const before = readFileSync(join(output, "13-通用JSON产物消费Mod.zip"))
  await expect(packageAutobizUtestLiteralLibrary(output)).rejects.toThrow("OUTPUT_EXISTS")
  await expect(
    packageAutobizUtestLiteralLibrary(join(AUTOBIZ_UTEST_LIBRARY_DEFAULTS.source, "invalid"))
  ).rejects.toThrow("outside immutable inputs")
  expect(readFileSync(join(output, "13-通用JSON产物消费Mod.zip")).equals(before)).toBe(true)
})

it("rejects an unreviewed source without allocating a library and retains strict knowledge version admission", async () => {
  const unknown = join(root, "unknown"),
    target = join(root, "rejected")
  await mkdir(unknown)
  await writeFile(
    join(unknown, "plugin.json"),
    JSON.stringify({ name: "unknown", version: "1.0.4" })
  )
  await expect(
    packageAutobizUtestLiteralLibrary(target, {
      ...AUTOBIZ_UTEST_LIBRARY_DEFAULTS,
      source: unknown
    })
  ).rejects.toThrow("Exact reviewed 1.0.4 source required")
  await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" })
  await expect(
    prepareAutobizKnowledgeMod(join(root, "unknown-knowledge"), "1.0.5")
  ).rejects.toThrow("Unsupported reviewed kernel version")
  const knowledge = businessModCatalog(
    await snapshotDerivationSource(join(output, "Mods来源/知识与上下文Mod"))
  )
  expect(knowledge.kernelRef?.version).toBe("1.0.4")
  expect(knowledge.extensions?.map((extension) => extension.id)).toEqual(["autobiz.knowledge"])
})
