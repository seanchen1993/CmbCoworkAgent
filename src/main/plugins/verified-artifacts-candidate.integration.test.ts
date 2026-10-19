import AdmZip from "adm-zip"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"
import { assertPackageExtensionCompatibility } from "./extension-contract"
import { readNativeCapabilityCatalog } from "./capability-catalog"

const archive = process.env.VERIFIED_ARTIFACTS_CANDIDATE_ARCHIVE
const source = process.env.VERIFIED_ARTIFACTS_KERNEL_SOURCE
it.skipIf(!archive || !source)("admits the actual new export ZIP with exact reviewed agent resources and refuses changed bytes", async () => {
  const bytes = await readFile(resolve(archive!))
  const digest = createHash("sha256").update(bytes).digest("hex")
  const zip = new AdmZip(bytes)
  const root = await mkdtemp(join(tmpdir(), "verified-candidate-"))
  try {
    zip.extractAllTo(root, false)
    const plugin = JSON.parse(zip.readAsText("plugin.json"))
    const manifest = JSON.parse(zip.readAsText("devclaw.project-runtime.json"))
    expect(plugin.version).toBe("1.0.1")
    expect(manifest.extensionContract.verifiedArtifacts.artifactIds)
      .toEqual(["warehouse_sql_results", "warehouse_quality"])
    expect(manifest.runtime.stages.map((stage: { id: string }) => stage.id))
      .toEqual(["biz.prd", "dev.specs", "warehouse.model", "warehouse.sql", "warehouse.quality"])
    for (const path of ["agents/explore_spec.md", "agents/critic.md"])
      expect(zip.readFile(path)).toEqual(await readFile(join(source!, path)))
    expect(zip.readFile("agents/explore.md")).toBeNull()
    expect(() => assertPackageExtensionCompatibility(root)).not.toThrow()
    const catalog = await readNativeCapabilityCatalog({ ...plugin, id: "new-candidate",
      path: root, enabled: true }, "project")
    expect(catalog.status, catalog.reasons.join(";")).toBe("declared")
    expect(catalog.legacyAdapter).toBe("autobiz-v1")
    await writeFile(join(root, "agents/explore_spec.md"), "---\nname: altered-agent\n---\nChanged instructions")
    expect(() => assertPackageExtensionCompatibility(root)).toThrow()
    expect(createHash("sha256").update(await readFile(resolve(archive!))).digest("hex")).toBe(digest)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
