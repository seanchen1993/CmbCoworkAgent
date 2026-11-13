import { mkdtemp, writeFile, readFile, symlink, unlink, link, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { resolveCheckpointDatabaseIdentity, assertCheckpointDatabasePathCurrent,
  readCheckpointDatabaseFileIdentity, assertCheckpointDatabaseFileIdentity } from "./checkpoint-database-identity"
const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture() { const root = await mkdtemp(join(tmpdir(), "checkpoint-identity-")); directories.push(root); return root }

it("keeps physical-parent identity stable across creation and directory aliases", async () => {
  const root = await fixture(), actual = join(root, "actual"), alias = join(root, "alias")
  await mkdir(actual)
  await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir")
  const before = await resolveCheckpointDatabaseIdentity(join(alias, "thread.sqlite"))
  const otherBefore = await resolveCheckpointDatabaseIdentity(join(actual, "thread.sqlite"))
  expect(before.key).toBe(otherBefore.key)
  await writeFile(join(actual, "thread.sqlite"), "original")
  const after = await resolveCheckpointDatabaseIdentity(join(alias, "thread.sqlite"))
  expect(after.key).toBe(before.key)
  expect(after.path).toBe(otherBefore.path)
  await assertCheckpointDatabasePathCurrent(after)
  if (process.platform === "win32")
    expect((await resolveCheckpointDatabaseIdentity(join(actual.toUpperCase(), "THREAD.SQLITE"))).key).toBe(after.key)
})

it("does not chase a retargeted alias with the original file admission", async () => {
  const root = await fixture(), first = join(root, "first"), second = join(root, "second"), alias = join(root, "alias")
  await mkdir(first); await mkdir(second)
  await writeFile(join(first, "thread.sqlite"), "first")
  await writeFile(join(second, "thread.sqlite"), "second")
  const kind = process.platform === "win32" ? "junction" : "dir"
  await symlink(first, alias, kind)
  const original = await resolveCheckpointDatabaseIdentity(join(alias, "thread.sqlite"))
  await unlink(alias); await symlink(second, alias, kind)
  await expect(assertCheckpointDatabasePathCurrent(original)).rejects.toThrow("DATABASE_IDENTITY_CHANGED")
  expect((await resolveCheckpointDatabaseIdentity(join(alias, "thread.sqlite"))).key).not.toBe(original.key)
  expect(await readFile(original.path, "utf8")).toBe("first")
})

it("rejects a missing-file parent retarget before creating the database", async () => {
  const root = await fixture(), first = join(root, "first"), second = join(root, "second"), alias = join(root, "alias")
  await mkdir(first); await mkdir(second)
  const kind = process.platform === "win32" ? "junction" : "dir"
  await symlink(first, alias, kind)
  const original = await resolveCheckpointDatabaseIdentity(join(alias, "thread.sqlite"))
  await assertCheckpointDatabasePathCurrent(original)
  await unlink(alias); await symlink(second, alias, kind)
  await expect(assertCheckpointDatabasePathCurrent(original)).rejects.toThrow("DATABASE_IDENTITY_CHANGED")
  await expect(readFile(join(first, "thread.sqlite"))).rejects.toMatchObject({ code: "ENOENT" })
  await expect(readFile(join(second, "thread.sqlite"))).rejects.toMatchObject({ code: "ENOENT" })
})

it("does not recreate a disappeared parent while checking an existing admission", async () => {
  const root = await fixture(), parent = join(root, "removed")
  const original = await resolveCheckpointDatabaseIdentity(join(parent, "thread.sqlite"))
  await rm(parent, { recursive: true })
  await expect(assertCheckpointDatabasePathCurrent(original)).rejects.toMatchObject({
    message: "SQLJS_SAVER_DATABASE_IDENTITY_CHANGED", cause: { code: "ENOENT" }
  })
  await expect(readFile(join(parent, "thread.sqlite"))).rejects.toMatchObject({ code: "ENOENT" })
  await expect(import("node:fs/promises").then(fs => fs.stat(parent))).rejects.toMatchObject({ code: "ENOENT" })
})

it("rejects file replacement and hard links without modifying either database", async () => {
  const root = await fixture(), path = join(root, "thread.sqlite"), alias = join(root, "other.sqlite")
  await writeFile(path, "original")
  const original = await readCheckpointDatabaseFileIdentity(path)
  await unlink(path); await writeFile(path, "replacement")
  await expect(assertCheckpointDatabaseFileIdentity(path, original)).rejects.toThrow("DATABASE_IDENTITY_CHANGED")
  await link(path, alias)
  await expect(resolveCheckpointDatabaseIdentity(path)).rejects.toThrow("HARD_LINK_DATABASE_UNSUPPORTED")
  expect(await readFile(path, "utf8")).toBe("replacement")
  expect(await readFile(alias, "utf8")).toBe("replacement")
})
