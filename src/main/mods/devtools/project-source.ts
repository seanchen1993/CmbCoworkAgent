import { lstat, readdir, realpath } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import {
  createAuthoringSourceBundle,
  hasAuthoringTextExtension,
  AUTHORING_BUNDLE_LIMITS,
  type AuthoringSourceBundle
} from "./authoring-bundle"
import { readBoundedAuthoringVersionFile } from "./authoring-version-file"

export const isProjectSourcePath = (path: string) =>
  [
    "plugin.json",
    "devclaw.project-runtime.json",
    "devclaw.capabilities.json",
    "README.md",
    "tests/project-contract.json",
    "devclaw.project-actions.lock.json",
    "devclaw.harness.json"
  ].includes(path) ||
  path === ".mcp.json" ||
  (/^(?:mods|hooks|skills)\/[A-Za-z0-9_./-]+$/.test(path) && hasAuthoringTextExtension(path))

/** Bounded declared package resources. No credentials, external imports or filesystem links. */
export async function readProjectSource(directory: string): Promise<{
  root: string
  bundle: AuthoringSourceBundle
  excluded: string[]
}> {
  const root = await realpath(directory)
  const files: Array<{ path: string; text: string }> = []
  const excluded: string[] = []
  let visited = 0
  const walk = async (dir: string, depth: number) => {
    if (depth > 8) throw Error("PROJECT_SOURCE_DEPTH")
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++visited > 128) throw Error("PROJECT_SOURCE_LIMIT")
      const absolute = join(dir, entry.name)
      const path = relative(root, absolute).replace(/\\/g, "/")
      if (
        entry.isDirectory() &&
        (/^(?:mods|hooks|skills)(?:\/[A-Za-z0-9_./-]+)?$/.test(path) || path === "tests")
      ) {
        if ((await realpath(absolute)) !== resolve(absolute)) throw Error("PROJECT_SOURCE_CHANGED")
        await walk(absolute, depth + 1)
        continue
      }
      if (!isProjectSourcePath(path)) {
        excluded.push(path)
        continue
      }
      const stat = await lstat(absolute)
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (await realpath(absolute)) !== resolve(absolute)
      )
        throw Error("PROJECT_SOURCE_CHANGED")
      files.push({
        path,
        text: readBoundedAuthoringVersionFile(absolute, AUTHORING_BUNDLE_LIMITS.fileBytes)
      })
    }
  }
  await walk(root, 0)
  if ((await realpath(directory)) !== root) throw Error("PROJECT_SOURCE_CHANGED")
  return { root, bundle: createAuthoringSourceBundle(files), excluded }
}
