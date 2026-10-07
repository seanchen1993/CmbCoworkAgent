import { lstat, readdir, writeFile, open } from "node:fs/promises"
import { constants } from "node:fs"
import { join } from "node:path"
import { randomBytes, createHash } from "node:crypto"
import { privateTemp, removePrivateTemp } from "../process.mjs"
import { active } from "./test-database.mjs"
import { validator } from "../../../tests/bot/schema-support.mjs"

const entries = new WeakMap(), hash = bytes => createHash("sha256").update(bytes).digest("hex")
const fail = () => { throw Error("C2_IDENTITY_FILE") }
function keys(value, names) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...names].sort().join()) fail() }
function ids(values) { if (!Array.isArray(values) || values.length > 64 || new Set(values).size !== values.length || values.some(id => !validator("Id")(id))) fail() }
export function validateHttpPrincipals(principals) {
  if (!Array.isArray(principals) || !principals.length || principals.length > 16) fail()
  const seen = new Set()
  for (const p of principals) {
    keys(p, ["principalId", "active", "spaces"])
    if (!validator("Id")(p.principalId) || seen.has(p.principalId) || typeof p.active !== "boolean" || !Array.isArray(p.spaces) || p.spaces.length > 16) fail()
    seen.add(p.principalId); const spaces = new Set()
    for (const s of p.spaces) {
      keys(s, ["spaceId", "member", "canCreateBot", "canCreateGroup", "knowledgeRefs", "repositoryRefs", "skillAllowlist", "capabilityCeiling"])
      if (!validator("Id")(s.spaceId) || spaces.has(s.spaceId) || [s.member, s.canCreateBot, s.canCreateGroup].some(x => typeof x !== "boolean")) fail()
      spaces.add(s.spaceId)
      for (const values of [s.knowledgeRefs, s.repositoryRefs, s.skillAllowlist]) ids(values)
      if (!Array.isArray(s.capabilityCeiling) || s.capabilityCeiling.length > 16 || new Set(s.capabilityCeiling).size !== s.capabilityCeiling.length || s.capabilityCeiling.some(x => !validator("Capability")(x))) fail()
      if (!s.member && (s.canCreateBot || s.canCreateGroup || s.knowledgeRefs.length || s.repositoryRefs.length || s.skillAllowlist.length || s.capabilityCeiling.length)) fail()
    }
  }
}
export function verifyHttpMetadata(stat, expected, directory = false) {
  if (!stat || !expected || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.ino !== expected.ino || stat.dev !== expected.dev || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail()
}
export async function createHttpFixture(principals, signal) {
  active(signal); validateHttpPrincipals(principals)
  const dir = await privateTemp(); let entry
  try {
    active(signal)
    const identity = { principals, bearers: principals.map(p => ({ principalId: p.principalId, token: randomBytes(32).toString("hex") })) }
    const bytes = Buffer.from(JSON.stringify(identity)), file = join(dir, "identity.json")
    if (bytes.length > 65536) fail()
    await writeFile(file, bytes, { mode: 0o600, flag: "wx" }); active(signal)
    entry = Object.freeze({ dir, file }); entries.set(entry, { directory: await lstat(dir), file: await lstat(file), digest: hash(bytes) })
    await checkHttpFixture(entry, signal)
    return entry
  } catch (error) { await removePrivateTemp(dir); throw error }
}
export async function checkHttpFixture(entry, signal) {
  active(signal); const owner = entries.get(entry); if (!owner) fail()
  verifyHttpMetadata(await lstat(entry.dir), owner.directory, true)
  if ((await readdir(entry.dir)).join() !== "identity.json") fail()
  verifyHttpMetadata(await lstat(entry.file), owner.file); active(signal)
  return owner
}
export async function readHttpIdentity(entry, signal) {
  const owner = await checkHttpFixture(entry, signal); active(signal)
  const file = await open(entry.file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    verifyHttpMetadata(await file.stat(), owner.file); active(signal)
    const bytes = await file.readFile(); active(signal)
    if (bytes.length > 65536 || hash(bytes) !== owner.digest) fail()
    await checkHttpFixture(entry, signal); active(signal)
    return JSON.parse(bytes.toString("utf8"))
  } finally { await file.close() }
}
export async function closeHttpFixture(entry) {
  await checkHttpFixture(entry); await removePrivateTemp(entry.dir); entries.delete(entry)
}
