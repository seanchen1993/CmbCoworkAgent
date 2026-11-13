import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { prepareAutobizPlanMergeSource } from "../../../scripts/prepare-autobiz-plan-merge-source"
import { prepareAutobizWorkflowWakeupSource } from "../../../scripts/prepare-autobiz-workflow-wakeup-source"
import { prepareAutobizSpecRoleSource } from "../../../scripts/prepare-autobiz-spec-role-source"
import { prepareAutobizUtestLiteralSource } from "../../../scripts/prepare-autobiz-utest-literal-source"
import { prepareAutobizKnowledgeMod } from "../../../scripts/prepare-autobiz-knowledge-mod"
import { assembleBusinessMods } from "./business-mod-assembler"
import { businessModCatalog } from "./business-mod-manifest"
import { isReviewedAutobizProtocol } from "./autobiz-composition-protocol"
import { snapshotDerivationSource, writeDerivationFiles } from "./derivation-source"

const inputs = resolve("tests/fixtures/autobiz-reviewed")
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
type FixtureFile = { path: string; sha256: string; bytes: number; mode?: number }

/** Fixed original inputs, original transforms, and an independently owned temporary directory. */
export async function createAutobizSourceFixture() {
  const provenance = JSON.parse(await readFile(join(inputs, "provenance.json"), "utf8")) as {
    files: { base: FixtureFile[]; observer: FixtureFile[]; archives: FixtureFile[] }
  }
  const root = await mkdtemp(join(tmpdir(), "autobiz-reviewed-source-"))
  const close = async () => {
    assert.equal(dirname(root), tmpdir())
    assert(root.split(/[\\/]/).at(-1)?.startsWith("autobiz-reviewed-source-"))
    await rm(root, { recursive: true, force: true })
  }
  try {
    async function copy(kind: "base" | "observer", destination: string) {
      const snapshot = await snapshotDerivationSource(join(inputs, kind))
      const expected = new Map(provenance.files[kind].map(file => [file.path, file]))
      assert.equal(snapshot.files.length, expected.size)
      assert.deepEqual(snapshot.excluded, [])
      for (const file of snapshot.files) {
        const original = expected.get(file.path)
        assert(original, file.path)
        assert.equal(file.digest, original.sha256, file.path)
        assert.equal(file.bytes.length, original.bytes, file.path)
      }
      await mkdir(destination)
      // Git's checkout permissions vary by platform. The historical snapshots used 0666.
      await writeDerivationFiles(destination, snapshot.files.map(file => ({ ...file, mode: 0o666 })))
    }
    for (const file of provenance.files.archives) {
      const bytes = await readFile(join(inputs, "archives", file.path))
      assert.equal(bytes.length, file.bytes)
      assert.equal(sha(bytes), file.sha256)
    }
    const base = join(root, "base"), merge = join(root, "merge"), wakeup = join(root, "wakeup"),
      spec = join(root, "spec"), utest = join(root, "utest")
    await copy("base", base)
    await prepareAutobizPlanMergeSource(merge, base)
    await prepareAutobizWorkflowWakeupSource(wakeup, merge)
    await prepareAutobizSpecRoleSource(spec, wakeup)
    await prepareAutobizUtestLiteralSource(utest, spec)
    const observerOriginal = join(root, "observer-original")
    await copy("observer", observerOriginal)
    async function observer(version: "1.0.2" | "1.0.3") {
      const directory = join(root, "observer-" + version)
      const original = await snapshotDerivationSource(observerOriginal)
      const changes = new Map<string, Buffer>()
      for (const name of ["plugin.json", "mods/business/manifest.json"]) {
        const value = JSON.parse(original.files.find(file => file.path === name)!.bytes.toString())
        if (name === "plugin.json") {
          assert.equal(value.version, "1.0.0")
          value.version = version
        } else {
          assert.deepEqual(value.kernelRef, { id: "autobiz.python-kernel", version: "1.0.0" })
          value.kernelRef.version = version
        }
        changes.set(name, Buffer.from(JSON.stringify(value, null, 2) + "\n"))
      }
      // The original matchingKernelSource changes only these two version declarations.
      await mkdir(directory)
      await writeDerivationFiles(directory, original.files.map(file => changes.has(file.path)
        ? { ...file, bytes: changes.get(file.path)!, digest: sha(changes.get(file.path)!) } : file))
      return directory
    }
    const observer103 = await observer("1.0.3")
    assert.equal((await snapshotDerivationSource(observer103)).digest,
      "5810c3eaec45761cd63f8eb727789b088eb7eb7450e28c7fd42f6d0acbcd00d8")
    const libraryInput = {
      source: utest, observer: observer103,
      warehouseArchive: join(inputs, "archives/producer-original.zip"),
      consumerArchive: join(inputs, "archives/consumer-original.zip")
    }
    return {
      root, base, merge, wakeup, spec, utest, libraryInput, close,
      async assemble(stage: "wakeup" | "spec") {
        const version = stage === "wakeup" ? "1.0.2" : "1.0.3"
        const observed = stage === "wakeup" ? await observer("1.0.2") : observer103
        const knowledge = join(root, "knowledge-" + version)
        await prepareAutobizKnowledgeMod(knowledge, version)
        const sources = await Promise.all([stage === "wakeup" ? wakeup : spec, observed, knowledge]
          .map(async directory => {
            const snapshot = await snapshotDerivationSource(directory)
            const catalog = businessModCatalog(snapshot)
            return { snapshot, catalog, modIds: [...catalog.modules.map(mod => mod.id),
              ...(catalog.extensions ?? []).map(mod => mod.id)] }
          }))
        const assembled = assembleBusinessMods(sources, {
          name: stage === "wakeup" ? "autobiz-complete-wakeup" : "autobiz-complete-spec-role",
          version, sources: []
        })
        assert.deepEqual(assembled.missingProviders, [])
        assert.equal(assembled.requiresFixedWorkflowAcknowledgement, false)
        assert(isReviewedAutobizProtocol(assembled))
        const output = join(root, "assembled-" + stage)
        await mkdir(output)
        await writeDerivationFiles(output, assembled.files)
        return output
      }
    }
  } catch (error) {
    await close()
    throw error
  }
}
