import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  validateDeliveredMatrixEvidence,
  verifyDeliveredMatrixSourceProof
} from "../support/matrix-delivered-source-proof"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert(
      /^matrix-source-proof-/.test(
        root
          .slice(root.lastIndexOf("\\") + 1)
          .split("/")
          .at(-1)!
      )
    )
    await rm(root, { recursive: true, force: true })
  }
})

// A deliberately synthetic structural fixture. It never launches an app or claims execution.
function records() {
  const sourceDigest = "a".repeat(64),
    digest = "b".repeat(64),
    oldDigest = "c".repeat(64)
  const zip = {
    sourceDigest,
    zip: "synthetic.zip",
    sha256: "d".repeat(64),
    oldInstallation: "old",
    newInstallation: "new",
    packageDigest: digest,
    originalPackageDigest: oldDigest,
    packageIdentity: {
      originalContentDigest: oldDigest,
      zipContentDigest: digest,
      zipSha256: "d".repeat(64)
    },
    upload: "original-PluginsPanel-file-input",
    copiedGrants: false
  }
  const trial = { status: "completed", stages: ["draft"], stageIndex: 1 }
  const delivery = {
    id: "11111111-1111-1111-1111-111111111111",
    pluginId: "new",
    originalPluginId: "old",
    name: "synthetic",
    version: "1.0.0",
    digest,
    sourceDigest
  }
  const identity = { pluginId: "new", name: delivery.name, version: delivery.version, digest }
  return {
    caseRun: { scenario: "report-derived", realModel: true, driverIntegrityVerified: true },
    evidence: {
      model: { realProvider: true },
      observations: [
        {
          requests: [{ status: 200 }],
          runtime: {
            controlled: false,
            requests: 1,
            stages: [{ requests: [{ status: 200 }] }],
            project: {
              controlledOutputs: false,
              trial,
              delivery,
              sameCandidateDigest: sourceDigest,
              zip
            }
          }
        }
      ]
    },
    runtime: {
      events: [
        { trial },
        { status: "succeeded", stageId: "draft", checks: [{ result: "passed" }] },
        { operation: "zip-original-upload", ...zip, identity }
      ]
    },
    first: { draftId: "example", revision: 1, digest: "e".repeat(64) },
    assembly: {
      originVerified: true,
      assemblyVerified: true,
      after: { draftId: "example", revision: 2, digest: sourceDigest }
    }
  }
}

describe("delivered matrix source proof", () => {
  it.each(["source.txt", "export.zip", "matrix-1-assembly.json", "evidence.json"])(
    "rejects changed %s bytes and leaves the file intact",
    async (name) => {
      const root = await mkdtemp(join(tmpdir(), "matrix-source-proof-"))
      roots.push(root)
      const path = join(root, name)
      await writeFile(path, "original evidence bytes")
      const hashes = {
        [path]: createHash("sha256")
          .update(await readFile(path))
          .digest("hex")
      }
      await expect(verifyDeliveredMatrixSourceProof({ hashes })).resolves.toBeUndefined()
      await writeFile(path, "changed evidence bytes")
      await expect(verifyDeliveredMatrixSourceProof({ hashes })).rejects.toThrow(
        "DELIVERED_SOURCE_CHANGED"
      )
      expect(await readFile(path, "utf8")).toBe("changed evidence bytes")
    }
  )

  it("requires a nonempty absolute byte fence", async () => {
    await expect(verifyDeliveredMatrixSourceProof({ hashes: {} })).rejects.toThrow(
      "HASHES_REQUIRED"
    )
    await expect(
      verifyDeliveredMatrixSourceProof({ hashes: { relative: "a".repeat(64) } })
    ).rejects.toThrow("ABSOLUTE_PATH_REQUIRED")
  })

  it("validates producer links without treating them as new execution", () => {
    const result = validateDeliveredMatrixEvidence(records())
    expect(result.authorRequests).toBe(1)
    expect(result.runtimeRequests).toBe(1)
  })

  it.each(["author-status", "controlled", "stage-check", "source", "assembly", "zip", "upload"])(
    "rejects an inconsistent historical %s producer record",
    (change) => {
      const input = records()
      if (change === "author-status") input.evidence.observations[0].requests[0].status = 429
      if (change === "controlled") input.evidence.observations[0].runtime.controlled = true
      if (change === "stage-check") input.runtime.events[1].checks![0].result = "failed"
      if (change === "source") input.assembly.after.digest = "f".repeat(64)
      if (change === "assembly") input.assembly.originVerified = false
      if (change === "zip")
        input.evidence.observations[0].runtime.project.delivery.digest = "f".repeat(64)
      if (change === "upload") {
        const upload = input.runtime.events.find((event) => "copiedGrants" in event)
        assert(upload && "copiedGrants" in upload)
        upload.copiedGrants = true
      }
      expect(() => validateDeliveredMatrixEvidence(input)).toThrow()
    }
  )
})
