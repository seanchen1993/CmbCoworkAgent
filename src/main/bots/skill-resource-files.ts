import { createHash } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import { lstat, opendir, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { BOT_FILE_BYTES } from "../../shared/bot-files"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"
import {
  BOT_SKILL_RESOURCE_ENTRIES,
  type BotSkillResource,
  type BotExternalSkill
} from "./skill-catalog-contract"
import { hasControlCharacters } from "./validation"

const ignored = new Set([".git", "node_modules", ".venv", "__pycache__"])
function validPart(part: string): boolean {
  return (
    Boolean(part) &&
    !part.startsWith(".") &&
    part !== ".." &&
    !/[<>:"|?*\\/]/.test(part) &&
    !hasControlCharacters(part) &&
    !/[. ]$/.test(part) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
    !ignored.has(part.toLowerCase())
  )
}
export function skillResourcePath(value: string): string {
  if (value.length > 4096 || !value.split("/").every(validPart))
    throw new Error("技能文件必须使用目录内的相对路径")
  return value
}
export function skillFileStamp(info: {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":")
}

/** Bounded metadata scan in the existing disposable catalog worker. Contents stay on
 * disk; paths, file versions and directory topology form the accepted skill revision.
 */
export async function scanSkillResources(root: string): Promise<BotSkillResource[]> {
  const entries: BotSkillResource[] = []
  let visited = 0
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 12 || entries.length >= BOT_SKILL_RESOURCE_ENTRIES)
      throw new Error("技能附属文件过多或目录过深")
    const candidate = relative === "." ? root : join(root, relative)
    const info = await lstat(candidate, { bigint: true })
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) return
    if (!info.isDirectory() && info.nlink !== 1n) return
    // Cmb discovers nested SKILL.md directories as independent skills. A parent
    // must not grant its disabled child's resources through an alternate path.
    if (relative !== "." && info.isDirectory()) {
      const nested = await lstat(join(candidate, "SKILL.md")).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null
          throw error
        }
      )
      if (nested) return
    }
    if (!Number.isSafeInteger(Number(info.size))) throw new Error("技能文件大小不可用")
    entries.push({
      path: relative,
      kind: info.isDirectory() ? "directory" : "file",
      size: Number(info.size),
      stamp: skillFileStamp(info)
    })
    if (!info.isDirectory()) return
    const directory = await opendir(candidate)
    for await (const entry of directory) {
      if (++visited > 2048) throw new Error("技能附属目录过大")
      if (!validPart(entry.name)) continue
      await walk(relative === "." ? entry.name : `${relative}/${entry.name}`, depth + 1)
    }
    if (skillFileStamp(await lstat(candidate, { bigint: true })) !== skillFileStamp(info))
      throw new Error("技能目录在读取期间变化")
  }
  if ((await realpath(root)) !== root) throw new Error("技能目录已变化")
  await walk(".", 0)
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Used by the existing synchronous pre-effect version fence. No resource contents
 * are reread here. Linked/replaced files and directory changes invalidate the version.
 */
export function assertSkillResources(skill: BotExternalSkill): void {
  if (realpathSync(skill.catalogPath) !== skill.filePath) throw new Error("技能来源路径已变化")
  if (realpathSync(skill.rootPath) !== skill.rootPath) throw new Error("技能目录已变化")
  for (const entry of skill.resources) {
    const info = lstatSync(
      entry.path === "." ? skill.rootPath : join(skill.rootPath, skillResourcePath(entry.path)),
      { bigint: true }
    )
    if (
      skillFileStamp(info) !== entry.stamp ||
      info.isSymbolicLink() ||
      (entry.kind === "file" ? !info.isFile() || info.nlink !== 1n : !info.isDirectory())
    )
      throw new Error("技能附属文件已变化，请重新确认所选版本")
  }
}

export async function readSkillResource(
  skill: BotExternalSkill,
  relative: string
): Promise<{ bytes: Buffer; sha256: string }> {
  const path = skillResourcePath(relative)
  const entry = skill.resources.find((item) => item.path === path && item.kind === "file")
  if (!entry) throw new Error("文件不属于此技能的已确认版本")
  assertSkillResources(skill)
  const result = await readPinnedSkillResource(skill, path, entry)
  assertSkillResources(skill)
  return result
}

/** A snapshot copy validates the catalog once around the entire bounded batch,
 * and validates each file's pinned inode/stamp as it is read. Rechecking all
 * resources for every copied file would turn large skills into quadratic I/O. */
export async function* readSkillResourceBatch(skill: BotExternalSkill) {
  assertSkillResources(skill)
  try {
    for (const entry of skill.resources) {
      if (entry.kind !== "file") continue
      const path = skillResourcePath(entry.path)
      yield { path, ...(await readPinnedSkillResource(skill, path, entry)) }
    }
  } finally {
    assertSkillResources(skill)
  }
}

async function readPinnedSkillResource(
  skill: BotExternalSkill,
  path: string,
  entry: BotSkillResource
) {
  const opened = await openStableFileHandle(skill.rootPath, resolve(skill.rootPath, path))
  try {
    const identity = opened.identity
    if (
      [
        identity.device,
        identity.inode,
        identity.size,
        identity.modifiedNs,
        identity.changedNs
      ].join(":") !== entry.stamp
    )
      throw new Error("技能文件已变化")
    const bytes = await readStableFileHandleBounded(opened, BOT_FILE_BYTES)
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") }
  } finally {
    await opened.handle.close()
  }
}
