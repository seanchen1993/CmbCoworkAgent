import AdmZip from "adm-zip"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { assembleBusinessMods } from "./business-mod-assembler"
import { businessModCatalog } from "./business-mod-manifest"
import { snapshotDerivationSource, writeDerivationFiles } from "./derivation-source"
import { assertPackageExtensionCompatibility } from "./extension-contract"
import { readNativeCapabilityCatalog } from "./capability-catalog"
import { isReviewedAutobizProtocol } from "./autobiz-composition-protocol"
import { verifyReviewedBusinessAssembly } from "./autobiz-business-assembly-protocol"
import reviewed from "./autobiz-business-kernel-merge-reviewed.json"

const source = resolve("output/deliveries/mods-creator-accepted-20261017/Mods来源/AutoBiz")
const oldArchive = resolve("output/deliveries/mods-verified-artifacts-20261017/12-数仓可验证产物导出版.zip")
const roots: string[] = []
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(dirname(root)).toBe(tmpdir())
    expect(root.split(/[\\/]/).at(-1)).toMatch(/^project-agent-closure-/)
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(!existsSync(source) || !existsSync(oldArchive))(
  "refuses the actual incomplete 12 ZIP and admits a real selected-source assembly with pinned agent bytes", async () => {
    const archiveBytes = await readFile(oldArchive)
    const beforeHash = sha(archiveBytes)
    const oldFiles = new AdmZip(archiveBytes).getEntries().filter(entry => !entry.isDirectory)
      .map(entry => { const bytes = entry.getData(); return {
        path: entry.entryName, bytes, digest: sha(bytes), mode: 0o644
      } })
    expect(isReviewedAutobizProtocol({ files: oldFiles })).toBe(false)
    const oldRoot = await mkdtemp(join(tmpdir(), "project-agent-closure-old-"))
    roots.push(oldRoot)
    await writeDerivationFiles(oldRoot, oldFiles)
    expect(() => assertPackageExtensionCompatibility(oldRoot)).toThrow("PROJECT_AGENT_RESOURCE_MISSING")
    const identity = JSON.parse(oldFiles.find(file => file.path === "plugin.json")!.bytes.toString())
    const oldCatalog = await readNativeCapabilityCatalog({ id: "old-12", name: identity.name,
      version: identity.version, path: oldRoot, enabled: true }, "project")
    expect(oldCatalog.status).toBe("invalid")
    expect(oldCatalog.reasons.join()).toContain("PROJECT_AGENT_RESOURCE_MISSING")

    const original = await snapshotDerivationSource(source)
    const result = assembleBusinessMods([{ snapshot: original, catalog: businessModCatalog(original),
      modIds: ["biz.prd", "dev.specs"] }], { name: "reviewed-agent-closure", version: "1.0.0", sources: [] })
    for (const path of ["agents/explore.md", "agents/critic.md"])
      expect(result.files.find(file => file.path === path)?.bytes)
        .toEqual(original.files.find(file => file.path === path)!.bytes)
    expect(verifyReviewedBusinessAssembly(result, reviewed)).toBe(true)
    expect(isReviewedAutobizProtocol(result)).toBe(true)
    const newRoot = await mkdtemp(join(tmpdir(), "project-agent-closure-new-"))
    roots.push(newRoot)
    await writeDerivationFiles(newRoot, result.files)
    expect(() => assertPackageExtensionCompatibility(newRoot)).not.toThrow()
    const admitted = await readNativeCapabilityCatalog({ id: "new-closure", name: "reviewed-agent-closure",
      version: "1.0.0", path: newRoot, enabled: true }, "project")
    expect(admitted.legacyAdapter).toBe("autobiz-v1")

    const agent = result.files.find(file => file.path === "agents/explore.md")!
    agent.bytes = Buffer.from("---\nname: unauthorized-replacement\n---\nChanged instructions")
    const lockFile = result.files.find(file => file.path === "devclaw.business-assembly.json")!
    const lock = JSON.parse(lockFile.bytes.toString())
    lock.files.find((file: { path: string }) => file.path === agent.path).digest = sha(agent.bytes)
    lockFile.bytes = Buffer.from(JSON.stringify(lock))
    expect(verifyReviewedBusinessAssembly(result, reviewed)).toBe(false)
    expect(isReviewedAutobizProtocol(result)).toBe(false)
    expect(sha(await readFile(oldArchive))).toBe(beforeHash)
    expect((await snapshotDerivationSource(source)).digest).toBe(original.digest)
  }, 30_000
)
