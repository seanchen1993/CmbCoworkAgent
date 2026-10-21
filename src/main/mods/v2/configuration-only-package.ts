import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync
} from "node:fs"
import { relative, resolve } from "node:path"
import { parseModJson } from "../../../shared/mods/validation"
import { isModObject, MODS_V2_API } from "../../../shared/mods/v2/contracts"
import { parseFunctionUserConfig } from "../../../shared/mods/v2/user-config"
import { parseFunctionUserConfigSchema } from "../../../shared/mods/v2/user-config-schema"
import { parseFunctionModelProtocol } from "../../../shared/mods/v2/model-protocol"
import { normalizePluginRelativePath, validatePluginManifest } from "../../plugins/manifest"
import { resolveModFile } from "../loader"
import { sourceProof, type FunctionSourceProof } from "./source-adoption-fence"
import type { ModObject } from "../../../shared/mods/types"

const packagePaths = [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", "plugin.json"]
const packageKeys = new Set([
  "name",
  "version",
  "description",
  "useScenario",
  "author",
  "license",
  "keywords",
  "skills",
  "hooks",
  "mcpServers",
  "mods",
  "userConfig",
  "userConfigSchema",
  "cmbCompatibility"
])
const nativeKeys = new Set([
  "apiVersion",
  "id",
  "version",
  "description",
  "userConfig",
  "userConfigSchema",
  "cmbCompatibility"
])
const pathKey = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path)

/** Strict metadata only: this declaration never represents a callable Function Mod. Ordinary
 * Skills, command Hooks and MCP remain owned by their independent native admission paths.
 */
export function readConfigurationOnlyPackage(directory: string) {
  const root = realpathSync(directory)
  const rootIdentity = lstatSync(root, { bigint: true })
  if (
    !rootIdentity.isDirectory() ||
    rootIdentity.isSymbolicLink() ||
    pathKey(root) !== pathKey(resolve(directory))
  )
    throw Error("MODS_CONFIGURATION_ONLY_SOURCE_INVALID")
  const captured = new Map<string, string>()
  const proofs: FunctionSourceProof[] = []
  const missing = new Set<string>()
  const readJson = (input: string) => {
    const clean = normalizePluginRelativePath(input)
    if (!clean || clean === ".") throw Error("MODS_CONFIGURATION_ONLY_SOURCE_INVALID")
    let path: string
    try {
      path = resolveModFile(root, clean)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missing.add(clean)
        return undefined
      }
      throw error
    }
    const before = lstatSync(path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 32768n)
      throw Error("MODS_CONFIGURATION_ONLY_SOURCE_INVALID")
    const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)
    const nonBlocking = process.platform === "win32" ? 0 : (constants.O_NONBLOCK ?? 0)
    const fd = openSync(path, constants.O_RDONLY | noFollow | nonBlocking)
    try {
      const opened = fstatSync(fd, { bigint: true })
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size ||
        opened.mtimeNs !== before.mtimeNs ||
        opened.ctimeNs !== before.ctimeNs
      )
        throw Error("MODS_CONFIGURATION_ONLY_SOURCE_CHANGED")
      const bytes = Buffer.alloc(Number(opened.size))
      let offset = 0
      while (offset < bytes.length) {
        const size = readSync(fd, bytes, offset, bytes.length - offset, offset)
        if (!size) throw Error("MODS_CONFIGURATION_ONLY_SOURCE_CHANGED")
        offset += size
      }
      const after = fstatSync(fd, { bigint: true })
      const current = lstatSync(path, { bigint: true })
      if (
        after.size !== opened.size ||
        after.mtimeNs !== opened.mtimeNs ||
        after.ctimeNs !== opened.ctimeNs ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino ||
        current.isSymbolicLink() ||
        current.nlink !== 1n ||
        resolveModFile(root, clean) !== path
      )
        throw Error("MODS_CONFIGURATION_ONLY_SOURCE_CHANGED")
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      const parsed = parseModJson(text)
      if (!isModObject(parsed) && !Array.isArray(parsed))
        throw Error("MODS_CONFIGURATION_ONLY_DECLARATION_INVALID")
      const key = relative(root, path).replace(/\\/g, "/")
      captured.set(key, text)
      proofs.push(sourceProof(key, bytes, { device: opened.dev, inode: opened.ino }))
      return parsed
    } finally {
      closeSync(fd)
    }
  }
  const readObject = (path: string): ModObject | undefined => {
    const parsed = readJson(path)
    if (parsed !== undefined && !isModObject(parsed))
      throw Error("MODS_CONFIGURATION_ONLY_DECLARATION_INVALID")
    return parsed
  }
  let manifest: ModObject | undefined
  for (const path of packagePaths) {
    manifest = readObject(path)
    if (manifest) break
  }
  if (
    manifest &&
    (!validatePluginManifest(manifest) ||
      Object.keys(manifest).some((key) => !packageKeys.has(key)))
  )
    throw Error("MODS_CONFIGURATION_ONLY_DECLARATION_INVALID")
  if (
    manifest &&
    ["hooks", "mods", "mcpServers"].some(
      (key) =>
        manifest![key] !== undefined && (typeof manifest![key] !== "string" || !manifest![key])
    )
  )
    throw Error("MODS_CONFIGURATION_ONLY_DECLARATION_INVALID")
  const nativePath = typeof manifest?.mods === "string" ? manifest.mods : "mods/manifest.json"
  const native = readObject(nativePath)
  if (manifest?.mods !== undefined && native === undefined)
    throw Error("MODS_CONFIGURATION_ONLY_DECLARATION_INVALID")
  if (
    native &&
    (native.apiVersion !== MODS_V2_API ||
      typeof native.id !== "string" ||
      !/^[a-zA-Z0-9][\w.-]{0,99}$/.test(native.id) ||
      Object.keys(native).some((key) => !nativeKeys.has(key)))
  )
    throw Error("MODS_CONFIGURATION_ONLY_DECLARATION_INVALID")
  for (const path of new Set([
    "hooks/hooks.json",
    ...(typeof manifest?.hooks === "string" ? [manifest.hooks] : [])
  ])) {
    const hooks = readJson(path)
    if (manifest?.hooks === path && hooks === undefined)
      throw Error("MODS_CONFIGURATION_ONLY_DECLARATION_INVALID")
    if (
      hooks &&
      (Object.hasOwn(hooks, "modules") ||
        (Array.isArray(hooks) &&
          hooks.some(
            (item) =>
              !isModObject(item) ||
              ["modules", "entry", "register"].some((key) => Object.hasOwn(item, key))
          )))
    )
      throw Error("MODS_CONFIGURATION_ONLY_BEHAVIOR_DECLARED")
  }
  if (
    (manifest?.userConfig !== undefined && native?.userConfig !== undefined) ||
    (manifest?.userConfigSchema !== undefined && native?.userConfigSchema !== undefined) ||
    (manifest?.cmbCompatibility !== undefined && native?.cmbCompatibility !== undefined)
  )
    throw Error("MODS_USER_CONFIG_DECLARATION_CONFLICT")
  if (
    (manifest?.userConfigSchema !== undefined && manifest.userConfig === undefined) ||
    (native?.userConfigSchema !== undefined && native.userConfig === undefined)
  )
    throw Error("MODS_USER_CONFIG_SCHEMA_SOURCE_CONFLICT")
  const userConfig = parseFunctionUserConfig(manifest?.userConfig ?? native?.userConfig)
  if (!userConfig || Object.keys(userConfig).length === 0)
    throw Error("MODS_CONFIGURATION_ONLY_DECLARATION_REQUIRED")
  const userConfigSchema = parseFunctionUserConfigSchema(
    manifest?.userConfigSchema ?? native?.userConfigSchema,
    userConfig
  )
  for (const declaration of [manifest, native]) {
    const compatibility = declaration?.cmbCompatibility
    const required = isModObject(compatibility) && compatibility.userConfigMigrations === "v1"
    if (declaration?.userConfigSchema !== undefined && !required)
      throw Error("MODS_USER_CONFIG_SCHEMA_COMPATIBILITY_REQUIRED")
    if (required && declaration?.userConfigSchema === undefined)
      throw Error("MODS_USER_CONFIG_SCHEMA_DECLARATION_REQUIRED")
  }
  const name = native?.id ?? manifest?.name
  if (typeof name !== "string" || !name.trim() || name.length > 200 || /\0/.test(name))
    throw Error("MODS_PLUGIN_NAME")
  const modelProtocol = parseFunctionModelProtocol(
    manifest?.cmbCompatibility ?? native?.cmbCompatibility
  )
  const current = lstatSync(root, { bigint: true })
  if (
    current.dev !== rootIdentity.dev ||
    current.ino !== rootIdentity.ino ||
    current.isSymbolicLink()
  )
    throw Error("MODS_CONFIGURATION_ONLY_SOURCE_CHANGED")
  return {
    root,
    rootIdentity,
    captured,
    proofs,
    missing: [...missing],
    name,
    userConfig,
    userConfigSchema,
    modelProtocol
  }
}

/** Static classification grants no execution or configuration values; uncertain declarations fail closed. */
export function isConfigurationOnlyPackage(root: string): boolean {
  try {
    readConfigurationOnlyPackage(root)
    return true
  } catch {
    return false
  }
}
