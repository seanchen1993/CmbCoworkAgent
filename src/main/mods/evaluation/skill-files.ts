import { createHash, randomUUID } from "node:crypto"
import {
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  linkSync,
  unlinkSync,
  lstatSync,
  readdirSync
} from "node:fs"
import { join, resolve } from "node:path"
import {
  acquireWindowsPublicationLease,
  publicationDirectoryAncestors
} from "../flows/windows-publication-lease"
import { readPlainSkill, skillPath, skillTextDigest } from "./skill-snapshots"
import type { EvaluationScope } from "./runner"

/** Windows handle exclusion plus exact source CAS. Unknown effects keep the original backup.
 * This never decrypts config, runs a Skill, auto-enables it or rewrites the optimizer candidate.
 */
export class SkillSnapshotFiles {
  constructor(
    readonly root: string,
    readonly backups: string,
    private readonly assertSource: (id: string) => void = () => {}
  ) {
    Object.freeze(this)
  }
  read(id: string) {
    this.assertSource(id)
    return readPlainSkill(this.root, id)
  }
  async replace(input: {
    skillId: string
    expected: string | null
    next: string | null
    scope: EvaluationScope
    beforeEffect(directory: string): void
  }): Promise<string> {
    if (process.platform !== "win32") throw Error("SKILL_EVALUATION_UNSUPPORTED")
    const { skillId, expected, next, scope, beforeEffect } = input
    const { signal, assertCurrent } = scope
    let lease: Awaited<ReturnType<typeof acquireWindowsPublicationLease>> | undefined
    const guard = () => {
      signal.throwIfAborted()
      lease?.assertAlive()
      assertCurrent()
      signal.throwIfAborted()
      lease?.assertAlive()
    }
    const directory = skillPath(this.root, skillId),
      target = join(directory, "SKILL.md")
    guard()
    if (this.read(skillId) !== expected) throw Error("SKILL_EVALUATION_STALE")
    mkdirSync(this.backups, { recursive: true })
    if (lstatSync(this.backups).isSymbolicLink()) throw Error("SKILL_EVALUATION_UNSUPPORTED")
    if (readdirSync(this.backups).length >= 32) throw Error("SKILL_EVALUATION_LIMIT")
    const backup = join(resolve(this.backups), randomUUID())
    mkdirSync(backup, { recursive: false })
    let exists = true
    try {
      lstatSync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      exists = false
    }
    try {
      lease = await acquireWindowsPublicationLease({
        directories: publicationDirectoryAncestors([
          this.root,
          backup,
          ...(exists ? [directory] : [])
        ]),
        files:
          expected === null
            ? []
            : [
                {
                  path: target,
                  digest: this.rawDigest(expected),
                  backup: join(backup, "before.txt")
                }
              ],
        createdDirectories: exists ? [] : [directory],
        publishedFiles: next === null ? [] : [{ path: target, digest: this.rawDigest(next) }],
        signal,
        assertCurrent: guard
      })
      guard()
      if (this.read(skillId) !== expected) throw Error("SKILL_EVALUATION_STALE")
      // The caller persists intent BEFORE the first modification to the live Skill directory.
      beforeEffect(backup)
      guard()
      if (!exists) {
        mkdirSync(directory, { recursive: false })
        await lease.lockCreatedDirectory(0)
      }
      if (next !== null) {
        const fd = openSync(join(backup, "after.txt"), "wx", 0o600)
        try {
          writeFileSync(fd, next, "utf8")
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
      }
      guard()
      if (expected !== null) await lease.backup(0)
      guard()
      if (next !== null) {
        linkSync(join(backup, "after.txt"), target)
        unlinkSync(join(backup, "after.txt"))
        await lease.lockPublishedFile(0)
      }
      guard()
      if (this.read(skillId) !== next) throw Error("SKILL_EVALUATION_STALE")
      await lease.close()
      lease = undefined
      signal.throwIfAborted()
      assertCurrent()
      signal.throwIfAborted()
      return backup
    } finally {
      await lease?.close()
    }
  }
  private rawDigest(text: string) {
    // Raw file hash is the handle helper's protocol; persistent semantic hashes distinguish absence.
    return requireHash(text)
  }
}
const requireHash = (text: string) => createHash("sha256").update(text).digest("hex")
export { skillTextDigest }
