import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { createRequire } from "node:module"
import { compileFunctionPlugin } from "../v2/loader"
import { functionAuthoringDeclarations } from "./authoring-declarations"

function libraryDirectory(): { path: string; bundled: boolean } {
  const bundled = resolve(__dirname, "../resources/mods-authoring/typescript")
  if (existsSync(join(bundled, "lib.es2023.d.ts"))) return { path: bundled, bundled: true }
  const require = createRequire(__filename)
  return { path: dirname(require.resolve("typescript")), bundled: false }
}

/** Compiler input is an immutable plugin snapshot plus our fixed SDK and trusted ES libraries. */
export async function checkFunctionAuthorTypes(directory: string) {
  const compiled = await compileFunctionPlugin(directory, { captureSources: true })
  const ts = await import("typescript")
  const sourceExtensions: Record<string, import("typescript").Extension> = {
    ".ts": ts.Extension.Ts,
    ".tsx": ts.Extension.Tsx,
    ".mts": ts.Extension.Mts,
    ".cts": ts.Extension.Cts,
    ".js": ts.Extension.Js,
    ".jsx": ts.Extension.Jsx,
    ".mjs": ts.Extension.Mjs,
    ".cjs": ts.Extension.Cjs
  }
  const canonical = (file: string) =>
    process.platform === "win32" ? resolve(file).toLowerCase() : resolve(file)
  const sdkPath = resolve(compiled.root, ".__cmb_authoring__/devclaw-mods.d.ts")
  const sources = new Map(
    Object.entries(compiled.authoringSources!).map(([name, text]) => [
      canonical(resolve(compiled.root, name)),
      text
    ])
  )
  sources.set(canonical(sdkPath), functionAuthoringDeclarations(compiled.modelProtocol))
  const { path: libs, bundled } = libraryDirectory()
  const allowedLib = (file: string) =>
    canonical(dirname(file)) === canonical(libs) &&
    /^lib\.(?:es[\w.]*|decorators(?:\.legacy)?)\.d\.ts$/.test(basename(file))
  const read = (file: string): string | undefined => {
    const captured = sources.get(canonical(file))
    if (captured !== undefined) return captured
    if (!allowedLib(file)) return undefined
    try {
      return readFileSync(file, "utf8")
    } catch {
      return undefined
    }
  }
  const options: import("typescript").CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2023.d.ts"],
    types: [],
    strict: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    skipLibCheck: false,
    allowJs: true,
    checkJs: true,
    jsx: ts.JsxEmit.React,
    jsxFactory: "h",
    jsxFragmentFactory: "Fragment"
  }
  const host: import("typescript").CompilerHost = {
    getSourceFile: (file, version) => {
      const text = read(file)
      return text === undefined ? undefined : ts.createSourceFile(file, text, version, true)
    },
    getDefaultLibFileName: () => join(libs, "lib.es2023.d.ts"),
    writeFile: () => {},
    getCurrentDirectory: () => compiled.root,
    getCanonicalFileName: canonical,
    useCaseSensitiveFileNames: () => process.platform !== "win32",
    getNewLine: () => "\n",
    fileExists: (file) => read(file) !== undefined,
    readFile: read,
    directoryExists: (dir) =>
      canonical(dir) === canonical(libs) ||
      [...sources.keys()].some((file) => file.startsWith(canonical(dir) + sep)),
    getDirectories: () => [],
    resolveModuleNames: (names, containing) =>
      names.map((name) => {
        if (name === "devclaw-mods" || name === "claude-code")
          return { resolvedFileName: sdkPath, extension: ts.Extension.Dts }
        if (!name.startsWith(".")) return undefined
        const requested = resolve(dirname(containing), name),
          outside = relative(compiled.root, requested)
        if (outside.startsWith("..") || isAbsolute(outside)) return undefined
        for (const candidate of [
          requested,
          requested + ".ts",
          requested + ".tsx",
          requested + ".mts",
          requested + ".cts",
          requested + ".js",
          requested + ".jsx",
          requested + ".mjs",
          requested + ".cjs",
          requested + ".d.ts",
          join(requested, "index.ts"),
          join(requested, "index.d.ts")
        ]) {
          if (!sources.has(canonical(candidate))) continue
          const extension = candidate.endsWith(".d.ts")
            ? ts.Extension.Dts
            : sourceExtensions[extname(candidate)] ?? ts.Extension.Js
          return { resolvedFileName: candidate, extension }
        }
        return undefined
      })
  }
  const roots = [
    sdkPath,
    ...compiled.sources
      .filter((name) => /\.(?:[cm]?[tj]s|tsx|jsx)$/.test(name))
      .map((name) => resolve(compiled.root, name))
  ]
  const program = ts.createProgram(roots, options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const position =
      diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : undefined
    return {
      code: String(diagnostic.code),
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      ...(diagnostic.file
        ? { file: relative(compiled.root, diagnostic.file.fileName).replace(/\\/g, "/") }
        : {}),
      ...(position ? { line: position.line + 1, column: position.character + 1 } : {})
    }
  })
  diagnostics.push(...(compiled.authorTypes?.diagnostics ?? []))
  return {
    scope: "authoring-subset" as const,
    valid: diagnostics.length === 0,
    digest: compiled.digest,
    runtimeProvidersVerified: false,
    standardLibraries: bundled ? "bundled-es-only" : "development-es-only",
    dependencyRegistry: false,
    diagnostics
  }
}
