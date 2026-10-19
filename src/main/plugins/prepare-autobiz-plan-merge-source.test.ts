import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { snapshotDerivationSource } from "./derivation-source"
import {
  AUTOBIZ_AGGREGATE_TARGET_SHA256,
  AUTOBIZ_PLAN_MERGE_TARGET_SHA256,
  prepareAutobizPlanMergeSource,
  transformAutobizEvidenceAggregate,
  transformAutobizPlanWriter
} from "../../../scripts/prepare-autobiz-plan-merge-source"
import { prepareAutobizKnowledgeMod } from "../../../scripts/prepare-autobiz-knowledge-mod"

const fixtures: string[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    expect(dirname(fixture)).toBe(tmpdir())
    expect(basename(fixture)).toMatch(/^autobiz-merge-transform-/)
    await rm(fixture, { recursive: true, force: true })
  }
})
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const realSource = process.env.AUTOBIZ_PLAN_MERGE_UPSTREAM ?? "C:/ai/autobiz_kanban"
describe("reviewed AutoBiz plugin compatibility source preparation", () => {
  it("rejects unknown revisions before transforming either executable file", async () => {
    await expect(transformAutobizPlanWriter(Buffer.from("unknown writer"))).rejects.toThrow(
      "exact reviewed revision"
    )
    expect(() => transformAutobizEvidenceAggregate(Buffer.from("unknown aggregate"))).toThrow(
      "exact reviewed revision"
    )
  })
  it.skipIf(!existsSync(join(realSource, "hooks/plan_writer.py")))(
    "copies the exact upstream without overwriting and changes only two executables and identity metadata",
    async () => {
      const source = realSource
      const original = await snapshotDerivationSource(source)
      await expect(
        prepareAutobizPlanMergeSource(join(source, "must-not-write"), source)
      ).rejects.toThrow("outside the read-only upstream")
      const fixture = await mkdtemp(join(tmpdir(), "autobiz-merge-transform-"))
      fixtures.push(fixture)
      const output = join(fixture, "source")
      const receipt = await prepareAutobizPlanMergeSource(output, source)
      expect(receipt.kernelVersion).toBe("1.0.1")
      expect(receipt.plugin).toEqual({ name: "autobiz-plan-merge-compatible", version: "1.0.1" })
      expect(digest(await readFile(join(output, "hooks/plan_writer.py")))).toBe(
        AUTOBIZ_PLAN_MERGE_TARGET_SHA256
      )
      expect(digest(await readFile(join(output, "hooks/parallel_evidence_aggregate.py")))).toBe(
        AUTOBIZ_AGGREGATE_TARGET_SHA256
      )
      expect(receipt.changedFiles.sort()).toEqual([
        "devclaw.project-runtime.json",
        "hooks/parallel_evidence_aggregate.py",
        "hooks/plan_writer.py",
        "mods/business/manifest.json",
        "plugin.json"
      ])
      const copied = await snapshotDerivationSource(output)
      expect(copied.files).toHaveLength(original.files.length)
      for (const file of original.files) {
        if (!receipt.changedFiles.includes(file.path))
          expect(copied.files.find((item) => item.path === file.path)?.digest, file.path).toBe(
            file.digest
          )
      }
      await expect(prepareAutobizPlanMergeSource(output, source)).rejects.toThrow(/EEXIST/)
      expect((await snapshotDerivationSource(output)).digest).toBe(copied.digest)
      expect((await snapshotDerivationSource(source)).digest).toBe(original.digest)
    },
    // This integration case reads the real upstream tree five times and copies its whole
    // reviewed closure. Its IO budget is separate from the project's stage latency gates.
    60_000
  )
  it("prepares a knowledge source for the explicit reviewed kernel and rejects arbitrary versions", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "autobiz-merge-transform-"))
    fixtures.push(fixture)
    const output = join(fixture, "knowledge")
    await prepareAutobizKnowledgeMod(output, "1.0.1")
    const manifest = JSON.parse(await readFile(join(output, "mods/business/manifest.json"), "utf8"))
    expect(manifest.kernelRef).toEqual({ id: "autobiz.python-kernel", version: "1.0.1" })
    expect(manifest.extensions[0].contextProvider.required).toBe(true)
    await expect(prepareAutobizKnowledgeMod(join(fixture, "unknown"), "999.0.0")).rejects.toThrow(
      "Unsupported reviewed kernel"
    )
  })
})
