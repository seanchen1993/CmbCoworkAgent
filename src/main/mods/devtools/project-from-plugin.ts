import { createHash } from "node:crypto"
import { existsSync, lstatSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { ZodError } from "zod"
import type { PluginMetadata } from "../../types"
import type { DevelopmentScope } from "../v2/development-session"
import { NATIVE_COMPOSITION_PATH, nativeCompositionSchema } from "../../plugins/native-composition"
import { assertOriginalContent, MARKET_CONTENT_DENIED } from "../../services/market-content"
import { readAuthoringProjectSource } from "./project-source"
import type { ProjectAuthoringSessions } from "./project-authoring-session"
import { parsePortableBusinessModUserConfig } from "../../plugins/business-mod-user-config"
import { parseFunctionUserConfigSchema } from "../../../shared/mods/v2/user-config-schema"

const identity = (plugin: PluginMetadata) =>
  createHash("sha256")
    .update(
      JSON.stringify([plugin.id, plugin.path, plugin.version, plugin.updatedAt, plugin.enabled])
    )
    .digest("hex")

/** Source stays pinned through the synchronous guards immediately before draft persistence. */
function pinSource(root: string, paths: string[]) {
  const entries = new Set([root])
  for (const path of paths) {
    let absolute = join(root, path)
    while (absolute !== root) {
      entries.add(absolute)
      absolute = dirname(absolute)
    }
  }
  const stamp = (path: string) => {
    const stat = lstatSync(path, { bigint: true })
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n)))
      throw Error("PROJECT_PLUGIN_SOURCE_CHANGED")
    if (stat.isDirectory() && realpathSync(path) !== resolve(path))
      throw Error("PROJECT_PLUGIN_SOURCE_CHANGED")
    return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(
      ":"
    )
  }
  const stamps = [...entries].map((path) => [path, stamp(path)] as const)
  return () => {
    try {
      if (stamps.some(([path, before]) => stamp(path) !== before))
        throw Error("PROJECT_PLUGIN_SOURCE_CHANGED")
    } catch {
      throw Error("PROJECT_PLUGIN_SOURCE_CHANGED")
    }
  }
}

/** Copy exact native author source, never installed permissions, runtime state or approvals. */
export async function projectFromInstalledPlugin(input: {
  scope: DevelopmentScope
  pluginId: string
  id: string
  name?: string
  sourceDigest?: string
  plugins(): PluginMetadata[]
  sessions: Pick<ProjectAuthoringSessions, "save">
  guard(): void
}) {
  input.guard()
  const selected = input.plugins().find((plugin) => plugin.id === input.pluginId)
  if (!selected) throw Error("PROJECT_PLUGIN_NOT_INSTALLED")
  const plugin = { ...selected }
  const installedIdentity = identity(plugin)
  const guard = () => {
    input.guard()
    const current = input.plugins().find((item) => item.id === input.pluginId)
    if (!current || identity(current) !== installedIdentity)
      throw Error("PROJECT_PLUGIN_SOURCE_CHANGED")
  }
  const root = resolve(plugin.path)
  try {
    assertOriginalContent(root)
    if (!existsSync(join(root, NATIVE_COMPOSITION_PATH)))
      throw Error("PROJECT_PLUGIN_NATIVE_SOURCE_REQUIRED")
    // Native compositions declare their configuration in source.json. Do not copy local
    // connection settings or silently omit a second executable package registration.
    if (existsSync(join(root, ".mcp.json"))) throw Error("PROJECT_PLUGIN_SOURCE_UNSUPPORTED")
    const source = await readAuthoringProjectSource(root)
    guard()
    const declaration = nativeCompositionSchema.parse(
      JSON.parse(source.bundle.files.find((file) => file.path === NATIVE_COMPOSITION_PATH)!.text)
    )
    const manifest = source.bundle.files.find((file) => file.path === "plugin.json")
    if (manifest) {
      const metadata = JSON.parse(manifest.text)
      const userConfig = parsePortableBusinessModUserConfig(declaration.configuration?.userConfig)
      const userConfigSchema = parseFunctionUserConfigSchema(
        declaration.configuration?.userConfigSchema,
        userConfig
      )
      if (
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata) ||
        Object.keys(metadata).some(
          (key) =>
            ![
              "name",
              "version",
              "description",
              "skills",
              "userConfig",
              "userConfigSchema",
              "cmbCompatibility"
            ].includes(key)
        ) ||
        metadata.name !== declaration.plugin.id ||
        metadata.version !== declaration.plugin.version ||
        metadata.skills !== "skills" ||
        !isDeepStrictEqual(metadata.userConfig, userConfig) ||
        !isDeepStrictEqual(metadata.userConfigSchema, userConfigSchema) ||
        !isDeepStrictEqual(
          metadata.cmbCompatibility,
          userConfigSchema ? { userConfigMigrations: "v1" } : undefined
        )
      )
        throw Error("PROJECT_PLUGIN_SOURCE_UNSUPPORTED")
    }
    const retained = new Set([
      NATIVE_COMPOSITION_PATH,
      ...declaration.resources,
      ...declaration.modules.map((module) => module.skill),
      "plugin.json",
      "composition/lock.json",
      "devclaw.project-runtime.json",
      "devclaw.project-actions.lock.json"
    ])
    // Compiler-generated native Skills are regenerated. All other author files must be
    // declared, otherwise recompilation would silently discard original behavior.
    const generatedSkills = new Set(
      declaration.modules.map((module) => `skills/native-${module.id}/SKILL.md`)
    )
    if (
      source.excluded.length ||
      source.bundle.files.some(
        (file) => !retained.has(file.path) && !generatedSkills.has(file.path)
      )
    )
      throw Error("PROJECT_PLUGIN_SOURCE_UNSUPPORTED")
    if (input.sourceDigest && input.sourceDigest !== source.bundle.digest)
      throw Error("PROJECT_PLUGIN_SOURCE_CHANGED")
    const pinned = pinSource(
      root,
      source.bundle.files.map((file) => file.path)
    )
    const currentGuard = () => {
      guard()
      assertOriginalContent(root)
      pinned()
    }
    // A second bounded read binds the bytes read before pinning to the pinned file identities.
    const checked = await readAuthoringProjectSource(root)
    currentGuard()
    if (checked.bundle.digest !== source.bundle.digest || checked.excluded.length)
      throw Error("PROJECT_PLUGIN_SOURCE_CHANGED")
    const draft = await input.sessions.save(
      input.scope,
      {
        id: input.id,
        name: input.name ?? declaration.plugin.title,
        revision: 0,
        files: source.bundle.files
      },
      currentGuard
    )
    currentGuard()
    return {
      draft,
      origin: {
        pluginId: plugin.id,
        name: plugin.name,
        version: plugin.version,
        installedIdentity,
        sourceDigest: source.bundle.digest
      },
      originalPreserved: true,
      executed: false,
      grantsAuthority: false,
      requiresFreshTrial: true
    }
  } catch (error) {
    if (error instanceof Error && error.message === MARKET_CONTENT_DENIED)
      throw Error("PROJECT_PLUGIN_SOURCE_PROTECTED")
    if (error instanceof SyntaxError || error instanceof ZodError)
      throw Error("PROJECT_PLUGIN_SOURCE_INVALID")
    if (
      error instanceof Error &&
      (["PROJECT_SOURCE_CHANGED", "AUTHORING_VERSION_CHANGED"].includes(error.message) ||
        ["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
    )
      throw Error("PROJECT_PLUGIN_SOURCE_CHANGED")
    throw error
  }
}
