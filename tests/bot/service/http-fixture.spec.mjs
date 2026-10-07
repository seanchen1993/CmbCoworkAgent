import { test } from "node:test"
import assert from "node:assert/strict"
import { chmod, lstat, writeFile, link, unlink, readFile } from "node:fs/promises"
import { join } from "node:path"
import { createHttpFixture, checkHttpFixture, readHttpIdentity, closeHttpFixture, validateHttpPrincipals, verifyHttpMetadata } from "../../../deploy/dev/service/http-fixture.mjs"

function principals() { return [{ principalId: "p:A.1", active: true, spaces: [{ spaceId: "A", member: true, canCreateBot: true, canCreateGroup: false, knowledgeRefs: ["k:1"], repositoryRefs: [], skillAllowlist: [], capabilityCeiling: ["repository.read"] }] }] }
test("HTTP identity has exact source IDs/enums and finite closed grants", () => {
  validateHttpPrincipals(principals())
  for (const mutate of [p => p[0].active = 1, p => p[0].spaces[0].member = false, p => p[0].spaces[0].knowledgeRefs.push("k:1"), p => p[0].spaces[0].capabilityCeiling.push("repository.write"), p => p[0].spaces[0].owner = "self", p => p.push(p[0])]) {
    const p = principals(); mutate(p); assert.throws(() => validateHttpPrincipals(p), /C2_IDENTITY_FILE/)
  }
})
test("registered private identity file checks metadata before reads and refuses unknown/aborted", async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(createHttpFixture(principals(), controller.signal), /B1_CANCELLED/)
  await assert.rejects(readHttpIdentity({ file: "/unowned-not-readable", dir: "/unowned" }), /C2_IDENTITY_FILE/)
  const entry = await createHttpFixture(principals())
  try {
    const value = await readHttpIdentity(entry); assert.equal(value.bearers.length, 1); assert.match(value.bearers[0].token, /^[a-f0-9]{64}$/)
    const stat = await lstat(entry.file)
    for (const patch of [{ ino: stat.ino + 1 }, { uid: stat.uid + 1 }, { mode: 0o644 }, { nlink: 2 }, { isSymbolicLink: () => true }]) assert.throws(() => verifyHttpMetadata({ ...stat, isFile: () => true, isSymbolicLink: () => false, ...patch }, stat), /C2_IDENTITY_FILE/)
    await chmod(entry.file, 0o644); await assert.rejects(readHttpIdentity(entry), /C2_IDENTITY_FILE/); await chmod(entry.file, 0o600)
    const extra = join(entry.dir, "unexpected"); await writeFile(extra, "x", { mode: 0o600, flag: "wx" }); await assert.rejects(checkHttpFixture(entry), /C2_IDENTITY_FILE/); await unlink(extra)
    const alias = join(entry.dir, "alias"); await link(entry.file, alias); await assert.rejects(readHttpIdentity(entry), /C2_IDENTITY_FILE/); await unlink(alias)
    const bytes = await readFile(entry.file); await writeFile(entry.file, "{}", { mode: 0o600 }); await assert.rejects(readHttpIdentity(entry), /C2_IDENTITY_FILE/); await writeFile(entry.file, bytes, { mode: 0o600 })
    await assert.rejects(readHttpIdentity(entry, controller.signal), /B1_CANCELLED/)
  } finally { await closeHttpFixture(entry) }
  await assert.rejects(lstat(entry.dir), { code: "ENOENT" })
})
