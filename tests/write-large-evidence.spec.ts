import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeLargeEvidence } from "./support/write-large-evidence"

const directory = mkdtempSync(join(tmpdir(), "devclaw-large-evidence-"))
try {
  const file = join(directory, "evidence.json")
  const evidence = {
    passed: true,
    omitted: undefined,
    rounds: Array.from({ length: 8 }, (_, turn) => ({
      turn,
      text: "真实帧\\\"\n".repeat(200_000),
      samples: [{ count: 1, marker: "回答" }, null]
    })),
    empty: [],
    profile: { maxMs: 100, skipped: undefined }
  }
  writeLargeEvidence(file, evidence)
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), JSON.parse(JSON.stringify(evidence)))
  writeLargeEvidence(file, { rounds: [undefined, false, 0], passed: false })
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { rounds: [null, false, 0], passed: false })
  const previous = readFileSync(file)
  const circular: Record<string, unknown> = {}
  circular.self = circular
  for (const invalid of [circular, { unsupported: 1n }]) {
    assert.throws(() => writeLargeEvidence(file, { rounds: [invalid] }), TypeError)
    assert.deepEqual(readFileSync(file), previous, "failed serialization keeps the complete old proof")
  }
  console.log("PASS complete large evidence values, Unicode/escaping, array nulls and atomic replacement")
} finally {
  rmSync(directory, { recursive: true, force: true })
}
