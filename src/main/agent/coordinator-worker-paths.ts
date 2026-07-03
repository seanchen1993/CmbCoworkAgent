import { existsSync, realpathSync, statSync } from "fs"
import path from "path"

const caseSensitivityCache = new Map<string, boolean>()

function toggleFirstAsciiLetter(value: string): string | undefined {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char >= "a" && char <= "z") {
      return `${value.slice(0, index)}${char.toUpperCase()}${value.slice(index + 1)}`
    }
    if (char >= "A" && char <= "Z") {
      return `${value.slice(0, index)}${char.toLowerCase()}${value.slice(index + 1)}`
    }
  }
  return undefined
}

function nearestExistingPath(filePath: string): string {
  let current = path.resolve(filePath)
  while (!existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

function realpathNativeSafe(filePath: string): string {
  return typeof realpathSync.native === "function"
    ? realpathSync.native(filePath)
    : realpathSync(filePath)
}

export function usesCaseInsensitiveCoordinatorPathMatching(filePath = process.cwd()): boolean {
  if (process.platform === "win32") return true
  if (process.platform !== "darwin") return false

  let current = nearestExistingPath(filePath)
  try {
    if (!statSync(current).isDirectory()) {
      current = path.dirname(current)
    }
  } catch {
    current = path.dirname(current)
  }

  const cacheKey = path.resolve(current)
  const cached = caseSensitivityCache.get(cacheKey)
  if (cached !== undefined) return cached

  let probe = cacheKey
  while (true) {
    const parent = path.dirname(probe)
    const base = path.basename(probe)
    const toggled = toggleFirstAsciiLetter(base)
    if (toggled && toggled !== base) {
      const variant = path.join(parent, toggled)
      if (!existsSync(variant)) {
        caseSensitivityCache.set(cacheKey, false)
        return false
      }
      try {
        const insensitive = realpathSync.native(variant) === realpathSync.native(probe)
        caseSensitivityCache.set(cacheKey, insensitive)
        return insensitive
      } catch {
        caseSensitivityCache.set(cacheKey, true)
        return true
      }
    }
    if (parent === probe) {
      caseSensitivityCache.set(cacheKey, false)
      return false
    }
    probe = parent
  }
}

export function resolveCoordinatorPath(filePath: string): string {
  const resolved = path.resolve(filePath)
  const pendingSegments: string[] = []
  let probe = resolved
  while (true) {
    try {
      const realProbe = realpathNativeSafe(probe)
      return pendingSegments.length === 0
        ? realProbe
        : path.join(realProbe, ...pendingSegments.reverse())
    } catch {
      const parent = path.dirname(probe)
      if (parent === probe) {
        return resolved
      }
      pendingSegments.push(path.basename(probe))
      probe = parent
    }
  }
}

export function coordinatorFileMatchKey(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "")
  return usesCaseInsensitiveCoordinatorPathMatching(filePath)
    ? normalized.toLocaleLowerCase("en-US")
    : normalized
}

export function isCoordinatorPathWithin(targetPath: string, rootPath: string): boolean {
  const target = coordinatorFileMatchKey(resolveCoordinatorPath(targetPath))
  const root = coordinatorFileMatchKey(resolveCoordinatorPath(rootPath))
  return target === root || target.startsWith(`${root}/`)
}

export function isCoordinatorPathOwnedBy(targetPath: string, ownedPath: string): boolean {
  const explicitDirectory = /\/+$/.test(ownedPath.replace(/\\/g, "/"))
  const canonicalOwnedPath = ownedPath.replace(/[\\/]+$/, "")
  const target = coordinatorFileMatchKey(resolveCoordinatorPath(targetPath))
  const owned = coordinatorFileMatchKey(resolveCoordinatorPath(canonicalOwnedPath))
  if (target === owned) return true

  try {
    if (!statSync(resolveCoordinatorPath(canonicalOwnedPath)).isDirectory()) {
      return false
    }
  } catch {
    if (!explicitDirectory) return false
  }

  return target.startsWith(`${owned}/`)
}
