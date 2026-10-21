import type {
  BusinessModCatalog,
  BusinessModDefinition,
  BusinessModExtensionDefinition,
  BusinessModHostDeclaration
} from "../../shared/business-mods"
import { BUSINESS_MOD_MANIFEST } from "../../shared/business-mods"
import { parseClawActionExports } from "../../shared/mods/claw-actions"
import { parseCapabilityUsage } from "../../shared/mods/capability-usage"
import type { DerivationFile, DerivationSnapshot } from "./derivation-source"
import { parsePortableBusinessModUserConfig } from "./business-mod-user-config"
import { validateToolSchema } from "../mods/v2/tool-schema"
import type { ModObject } from "../../shared/mods/types"
import {
  parseProjectRuntimeManifestV1,
  type ProjectRuntimeManifest
} from "../../shared/project-runtime"
import { assertHostRuntimeSupported } from "../harness-board/project-runtime/host-validators"

const identifier = /^[a-zA-Z0-9][\w.-]{0,79}$/
const version = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/
export function businessModObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("业务 Mods 配置必须是对象")
  return value as Record<string, unknown>
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw Error("业务 Mods 配置含未知字段")
}
function text(value: unknown, max = 160): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw Error("业务 Mods 文本字段无效")
  return value
}
export function businessModId(value: unknown): string {
  const id = text(value, 80)
  if (!identifier.test(id)) throw Error("业务 Mod 标识无效")
  return id
}
export function businessModPath(value: unknown): string {
  const path = text(value, 512)
  if (
    /[\\:*?<>"|]/.test(path) ||
    [...path].some((character) => character.charCodeAt(0) < 32) ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part)) ||
    path
      .split("/")
      .some((part) =>
        /^(?:\.git|node_modules|\.env.*|credentials.*|secrets?.*|\.ssh|\.aws|\.azure)$/i.test(part)
      )
  )
    throw Error("业务 Mod 资源路径无效")
  return path
}
function strings(value: unknown, parse: (value: unknown) => string, max = 512): string[] {
  if (!Array.isArray(value) || value.length > max) throw Error("业务 Mod 列表无效")
  const result = value.map(parse)
  if (new Set(result.map((item) => item.toLowerCase())).size !== result.length)
    throw Error("业务 Mod 列表含重复项")
  return result
}
function kernelIdentity(value: unknown) {
  const raw = businessModObject(value)
  const id = businessModId(raw.id),
    declaredVersion = text(raw.version)
  if (!version.test(declaredVersion)) throw Error("业务 Mods 内核版本必须精确")
  return { id, version: declaredVersion }
}

/** Validate through the original executor parser; authoring adds no executable schema. */
function hostDeclaration(
  value: unknown,
  id: string,
  title: string,
  skill: string
): BusinessModHostDeclaration {
  const raw = businessModObject(value)
  fields(raw, ["stage", "actions", "artifacts", "checks", "environment"])
  const stage = businessModObject(raw.stage)
  fields(stage, ["actionIds", "artifactIds", "checkIds", "approval"])
  const runtime = parseProjectRuntimeManifestV1({
    apiVersion: "devclaw.project-runtime/v1",
    plugin: { id: "business-mod-validation", version: "1.0.0" },
    mode: "host",
    stateOwner: "host",
    stages: [{ ...stage, id, title, skill }],
    actions: raw.actions,
    artifacts: raw.artifacts,
    checks: raw.checks,
    environment: raw.environment,
    capabilities: {
      execution: true,
      conditionalTransition: false,
      idempotency: false,
      reconciliation: false,
      cancellation: true
    }
  })
  assertHostRuntimeSupported(runtime)
  const { actionIds, artifactIds, checkIds, approval } = runtime.stages[0]
  return {
    stage: { actionIds, artifactIds, checkIds, approval },
    actions: runtime.actions,
    artifacts: runtime.artifacts,
    checks: runtime.checks,
    environment: runtime.environment
  }
}

/** Static, bounded manifest parsing. No author module or Python code is evaluated. */
export function parseBusinessModCatalog(value: unknown): BusinessModCatalog {
  if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) throw Error("业务 Mods 配置过大")
  const raw = businessModObject(value)
  fields(raw, ["apiVersion", "kind", "kernel", "kernelRef", "modules", "extensions"])
  if (
    raw.apiVersion !== "devclaw.business-mods/v1" ||
    raw.kind !== "catalog" ||
    !!raw.kernel === !!raw.kernelRef
  )
    throw Error("业务 Mods 来源协议无效")
  let kernel: BusinessModCatalog["kernel"]
  if (raw.kernel) {
    const data = businessModObject(raw.kernel)
    fields(data, ["id", "version", "resources", "boardConfigPath", "pluginFields", "runtime"])
    let runtime: NonNullable<BusinessModCatalog["kernel"]>["runtime"]
    if (data.runtime !== undefined) {
      const declaration = businessModObject(data.runtime)
      fields(declaration, ["adapter", "capabilities"])
      if (declaration.adapter !== "autobiz-v1" && declaration.adapter !== "host-linear-v1")
        throw Error("BUSINESS_MOD_ASSEMBLY_ADAPTER_UNSUPPORTED")
      if (declaration.adapter === "autobiz-v1" && Object.hasOwn(declaration, "capabilities"))
        throw Error("BUSINESS_MOD_KERNEL_RUNTIME_CONFLICT")
      let capabilities: ProjectRuntimeManifest["capabilities"] | undefined
      if (Object.hasOwn(declaration, "capabilities") && declaration.capabilities === undefined)
        throw Error("BUSINESS_MOD_HOST_CAPABILITIES_INVALID")
      if (declaration.capabilities !== undefined) {
        const original = businessModObject(declaration.capabilities)
        const keys = [
          "execution",
          "conditionalTransition",
          "idempotency",
          "reconciliation",
          "cancellation"
        ] as const
        fields(original, [...keys])
        if (keys.some((key) => typeof original[key] !== "boolean"))
          throw Error("BUSINESS_MOD_HOST_CAPABILITIES_INVALID")
        capabilities = Object.fromEntries(
          keys.map((key) => [key, original[key]])
        ) as ProjectRuntimeManifest["capabilities"]
      }
      runtime =
        declaration.adapter === "host-linear-v1"
          ? { adapter: "host-linear-v1", ...(capabilities ? { capabilities } : {}) }
          : { adapter: "autobiz-v1" }
    }
    if (
      runtime?.adapter === "host-linear-v1"
        ? data.boardConfigPath !== undefined
        : data.boardConfigPath === undefined
    )
      throw Error("BUSINESS_MOD_KERNEL_RUNTIME_CONFLICT")
    const pluginFields =
      data.pluginFields === undefined ? undefined : businessModObject(data.pluginFields)
    if (pluginFields)
      fields(pluginFields, [
        "hooks",
        "skills",
        "mcpServers",
        "description",
        "author",
        "license",
        "keywords",
        "useScenario",
        "userConfig"
      ])
    if (pluginFields?.userConfig !== undefined)
      parsePortableBusinessModUserConfig(pluginFields.userConfig)
    kernel = {
      ...kernelIdentity(data),
      resources: strings(data.resources, businessModPath, 4096),
      ...(data.boardConfigPath === undefined
        ? {}
        : {
            boardConfigPath: businessModPath(data.boardConfigPath)
          }),
      ...(runtime ? { runtime } : {}),
      ...(pluginFields ? { pluginFields: structuredClone(pluginFields) } : {})
    }
  }
  if (!Array.isArray(raw.modules) || raw.modules.length > 64) throw Error("业务 Mods 来源声明无效")
  const seen = new Set<string>()
  const modules = raw.modules.map((value): BusinessModDefinition => {
    const item = businessModObject(value)
    fields(item, [
      "id",
      "title",
      "node",
      "skill",
      "resources",
      "dependencies",
      "checks",
      "host",
      "insertAfter",
      "userConfig"
    ])
    const id = businessModId(item.id),
      node = businessModObject(item.node)
    if (seen.has(id.toLowerCase()) || node.id !== id || typeof node.skill !== "string")
      throw Error("业务 Mods 节点标识重复或不一致")
    seen.add(id.toLowerCase())
    businessModId(node.skill)
    const skill = businessModObject(item.skill)
    fields(skill, ["entry", "resources"])
    const dependencies = businessModObject(item.dependencies)
    fields(dependencies, ["required", "advisory"])
    const checks = businessModObject(item.checks)
    fields(checks, ["validators", "guards"])
    const validators = strings(
      checks.validators,
      (value) => {
        if (value === `business:${id}`) return String(value)
        return businessModId(value)
      },
      64
    )
    const guards = strings(checks.guards, businessModId, 64)
    if (
      JSON.stringify(node.validators ?? []) !== JSON.stringify(validators) ||
      JSON.stringify(node.guards ?? []) !== JSON.stringify(guards)
    )
      throw Error("业务 Mod 检查声明与实际节点不一致")
    if (node.validatorBindings !== undefined) {
      const bindings = businessModObject(node.validatorBindings)
      fields(bindings, [`business:${id}`])
      for (const [key, value] of Object.entries(bindings)) {
        const binding = businessModObject(value)
        fields(binding, ["path", "function"])
        if (
          !validators.includes(key) ||
          !businessModPath(binding.path).startsWith(`mods/business/${id}/`) ||
          typeof binding.function !== "string" ||
          !/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(binding.function)
        )
          throw Error("业务 Mod 检查实现必须位于自己的命名空间")
      }
    }
    const entry = businessModPath(skill.entry)
    if (
      !(kernel
        ? entry.startsWith("skills/") && entry.endsWith(`/${node.skill}/SKILL.md`)
        : entry === `skills/${node.skill}/SKILL.md`)
    )
      throw Error("业务 Mod 技能入口与节点不一致")
    return {
      id,
      title: text(item.title),
      node: structuredClone(node),
      skill: { entry, resources: strings(skill.resources, businessModPath) },
      resources: strings(item.resources, businessModPath),
      dependencies: {
        required: strings(dependencies.required, businessModId, 64),
        advisory: strings(dependencies.advisory, businessModId, 64)
      },
      checks: { validators, guards },
      ...(item.host === undefined
        ? {}
        : {
            host: hostDeclaration(item.host, id, text(item.title), entry)
          }),
      ...(item.userConfig === undefined
        ? {}
        : {
            userConfig: parsePortableBusinessModUserConfig(item.userConfig)
          }),
      ...(item.insertAfter === undefined ? {} : { insertAfter: businessModId(item.insertAfter) })
    }
  })
  if (
    raw.extensions !== undefined &&
    (!Array.isArray(raw.extensions) || raw.extensions.length > 32)
  )
    throw Error("常驻扩展列表无效")
  const extensions = (raw.extensions === undefined ? [] : (raw.extensions as unknown[])).map(
    (value): BusinessModExtensionDefinition => {
      const item = businessModObject(value)
      fields(item, [
        "id",
        "title",
        "kind",
        "entry",
        "resources",
        "dependencies",
        "usage",
        "actions",
        "configSchema",
        "userConfig",
        "contextProvider",
        "stageRecoveryAdapter",
        "skills"
      ])
      const id = businessModId(item.id),
        entry = businessModPath(item.entry)
      if (
        seen.has(id.toLowerCase()) ||
        item.kind !== "function" ||
        !entry.startsWith(`mods/business/${id}/`) ||
        !/\.[cm]?[jt]s$/.test(entry)
      )
        throw Error("常驻扩展标识或入口无效")
      seen.add(id.toLowerCase())
      const dependencies = businessModObject(item.dependencies)
      fields(dependencies, ["required", "advisory"])
      const configSchema =
        item.configSchema === undefined
          ? undefined
          : (businessModObject(item.configSchema) as ModObject)
      if (configSchema) validateToolSchema(configSchema)
      const skills =
        item.skills === undefined
          ? undefined
          : strings(
              item.skills,
              (value) => {
                const path = businessModPath(value)
                if (!path.startsWith(`mods/business/${id}/skills/`) || !path.endsWith("/SKILL.md"))
                  throw Error("常驻扩展辅助技能必须位于自己的命名空间")
                return path
              },
              16
            )
      let contextProvider: BusinessModExtensionDefinition["contextProvider"]
      if (item.contextProvider !== undefined) {
        const provider = businessModObject(item.contextProvider)
        fields(provider, ["entry", "operations", "knowledgeBinding", "required"])
        const providerEntry = businessModPath(provider.entry)
        if (
          !providerEntry.startsWith(`mods/business/${id}/`) ||
          !Array.isArray(provider.operations) ||
          !provider.operations.length ||
          provider.operations.length > 2 ||
          new Set(provider.operations).size !== provider.operations.length ||
          !provider.operations.every((op) => op === "session-context" || op === "sync-knowledge") ||
          typeof provider.required !== "boolean" ||
          (provider.knowledgeBinding !== undefined &&
            (typeof provider.knowledgeBinding !== "string" ||
              !/^[a-zA-Z][\w.-]{0,79}$/.test(provider.knowledgeBinding)))
        )
          throw Error("业务 Mod 上下文提供器声明无效")
        contextProvider = {
          entry: providerEntry,
          operations: [...provider.operations] as NonNullable<typeof contextProvider>["operations"],
          required: provider.required,
          ...(provider.knowledgeBinding === undefined
            ? {}
            : { knowledgeBinding: provider.knowledgeBinding as string })
        }
      }
      let stageRecoveryAdapter: BusinessModExtensionDefinition["stageRecoveryAdapter"]
      if (item.stageRecoveryAdapter !== undefined) {
        const recovery = businessModObject(item.stageRecoveryAdapter)
        fields(recovery, [
          "apiVersion",
          "entry",
          "runtime",
          "isolation",
          "codeSource",
          "externalEffects"
        ])
        const recoveryEntry = businessModPath(recovery.entry)
        if (
          recovery.apiVersion !== "devclaw.plugin-stage-recovery/v1" ||
          recovery.runtime !== "python" ||
          recovery.isolation !== "private-output-copy" ||
          recovery.codeSource !== "keep" ||
          recovery.externalEffects !== "network-requires-confirmation" ||
          !recoveryEntry.startsWith(`mods/business/${id}/`) ||
          !recoveryEntry.endsWith(".py")
        )
          throw Error("BUSINESS_MOD_STAGE_RECOVERY_ADAPTER_INVALID")
        stageRecoveryAdapter = {
          apiVersion: "devclaw.plugin-stage-recovery/v1",
          entry: recoveryEntry,
          runtime: "python",
          isolation: "private-output-copy",
          codeSource: "keep",
          externalEffects: "network-requires-confirmation"
        }
      }
      return {
        id,
        title: text(item.title),
        kind: "function",
        entry,
        resources: strings(item.resources, businessModPath),
        dependencies: {
          required: strings(dependencies.required, businessModId, 64),
          advisory: strings(dependencies.advisory, businessModId, 64)
        },
        ...(item.usage === undefined ? {} : { usage: parseCapabilityUsage(item.usage) }),
        ...(configSchema ? { configSchema: structuredClone(configSchema) } : {}),
        ...(contextProvider ? { contextProvider } : {}),
        ...(stageRecoveryAdapter ? { stageRecoveryAdapter } : {}),
        ...(skills?.length ? { skills } : {}),
        ...(item.userConfig === undefined
          ? {}
          : {
              userConfig: parsePortableBusinessModUserConfig(item.userConfig)
            }),
        ...(item.actions === undefined
          ? {}
          : { actions: parseClawActionExports({ actions: item.actions }) })
      }
    }
  )
  if ((!modules.length && !extensions.length) || modules.length + extensions.length > 64)
    throw Error("业务 Mods 来源需要1至64个实现或常驻扩展")
  return {
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    modules,
    ...(extensions.length ? { extensions } : {}),
    ...(kernel ? { kernel } : { kernelRef: kernelIdentity(raw.kernelRef) })
  }
}
export function businessModCatalog(snapshot: DerivationSnapshot): BusinessModCatalog {
  const file = snapshot.files.find((item) => item.path === BUSINESS_MOD_MANIFEST)
  if (!file || file.bytes.length > 256 * 1024) throw Error("来源没有业务 Mods 声明")
  return parseBusinessModCatalog(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))
  )
}
export function businessModResources(
  snapshot: DerivationSnapshot,
  paths: string[]
): DerivationFile[] {
  const files = new Map<string, DerivationFile>()
  for (const path of paths) {
    businessModPath(path)
    const found = snapshot.files.filter(
      (file) => file.path === path || file.path.startsWith(path + "/")
    )
    if (!found.length) throw Error(`业务 Mod 必需资源缺失或已排除：${path}`)
    for (const file of found) files.set(file.path, file)
  }
  return [...files.values()]
}
