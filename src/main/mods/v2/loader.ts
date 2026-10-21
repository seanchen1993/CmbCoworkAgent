import {
  parseFunctionModelProtocol,
  type FunctionModelProtocol
} from "../../../shared/mods/v2/model-protocol"
import { createHash } from "node:crypto"
import { assertFunctionSourcesCurrent, bindFunctionSourceProofs, sourceProof, type FunctionSourceProof } from "./source-adoption-fence"
import { readConfigurationOnlyPackage } from "./configuration-only-package"
import { lstatSync, realpathSync, statSync } from "node:fs"
import { dirname, extname, relative, resolve } from "node:path"
import type { ModObject } from "../../../shared/mods/types"
import { parseFunctionUserConfig, type FunctionUserConfig } from "../../../shared/mods/v2/user-config"
import { parseFunctionUserConfigSchema, type FunctionUserConfigSchema } from "../../../shared/mods/v2/user-config-schema"
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
import { parseFunctionModule, resolveClientModules } from "./client-loader"
import { FUNCTION_STATE_LIBRARY } from "./state-library"
import { discoverFunctionEnvironment, type FunctionEnvironmentDeclaration } from "./environment-sdk"
import type { FunctionAuthorTypes } from "./author-types"
import { parseClawActionExports, type ClawActionExport } from "../../../shared/mods/claw-actions"
import { validateToolSchema } from "./tool-schema"
import {
  parseClawComponentExports,
  type ClawComponentExport
} from "../../../shared/mods/claw-components"
import { assembleFunctionComponents, type CompiledFunctionComponent } from "./component-projection"
export { projectFunctionComponents, type FunctionComponentProjection } from "./component-projection"

export interface CompiledFunctionPlugin {
  /** Main-only configuration metadata; never a guest execution source. */
  configurationOnly?: true
  name: string
  modelProtocol: FunctionModelProtocol
  root: string
  profile: typeof CLAUDE_MODS_PROFILE
  digest: string
  code: string
  options: ModObject
  userConfig?: FunctionUserConfig
  userConfigSchema?: FunctionUserConfigSchema
  sources: string[]
  clients: Record<string, string>
  environment: FunctionEnvironmentDeclaration
  authorTypes?: FunctionAuthorTypes
  authoringSources?: Record<string, string>
  authoringEntries?: string[]
  actions?: ClawActionExport[]
  components?: ClawComponentExport[]
  componentModules?: Record<string, CompiledFunctionComponent>
}

/** Configuration readers may use native schema metadata without constructing a dummy guest.
 * Behavioral packages still take the unchanged ordinary compiler and all of its module checks.
 */
export async function compileFunctionConfiguration(
  directory: string,
  tooling?: { captureSources: boolean }
): Promise<CompiledFunctionPlugin> {
  let metadata: ReturnType<typeof readConfigurationOnlyPackage>
  try { metadata = readConfigurationOnlyPackage(realpathSync(directory)) }
  catch { return compileFunctionPlugin(directory, tooling) }
  const sources = [...metadata.captured].sort(([a], [b]) => a.localeCompare(b))
  const compiled: CompiledFunctionPlugin = {
    configurationOnly: true,
    name: metadata.name,
    root: metadata.root,
    profile: CLAUDE_MODS_PROFILE,
    modelProtocol: metadata.modelProtocol,
    digest: createHash("sha256").update(JSON.stringify({
      configurationOnly: 1, hostRevision: FUNCTION_HOST_REVISION, sources
    })).digest("hex"),
    code: "", options: {}, clients: {}, environment: { read: [], write: [] },
    userConfig: metadata.userConfig,
    ...(metadata.userConfigSchema ? { userConfigSchema: metadata.userConfigSchema } : {}),
    sources: sources.map(([path]) => path),
    ...(tooling?.captureSources ? { authoringSources: Object.fromEntries(sources), authoringEntries: [] } : {})
  }
  bindFunctionSourceProofs(compiled, metadata.proofs, metadata.missing, true,
    { device: metadata.rootIdentity.dev, inode: metadata.rootIdentity.ino })
  assertFunctionSourcesCurrent(compiled)
  return compiled
}

async function read(root: string, path: string, limit: number) {
  const file = await openStableFileHandle(root, path)
  try {
    const bytes = await readStableFileHandleBounded(file, limit)
    return { bytes, identity: { device: file.identity.device, inode: file.identity.inode } }
  } finally {
    await file.handle.close()
  }
}

/** Inspect and build an immutable snapshot; never executes the plugin or an install script. */
export async function compileFunctionPlugin(
  directory: string,
  tooling?: { captureSources: boolean }
): Promise<CompiledFunctionPlugin> {
  const root = realpathSync(directory)
  const rootIdentity = lstatSync(root, { bigint: true })
  const captured = new Map<string, string>()
  const sourceProofs = new Map<string, FunctionSourceProof>()
  const missingSources = new Set<string>()
  let adoptableSources = true
  const readSource = async (path: string, limit: number) => {
    const { bytes, identity } = await read(root, path, limit)
    const key = relative(root, path).replace(/\\/g, "/")
    sourceProofs.set(key, sourceProof(key, bytes, identity))
    missingSources.delete(key)
    return bytes
  }
  const readJson = async (path: string): Promise<ModObject> => {
    const clean = normalizePluginRelativePath(path)
    if (!clean) throw Error("MODS_PATH_INVALID")
    let file: string
    try { file = resolveModFile(root, clean) }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        missingSources.add(clean)
      throw error
    }
    const text = (await readSource(file, 32768)).toString("utf8")
    captured.set(clean, text)
    const result = parseModJson(text)
    if (!isModObject(result)) throw Error("MODS_MANIFEST_INVALID")
    return result
  }
  let name: string
  let modules: string[]
  let options: ModObject = {}
  const packageInfo = readPluginManifest(root)
  for (const path of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", "plugin.json"]) {
    if (packageInfo && path === packageInfo.relPath) break
    try { await readSource(resolveModFile(root, path), 32768) }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        missingSources.add(path)
      // The existing package reader deliberately ignores unusable higher priority files.
      // Preserve cold loading; only private adoption requires a complete bounded proof.
      else adoptableSources = false
    }
  }
  const packageManifest = packageInfo ? await readJson(packageInfo.relPath) : undefined
  const nativePath =
    typeof packageManifest?.mods === "string" ? packageManifest.mods : "mods/manifest.json"
  let native: ModObject | undefined
  try {
    native = await readJson(nativePath)
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
  }
  const components = parseClawComponentExports(native?.claw)
  if (packageManifest?.userConfig !== undefined && native?.userConfig !== undefined)
    throw Error("MODS_USER_CONFIG_DECLARATION_CONFLICT")
  const userConfig = parseFunctionUserConfig(packageManifest?.userConfig !== undefined
    ? packageManifest.userConfig : native?.userConfig)
  if (packageManifest?.userConfigSchema !== undefined && native?.userConfigSchema !== undefined)
    throw Error("MODS_USER_CONFIG_DECLARATION_CONFLICT")
  if ((packageManifest?.userConfigSchema !== undefined && packageManifest.userConfig === undefined) ||
    (native?.userConfigSchema !== undefined && native.userConfig === undefined))
    throw Error("MODS_USER_CONFIG_SCHEMA_SOURCE_CONFLICT")
  const userConfigSchema = parseFunctionUserConfigSchema(packageManifest?.userConfigSchema ?? native?.userConfigSchema,
    userConfig)
  if (components.length && userConfig && Object.hasOwn(userConfig, "claw"))
    throw Error("MODS_USER_CONFIG_RESERVED_FIELD")
  if (parseClawComponentExports(packageManifest?.claw).length)
    throw Error("CLAW_COMPONENTS_NATIVE_ONLY")
  if (components.length && (native?.apiVersion !== MODS_V2_API || native.entry !== undefined))
    throw Error("CLAW_COMPONENT_ENTRY_CONFLICT")
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
      (!components.length && typeof manifest.entry !== "string")
    )
      throw Error("MODS_MANIFEST_INVALID")
    name = manifest.id
    modules = components.length
      ? components.map((entry) => relative(root, resolve(root, dirname(nativePath), entry.entry)))
      : [relative(root, resolve(root, dirname(nativePath), manifest.entry as string))]
    if (manifest.options !== undefined) {
      if (!isModObject(manifest.options)) throw Error("MODS_OPTIONS_INVALID")
      options = manifest.options
    }
  }
  if (!/^[a-zA-Z0-9][\w.-]{0,99}$/.test(name)) throw Error("MODS_PLUGIN_NAME")
  if (packageManifest?.claw !== undefined && native?.claw !== undefined)
    throw Error("CLAW_ACTION_DECLARATION_CONFLICT")
  if (packageManifest?.cmbCompatibility !== undefined && native?.cmbCompatibility !== undefined)
    throw Error("MODS_MODEL_PROTOCOL_CONFLICT")
  const modelProtocol = parseFunctionModelProtocol(
    packageManifest?.cmbCompatibility !== undefined
      ? packageManifest.cmbCompatibility
      : native?.cmbCompatibility
  )
  for (const manifest of [packageManifest, native]) {
    const compatibility = manifest?.cmbCompatibility
    const migrationsRequired = isModObject(compatibility) && compatibility.userConfigMigrations === "v1"
    if (manifest?.userConfigSchema !== undefined && !migrationsRequired)
      throw Error("MODS_USER_CONFIG_SCHEMA_COMPATIBILITY_REQUIRED")
    if (migrationsRequired && manifest?.userConfigSchema === undefined)
      throw Error("MODS_USER_CONFIG_SCHEMA_DECLARATION_REQUIRED")
  }
  const actions = parseClawActionExports(
    packageManifest?.claw !== undefined ? packageManifest.claw : native?.claw
  )
  for (const action of actions) {
    validateToolSchema(action.inputSchema)
    if (action.configSchema !== undefined) validateToolSchema(action.configSchema)
    if (action.outputSchema) validateToolSchema(action.outputSchema)
  }
  if (modules.length === 0 || modules.length > (components.length ? 32 : 16))
    throw Error("MODS_MODULES_LIMIT")
  if (components.length) {
    const actionIds = components.flatMap((entry) => entry.actionIds)
    if (
      new Set(actionIds).size !== actionIds.length ||
      actionIds.length !== actions.length ||
      actions.some((action) => !actionIds.includes(action.id))
    )
      throw Error("CLAW_COMPONENT_ACTION_OWNERSHIP")
    for (const entry of components) if (entry.configSchema) validateToolSchema(entry.configSchema)
  }
  let authorTypes: FunctionAuthorTypes | undefined
  if (packageManifest?.types !== undefined) {
    const { readFunctionAuthorTypes } = await import("./author-types")
    const declaration = await readFunctionAuthorTypes(
      root,
      packageManifest.types,
      packageManifest.dependencies
    )
    authorTypes = declaration.metadata
    captured.set(authorTypes.entry, declaration.source)
    const bytes = await readSource(resolveModFile(root, authorTypes.entry), 262144)
    if (bytes.toString("utf8") !== declaration.source) throw Error("MODS_CONFIG_SOURCE_CHANGED")
  }
  const entryPaths = modules.map((path) => resolveModFile(root, path))
  const pathKey = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path)
  const componentEntries = new Set(components.length ? entryPaths.map(pathKey) : [])
  if (components.length && componentEntries.size !== components.length)
    throw Error("CLAW_COMPONENT_ENTRY_DUPLICATE")
  const { build, version } = modCompiler()
  let bytes = 0
  let files = 0
  let clientModules = new Set<string>()
  let environmentNames = { read: new Set<string>(), write: new Set<string>() }
  let activeComponentEntry: string | undefined
  const buildModule = (contents: string, globalName: string, surface = false) =>
    build({
      stdin: {
        contents,
        resolveDir: root,
        loader: "js"
      },
      bundle: true,
      write: false,
      format: "iife",
      globalName,
      platform: "neutral",
      target: "es2016",
      jsxFactory: "__functionJsx",
      jsxFragment: "__functionFragment",
      logLevel: "silent",
      plugins: [
        {
          name: "mods-v2-snapshot",
          setup(builder) {
            builder.onLoad({ filter: /.*/, namespace: "function-state-library" }, () => ({
              contents: FUNCTION_STATE_LIBRARY,
              loader: "js"
            }))
            builder.onResolve({ filter: /.*/ }, (args) => {
              if ((args.path === "devclaw-mods" || args.path === "claude-code") &&
                args.kind === "import-statement")
                return { path: "claude-code", namespace: "function-state-library" }
              if (args.kind !== "import-statement" || !args.path.startsWith("."))
                throw Error("MODS_IMPORT_DENIED")
              const requested = resolve(
                args.importer && args.importer !== "<stdin>" ? dirname(args.importer) : root,
                args.path
              )
              const candidates = extname(requested)
                ? [requested]
                : [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs", "/index.ts"].map((s) => requested + s)
              for (const candidate of candidates) {
                try {
                  const path = resolveModFile(root, relative(root, candidate))
                  if (componentEntries.has(pathKey(path)) && pathKey(path) !== activeComponentEntry)
                    throw Error("CLAW_COMPONENT_CROSS_ENTRY_IMPORT")
                  return {
                    path,
                    namespace: "function-mod"
                  }
                } catch (error) {
                  if (error instanceof Error && "code" in error && error.code === "ENOENT")
                    missingSources.add(relative(root, candidate).replace(/\\/g, "/"))
                  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
                    throw error
                }
              }
              throw Error("MODS_IMPORT_MISSING")
            })
            builder.onLoad({ filter: /.*/, namespace: "function-mod" }, async (args) => {
              const extension = extname(args.path)
              if (![".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(extension))
                throw Error("MODS_IMPORT_TYPE")
              const file = resolveModFile(root, relative(root, args.path))
              const key = relative(root, file).replace(/\\/g, "/")
              let content = captured.get(key)
              if (content === undefined) {
                const size = statSync(file).size
                bytes += size
                if (++files > 128 || bytes > 2 * 1024 * 1024) throw Error("MODS_SOURCE_LIMIT")
                content = (await readSource(file, size)).toString("utf8")
                captured.set(key, content)
              }
              const loader =
                extension === ".tsx"
                  ? "tsx"
                  : extension === ".jsx"
                    ? "jsx"
                    : extension.endsWith("ts")
                      ? "ts"
                      : "js"
              if (!surface) {
                const result = resolveClientModules(content, loader, file, root)
                const declaration = discoverFunctionEnvironment(result.code)
                for (const name of declaration.read) environmentNames.read.add(name)
                for (const name of declaration.write) environmentNames.write.add(name)
                if (environmentNames.read.size + environmentNames.write.size > 128)
                  throw Error("MODS_ENV_DECLARATION_LIMIT")
                for (const module of result.modules) clientModules.add(module)
                return { contents: result.code, loader: "js" }
              }
              return {
                contents: parseFunctionModule(content, loader, file, root).code,
                loader: "js"
              }
            })
          }
        }
      ]
    })
  const registerSource = (paths: string[]) =>
    paths
      .map(
        (path, i) =>
          `import { register as r${i} } from ${JSON.stringify("./" + path.replace(/\\/g, "/"))}`
      )
      .join("\n") +
    `\nexport function register(on, options) { ${paths.map((_, i) => `const v${i} = r${i}(on, options); if (v${i} && typeof v${i}.then === "function") throw Error("MODS_ASYNC_REGISTER");`).join(" ")} }`
  const componentModules: Record<string, CompiledFunctionComponent> = Object.create(null)
  let componentBundleBytes = 0
  if (components.length) {
    for (const [index, entry] of components.entries()) {
      clientModules = new Set()
      environmentNames = { read: new Set(), write: new Set() }
      activeComponentEntry = pathKey(entryPaths[index])
      const globalName = `__cmbComponent${index}`
      const result = await buildModule(registerSource([modules[index]]), globalName)
      const code = result.outputFiles[0]?.text
      if (!code || (componentBundleBytes += Buffer.byteLength(code)) > 2 * 1024 * 1024)
        throw Error("MODS_BUNDLE_LIMIT")
      const clients: Record<string, string> = Object.create(null)
      if (clientModules.size > 16) throw Error("MODS_CLIENT_MODULE_LIMIT")
      for (const module of [...clientModules].sort()) {
        const output = await buildModule(
          `import * as surface from ${JSON.stringify("./" + module)}; export default surface.default; export * from ${JSON.stringify("./" + module)}`,
          "__cmbSurfaceMod",
          true
        )
        const source = output.outputFiles[0]?.text
        if (!source || (componentBundleBytes += Buffer.byteLength(source)) > 2 * 1024 * 1024)
          throw Error("MODS_BUNDLE_LIMIT")
        clients[module] = source
      }
      componentModules[entry.id] = {
        code,
        globalName,
        clients,
        environment: {
          read: [...environmentNames.read].sort(),
          write: [...environmentNames.write].sort()
        }
      }
    }
    environmentNames = { read: new Set(), write: new Set() }
    for (const module of Object.values(componentModules)) {
      module.environment.read.forEach((name) => environmentNames.read.add(name))
      module.environment.write.forEach((name) => environmentNames.write.add(name))
    }
    if (environmentNames.read.size + environmentNames.write.size > 128)
      throw Error("MODS_ENV_DECLARATION_LIMIT")
  }
  const output = components.length
    ? undefined
    : await buildModule(
        modules
          .map(
            (path, i) =>
              `import { register as r${i} } from ${JSON.stringify("./" + path.replace(/\\/g, "/"))}`
          )
          .join("\n") +
          `\nexport function register(on, options) { ${modules.map((_, i) => `const v${i} = r${i}(on, options); if (v${i} && typeof v${i}.then === "function") throw Error("MODS_ASYNC_REGISTER");`).join(" ")} }`,
        "__cmbFunctionMod"
      )
  const code = components.length
    ? assembleFunctionComponents(components, componentModules, {})
    : output?.outputFiles[0]?.text
  if (!code || Buffer.byteLength(code) > 2 * 1024 * 1024) throw Error("MODS_BUNDLE_LIMIT")
  const clients: Record<string, string> = Object.create(null)
  if (components.length) {
    for (const module of Object.values(componentModules)) Object.assign(clients, module.clients)
    clientModules = new Set()
  }
  if (clientModules.size > 16 || Object.keys(clients).length > 16)
    throw Error("MODS_CLIENT_MODULE_LIMIT")
  let bundleBytes = Buffer.byteLength(code)
  for (const module of [...clientModules].sort()) {
    const output = await buildModule(
      `import * as surface from ${JSON.stringify("./" + module)}; export default surface.default; export * from ${JSON.stringify("./" + module)}`,
      "__cmbSurfaceMod",
      true
    )
    const source = output.outputFiles[0]?.text
    if (!source || (bundleBytes += Buffer.byteLength(source)) > 2 * 1024 * 1024)
      throw Error("MODS_BUNDLE_LIMIT")
    clients[module] = source
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        name,
        profile: CLAUDE_MODS_PROFILE,
        ...(modelProtocol === "result-v1" ? { modelProtocol } : {}),
        hostRevision: FUNCTION_HOST_REVISION,
        version,
        code,
        clients,
        environment: {
          read: [...environmentNames.read].sort(),
          write: [...environmentNames.write].sort()
        },
        sources: [...captured].sort(([a], [b]) => a.localeCompare(b))
      })
    )
    .digest("hex")
  const compiled: CompiledFunctionPlugin = {
    name,
    modelProtocol,
    actions,
    ...(components.length ? { components, componentModules } : {}),
    root,
    profile: CLAUDE_MODS_PROFILE,
    digest,
    code,
    clients,
    environment: {
      read: [...environmentNames.read].sort(),
      write: [...environmentNames.write].sort()
    },
    options,
    ...(userConfig === undefined ? {} : { userConfig }),
    ...(userConfigSchema === undefined ? {} : { userConfigSchema }),
    sources: [...captured.keys()].sort(),
    ...(authorTypes ? { authorTypes } : {}),
    ...(tooling?.captureSources
      ? {
          authoringSources: Object.fromEntries(captured),
          authoringEntries: modules.map((path) => path.replace(/\\/g, "/"))
        }
      : {})
  }
  bindFunctionSourceProofs(compiled, [...sourceProofs.values()], [...missingSources], adoptableSources,
    { device: rootIdentity.dev, inode: rootIdentity.ino })
  return compiled
}
