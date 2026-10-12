import { build, type Loader } from "esbuild"
import { createHash } from "node:crypto"
import { createRequire, isBuiltin } from "node:module"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, extname, join, relative } from "node:path"

type FileIdentity = { path: string; bytes: number; sha256: string }
export interface TrustedMacFaultHostEntry {
  readonly kind: "trusted-mac-owned-shell-fault-host"
  readonly entry: string
  readonly directory: string
  readonly manifest: string
  assertCurrent(): void
  close(): Promise<void>
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

// The Darwin production builder has no native distribution pin. Match its
// botBuildIdentity byte order without executing a production bundle or adding
// a dependency on an injectable production startup API.
async function sourceBuildIdentity(root: string): Promise<string> {
  const hash = createHash("sha256")
  const visit = async (path: string): Promise<void> => {
    if ((await stat(path)).isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name))
    } else if (!/\.(test|spec)\./.test(path)) {
      hash.update(path.replace(root, ""))
      hash.update(await readFile(path))
    }
  }
  for (const path of ["src/main", "src/shared", "package-lock.json", "electron.vite.config.ts"])
    await visit(join(root, path))
  return hash.digest("hex").slice(0, 24)
}

async function files(directory: string): Promise<FileIdentity[]> {
  const result: FileIdentity[] = []
  let total = 0
  const visit = async (path: string) => {
    const info = await lstat(path)
    if (info.isSymbolicLink())
      throw new Error("Trusted Host compiled inputs must be physical files")
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name))
      return
    }
    if (!info.isFile()) throw new Error("Invalid trusted Host compiled input")
    total += info.size
    if (result.length >= 8192 || total > 512 * 1024 * 1024)
      throw new Error("Trusted Host compiled inputs exceed the fixture limit")
    const bytes = await readFile(path)
    result.push({
      path: relative(directory, path),
      bytes: bytes.length,
      sha256: sha256(bytes)
    })
  }
  await visit(directory)
  return result
}

/** Explicit fault-test build only. Production Host never imports this module,
 * accepts its handle, or chooses a backend through an environment/CLI flag. */
export async function createCompiledTrustedMacOwnedHostFixture(
  options: { sourceRoot?: string; compiledDirectory?: string } = {}
): Promise<TrustedMacFaultHostEntry> {
  if (process.platform !== "darwin") throw new Error("The trusted Mac fault Host requires macOS")
  const sourceRoot = await realpath(options.sourceRoot ?? process.cwd())
  const compiledDirectory = await realpath(
    options.compiledDirectory ?? join(sourceRoot, "out/main")
  )
  const runtime = await realpath(join(sourceRoot, "src/main/bots/host-runtime-entry.ts"))
  const productionFactory = await realpath(join(sourceRoot, "src/main/bots/host-shell-factory.ts"))
  const trustedFactory = await realpath(
    join(sourceRoot, "src/main/bots/mac-host-shell-test-factory.ts")
  )
  const dependencies = await realpath(join(sourceRoot, "node_modules"))
  const sourceBuildId = await sourceBuildIdentity(sourceRoot)
  const compiledInputs = await files(compiledDirectory)
  for (const required of ["bot-host.js", "bot-shell-owner.js", "bot-shell.js"])
    if (!compiledInputs.some((file) => file.path === required))
      throw new Error(`Missing current compiled Host input: ${required}`)
  const formalBuildIds = new Set<string>()
  const formalBuildIdFiles: string[] = []
  for (const file of compiledInputs.filter((file) => /\.[cm]?js$/.test(file.path))) {
    const code = await readFile(join(compiledDirectory, file.path), "utf8")
    for (const match of code.matchAll(
      /\bBOT_BUILD_ID\s*=\s*(?:true\s*\?\s*)?["']([a-f0-9]{24})["']/g
    )) {
      formalBuildIds.add(match[1])
      formalBuildIdFiles.push(file.path)
    }
  }
  if (formalBuildIds.size !== 1 || !formalBuildIds.has(sourceBuildId))
    throw new Error(
      "Trusted fault Host requires a current formal Main build matching source BOT_BUILD_ID"
    )
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cmb-trusted-mac-fault-host-")))
  const main = join(directory, "out/main")
  const entry = join(main, "bot-host-owned-shell-test.cjs")
  const manifest = join(directory, "trusted-fault-host-manifest.json")
  let completed = false
  try {
    await mkdir(dirname(main), { recursive: true })
    await cp(compiledDirectory, main, {
      recursive: true,
      dereference: false,
      errorOnExist: true
    })
    if (JSON.stringify(await files(main)) !== JSON.stringify(compiledInputs))
      throw new Error("Compiled Host inputs changed while copying the fault fixture")
    // Pin a narrow CommonJS package boundary so Seatbelt grants the copied
    // worker's sibling Rollup chunks read access, rather than only its entry.
    // The boundary is included in artifacts and checked before every launch.
    await writeFile(
      join(main, "package.json"),
      JSON.stringify({
        name: "cmb-trusted-mac-owned-shell-fault-host",
        private: true,
        type: "commonjs"
      }) + "\n",
      { flag: "wx", mode: 0o600 }
    )
    // Executable code is a physical copy. Dependency lookup is explicitly bound
    // to the canonical installed tree; the Mac compiler grants it read-only.
    await symlink(dependencies, join(directory, "node_modules"), "dir")
    const dependencyProbe = createRequire(join(main, "bot-shell.js"))
    const zodPackage = await realpath(dependencyProbe.resolve("zod/package.json"))
    const zodSha256 = sha256(await readFile(zodPackage))
    const sources = new Map<string, string>()
    const bindings: Array<{ importer: string; specifier: string }> = []
    const seed = sha256(
      JSON.stringify({
        compiledInputs,
        trustedFactory: sha256(await readFile(trustedFactory))
      })
    ).slice(0, 24)
    const result = await build({
      entryPoints: [join(sourceRoot, "src/main/bots/host-entry.ts")],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22.16",
      packages: "external",
      absWorkingDir: sourceRoot,
      metafile: true,
      logLevel: "silent",
      define: {
        __BOT_BUILD_ID__: JSON.stringify(seed),
        __BOT_NATIVE_DISTRIBUTION__: "null",
        "import.meta.url": "__CMB_TRUSTED_TEST_MODULE_URL__"
      },
      banner: {
        js: 'const __CMB_TRUSTED_TEST_MODULE_URL__ = require("node:url").pathToFileURL(__filename).href;'
      },
      plugins: [
        {
          name: "explicit-trusted-mac-fault-host",
          setup(bundler) {
            bundler.onResolve({ filter: /.*/, namespace: "trusted-mac-fault-host" }, (args) => {
              if (args.path !== productionFactory && args.path !== trustedFactory)
                throw new Error("Unexpected import in the trusted factory bridge")
              return { path: args.path, namespace: "file" }
            })
            bundler.onResolve({ filter: /^\.\/host-shell-factory$/ }, async (args) => {
              if (!args.importer || (await realpath(args.importer)) !== runtime) return undefined
              bindings.push({ importer: runtime, specifier: args.path })
              return { path: "factory", namespace: "trusted-mac-fault-host" }
            })
            bundler.onLoad({ filter: /^factory$/, namespace: "trusted-mac-fault-host" }, () => ({
              contents: `export { readBotOwnedShellArtifact } from ${JSON.stringify(productionFactory)};
              export { createTrustedMacBotHostShellTestFactory as createBotHostShellFactory }
              from ${JSON.stringify(trustedFactory)};`,
              loader: "ts"
            }))
            bundler.onLoad({ filter: /\.(?:[cm]?ts|tsx|[cm]?js|json)$/ }, async (args) => {
              if (args.namespace !== "file") return undefined
              const bytes = await readFile(args.path)
              const physical = await realpath(args.path)
              const hash = sha256(bytes)
              if (sources.has(physical) && sources.get(physical) !== hash)
                throw new Error("Trusted Host source changed during compilation")
              sources.set(physical, hash)
              const extension = extname(args.path)
              const loader: Loader =
                extension === ".json"
                  ? "json"
                  : extension === ".tsx"
                    ? "tsx"
                    : extension.endsWith("ts")
                      ? "ts"
                      : "js"
              return {
                contents: bytes.toString("utf8"),
                loader,
                resolveDir: dirname(args.path)
              }
            })
          }
        }
      ]
    })
    if (!bindings.length || bindings.some((binding) => binding.importer !== runtime))
      throw new Error("The trusted factory was not bound exclusively to Host runtime")
    for (const [path, hash] of sources)
      if (sha256(await readFile(path)) !== hash)
        throw new Error("Trusted Host source changed during build")
    if (JSON.stringify(await files(compiledDirectory)) !== JSON.stringify(compiledInputs))
      throw new Error("Formal compiled Host inputs changed during the fault-test build")
    if ((await sourceBuildIdentity(sourceRoot)) !== sourceBuildId)
      throw new Error("Formal source build identity changed during the fault-test build")
    const artifacts = await files(main)
    const externalImports = [
      ...new Set(
        Object.values(result.metafile!.outputs).flatMap((output) =>
          output.imports.filter((item) => item.external).map((item) => item.path)
        )
      )
    ].sort()
    const externalEntries: Array<{ specifier: string; path: string; sha256: string }> = []
    for (const specifier of externalImports.filter((item) => !isBuiltin(item))) {
      const path = await realpath(dependencyProbe.resolve(specifier))
      externalEntries.push({ specifier, path, sha256: sha256(await readFile(path)) })
    }
    await writeFile(
      manifest,
      JSON.stringify(
        {
          schemaVersion: 1,
          kind: "trusted-mac-owned-shell-fault-host",
          production: false,
          buildId: seed,
          formalSourceBuildId: sourceBuildId,
          formalCompiledBuildId: [...formalBuildIds][0],
          formalBuildIdFiles,
          entry,
          sourceRoot,
          compiledDirectory,
          compiledInputs,
          sources: [...sources]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([path, hash]) => ({ path, sha256: hash })),
          resolver: {
            importer: runtime,
            specifier: "./host-shell-factory",
            bindings
          },
          dependencies: {
            kind: "canonical-installed-read-only-tree",
            root: dependencies,
            zodPackage,
            zodSha256,
            externalEntries,
            pinScope:
              "Resolved direct external entries and zod metadata; not all transitive dependency files"
          },
          externalImports,
          artifacts,
          proofScope:
            "Inherited lifetime fault tests only; no production Mac command capability or desktop IPC proof"
        },
        null,
        2
      ) + "\n"
    )
    completed = true
    return Object.freeze({
      kind: "trusted-mac-owned-shell-fault-host" as const,
      entry,
      directory,
      manifest,
      assertCurrent() {
        if (realpathSync(main) !== main)
          throw new Error("Trusted fault Host compiled directory changed before launch")
        for (const artifact of artifacts) {
          const path = join(main, artifact.path)
          const info = lstatSync(path)
          if (
            !info.isFile() ||
            info.isSymbolicLink() ||
            realpathSync(path) !== path ||
            sha256(readFileSync(path)) !== artifact.sha256
          )
            throw new Error("Trusted fault Host compiled artifacts changed before launch")
        }
        if (
          realpathSync(join(directory, "node_modules")) !== dependencies ||
          sha256(readFileSync(zodPackage)) !== zodSha256
        )
          throw new Error("Trusted fault Host dependencies changed before launch")
        for (const dependency of externalEntries)
          if (
            realpathSync(dependencyProbe.resolve(dependency.specifier)) !== dependency.path ||
            sha256(readFileSync(dependency.path)) !== dependency.sha256
          )
            throw new Error("Trusted fault Host external entry changed before launch")
      },
      async close() {
        await rm(directory, { recursive: true, force: true })
      }
    })
  } finally {
    if (!completed) await rm(directory, { recursive: true, force: true })
  }
}
