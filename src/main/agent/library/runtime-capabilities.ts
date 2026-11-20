import { discoverSkills } from "../../skills/discovery"
import { resolve } from "path"

export async function resolveAllowedSkillRootDirs(
  sourceDirs: string[],
  allowedSkillNames: readonly string[]
): Promise<string[]> {
  if (allowedSkillNames.length === 0) return []
  const allowedNames = new Set(allowedSkillNames)
  return Array.from(
    new Map(
      (await Promise.all(sourceDirs.map((source) => discoverSkills(source))))
        .flat()
        .filter((skill) => allowedNames.has(skill.name))
        .map((skill) => [resolve(skill.rootDir), skill.rootDir])
    ).values()
  )
}

function normalizeBackendPath(input: string): string {
  return input.replace(/\\/g, "/").replace(/\/+$/, "")
}

/** Restricts only SkillsMiddleware's source-directory enumeration. */
export function createAllowedSkillsBackend(
  backend: any,
  sourceDirs: string[],
  allowedSkillRootDirs: string[]
): any {
  const sourcePaths = new Set(sourceDirs.map(normalizeBackendPath))
  const allowedPaths = new Set(allowedSkillRootDirs.map(normalizeBackendPath))
  return new Proxy(backend, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property !== "lsInfo" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value
      }
      return async (dirPath: string) => {
        const entries = await value.call(target, dirPath)
        if (!sourcePaths.has(normalizeBackendPath(dirPath))) return entries
        return entries.filter(
          (entry: { is_dir?: boolean; path?: string }) =>
            !entry.is_dir ||
            (entry.path != null && allowedPaths.has(normalizeBackendPath(entry.path)))
        )
      }
    }
  })
}
