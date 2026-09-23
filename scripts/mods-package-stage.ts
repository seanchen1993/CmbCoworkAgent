import { createRequire } from "node:module"
import { cp, lstat, mkdir, readFile, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

interface PackageManifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}
export interface ProductionPackage {
  source: string
  relative: string
  name: string
  version: string
}
const inside = (root: string, path: string): boolean => {
  const child = relative(root, path)
  return !!child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}
const manifest = async (root: string): Promise<PackageManifest> =>
  JSON.parse(await readFile(join(root, "package.json"), "utf8"))

export async function assertFreshPackageOutput(root: string, destination: string): Promise<string> {
  const allowed = resolve(root, "output/mods-v2-validation")
  const output = resolve(root, destination)
  if (!inside(allowed, output)) throw Error("MODS_PACKAGE_OUTPUT_SCOPE")
  let ancestor = resolve(root)
  for (const part of ["", ...relative(root, output).split(sep)]) {
    ancestor = resolve(ancestor, part)
    const info = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (info?.isSymbolicLink()) throw Error("MODS_PACKAGE_OUTPUT_LINK")
    if (ancestor === output && info) throw Error("MODS_PACKAGE_OUTPUT_EXISTS")
  }
  return output
}

/** Read installed package metadata, including nested versions; never invoke npm install/rebuild. */
export async function collectProductionPackages(app: string): Promise<ProductionPackage[]> {
  const modules = await realpath(join(app, "node_modules"))
  const packages = new Map<string, ProductionPackage>()
  const visit = async (from: string, pkg: PackageManifest): Promise<void> => {
    const optional = pkg.optionalDependencies ?? {}
    const required = { ...pkg.dependencies, ...optional, ...pkg.peerDependencies }
    for (const name of Object.keys(required).sort()) {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name))
        throw Error(`MODS_PACKAGE_DEPENDENCY_NAME: ${name}`)
      // Builtin names such as string_decoder can also name explicitly required npm polyfills.
      const paths =
        createRequire(join(from, "package.json")).resolve.paths("__mods_package_lookup__") ?? []
      let source: string | undefined
      for (const path of paths) {
        const candidate = join(path, name)
        if (
          await stat(join(candidate, "package.json")).then(
            (value) => value.isFile(),
            () => false
          )
        ) {
          if ((await lstat(candidate)).isSymbolicLink())
            throw Error(`MODS_PACKAGE_DEPENDENCY_LINK: ${name}`)
          source = await realpath(candidate)
          break
        }
      }
      if (!source) {
        if (
          Object.hasOwn(optional, name) ||
          (!Object.hasOwn(pkg.dependencies ?? {}, name) &&
            pkg.peerDependenciesMeta?.[name]?.optional)
        )
          continue
        throw Error(`MODS_PACKAGE_DEPENDENCY_MISSING: ${name} from ${from}`)
      }
      if (!inside(modules, source)) throw Error(`MODS_PACKAGE_DEPENDENCY_OUTSIDE: ${name}`)
      if (packages.has(source)) continue
      if (packages.size >= 4096) throw Error("MODS_PACKAGE_DEPENDENCY_LIMIT")
      const child = await manifest(source)
      if (!child.name || !child.version) throw Error(`MODS_PACKAGE_METADATA: ${name}`)
      packages.set(source, {
        source,
        relative: relative(modules, source).split(sep).join("/"),
        name: child.name,
        version: child.version
      })
      await visit(source, child)
    }
  }
  await visit(resolve(app), await manifest(app))
  return [...packages.values()].sort((a, b) => a.relative.localeCompare(b.relative))
}

/** Write a fresh isolated dependency tree. Source junctions remain strictly read-only. */
export async function stageProductionPackages(
  stage: string,
  packages: ProductionPackage[]
): Promise<void> {
  const modules = resolve(stage, "node_modules")
  if (
    await stat(modules).then(
      () => true,
      () => false
    )
  )
    throw Error("MODS_PACKAGE_STAGE_EXISTS")
  for (const pkg of packages)
    if (!inside(modules, resolve(modules, pkg.relative))) throw Error("MODS_PACKAGE_STAGE_PATH")
  await mkdir(modules, { recursive: true })
  // Parent packages must precede nested packages; no directory is copied onto itself.
  for (const pkg of [...packages].sort((a, b) => a.relative.length - b.relative.length)) {
    const destination = resolve(modules, pkg.relative)
    await mkdir(dirname(destination), { recursive: true })
    await cp(pkg.source, destination, {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: true,
      filter: async (path) => {
        const child = relative(pkg.source, path)
        if (child === "node_modules" || child.startsWith(`node_modules${sep}`)) return false
        if ((await lstat(path)).isSymbolicLink()) throw Error("MODS_PACKAGE_CONTENT_LINK")
        return true
      }
    })
  }
}
