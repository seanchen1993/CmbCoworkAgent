export interface PackageJson {
  name: string
  version: string
  license: string
  engines: { node: string }
  dependencies: Record<string, string>
}

interface LockedPackage {
  version?: string
  resolved?: string
  integrity?: string
  link?: boolean
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  dev?: boolean
  devOptional?: boolean
  optional?: boolean
  [key: string]: unknown
}
interface SourceLock {
  lockfileVersion: number
  packages: Record<string, LockedPackage>
}

/** Keep installed runtime versions and integrity from the repository lock. */
export function projectServiceLock(source: SourceLock, service: PackageJson): object {
  if (source.lockfileVersion !== 3 || !source.packages || !source.packages[""])
    throw new Error("Independent Host requires the repository's npm v3 lockfile")
  const selected = new Map<string, boolean>()
  const work: { path: string; optional: boolean }[] = []
  const resolveDependency = (from: string, name: string): string | undefined => {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name))
      throw new Error("Invalid locked dependency name")
    let cursor = from
    for (;;) {
      const path = (cursor ? cursor + "/" : "") + "node_modules/" + name
      if (source.packages[path]) return path
      if (!cursor) return undefined
      const ancestor = cursor.lastIndexOf("/node_modules/")
      cursor = ancestor < 0 ? "" : cursor.slice(0, ancestor)
    }
  }
  const enqueue = (from: string, name: string, optional: boolean): void => {
    const path = resolveDependency(from, name)
    if (!path) {
      if (optional) return
      throw new Error(`Missing locked runtime dependency ${name}`)
    }
    work.push({ path, optional })
  }
  for (const [name, version] of Object.entries(service.dependencies)) {
    const path = resolveDependency("", name)
    if (!path || source.packages[path].version !== version)
      throw new Error(`Installed runtime dependency differs from the lock: ${name}`)
    enqueue("", name, false)
  }
  while (work.length) {
    const { path, optional } = work.pop()!
    const previous = selected.get(path)
    if (previous !== undefined && (!previous || optional)) continue
    selected.set(path, optional)
    if (selected.size > 4096) throw new Error("Runtime dependency graph exceeds its limit")
    const value = source.packages[path]
    if (value.link || typeof value.version !== "string")
      throw new Error(`Unsupported linked runtime dependency ${path}`)
    const optionalDependencies = value.optionalDependencies ?? {}
    for (const name of Object.keys(value.dependencies ?? {}))
      enqueue(path, name, optional || name in optionalDependencies)
    for (const name of Object.keys(optionalDependencies)) enqueue(path, name, true)
    for (const name of Object.keys(value.peerDependencies ?? {}))
      enqueue(path, name, optional || value.peerDependenciesMeta?.[name]?.optional === true)
  }
  const packages: Record<string, unknown> = {
    "": {
      name: service.name,
      version: service.version,
      license: service.license,
      engines: service.engines,
      dependencies: service.dependencies
    }
  }
  for (const [path, optional] of [...selected].sort(([a], [b]) => a.localeCompare(b))) {
    const value = { ...source.packages[path] }
    delete value.dev
    delete value.devOptional
    delete value.optional
    if (optional) value.optional = true
    packages[path] = value
  }
  return {
    name: service.name,
    version: service.version,
    lockfileVersion: 3,
    requires: true,
    packages
  }
}
