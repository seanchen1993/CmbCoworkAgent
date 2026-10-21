import { lstat, readdir, realpath } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import {
  createAuthoringSourceBundle,
  hasAuthoringTextExtension,
  AUTHORING_BUNDLE_LIMITS,
  type AuthoringSourceBundle
} from "./authoring-bundle"
import { readBoundedAuthoringVersionFile } from "./authoring-version-file"
import { normalizeProjectResourcePaths } from "./project-resource-paths"
import { BUSINESS_MOD_MANIFEST } from "../../../shared/business-mods"
import { parseBusinessModCatalog } from "../../plugins/business-mod-manifest"
import { readRuntimeScopedFileAsync } from "../../harness-board/project-runtime/safe-files-async"

export const isProjectSourcePath = (path: string, resourcePaths: readonly string[] = []) =>
  [
    "plugin.json",
    "devclaw.project-runtime.json",
    "devclaw.stage-recovery.json",
    "devclaw.stage-recovery-adapter.json",
    "devclaw.capabilities.json",
    "devclaw.business-assembly.json",
    "devclaw.portability.json",
    "README.md",
    "tests/project-contract.json",
    "devclaw.project-actions.lock.json",
    "devclaw.harness.json"
  ].includes(path) ||
  path === ".mcp.json" ||
  (/^(?:mods|hooks|skills)\/[A-Za-z0-9_./-]+$/.test(path) && hasAuthoringTextExtension(path)) ||
  resourcePaths.includes(path)

/** Bounded declared package resources. No credentials, external imports or filesystem links. */
export async function readProjectSource(
  directory: string,
  importedResources?: readonly string[]
): Promise<{
  root: string
  bundle: AuthoringSourceBundle
  excluded: string[]
}> {
  const root = await realpath(directory)
  let declaredResources = importedResources
  let requiredResources: string[] = []
  {
    // Portable CLI/source readback follows the public catalog's explicit resource closure.
    // These paths remain bounded text input, not execution or filesystem permission grants.
    const file = await readRuntimeScopedFileAsync(
      root,
      BUSINESS_MOD_MANIFEST,
      AUTHORING_BUNDLE_LIMITS.fileBytes
    )
    if (file.bytes) {
      const catalog = parseBusinessModCatalog(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))
      )
      requiredResources = normalizeProjectResourcePaths(
        [
          ...new Set([
            ...(catalog.kernel?.resources ?? []),
            ...catalog.modules.flatMap((mod) => [
              mod.skill.entry,
              ...mod.skill.resources,
              ...mod.resources
            ]),
            ...(catalog.extensions ?? []).flatMap((mod) => [
              mod.entry,
              ...mod.resources,
              ...(mod.contextProvider ? [mod.contextProvider.entry] : []),
              ...(mod.stageRecoveryAdapter ? [mod.stageRecoveryAdapter.entry] : []),
              ...(mod.skills ?? [])
            ])
          ])
        ],
        true
      )
      declaredResources ??= requiredResources.filter((path) => !isProjectSourcePath(path))
    }
  }
  const usesCatalogPrefixes = importedResources === undefined
  const resourcePaths = normalizeProjectResourcePaths(declaredResources ?? [], usesCatalogPrefixes)
  const matchesResource = (path: string) =>
    resourcePaths.some(
      (resource) => path === resource || (usesCatalogPrefixes && path.startsWith(`${resource}/`))
    )
  const files: Array<{ path: string; text: string }> = []
  const excluded: string[] = []
  let visited = 0
  const walk = async (dir: string, depth: number) => {
    if (depth > 8) throw Error("PROJECT_SOURCE_DEPTH")
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++visited > 128) throw Error("PROJECT_SOURCE_LIMIT")
      const absolute = join(dir, entry.name)
      const path = relative(root, absolute).replace(/\\/g, "/")
      if (matchesResource(path)) normalizeProjectResourcePaths([path], entry.isDirectory())
      if (
        entry.isDirectory() &&
        (/^(?:mods|hooks|skills)(?:\/[A-Za-z0-9_./-]+)?$/.test(path) ||
          path === "tests" ||
          matchesResource(path) ||
          resourcePaths.some((resource) => resource.startsWith(`${path}/`)))
      ) {
        if ((await realpath(absolute)) !== resolve(absolute)) throw Error("PROJECT_SOURCE_CHANGED")
        await walk(absolute, depth + 1)
        continue
      }
      if (!isProjectSourcePath(path, resourcePaths) && !matchesResource(path)) {
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
  if (
    requiredResources.some(
      (path) => !files.some((file) => file.path === path || file.path.startsWith(`${path}/`))
    )
  )
    throw Error("PROJECT_RESOURCE_MISSING")
  if ((await realpath(directory)) !== root) throw Error("PROJECT_SOURCE_CHANGED")
  return { root, bundle: createAuthoringSourceBundle(files), excluded }
}
