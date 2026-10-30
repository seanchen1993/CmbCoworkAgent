import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { lstatSync, realpathSync, statSync } from "node:fs"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { parseModManifest } from "../../shared/mods/validation"
import type { ModManifest } from "../../shared/mods/types"
import { ModError } from "./errors"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"

let compiler: typeof import("esbuild") | undefined
export function modCompiler(): typeof import("esbuild") {
  if (!compiler) {
    const require = createRequire(join(__dirname, "mods-loader.cjs"))
    // esbuild uses spawn, which cannot execute an ASAR virtual path. Load its
    // real unpacked JS entry so it also resolves the real unpacked native binary.
    const entry = require.resolve("esbuild").replace(/\.asar([\\/])/, ".asar.unpacked$1")
    compiler = require(entry) as typeof import("esbuild")
  }
  return compiler
}

async function snapshot(root: string, file: string, limit: number): Promise<Buffer> {
  const opened = await openStableFileHandle(root, file)
  try {
    return await readStableFileHandleBounded(opened, limit)
  } finally {
    await opened.handle.close()
  }
}

export interface CompiledMod {
  pluginId: string
  manifest: ModManifest
  digest: string
  code: string
}

/** Reads only bounded data; shared by version routing and both loaders. */
export async function readModApiVersion(root: string, path: string): Promise<unknown> {
  const file = resolveModFile(root, path)
  const input = JSON.parse((await snapshot(root, file, 32768)).toString("utf8"))
  return input && typeof input === "object" ? input.apiVersion : undefined
}

export function resolveModFile(root: string, input: string): string {
  if (!input || isAbsolute(input) || /[:\0]/.test(input)) throw new ModError("MODS_PATH_INVALID")
  const parts = input.replace(/\\/g, "/").split("/")
  if (parts.some((part) => !part || part === ".." || part === "." || /[. ]$/.test(part))) {
    throw new ModError("MODS_PATH_INVALID")
  }
  const base = realpathSync(root)
  let candidate = base
  for (const part of parts) {
    candidate = join(candidate, part)
    if (lstatSync(candidate).isSymbolicLink()) throw new ModError("MODS_PATH_LINK")
  }
  const actual = realpathSync(candidate)
  const rel = relative(base, actual)
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new ModError("MODS_PATH_ESCAPE")
  }
  if (!statSync(actual).isFile()) throw new ModError("MODS_PATH_NOT_FILE")
  return actual
}

export async function compileMod(
  pluginId: string,
  pluginRoot: string,
  manifestPath: string
): Promise<CompiledMod> {
  const { build, version: compilerVersion } = modCompiler()
  const root = realpathSync(pluginRoot)
  const manifestFile = resolveModFile(root, manifestPath)
  if (statSync(manifestFile).size > 32_768) throw new ModError("MODS_MANIFEST_SIZE")
  const manifest = parseModManifest(
    JSON.parse((await snapshot(root, manifestFile, 32_768)).toString("utf8"))
  )
  const entryRel = relative(root, resolve(dirname(manifestFile), manifest.entry))
  const entry = resolveModFile(root, entryRel)
  const sources = new Map<string, string>()
  let totalBytes = 0
  let sourceCount = 0
  const output = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "__cmbMod",
    platform: "neutral",
    target: "es2020",
    logLevel: "silent",
    sourcemap: false,
    plugins: [
      {
        name: "cmb-mod-files",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === "entry-point") return { path: entry, namespace: "mod" }
            if (args.kind === "dynamic-import" || !args.path.startsWith(".")) {
              throw new ModError("MODS_IMPORT_DENIED")
            }
            const requested = resolve(dirname(args.importer), args.path)
            const candidates = extname(requested)
              ? [requested]
              : [requested + ".ts", requested + ".js", join(requested, "index.ts")]
            for (const candidate of candidates) {
              try {
                const file = resolveModFile(root, relative(root, candidate))
                return { path: file, namespace: "mod" }
              } catch (error) {
                if (error instanceof ModError) throw error
              }
            }
            throw new ModError("MODS_IMPORT_MISSING")
          })
          builder.onLoad({ filter: /.*/, namespace: "mod" }, async (args) => {
            const extension = extname(args.path)
            if (![".ts", ".mts", ".js", ".mjs"].includes(extension)) {
              throw new ModError("MODS_IMPORT_TYPE")
            }
            const file = resolveModFile(root, relative(root, args.path))
            const reservedBytes = statSync(file).size
            totalBytes += reservedBytes
            if (++sourceCount > 64 || totalBytes > 2 * 1024 * 1024) {
              throw new ModError("MODS_SOURCE_LIMIT")
            }
            const bytes = await snapshot(root, file, reservedBytes)
            // Compilation uses these captured bytes. No later reread of mutable source is executed.
            sources.set(relative(root, file).replace(/\\/g, "/"), bytes.toString("utf8"))
            return { contents: bytes, loader: extension.endsWith("ts") ? "ts" : "js" }
          })
        }
      }
    ]
  })
  const code = output.outputFiles[0]?.text
  if (!code || Buffer.byteLength(code) > 2 * 1024 * 1024) throw new ModError("MODS_BUNDLE_LIMIT")
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        pluginId,
        manifest,
        compilerVersion,
        target: "es2020",
        sources: [...sources].sort(([a], [b]) => a.localeCompare(b)),
        code
      })
    )
    .digest("hex")
  return { pluginId, manifest, digest, code }
}
