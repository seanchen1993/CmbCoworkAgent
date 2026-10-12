import { createHash } from "node:crypto"
import { lstat, mkdir, open, realpath } from "node:fs/promises"
import { join, relative, isAbsolute } from "node:path"
import type { BotExternalSkill } from "./skill-catalog-contract"
import {
  assertSkillResources,
  readSkillResourceBatch,
  skillResourcePath
} from "./skill-resource-files"
import { canonicalJson } from "./validation"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"
import type { WorkflowWorktreeIsolationBoundary } from "../agent/workflow/types"

const MAX_BYTES = 16 * 1024 * 1024
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

/** This is runtime support, covered by Cmb's existing .cmbdevclaw worktree
 * excludes. A skill revision gets a stable private copy, never a source cwd. */
export function botWorktreeSkillRoot(
  boundary: WorkflowWorktreeIsolationBoundary,
  source: BotExternalSkill
): string {
  const revision = createHash("sha256")
    .update(canonicalJson([source.id, source.sha256, source.resources]))
    .digest("hex")
  return join(boundary.workspaceRoot, ".cmbdevclaw", "bot-skill-hooks", revision)
}

/** Copies only the Host's approved catalog revision. No links, hidden resources,
 * directory discovery, package installation, or overwriting modified snapshots. */
export async function materializeBotWorktreeSkill(
  boundary: WorkflowWorktreeIsolationBoundary,
  source: BotExternalSkill,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted()
  assertSkillResources(source)
  const root = boundary.workspaceRoot
  if ((await realpath(root)) !== root) throw new Error("隔离工作区目录已变化")
  const target = botWorktreeSkillRoot(boundary, source)
  const ensure = async (directory: string) => {
    const part = relative(root, directory)
    if (part === ".." || part.startsWith("../") || part.startsWith("..\\") || isAbsolute(part))
      throw new Error("技能副本超出工作区")
    let current = root
    for (const name of part.split(/[\\/]/).filter(Boolean)) {
      signal.throwIfAborted()
      current = join(current, name)
      await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
      })
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(current)) !== current)
        throw new Error("技能副本目录不能是符号链接或目录联接")
    }
  }
  const files = source.resources.filter((entry) => entry.kind === "file")
  if (files.reduce((total, file) => total + file.size, 0) > MAX_BYTES)
    throw new Error("隔离技能文件总量超过 16 MiB，请减少非执行资源后重新选择技能版本")
  await ensure(target)
  for (const entry of source.resources) {
    if (entry.path !== "." && entry.kind === "directory")
      await ensure(join(target, skillResourcePath(entry.path)))
  }
  for await (const original of readSkillResourceBatch(source)) {
    const resource = original.path
    const parts = resource.split("/")
    await ensure(join(target, ...parts.slice(0, -1)))
    const destination = join(target, ...parts)
    const originalMode = (await lstat(join(source.rootPath, resource))).mode
    signal.throwIfAborted()
    const handle = await open(destination, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return null
      throw error
    })
    if (handle) {
      try {
        await handle.writeFile(original.bytes)
        await handle.chmod(0o600 | (originalMode & 0o111))
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    const entryInfo = await lstat(destination)
    if (entryInfo.isSymbolicLink() || entryInfo.nlink !== 1) throw new Error("隔离技能副本已被替换")
    const copied = await openStableFileHandle(target, destination)
    try {
      if (hash(await readStableFileHandleBounded(copied, MAX_BYTES)) !== original.sha256)
        throw new Error("隔离技能副本内容已变化，不能执行未审批的脚本")
    } finally {
      await copied.handle.close()
    }
  }
  assertSkillResources(source)
  signal.throwIfAborted()
  return target
}
