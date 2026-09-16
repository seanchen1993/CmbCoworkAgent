import { createHash } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import { dirname, extname, relative, resolve } from "node:path"
import type { ModObject } from "../../../shared/mods/types"
import {
  isModObject,
  CLAUDE_MODS_PROFILE,
  FUNCTION_HOST_REVISION,
  MODS_V2_API
} from "../../../shared/mods/v2/contracts"
import { parseModJson } from "../../../shared/mods/validation"
import {
  openStableFileHandle,
  readStableFileHandleBounded
} from "../../services/stable-file-handle"
import { modCompiler, resolveModFile } from "../loader"
import { normalizePluginRelativePath, readPluginManifest } from "../../plugins/manifest"

export interface CompiledFunctionPlugin {
  name: string
  root: string
  profile: typeof CLAUDE_MODS_PROFILE
  digest: string
  code: string
  options: ModObject
  sources: string[]
}

async function read(root: string, path: string, limit: number): Promise<Buffer> {
  const file = await openStableFileHandle(root, path)
  try {
    return await readStableFileHandleBounded(file, limit)
  } finally {
    await file.handle.close()
  }
}

/** Inspect and build an immutable snapshot; never executes the plugin or an install script. */
export async function compileFunctionPlugin(directory: string): Promise<CompiledFunctionPlugin> {
  const root = realpathSync(directory)
  const captured = new Map<string, string>()
  const readJson = async (path: string): Promise<ModObject> => {
    const clean = normalizePluginRelativePath(path)
    if (!clean) throw Error("MODS_PATH_INVALID")
    const file = resolveModFile(root, clean)
    const text = (await read(root, file, 32768)).toString("utf8")
    captured.set(clean, text)
    const result = parseModJson(text)
    if (!isModObject(result)) throw Error("MODS_MANIFEST_INVALID")
    return result
  }
  let name: string
  let modules: string[]
  let options: ModObject = {}
  const packageInfo = readPluginManifest(root)
  const packageManifest = packageInfo ? await readJson(packageInfo.relPath) : undefined
  const nativePath =
    typeof packageManifest?.mods === "string" ? packageManifest.mods : "mods/manifest.json"
  let native: ModObject | undefined
  try {
    native = await readJson(nativePath)
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
  }
  if (packageManifest && native?.apiVersion !== MODS_V2_API) {
    if (typeof packageManifest.name !== "string") throw Error("MODS_PLUGIN_NAME")
    name = packageManifest.name
    const hooksPath =
      typeof packageManifest.hooks === "string" ? packageManifest.hooks : "hooks/hooks.json"
    const hooks = await readJson(hooksPath)
    if (!Array.isArray(hooks.modules) || !hooks.modules.every((m) => typeof m === "string"))
      throw Error("MODS_MODULES_INVALID")
    modules = hooks.modules.map((m) =>
      relative(root, resolve(root, dirname(hooksPath), m as string))
    )
  } else {
    const manifest = native
    if (
      manifest?.apiVersion !== MODS_V2_API ||
      typeof manifest.id !== "string" ||
      typeof manifest.entry !== "string"
    )
      throw Error("MODS_MANIFEST_INVALID")
    name = manifest.id
    modules = [relative(root, resolve(root, dirname(nativePath), manifest.entry))]
    if (manifest.options !== undefined) {
      if (!isModObject(manifest.options)) throw Error("MODS_OPTIONS_INVALID")
      options = manifest.options
    }
  }
  if (!/^[a-zA-Z0-9][\w.-]{0,99}$/.test(name)) throw Error("MODS_PLUGIN_NAME")
  if (modules.length === 0 || modules.length > 16) throw Error("MODS_MODULES_LIMIT")
  for (const path of modules) resolveModFile(root, path)
  const { build, version } = modCompiler()
  let bytes = 0
  let files = 0
  const output = await build({
    stdin: {
      contents:
        modules
          .map(
            (path, i) =>
              `import { register as r${i} } from ${JSON.stringify("./" + path.replace(/\\/g, "/"))}`
          )
          .join("\n") +
        `\nexport function register(on, options) { ${modules.map((_, i) => `const v${i} = r${i}(on, options); if (v${i} && typeof v${i}.then === "function") throw Error("MODS_ASYNC_REGISTER");`).join(" ")} }`,
      resolveDir: root,
      loader: "js"
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "__cmbFunctionMod",
    platform: "neutral",
    target: "es2016",
    jsxFactory: "__functionJsx",
    jsxFragment: "__functionFragment",
    logLevel: "silent",
    plugins: [
      {
        name: "mods-v2-snapshot",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === "dynamic-import" || !args.path.startsWith("."))
              throw Error("MODS_IMPORT_DENIED")
            const requested = resolve(
              args.importer && args.importer !== "<stdin>" ? dirname(args.importer) : root,
              args.path
            )
            const candidates = extname(requested)
              ? [requested]
              : [".ts", ".tsx", ".js", ".jsx", "/index.ts"].map((s) => requested + s)
            for (const candidate of candidates) {
              try {
                return {
                  path: resolveModFile(root, relative(root, candidate)),
                  namespace: "function-mod"
                }
              } catch (error) {
                if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
                  throw error
              }
            }
            throw Error("MODS_IMPORT_MISSING")
          })
          builder.onLoad({ filter: /.*/, namespace: "function-mod" }, async (args) => {
            const extension = extname(args.path)
            if (![".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"].includes(extension))
              throw Error("MODS_IMPORT_TYPE")
            const file = resolveModFile(root, relative(root, args.path))
            const size = statSync(file).size
            bytes += size
            if (++files > 128 || bytes > 2 * 1024 * 1024) throw Error("MODS_SOURCE_LIMIT")
            const content = await read(root, file, size)
            captured.set(relative(root, file).replace(/\\/g, "/"), content.toString("utf8"))
            return {
              contents: content,
              loader:
                extension === ".tsx"
                  ? "tsx"
                  : extension === ".jsx"
                    ? "jsx"
                    : extension.endsWith("ts")
                      ? "ts"
                      : "js"
            }
          })
        }
      }
    ]
  })
  const code = output.outputFiles[0]?.text
  if (!code || Buffer.byteLength(code) > 2 * 1024 * 1024) throw Error("MODS_BUNDLE_LIMIT")
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        name,
        profile: CLAUDE_MODS_PROFILE,
        hostRevision: FUNCTION_HOST_REVISION,
        version,
        code,
        sources: [...captured].sort(([a], [b]) => a.localeCompare(b))
      })
    )
    .digest("hex")
  return {
    name,
    root,
    profile: CLAUDE_MODS_PROFILE,
    digest,
    code,
    options,
    sources: [...captured.keys()].sort()
  }
}
