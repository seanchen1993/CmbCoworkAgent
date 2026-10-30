import { lstatSync, readdirSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  readRuntimeScopedFile,
  runtimeDigest
} from "../../harness-board/project-runtime/safe-files"
import { projectSourceSetSchema } from "./project-source-set-declaration"

export interface DependencySourceLocation {
  sourceId: string
  relative: string
  sourceSet?: string
  declarationDigest?: string
}

/** Host-generated opaque IDs, not caller paths. Rebuild on each discovery/preparation. */
export function dependencySourceIndex(root: string): DependencySourceLocation[] {
  let directories: string[]
  try {
    directories = readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          /^[a-z][a-z0-9-]{0,47}$/.test(entry.name)
      )
      .map((entry) => entry.name)
      .sort()
      .slice(0, 64)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const entries: DependencySourceLocation[] = directories.map((relative) => ({
    sourceId: relative,
    relative
  }))
  // Root source-sets are also supported; top-level dependencies retain their original IDs.
  for (const directory of ["", ...directories]) {
    assertDependencyDirectory(root, directory)
    const descriptor = readRuntimeScopedFile(
      join(root, directory),
      "devclaw.source-set.json",
      16000
    )
    if (!descriptor.bytes) continue
    const declaration = projectSourceSetSchema.parse(JSON.parse(descriptor.bytes.toString("utf8")))
    const paths = [declaration.project, ...declaration.dependencies]
    if (
      new Set(paths.map((path) => path.toLowerCase())).size !== paths.length ||
      paths.some((left) =>
        paths.some(
          (right) => left !== right && right.toLowerCase().startsWith(left.toLowerCase() + "/")
        )
      )
    )
      throw Error("PROJECT_SOURCE_SET_PATH_COLLISION")
    for (const dependency of declaration.dependencies) {
      const relative = [directory, dependency].filter(Boolean).join("/")
      assertDependencyDirectory(root, relative)
      const existing = entries.find(
        (entry) => entry.relative.toLowerCase() === relative.toLowerCase()
      )
      if (existing) {
        existing.sourceSet ??= [directory, "devclaw.source-set.json"].filter(Boolean).join("/")
        existing.declarationDigest ??= runtimeDigest(descriptor.bytes)
        continue
      }
      const sourceId = "source-set-" + runtimeDigest(relative).slice(0, 32)
      if (entries.some((entry) => entry.sourceId === sourceId))
        throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_AMBIGUOUS")
      entries.push({
        sourceId,
        relative,
        sourceSet: [directory, "devclaw.source-set.json"].filter(Boolean).join("/"),
        declarationDigest: runtimeDigest(descriptor.bytes)
      })
    }
  }
  return entries.sort((left, right) => left.sourceId.localeCompare(right.sourceId, "en"))
}

export function assertDependencyDirectory(root: string, relative: string) {
  let directory = resolve(root)
  for (const segment of ["", ...relative.split("/").filter(Boolean)]) {
    if (segment) directory = join(directory, segment)
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory)
      throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_UNSAFE")
  }
  return directory
}
