import test from "node:test"
import assert from "node:assert/strict"
import { metadata, markerMatches, validateTestMetadata, cleanupTestDatabase } from "../../../deploy/dev/service/test-database.mjs"

function stat(extra = {}) { return { uid: process.getuid(), mode: 0o600, nlink: 1, isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, ...extra } }
test("B1 checks private metadata before content (mode/uid/link/type/nlink)", () => {
  metadata(stat(), 0o600)
  for (const bad of [{ uid: process.getuid() + 1 }, { mode: 0o644 }, { nlink: 2 }, { isSymbolicLink: () => true }, { isFile: () => false }]) {
    assert.throws(() => metadata(stat(bad), 0o600), /B1_PRIVATE_METADATA/)
  }
})
test("B1 rejects unknown ownership and never adopts dev or forged test entries", async () => {
  const entry = { project: "devclaw-bot-test-0000000000000000", owner: "owner" }
  markerMatches({ project: entry.project, role: "test", owner: "owner" }, entry)
  for (const bad of [{ project: entry.project, role: "dev", owner: "owner" }, { project: entry.project, role: "test", owner: "other" }, { project: entry.project, role: "test", owner: "owner", arbitrary: true }]) {
    assert.throws(() => markerMatches(bad, entry), /B1_OWNER/)
  }
  for (const forged of [{ project: "devclaw-bot-dev" }, entry, null]) {
    await assert.rejects(validateTestMetadata(forged), /B1_UNREGISTERED/)
    await assert.rejects(cleanupTestDatabase(forged), /B1_UNREGISTERED/)
  }
})
