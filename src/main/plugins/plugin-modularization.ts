import { createHash } from "node:crypto"
import type { BusinessModCatalog, BusinessModDefinition } from "../../shared/business-mods"
import { BUSINESS_MOD_MANIFEST } from "../../shared/business-mods"
import type {
  PluginModularizationConfirmation,
  PluginModularizationInspection
} from "../../shared/plugin-modularization"
import {
  parseProjectRuntimeManifest,
  projectRuntimeExtensionContract,
  REQUIRED_BUSINESS_CHECKS_PROTOCOL,
  type ProjectRuntimeManifest
} from "../../shared/project-runtime"
import { parseSkillFrontmatter, parseSkillNameFromFrontmatterYaml } from "../skills/frontmatter"
import { isMap, isScalar, parseDocument } from "yaml"
import { isSupportedHookEvent } from "../hooks/types"
import { types } from "node:util"
import {
  AUTHORING_BUNDLE_LIMITS,
  createAuthoringSourceBundle
} from "../mods/devtools/authoring-bundle"
import { normalizeProjectResourcePaths } from "../mods/devtools/project-resource-paths"
import { parsePluginCapabilities } from "../../shared/plugin-capabilities"
import { assembleBusinessMods } from "./business-mod-assembler"
import { redactPluginSourceCredentials } from "./plugin-source-redaction"
import {
  businessModCatalog,
  businessModPath,
  parseBusinessModCatalog
} from "./business-mod-manifest"
import {
  DERIVATION_LIMITS,
  derivationDigest,
  type DerivationFile,
  type DerivationSnapshot
} from "./derivation-source"

const runtimePath = "devclaw.project-runtime.json"
const generatedPaths = new Set([
  runtimePath,
  BUSINESS_MOD_MANIFEST,
  "devclaw.business-assembly.json",
  "devclaw.portability.json",
  "devclaw.capabilities.json"
])
const pluginFieldNames = [
  "description",
  "author",
  "license",
  "hooks",
  "skills",
  "mcpServers",
  "userConfig"
]
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes)
const json = (file: DerivationFile) => JSON.parse(decode(file.bytes)) as unknown
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("PLUGIN_MODULARIZATION_METADATA_INVALID")
  return value as Record<string, unknown>
}
type SkillAlias = NonNullable<PluginModularizationInspection["aliases"]>[number]

/** Additive text authoring only, using the existing UTF-8/file/path limits and no new reader. */
function addMigrationFiles(
  snapshot: DerivationSnapshot,
  input: PluginModularizationConfirmation["modularizationFiles"]
) {
  if (input === undefined)
    return { snapshot, additions: [] as Array<{ path: string; text: string }> }
  if (!Array.isArray(input) || types.isProxy(input) || input.length > AUTHORING_BUNDLE_LIMITS.files)
    throw Error("PLUGIN_MODULARIZATION_FILES_LIMIT")
  const additions: Array<{ path: string; text: string }> = []
  const files = [...snapshot.files]
  const prefixes = new Map<string, string>()
  for (const file of files) {
    const parts = file.path.split("/")
    for (let index = 1; index <= parts.length; index++) {
      const path = parts.slice(0, index).join("/")
      prefixes.set(path.toLowerCase(), path)
    }
  }
  let bytes = 0
  for (let index = 0; index < input.length; index++) {
    const row = Object.getOwnPropertyDescriptor(input, String(index))
    if (!row || !("value" in row)) throw Error("PLUGIN_MODULARIZATION_FILES_INVALID")
    // Native synthetic identity is validation-only; it is never added to the candidate.
    const validated = createAuthoringSourceBundle([
      { path: "plugin.json", text: '{"name":"migration-file-check","version":"1.0.0"}' },
      row.value
    ]).files.find((file) => file.path !== "plugin.json")!
    const { path, text } = validated
    businessModPath(path)
    normalizeProjectResourcePaths([path])
    if (
      !/^(?:skills|tests|knowledge|references|scripts|agents|workflows)\//.test(path) &&
      !path.startsWith("mods/business/")
    )
      throw Error("PLUGIN_MODULARIZATION_FILE_PATH_FORBIDDEN")
    if (generatedPaths.has(path) || /(?:^|\/)(?:plugin\.json|devclaw\.[\w.-]+\.json)$/i.test(path))
      throw Error("PLUGIN_MODULARIZATION_FILE_IDENTITY_FORBIDDEN")
    const parts = path.split("/")
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join("/")
      const previous = prefixes.get(prefix.toLowerCase())
      if (previous !== undefined && previous !== prefix)
        throw Error("PLUGIN_MODULARIZATION_FILE_COLLISION")
    }
    const key = path.toLowerCase()
    if (
      files.some(
        (file) =>
          file.path.toLowerCase() === key ||
          file.path.toLowerCase().startsWith(key + "/") ||
          key.startsWith(file.path.toLowerCase() + "/")
      )
    )
      throw Error("PLUGIN_MODULARIZATION_FILE_COLLISION")
    bytes += Buffer.byteLength(path) + Buffer.byteLength(text)
    if (bytes > AUTHORING_BUNDLE_LIMITS.totalBytes) throw Error("PLUGIN_MODULARIZATION_FILES_LIMIT")
    const content = Buffer.from(text)
    files.push({ path, bytes: content, mode: 0o644, digest: sha(content) })
    additions.push({ path, text })
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join("/")
      prefixes.set(prefix.toLowerCase(), prefix)
    }
  }
  const totalBytes = files.reduce((sum, file) => sum + file.bytes.length, 0)
  if (files.length > DERIVATION_LIMITS.files || totalBytes > DERIVATION_LIMITS.totalBytes)
    throw Error("PLUGIN_MODULARIZATION_FILES_LIMIT")
  return {
    additions,
    snapshot: { ...snapshot, files, totalBytes, digest: derivationDigest(files, snapshot.excluded) }
  }
}

function modularizationDiagnostic(error: unknown) {
  const messages: Record<string, string> = {
    PLUGIN_MODULARIZATION_METADATA_NEEDS_MAPPING:
      "多个插件清单或额外插件字段需要显式映射；不能只选择其中一份后丢失另一份配置。",
    PLUGIN_MODULARIZATION_CREDENTIAL_METADATA:
      "插件元数据包含凭据值，请先移除明文凭据并改为宿主用户配置绑定；不将原值交给模型。",
    PLUGIN_MODULARIZATION_CONTEXT_MAPPING_REQUIRED:
      "原流程声明了知识或上下文提供器，需要保留协议与提供器映射，不能替换为空上下文。",
    PLUGIN_MODULARIZATION_FUNCTION_MAPPING_REQUIRED:
      "原插件含原生 Function 注册，请先将每个入口、资源、公开动作及配置映射为常驻扩展。",
    PLUGIN_MODULARIZATION_SKILL_MAPPING_REQUIRED:
      "阶段 Skill 入口、名称或搜索目录不完整，请补齐真实 Skill 映射。",
    PLUGIN_MODULARIZATION_SKILL_FRONTMATTER_MAPPING_REQUIRED:
      "原 Skill 的 YAML name 无法安全地单独替换；请保留原文并显式提供可验证的别名方案。",
    PLUGIN_MODULARIZATION_SKILL_ALIAS_COLLISION:
      "将生成的阶段 Skill 别名与原文件或已有技能名冲突；请先显式处理命名，不能覆盖原文件。",
    PLUGIN_MODULARIZATION_SKILL_ALIAS_LIMIT:
      "保留原技能并复制阶段别名会超出原生源码大小或文件数限制；请先明确拆分共享资源，不能丢弃文件。",
    PLUGIN_MODULARIZATION_SKILL_ALIAS_NESTED_MAPPING_REQUIRED:
      "原技能目录含嵌套 Skill；复制别名会制造同名嵌套入口，请作者先明确共享 Skill 映射，不能重复注册或丢弃原入口。",
    PLUGIN_MODULARIZATION_SKILL_HOOK_MAPPING_REQUIRED:
      "原插件存在技能生命周期 Hook，别名会改变 skillName 或 matcher 语义。请作者先完成明确的 Hook 映射；本候选不会改写或跳过原 Hook。",
    PLUGIN_MODULARIZATION_SKILL_HOOK_DECLARATION_INVALID:
      "原 Hook 声明无法静态识别，不能证明技能改名仍保持原约束。请作者先整理为可核对声明并明确映射，不能忽略未知事件或字段。",
    PLUGIN_MODULARIZATION_CAPABILITY_MAPPING_REQUIRED:
      "原能力目录包含多流程、额外能力、依赖或强制 Hook；请保留这些入口和约束后显式迁移。",
    PLUGIN_MODULARIZATION_RESOURCE_LOSS:
      "候选未包含全部原资源；请补齐知识、脚本、Hooks 与相对引用闭包。",
    PLUGIN_MODULARIZATION_RUNTIME_CHANGED:
      "候选改变了原阶段、产物、检查、环境声明或人工审批；必须先保持原契约完整。",
    BUSINESS_MOD_HOST_DECLARATION_CONFLICT:
      "多个阶段引用相同标识但定义不同的检查、产物、动作或环境；必须显式解决冲突，不能择一覆盖。",
    BUSINESS_MOD_HOST_REQUIRED_ARTIFACT_UNCHECKED:
      "阶段必需产物缺少对应原生检查，请补全真实检查，不能将必需产物改为可选。",
    BUSINESS_MOD_HOST_STAGE_CHECK_REQUIRED:
      "阶段没有原生检查，不能把无验收依据的步骤标记为迁移成功。",
    PROJECT_RUNTIME_MANIFEST_INVALID:
      "原项目契约无效或共享声明的同一标识具有不同定义；请核对阶段、动作、产物和检查，不得择一覆盖。"
  }
  const raw = error instanceof Error ? error.message : ""
  const code =
    /^[A-Z][A-Z0-9_]{0,127}$/.test(raw) && Object.hasOwn(messages, raw)
      ? raw
      : "PLUGIN_MODULARIZATION_CONTRACT_MAPPING_REQUIRED"
  return {
    code,
    message:
      messages[code] ??
      "原契约不能自动无损投影。请补全可编辑迁移计划，保留 Function、知识上下文、Hooks、配置与全部产物校验；继续使用原生解析器及组装器审查。"
  }
}

/** Change one real YAML scalar; all surrounding metadata, comments and body bytes remain exact. */
function aliasSkill(bytes: Buffer, name: string): Buffer {
  const original = decode(bytes)
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/.exec(original)
  if (!frontmatter || !parseSkillNameFromFrontmatterYaml(original))
    throw Error("PLUGIN_MODULARIZATION_SKILL_FRONTMATTER_MAPPING_REQUIRED")
  const document = parseDocument(frontmatter[1])
  if (document.errors.length || !isMap(document.contents))
    throw Error("PLUGIN_MODULARIZATION_SKILL_FRONTMATTER_MAPPING_REQUIRED")
  const names = document.contents.items.filter(
    (item) =>
      isScalar(item.key) &&
      typeof item.key.value === "string" &&
      item.key.value.toLowerCase() === "name"
  )
  if (
    names.length !== 1 ||
    !isScalar(names[0].value) ||
    !names[0].value.range ||
    typeof names[0].value.value !== "string"
  )
    throw Error("PLUGIN_MODULARIZATION_SKILL_FRONTMATTER_MAPPING_REQUIRED")
  const [start, end] = names[0].value.range
  if (/[\r\n]/.test(frontmatter[1].slice(start, end)))
    throw Error("PLUGIN_MODULARIZATION_SKILL_FRONTMATTER_MAPPING_REQUIRED")
  const offset = frontmatter[0].indexOf("\n") + 1
  const result =
    original.slice(0, offset + start) + JSON.stringify(name) + original.slice(offset + end)
  if (parseSkillNameFromFrontmatterYaml(result) !== name)
    throw Error("PLUGIN_MODULARIZATION_SKILL_FRONTMATTER_MAPPING_REQUIRED")
  const before = parseSkillFrontmatter(original)
  const after = parseSkillFrontmatter(result)
  const nameKey = names[0].key
  if (
    !isScalar(nameKey) ||
    typeof nameKey.value !== "string" ||
    before.body !== after.body ||
    !same({ ...before.frontmatter, [nameKey.value]: name }, after.frontmatter)
  )
    throw Error("PLUGIN_MODULARIZATION_SKILL_FRONTMATTER_MAPPING_REQUIRED")
  return Buffer.from(result)
}

function assertAliasHooks(snapshot: DerivationSnapshot) {
  const invalid = () => {
    throw Error("PLUGIN_MODULARIZATION_SKILL_HOOK_DECLARATION_INVALID")
  }
  const lifecycle = (event: unknown) => {
    if (!isSupportedHookEvent(event)) invalid()
    if (event === "PreSkillUse" || event === "PostSkillUse")
      throw Error("PLUGIN_MODULARIZATION_SKILL_HOOK_MAPPING_REQUIRED")
  }
  const fields = new Set([
    "id",
    "type",
    "command",
    "prompt",
    "url",
    "enabled",
    "timeout",
    "timeoutMs",
    "shell",
    "matcher",
    "async",
    "if",
    "once",
    "persistAfterInterrupt",
    "statusMessage",
    "forcedOutcome",
    "forcedReason",
    "onBlock",
    "model",
    "modelId",
    "fallback",
    "headers",
    "allowedEnvVars",
    "injectUserContext",
    "createdAt",
    "updatedAt",
    "description"
  ])
  const handler = (value: unknown, flat = false) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid()
    const row = value as Record<string, unknown>
    if (Object.keys(row).some((key) => !fields.has(key) && !(flat && key === "event"))) invalid()
    const type = row.type ?? (typeof row.prompt === "string" ? "prompt" : "command")
    if (
      type === "command"
        ? typeof row.command !== "string"
        : type === "prompt"
          ? typeof row.prompt !== "string"
          : type === "http"
            ? typeof row.url !== "string"
            : true
    )
      invalid()
    if (flat) lifecycle(row.event)
  }
  const declaration = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const row of value) handler(row, true)
      return
    }
    if (!value || typeof value !== "object") return invalid()
    let map = value as Record<string, unknown>
    if (Object.hasOwn(map, "hooks")) {
      if (
        Object.keys(map).some((key) => !["description", "hooks"].includes(key)) ||
        !map.hooks ||
        typeof map.hooks !== "object" ||
        Array.isArray(map.hooks)
      )
        return invalid()
      map = map.hooks as Record<string, unknown>
    }
    for (const [event, groups] of Object.entries(map)) {
      lifecycle(event)
      if (!Array.isArray(groups)) return invalid()
      for (const group of groups) {
        if (!group || typeof group !== "object" || Array.isArray(group)) return invalid()
        const row = group as Record<string, unknown>
        if (
          Object.keys(row).some((key) => !["matcher", "hooks"].includes(key)) ||
          (row.matcher !== undefined && typeof row.matcher !== "string") ||
          !Array.isArray(row.hooks)
        )
          return invalid()
        for (const value of row.hooks) handler(value)
      }
    }
  }
  const read = (path: string, required = false) => {
    const file = snapshot.files.find((file) => file.path === path)
    if (!file) {
      if (required) invalid()
      return
    }
    let value: unknown
    try {
      value = json(file)
    } catch {
      return invalid()
    }
    declaration(value)
  }
  const metadata = object(json(snapshot.files.find((file) => file.path === snapshot.manifests[0])!))
  if (metadata.hooks !== undefined && typeof metadata.hooks !== "string") invalid()
  read(
    typeof metadata.hooks === "string" ? metadata.hooks.replace(/^\.\//, "") : "hooks/hooks.json",
    typeof metadata.hooks === "string"
  )
  for (const skill of snapshot.files.filter((file) => file.path.endsWith("/SKILL.md"))) {
    const frontmatter = parseSkillFrontmatter(decode(skill.bytes)).frontmatter
    if (Object.hasOwn(frontmatter, "hooks")) declaration(frontmatter.hooks)
    const root = skill.path.slice(0, -"/SKILL.md".length)
    read(root + "/hooks.json")
    read(root + "/hooks/hooks.json")
  }
}

/** Stage-local aliases retain the old Skill for Hooks and copy its relative resource closure. */
function prepareHostAliases(snapshot: DerivationSnapshot, runtime: ProjectRuntimeManifest) {
  const aliases: SkillAlias[] = []
  const files = [...snapshot.files]
  let totalBytes = snapshot.files.reduce((total, file) => total + file.bytes.length, 0)
  const mapped = structuredClone(runtime)
  let hookContractChecked = false
  const stageNames = runtime.stages.map((stage) => {
    const skill = snapshot.files.find((file) => file.path === stage.skill)
    return skill ? parseSkillNameFromFrontmatterYaml(decode(skill.bytes)) : null
  })
  for (const [index, stage] of runtime.stages.entries()) {
    const originalSkill = snapshot.files.find((file) => file.path === stage.skill)
    const originalName = stageNames[index]
    if (!originalSkill || !originalName || !originalSkill.path.endsWith("/SKILL.md"))
      throw Error("PLUGIN_MODULARIZATION_SKILL_MAPPING_REQUIRED")
    if (
      runtime.stages.filter((item) => item.skill === stage.skill).length === 1 &&
      stageNames.filter((name) => name?.toLowerCase() === originalName.toLowerCase()).length ===
        1 &&
      originalSkill.path.endsWith(`/${originalName}/SKILL.md`)
    )
      continue
    const name = "stage-" + sha(stage.id).slice(0, 16)
    if (!hookContractChecked) {
      assertAliasHooks(snapshot)
      hookContractChecked = true
    }
    const originalRoot = originalSkill.path.slice(0, -"/SKILL.md".length)
    const parent = originalRoot.slice(0, originalRoot.lastIndexOf("/"))
    const root = `${parent}/${name}`
    if (
      files.some(
        (file) =>
          file.path.toLowerCase() === root.toLowerCase() ||
          file.path.toLowerCase().startsWith(root.toLowerCase() + "/")
      ) ||
      snapshot.files.some(
        (file) =>
          file.path.endsWith("/SKILL.md") &&
          parseSkillNameFromFrontmatterYaml(decode(file.bytes))?.toLowerCase() ===
            name.toLowerCase()
      )
    )
      throw Error("PLUGIN_MODULARIZATION_SKILL_ALIAS_COLLISION")
    const closure = snapshot.files.filter((file) => file.path.startsWith(originalRoot + "/"))
    if (closure.some((file) => file.path !== originalSkill.path && file.path.endsWith("/SKILL.md")))
      throw Error("PLUGIN_MODULARIZATION_SKILL_ALIAS_NESTED_MAPPING_REQUIRED")
    for (const file of closure) {
      const bytes =
        file.path === originalSkill.path ? aliasSkill(file.bytes, name) : Buffer.from(file.bytes)
      totalBytes += bytes.length
      if (
        files.length >= DERIVATION_LIMITS.files ||
        totalBytes > DERIVATION_LIMITS.totalBytes ||
        bytes.length > DERIVATION_LIMITS.fileBytes
      )
        throw Error("PLUGIN_MODULARIZATION_SKILL_ALIAS_LIMIT")
      files.push({
        ...file,
        path: root + file.path.slice(originalRoot.length),
        bytes,
        digest: sha(bytes)
      })
    }
    mapped.stages[index].skill = root + "/SKILL.md"
    aliases.push({
      stageId: stage.id,
      originalSkill: originalSkill.path,
      skill: mapped.stages[index].skill!,
      name
    })
  }
  return {
    runtime: mapped,
    aliases,
    snapshot: { ...snapshot, files, totalBytes, digest: derivationDigest(files, snapshot.excluded) }
  }
}

/** Do not expose literal credential-like metadata in a model-readable migration proposal. */
function credentialMetadata(value: unknown): boolean {
  return redactPluginSourceCredentials(value).redacted
}

function pluginFields(snapshot: DerivationSnapshot): Record<string, unknown> {
  const manifest = object(json(snapshot.files.find((file) => file.path === snapshot.manifests[0])!))
  if (
    snapshot.manifests.some(
      (path) => !same(manifest, json(snapshot.files.find((file) => file.path === path)!))
    )
  )
    throw Error("PLUGIN_MODULARIZATION_METADATA_NEEDS_MAPPING")
  if (Object.keys(manifest).some((key) => !["name", "version", ...pluginFieldNames].includes(key)))
    throw Error("PLUGIN_MODULARIZATION_METADATA_NEEDS_MAPPING")
  if (credentialMetadata(manifest)) throw Error("PLUGIN_MODULARIZATION_CREDENTIAL_METADATA")
  return Object.fromEntries(
    pluginFieldNames
      .filter((key) => manifest[key] !== undefined)
      .map((key) => [key, structuredClone(manifest[key])])
  )
}

function readRuntime(snapshot: DerivationSnapshot): ProjectRuntimeManifest | undefined {
  const file = snapshot.files.find((entry) => entry.path === runtimePath)
  return file ? parseProjectRuntimeManifest(json(file)) : undefined
}

function hostCatalog(
  snapshot: DerivationSnapshot,
  runtime: ProjectRuntimeManifest
): BusinessModCatalog {
  const raw = json(snapshot.files.find((file) => file.path === runtimePath)!)
  const contract = projectRuntimeExtensionContract(raw)
  if (
    contract &&
    (contract.context ||
      contract.verifiedArtifacts ||
      contract.requires.some((id) => id !== REQUIRED_BUSINESS_CHECKS_PROTOCOL))
  )
    throw Error("PLUGIN_MODULARIZATION_CONTEXT_MAPPING_REQUIRED")
  const fields = pluginFields(snapshot)
  if (snapshot.files.some((file) => file.path === "mods/manifest.json"))
    throw Error("PLUGIN_MODULARIZATION_FUNCTION_MAPPING_REQUIRED")
  const modules: BusinessModDefinition[] = runtime.stages.map((stage, index) => {
    const skill = snapshot.files.find((file) => file.path === stage.skill)
    const name = skill && parseSkillNameFromFrontmatterYaml(decode(skill.bytes))
    if (!skill || !name) throw Error("PLUGIN_MODULARIZATION_SKILL_MAPPING_REQUIRED")
    const root = skill.path.slice(0, -"/SKILL.md".length)
    const actions = runtime.actions.filter(
      (action) =>
        stage.actionIds.includes(action.id) ||
        runtime.checks.some(
          (check) => stage.checkIds.includes(check.id) && check.actionId === action.id
        )
    )
    return {
      id: stage.id,
      title: stage.title,
      node: { id: stage.id, skill: name, order: (index + 1) * 10 },
      skill: { entry: skill.path, resources: [root] },
      resources: [],
      // This is the original linear route constraint, not an inferred business data dependency.
      dependencies: { required: index ? [runtime.stages[index - 1].id] : [], advisory: [] },
      checks: { validators: [], guards: [] },
      host: {
        stage: {
          actionIds: stage.actionIds,
          artifactIds: stage.artifactIds,
          checkIds: stage.checkIds,
          approval: stage.approval
        },
        actions,
        artifacts: runtime.artifacts.filter((artifact) => stage.artifactIds.includes(artifact.id)),
        checks: runtime.checks.filter((check) => stage.checkIds.includes(check.id)),
        environment: index ? [] : runtime.environment
      }
    }
  })
  const skillRoots = modules.map((mod) => mod.skill.entry.slice(0, -"/SKILL.md".length) + "/")
  return parseBusinessModCatalog({
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    kernel: {
      id: `migrated.${sha(snapshot.name).slice(0, 16)}`,
      version: "1.0.0",
      runtime: { adapter: "host-linear-v1", capabilities: structuredClone(runtime.capabilities) },
      pluginFields: fields,
      resources: snapshot.files
        .filter(
          (file) =>
            !generatedPaths.has(file.path) &&
            !snapshot.manifests.includes(file.path) &&
            !skillRoots.some((root) => file.path.startsWith(root))
        )
        .map((file) => file.path)
    },
    modules
  })
}

function checkProjection(
  snapshot: DerivationSnapshot,
  catalog: BusinessModCatalog,
  prepared = readRuntime(snapshot)?.mode === "host"
    ? prepareHostAliases(snapshot, readRuntime(snapshot)!)
    : undefined,
  authored = snapshot
) {
  if (!catalog.kernel) throw Error("PLUGIN_MODULARIZATION_KERNEL_REQUIRED")
  if (
    !readRuntime(snapshot) &&
    snapshot.files.some((file) => file.path.toLowerCase() === "board_core/board_config.json") &&
    catalog.kernel.runtime?.adapter === "host-linear-v1"
  )
    throw Error("PLUGIN_MODULARIZATION_ADAPTER_MAPPING_REQUIRED")
  const fields = pluginFields(snapshot)
  for (const key of ["hooks", "mcpServers", "userConfig"])
    if (!same(fields[key], catalog.kernel.pluginFields?.[key]))
      throw Error("PLUGIN_MODULARIZATION_METADATA_CHANGED")
  if (fields.skills !== undefined && fields.skills !== "skills" && !same(fields.skills, ["skills"]))
    throw Error("PLUGIN_MODULARIZATION_SKILL_MAPPING_REQUIRED")
  const capabilityFile = snapshot.files.find((file) => file.path === "devclaw.capabilities.json")
  if (capabilityFile) {
    const capabilities = parsePluginCapabilities(json(capabilityFile))?.capabilities
    if (
      !capabilities ||
      capabilities.length !== 1 ||
      capabilities.some(
        (capability) =>
          capability.kind !== "flow" ||
          capability.entry !== runtimePath ||
          capability.usage !== "project" ||
          capability.dependsOn.length ||
          (capability.requiredHooks?.length ?? 0) ||
          (capability.requiredMcpServers?.length ?? 0) ||
          (capability.inputs?.length ?? 0)
      )
    )
      throw Error("PLUGIN_MODULARIZATION_CAPABILITY_MAPPING_REQUIRED")
  }
  const projection = assembleBusinessMods(
    [
      {
        snapshot: prepared?.snapshot ?? authored,
        catalog,
        modIds: [
          ...catalog.modules.map((mod) => mod.id),
          ...(catalog.extensions ?? []).map((mod) => mod.id)
        ]
      }
    ],
    {
      sources: [],
      name: "migration-review-" + snapshot.digest.slice(0, 16),
      version: "1.0.0",
      order: catalog.modules.map((mod) => mod.id)
    }
  )
  if (projection.missingProviders.length) throw Error("PLUGIN_MODULARIZATION_PROVIDER_MISSING")
  for (const file of authored.files) {
    if (generatedPaths.has(file.path) || snapshot.manifests.includes(file.path)) continue
    if (!projection.files.some((entry) => entry.path === file.path && entry.digest === file.digest))
      throw Error("PLUGIN_MODULARIZATION_RESOURCE_LOSS")
  }
  const original = readRuntime(snapshot)
  if (original) {
    const projected = parseProjectRuntimeManifest(
      json(projection.files.find((file) => file.path === runtimePath)!)
    )
    // An authored plan may add mapping metadata, but cannot silently drop original enforcement.
    for (const key of [
      "mode",
      "stateOwner",
      "actions",
      "artifacts",
      "checks",
      "environment",
      "capabilities"
    ] as const)
      if (!same(original[key], projected[key])) throw Error("PLUGIN_MODULARIZATION_RUNTIME_CHANGED")
    if (!same(prepared?.runtime.stages ?? original.stages, projected.stages))
      throw Error("PLUGIN_MODULARIZATION_RUNTIME_CHANGED")
    const originalContract = projectRuntimeExtensionContract(
      json(snapshot.files.find((file) => file.path === runtimePath)!)
    )
    const projectedContract = projectRuntimeExtensionContract(
      json(projection.files.find((file) => file.path === runtimePath)!)
    )
    if (originalContract && !same(originalContract, projectedContract))
      throw Error("PLUGIN_MODULARIZATION_CONTEXT_CHANGED")
  }
  return projection
}

/** Only inspect an already native-owned, bounded, credential-filtered source snapshot. */
export function inspectPluginModularization(
  snapshot: DerivationSnapshot
): PluginModularizationInspection {
  const view: PluginModularizationInspection = {
    sourceName: snapshot.name,
    sourceDigest: snapshot.digest,
    status: "needs-authoring",
    runtime: "unknown",
    files: snapshot.files.map(({ path, digest, bytes }) => ({ path, digest, bytes: bytes.length })),
    excluded: [...snapshot.excluded],
    stages: [],
    warnings: [
      "模块化候选保留原文件；排除的凭据、缓存和运行数据不复制。源代码中自行硬编码的凭据须先清理。",
      "静态检查通过仅表示候选可继续原生试用与审批，不代表业务验证成功或已安装。"
    ],
    blockers: [],
    nextAction: "author-migration-plan"
  }
  try {
    if (snapshot.files.some((file) => file.path === BUSINESS_MOD_MANIFEST)) {
      const catalog = businessModCatalog(snapshot)
      view.status = "already-modular"
      view.nextAction = "inspect-existing-mods"
      view.runtime =
        catalog.kernel?.runtime?.adapter === "host-linear-v1"
          ? "host"
          : catalog.kernel?.runtime?.adapter === "autobiz-v1"
            ? "legacy"
            : "unknown"
      return view
    }
    const runtime = readRuntime(snapshot)
    if (runtime) {
      view.runtime = runtime.mode
      view.stages = runtime.stages.map(({ id, title, skill, checkIds }) => ({
        id,
        title,
        ...(skill ? { skill } : {}),
        checks: checkIds.length
      }))
    }
    if (!runtime || runtime.mode !== "host") {
      view.blockers.push({
        code: "PLUGIN_MODULARIZATION_ADAPTER_MAPPING_REQUIRED",
        message:
          "未识别可直接拆分的原生 Host 阶段。需提供可编辑 catalog，明确阶段、共享资源、Hooks、配置、上下文及产物衔接；旧流程只能由受审适配器解释，不能猜测依赖。",
        paths: snapshot.files
          .filter((file) =>
            /(?:board_config|hooks|plugin|runtime|SKILL)\.(?:json|md)$/.test(file.path)
          )
          .map((file) => file.path)
      })
      return view
    }
    const prepared = prepareHostAliases(snapshot, runtime)
    const catalog = hostCatalog(prepared.snapshot, prepared.runtime)
    checkProjection(snapshot, catalog, prepared)
    view.status = "candidate"
    view.catalog = catalog
    if (prepared.aliases.length) view.aliases = prepared.aliases
    view.nextAction = "confirm-candidate"
    view.warnings.push(
      "保守保留原线性阶段顺序、检查与审批；不推断可删除的前置步骤。共享辅助资源完整保留，进一步拆分需显式编写依赖。"
    )
    if (prepared.aliases.length)
      view.warnings.push(
        "复用的 Skill 保留原文件与原名称；每阶段别名与原目录互为同父目录的兄弟目录，保持 ../ 和 ../../ 的相对基准，仅修改 frontmatter name 并完整复制原目录资源。技能生命周期或未知 Hook 须由作者先明确映射，本次不会改写原 Hook。"
      )
    view.warnings.push(
      "原 capabilities 五项声明按原值保留；声明本身不授予权限或证明实现了条件跳转、DAG、幂等或恢复能力，执行仍遵循原 Host。"
    )
  } catch (error) {
    // Do not relay parser exceptions: malformed JSON can include credential fragments.
    const diagnostic = modularizationDiagnostic(error)
    view.blockers.push({
      ...diagnostic,
      paths: [runtimePath, ...snapshot.manifests]
    })
  }
  return view
}

/** Produces additive source only. Caller owns freshness, isolated writing and native review. */
export function createPluginModularizationCandidate(
  snapshot: DerivationSnapshot,
  input: PluginModularizationConfirmation
) {
  if (input.confirmed !== true) throw Error("PLUGIN_MODULARIZATION_CONFIRMATION_REQUIRED")
  if (input.sourceDigest !== snapshot.digest) throw Error("PLUGIN_MODULARIZATION_SOURCE_CHANGED")
  const inspection = inspectPluginModularization(snapshot)
  if (inspection.status === "already-modular") throw Error("PLUGIN_MODULARIZATION_ALREADY_MODULAR")
  if (input.catalog === undefined && !inspection.catalog)
    throw Error("PLUGIN_MODULARIZATION_PLAN_REQUIRED")
  const catalog = parseBusinessModCatalog(input.catalog ?? inspection.catalog)
  const authored = addMigrationFiles(snapshot, input.modularizationFiles)
  const runtime = readRuntime(snapshot)
  const prepared =
    runtime?.mode === "host" ? prepareHostAliases(authored.snapshot, runtime) : undefined
  checkProjection(snapshot, catalog, prepared, authored.snapshot)
  const bytes = Buffer.from(JSON.stringify(catalog, null, 2) + "\n")
  const files = [
    ...(prepared?.snapshot.files ?? authored.snapshot.files).map((file) => ({
      ...file,
      bytes: Buffer.from(file.bytes)
    })),
    {
      path: BUSINESS_MOD_MANIFEST,
      bytes,
      mode: 0o644,
      digest: sha(bytes)
    }
  ].sort((left, right) => left.path.localeCompare(right.path, "en"))
  return {
    inspection,
    catalog,
    files,
    digest: derivationDigest(files, snapshot.excluded),
    status: "needs-native-validation" as const,
    modularizationFiles: authored.additions,
    addedFiles: authored.additions.map(({ path, text }) => ({
      path,
      bytes: Buffer.byteLength(text),
      digest: sha(Buffer.from(text))
    }))
  }
}
