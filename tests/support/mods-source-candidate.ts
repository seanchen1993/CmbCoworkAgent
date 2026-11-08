import assert from "node:assert/strict"
import { build, type Plugin } from "esbuild"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { createRequire } from "node:module"
import { startIsolatedAppRenderer } from "./isolated-app-renderer"
import { modsSourceNodeWorkers } from "./mods-source-node-workers"
import { captureModsSourceSnapshot, verifyModsSourceSnapshot } from "./mods-source-snapshot"
import { PLATFORM_EXAMPLES } from "../../src/main/mods/community-examples"
import { checkReactVirtuosoScrollCancel } from "../../scripts/apply-react-virtuoso-scroll-cancel.mjs"

export const MODS_VIRTUOSO_PATCH_SOURCE_ROOTS = [
  "scripts/apply-react-virtuoso-scroll-cancel.mjs",
  "scripts/apply-react-virtuoso-scroll-cancel.d.mts",
  "scripts/langchain-native-patch-text.mjs",
  "patches/react-virtuoso-scroll-cancel"
] as const

const virtuosoFiles = ["index.mjs", "index.cjs", "index.d.ts"].map(
  (name) => `node_modules/react-virtuoso/dist/${name}`
)

/** Installed bytes, not just the lockfile, identify a patched dependency. Never installs. */
export function captureModsVirtuosoDependencyProof(repository: string) {
  checkReactVirtuosoScrollCancel({ workspaceRoot: repository })
  return {
    version: "4.18.12" as const,
    files: Object.fromEntries(virtuosoFiles.map((file) => [file, hash(join(repository, file))]))
  }
}

export interface ModsSourceManifest {
  execution: "source-isolated"
  root: string
  repository: string
  head: string
  entry: string
  rendererUrl: string
  files: Record<string, string>
  sources: Record<string, string>
  sourceRoots: string[]
  dependencies: string
  reactVirtuosoScrollCancel: ReturnType<typeof captureModsVirtuosoDependencyProof>
}
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")
export function readModsSourceCandidate(path: string) {
  const value = JSON.parse(readFileSync(path, "utf8")) as ModsSourceManifest
  assert.equal(value.execution, "source-isolated", "SOURCE_CANDIDATE_KIND_REQUIRED")
  assert.equal(realpathSync(dirname(path)), realpathSync(value.root))
  assert.equal(value.entry, join(value.root, "out/main/index.js"))
  for (const [file, digest] of Object.entries(value.files)) {
    const actual = resolve(value.root, file)
    const tail = relative(realpathSync(value.root), realpathSync(actual))
    assert(tail && !tail.startsWith("..") && !tail.includes(":"), "SOURCE_PATH_OUTSIDE_CANDIDATE")
    assert.equal(hash(actual), digest, `SOURCE_CANDIDATE_CHANGED:${file}`)
  }
  assert.equal(
    hash(join(value.repository, "package-lock.json")),
    value.dependencies,
    "SOURCE_DEPENDENCIES_CHANGED"
  )
  assert(Array.isArray(value.sourceRoots) && value.sourceRoots.length, "SOURCE_ROOTS_REQUIRED")
  verifyModsSourceSnapshot(value.repository, value.sourceRoots, value.sources)
  assert(value.reactVirtuosoScrollCancel, "SOURCE_VIRTUOSO_PROOF_REQUIRED")
  for (const source of MODS_VIRTUOSO_PATCH_SOURCE_ROOTS)
    assert(value.sourceRoots.includes(source), `SOURCE_VIRTUOSO_PATCH_SOURCE_REQUIRED:${source}`)
  assert.deepEqual(
    captureModsVirtuosoDependencyProof(value.repository),
    value.reactVirtuosoScrollCancel,
    "SOURCE_VIRTUOSO_DEPENDENCY_CHANGED"
  )
  return value
}

/** Test compilation only: never invokes electron-vite, packages an app, or writes root/out. */
export async function prepareModsSourceCandidate(repository: string, directory: string) {
  // Fail before creating candidate output if npm ci skipped the dependency patch.
  const reactVirtuosoScrollCancel = captureModsVirtuosoDependencyProof(repository)
  const dependencies = hash(join(repository, "package-lock.json"))
  const root = resolve(directory)
  assert(!existsSync(root), "SOURCE_CANDIDATE_REQUIRES_NEW_DIRECTORY")
  assert(!["out", "dist", "build"].includes(relative(repository, root).split(/[\\/]/)[0]))
  mkdirSync(root, { recursive: true })
  const main = join(root, "out/main")
  mkdirSync(main, { recursive: true })
  const platformExamples = PLATFORM_EXAMPLES.map((example) => {
    assert.equal(example.origin, "devclaw", "SOURCE_PLATFORM_EXAMPLE_PROVENANCE_REQUIRED")
    if (example.origin !== "devclaw") throw Error("SOURCE_PLATFORM_EXAMPLE_PROVENANCE_REQUIRED")
    return example
  })
  const sourceRoots = [
    "src",
    "package.json",
    ...MODS_VIRTUOSO_PATCH_SOURCE_ROOTS,
    "resources/mods",
    "resources/native-compositions",
    "resources/mods-policy.json",
    "skills",
    "examples/autobiz-stage-checks",
    ...platformExamples.map((example) => example.sourcePath)
  ]
  const sources = captureModsSourceSnapshot(repository, sourceRoots)
  const workers = modsSourceNodeWorkers(repository)
  const require = createRequire(join(repository, "package.json"))
  const parsers: Plugin = {
    name: "same-production-esm-parser-entries",
    setup(builder) {
      builder.onResolve(
        { filter: /^(unified|remark-parse|remark-gfm|remark-rehype)$/ },
        (args) => ({
          path: require.resolve(args.path),
          external: false
        })
      )
    }
  }
  const capture: Plugin = {
    name: "capture-current-source",
    setup(builder) {
      builder.onLoad({ filter: /\.(?:[cm]?[jt]sx?|json)$/ }, (args) => {
        const file = relative(repository, args.path).replaceAll("\\", "/")
        if (file.startsWith("src/"))
          assert.equal(hash(args.path), sources[file], `SOURCE_CHANGED_DURING_COMPILE:${file}`)
        return undefined
      })
    }
  }
  const options = {
    bundle: true,
    platform: "node" as const,
    target: "node22",
    format: "cjs" as const,
    packages: "external" as const,
    plugins: [capture, workers.plugin, parsers],
    define: { "import.meta.env": "{}", "import.meta.url": "__filename" },
    logLevel: "warning" as const
  }
  const entries: Record<string, string> = {
    index: "src/main/index.ts",
    "browser-native-host": "src/main/browser/chrome/browser-native-host-entry.ts",
    "pty-host": "src/main/pty-host.ts",
    "code-exec-helper": "src/main/code-exec/helper-entry.ts",
    "mod-host": "src/main/mods/host-entry.ts",
    "function-mod-host": "src/main/mods/v2/host-entry.ts",
    "mods-cli": "src/main/mods/devtools/cli-entry.ts",
    "mods-authoring-preflight": "src/main/mods/devtools/authoring-preflight-entry.ts"
  }
  await build({
    ...options,
    entryPoints: Object.fromEntries(
      Object.entries(entries).map(([name, file]) => [name, join(repository, file)])
    ),
    outdir: main
  })
  const completed = new Set<string>()
  while (completed.size < workers.entries.size) {
    for (const [source, name] of [...workers.entries]) {
      if (completed.has(source)) continue
      await build({ ...options, entryPoints: [source], outfile: join(main, name) })
      completed.add(source)
    }
  }
  await build({
    ...options,
    entryPoints: [join(repository, "src/preload/index.ts")],
    outfile: join(root, "out/preload/index.js")
  })
  const pkg = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"))
  assert.equal(pkg.version, "2.0.0")
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      main: "out/main/index.js"
    })
  )
  // These are versioned platform assets, never user profiles or credentials.
  for (const file of [
    "resources/mods",
    "resources/native-compositions",
    "resources/mods-policy.json",
    "skills",
    ...[
      "background-job-controller-powershell-bootstrap.ps1",
      "background-job-controller.exe",
      "codex-command-runner.exe",
      "rg.exe"
    ].map((name) => `resources/bin/win32/${name}`)
  ]) {
    const original = join(repository, file)
    if (existsSync(original)) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      cpSync(original, join(root, file), { recursive: true, dereference: false })
    }
  }
  // Match the runtime lookups from the production electron-vite resource copier.
  const mirrors = [
    ["resources/mods", "out/resources/mods"],
    ["resources/native-compositions", "out/resources/native-compositions"],
    ["resources/mods-policy.json", "out/resources/mods-policy.json"],
    ["skills", "out/skills"],
    ["examples/autobiz-stage-checks", "out/resources/project-composition/autobiz"],
    ["resources/mods/community-originals", "out/resources/bundled-mods/community-originals"],
    ...platformExamples.map((example) => [
      example.sourcePath,
      `out/resources/bundled-mods/platform-examples/${example.id}`
    ])
  ]
  for (const [from, to] of mirrors) {
    mkdirSync(dirname(join(root, to)), { recursive: true })
    cpSync(join(repository, from), join(root, to), { recursive: true, dereference: false })
  }
  const libraries = join(root, "out/resources/mods-authoring/typescript")
  const typescript = dirname(require.resolve("typescript"))
  mkdirSync(libraries, { recursive: true })
  for (const name of readdirSync(typescript))
    if (/^lib\.(?:es[\w.]*|decorators(?:\.legacy)?)\.d\.ts$/.test(name))
      cpSync(join(typescript, name), join(libraries, name))
  cpSync(join(dirname(typescript), "LICENSE.txt"), join(libraries, "LICENSE.txt"))
  const generated = join(repository, "src/main/browser/record/common/playwright-codegen/generated")
  if (existsSync(generated)) cpSync(generated, join(main, "generated"), { recursive: true })
  const renderer = await startIsolatedAppRenderer(repository, root)
  try {
    const files: Record<string, string> = {}
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === "vite-cache") continue
        assert(!entry.isSymbolicLink(), "SOURCE_CANDIDATE_LINK_FORBIDDEN")
        const file = join(directory, entry.name)
        if (entry.isDirectory()) walk(file)
        else files[relative(root, file).replaceAll("\\", "/")] = hash(file)
      }
    }
    walk(root)
    verifyModsSourceSnapshot(repository, sourceRoots, sources)
    assert.deepEqual(
      captureModsVirtuosoDependencyProof(repository),
      reactVirtuosoScrollCancel,
      "SOURCE_VIRTUOSO_DEPENDENCY_CHANGED_DURING_BUILD"
    )
    assert.equal(
      hash(join(repository, "package-lock.json")),
      dependencies,
      "SOURCE_DEPENDENCIES_CHANGED_DURING_BUILD"
    )
    const manifest: ModsSourceManifest = {
      execution: "source-isolated",
      root,
      repository,
      head: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repository,
        encoding: "utf8"
      }).trim(),
      entry: join(main, "index.js"),
      rendererUrl: renderer.url,
      files,
      sources,
      sourceRoots,
      dependencies,
      reactVirtuosoScrollCancel
    }
    const path = join(root, "source-candidate.json")
    writeFileSync(path, JSON.stringify(manifest, null, 2))
    return { path, manifest, close: renderer.close }
  } catch (error) {
    await renderer.close()
    throw error
  }
}
