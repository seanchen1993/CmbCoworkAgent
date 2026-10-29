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
import { inspectPluginStateControl } from "./plugin-state-control-audit"
import {
  AUTHORING_BUNDLE_LIMITS,
  createAuthoringSourceBundle
} from "../mods/devtools/authoring-bundle"
import { normalizeProjectResourcePaths } from "../mods/devtools/project-resource-paths"
import { parsePluginCapabilities } from "../../shared/plugin-capabilities"
import { assembleBusinessMods } from "./business-mod-assembler"
import { resolveBusinessModAssemblyAdapter } from "./business-mod-assembly-adapter"
import { redactPluginSourceCredentials } from "./plugin-source-redaction"
import {
  assertBusinessModCatalogShape,
  BusinessModCatalogValidationError
} from "./business-mod-catalog-schema"
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
  "keywords",
  "useScenario",
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
const modularizationFileLimit = 32

function migrationFileFailure(path: string, code: string, message: string): never {
  throw new BusinessModCatalogValidationError([{ path, code, message }], code)
}

/** Additive text authoring only, using the existing UTF-8/file/path limits and no new reader. */
function addMigrationFiles(
  snapshot: DerivationSnapshot,
  input: PluginModularizationConfirmation["modularizationFiles"]
) {
  if (input === undefined)
    return { snapshot, additions: [] as Array<{ path: string; text: string }> }
  if (!Array.isArray(input) || types.isProxy(input))
    migrationFileFailure(
      "modularizationFiles",
      "PLUGIN_MODULARIZATION_FILES_INVALID",
      "modularizationFiles 必须是文本文件数组，每项只包含 path 和 text。"
    )
  if (input.length > modularizationFileLimit)
    migrationFileFailure(
      "modularizationFiles",
      "PLUGIN_MODULARIZATION_FILES_LIMIT",
      "本次最多新增 32 个文件；保留原资源，将新增实现整理到此上限后重新请求。"
    )
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
    const field = `modularizationFiles.${index}`
    const row = Object.getOwnPropertyDescriptor(input, String(index))
    if (!row || !("value" in row))
      migrationFileFailure(
        field,
        "PLUGIN_MODULARIZATION_FILES_INVALID",
        "该项必须是只包含 path 和 text 的普通数据对象；不接受访问器或缺失项。"
      )
    // Native synthetic identity is validation-only; it is never added to the candidate.
    let validated: { path: string; text: string }
    try {
      validated = createAuthoringSourceBundle([
        { path: "plugin.json", text: '{"name":"migration-file-check","version":"1.0.0"}' },
        row.value
      ]).files.find((file) => file.path !== "plugin.json")!
    } catch (error) {
      const code = error instanceof Error ? error.message : ""
      if (code === "AUTHORING_SOURCE_PATH")
        migrationFileFailure(
          `${field}.path`,
          "PLUGIN_MODULARIZATION_FILE_PATH_INVALID",
          "使用不超过 160 字符的包内相对文本路径；移除绝对路径、上级跳转、凭据路径或不支持的扩展名。"
        )
      if (code === "AUTHORING_SOURCE_COLLISION")
        migrationFileFailure(
          `${field}.path`,
          "PLUGIN_MODULARIZATION_FILE_IDENTITY_FORBIDDEN",
          "不能新增或覆盖插件身份清单；仅新增独立实现资源并在 catalog 中声明。"
        )
      if (code === "AUTHORING_SOURCE_TEXT")
        migrationFileFailure(
          `${field}.text`,
          "PLUGIN_MODULARIZATION_FILE_TEXT_INVALID",
          "text 必须是无空字符的有效 UTF-8 字符串，单文件最多 64 KiB；缩减或拆分后重新请求。"
        )
      migrationFileFailure(
        field,
        "PLUGIN_MODULARIZATION_FILES_INVALID",
        "该项必须是只包含 path 和 text 的普通数据对象；不接受访问器或额外字段。"
      )
    }
    const { path, text } = validated
    try {
      businessModPath(path)
      normalizeProjectResourcePaths([path])
    } catch {
      migrationFileFailure(
        `${field}.path`,
        "PLUGIN_MODULARIZATION_FILE_PATH_INVALID",
        "该路径包含禁止发布的资源；改用独立包内文本路径，不复制凭据、缓存或本地运行配置。"
      )
    }
    if (generatedPaths.has(path) || /(?:^|\/)(?:plugin\.json|devclaw\.[\w.-]+\.json)$/i.test(path))
      migrationFileFailure(
        `${field}.path`,
        "PLUGIN_MODULARIZATION_FILE_IDENTITY_FORBIDDEN",
        "不能新增或覆盖插件身份、运行契约或平台清单；仅新增独立实现资源并在 catalog 中声明。"
      )
    if (
      !/^(?:skills|tests|knowledge|references|scripts|agents|workflows)\//.test(path) &&
      !path.startsWith("mods/business/")
    )
      migrationFileFailure(
        `${field}.path`,
        "PLUGIN_MODULARIZATION_FILE_PATH_FORBIDDEN",
        "新增资源须位于 skills/、mods/business/、tests/、knowledge/、references/、scripts/、agents/ 或 workflows/。"
      )
    const parts = path.split("/")
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join("/")
      const previous = prefixes.get(prefix.toLowerCase())
      if (previous !== undefined && previous !== prefix)
        migrationFileFailure(
          `${field}.path`,
          "PLUGIN_MODULARIZATION_FILE_COLLISION",
          "该路径与原资源或此前新增项的目录大小写冲突；使用拼写一致且不覆盖原资源的新路径。"
        )
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
      migrationFileFailure(
        `${field}.path`,
        "PLUGIN_MODULARIZATION_FILE_COLLISION",
        "该路径重复、覆盖原文件或与文件父子路径冲突；改用独立新路径，并同步 catalog 资源引用。"
      )
    bytes += Buffer.byteLength(path) + Buffer.byteLength(text)
    if (bytes > AUTHORING_BUNDLE_LIMITS.totalBytes)
      migrationFileFailure(
        `${field}.text`,
        "PLUGIN_MODULARIZATION_FILES_LIMIT",
        "新增文件的路径与 UTF-8 文本总量超过 256 KiB；缩减新增实现，保留原资源后重新请求。"
      )
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
    migrationFileFailure(
      "modularizationFiles",
      "PLUGIN_MODULARIZATION_FILES_LIMIT",
      "原源码加新增资源超出整包文件数或字节上限；保留原插件，缩减新增实现后重新请求。"
    )
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
    PLUGIN_MODULARIZATION_KERNEL_REQUIRED:
      "原始插件首次模块化须声明完整 kernel（id、version、resources 与受审 runtime）；kernelRef 仅用于已有内核的扩展草稿。",
    BUSINESS_MOD_KERNEL_RUNTIME_CONFLICT:
      "kernel.runtime 与配置路径冲突：host-linear-v1 不接受 boardConfigPath；受审旧流程适配器需要原配置路径，且不能包含 Host 阶段声明。",
    BUSINESS_MOD_ASSEMBLY_ADAPTER_UNSUPPORTED:
      "仅可使用原生 modularization_schema 列出的受审静态适配器，不能注册或猜测作者脚本适配器。",
    PLUGIN_MODULARIZATION_METADATA_CHANGED:
      "kernel.pluginFields 必须保留原 hooks、mcpServers、userConfig、keywords 与 useScenario；请按脱敏原清单核对声明。",
    PLUGIN_MODULARIZATION_ADAPTER_MAPPING_REQUIRED:
      "原流程需由对应受审静态适配器解释；不能将旧流程改标为 Host，或猜测新的执行语义。",
    PLUGIN_MODULARIZATION_WORKFLOW_MAPPING_REQUIRED:
      "原流程的主干、动态阶段、路由或状态规则无法无损映射；请保留全部节点与约束，不能压平流程或丢弃分支来通过首次模块化。",
    PLUGIN_MODULARIZATION_PROVIDER_MISSING:
      "原知识或上下文入口缺少对应提供器；需保留原协议和真实资源，不能改为空上下文。",
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
  for (const key of ["hooks", "mcpServers", "userConfig", "keywords", "useScenario"])
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
  // Validate the assembler's real topological order, including dependency/insertAfter effects.
  // Inspecting only catalog.modules order would let those constraints reverse the original route.
  const projectedSourcePaths = new Set(
    resolveBusinessModAssemblyAdapter(catalog.kernel).assertModularizationSource?.({
      kernel: catalog.kernel,
      snapshot,
      modules: projection.steps.map((step) => catalog.modules.find((mod) => mod.id === step.id)!)
    }) ?? []
  )
  if (projection.missingProviders.length) throw Error("PLUGIN_MODULARIZATION_PROVIDER_MISSING")
  for (const file of authored.files) {
    if (
      generatedPaths.has(file.path) ||
      snapshot.manifests.includes(file.path) ||
      projectedSourcePaths.has(file.path)
    )
      continue
    if (!projection.files.some((entry) => entry.path === file.path && entry.digest === file.digest))
      throw Error("PLUGIN_MODULARIZATION_RESOURCE_LOSS")
  }
  const original = readRuntime(snapshot)
  if (original) {
    const projected = parseProjectRuntimeManifest(
      json(projection.files.find((file) => file.path === runtimePath)!)
    )
    // An authored plan may add mapping metadata, but cannot silently drop original enforcement.
    for (const key of ["mode", "stateOwner", "capabilities"] as const)
      if (!same(original[key], projected[key])) throw Error("PLUGIN_MODULARIZATION_RUNTIME_CHANGED")
    // Grouping declarations by stage may change table order. Check actions additionally use
    // their global checks-table order at runtime, so preserve that per-stage sequence below.
    const byId = (left: { id: string }, right: { id: string }) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    for (const key of ["actions", "artifacts", "checks", "environment"] as const)
      if (!same([...original[key]].sort(byId), [...projected[key]].sort(byId)))
        throw Error("PLUGIN_MODULARIZATION_RUNTIME_CHANGED")
    if (!same(prepared?.runtime.stages ?? original.stages, projected.stages))
      throw Error("PLUGIN_MODULARIZATION_RUNTIME_CHANGED")
    const actionCheckOrder = (runtime: ProjectRuntimeManifest) =>
      runtime.stages.map((stage) =>
        runtime.checks
          .filter((check) => stage.checkIds.includes(check.id) && check.kind === "action")
          .map((check) => check.id)
      )
    if (!same(actionCheckOrder(original), actionCheckOrder(projected)))
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
    stateControl: inspectPluginStateControl(snapshot, "unknown"),
    files: snapshot.files.map(({ path, digest, bytes }) => ({ path, digest, bytes: bytes.length })),
    excluded: [...snapshot.excluded],
    stages: [],
    warnings: [
      "模块化候选保留原文件；排除的凭据、缓存和运行数据不复制。源代码中自行硬编码的凭据须先清理。",
      "静态检查通过仅表示候选可继续原生试用与审批，不代表业务验证成功或已安装。",
      "业务组装声明不等于状态控制已迁移；原 Hooks、知识、配置与状态写入器继续保留。可用 state-extension 模板生成可执行决策骨架，未知图须作者确认，绑定原写入器并真实验证后才能称状态迁移。"
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
      view.stateControl = inspectPluginStateControl(snapshot, view.runtime)
      return view
    }
    const runtime = readRuntime(snapshot)
    if (runtime) {
      view.runtime = runtime.mode
      view.stateControl = inspectPluginStateControl(snapshot, view.runtime)
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
function modularizationCandidate(
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

/** Surface trusted, bounded repair diagnostics without exposing parser input or credential values. */
export function createPluginModularizationCandidate(
  snapshot: DerivationSnapshot,
  input: PluginModularizationConfirmation
) {
  if (input.confirmed !== true) throw Error("PLUGIN_MODULARIZATION_CONFIRMATION_REQUIRED")
  if (input.sourceDigest !== snapshot.digest) throw Error("PLUGIN_MODULARIZATION_SOURCE_CHANGED")
  try {
    if (input.catalog !== undefined) assertBusinessModCatalogShape(input.catalog)
    return modularizationCandidate(snapshot, input)
  } catch (error) {
    if (error instanceof BusinessModCatalogValidationError) throw error
    const diagnostic = modularizationDiagnostic(error)
    const parserHints: Record<string, { path: string; message: string }> = {
      "业务 Mods 来源协议无效": {
        path: "catalog",
        message:
          "apiVersion 必须为 devclaw.business-mods/v1，kind 必须为 catalog，kernel 和 kernelRef 只能声明一个。原始插件首次模块化需要 kernel。"
      },
      "业务 Mods 内核版本必须精确": {
        path: "catalog.kernel.version",
        message: "内核版本须为精确的语义版本，例如 1.0.0。"
      },
      "业务 Mods 节点标识重复或不一致": {
        path: "catalog.modules",
        message: "每个模块的 id 必须唯一并等于 node.id；node.skill 须为真实技能名。"
      },
      "业务 Mod 检查声明与实际节点不一致": {
        path: "catalog.modules",
        message: "checks.validators/guards 必须与该模块 node.validators/guards 一致，保留原检查。"
      },
      "业务 Mod 技能入口与节点不一致": {
        path: "catalog.modules",
        message:
          "skill.entry 必须在 skills/ 下且以 /<node.skill>/SKILL.md 结尾；skill.resources 使用实际包内路径。"
      },
      "共享内核不能包含未选择的业务 Skill": {
        path: "catalog.kernel.resources",
        message:
          "kernel.resources 不能重复包含 modules[].skill.entry；业务技能及其目录资源归该模块 skill.resources，共享 Hooks、知识与辅助入口仍需完整保留。"
      }
    }
    const hint = error instanceof Error ? parserHints[error.message] : undefined
    const credentialConfig =
      error instanceof Error && error.message.startsWith("业务配置包含不可发布的凭据声明")
    const missingResource =
      error instanceof Error && error.message.startsWith("业务 Mod 必需资源缺失或已排除：")
    throw new BusinessModCatalogValidationError(
      [
        {
          path: hint?.path ?? (missingResource ? "catalog.resources" : "catalog"),
          code: credentialConfig
            ? "PLUGIN_MODULARIZATION_CREDENTIAL_CONFIGURATION_REQUIRED"
            : missingResource
              ? "PLUGIN_MODULARIZATION_RESOURCE_LOSS"
              : diagnostic.code,
          message: credentialConfig
            ? "原业务配置包含具体凭据值，须改为安装后绑定或环境占位声明后重新检查；原值不显示、不复制到新清单，也不能删除配置规则来通过。"
            : missingResource
              ? "声明的资源未在当前过滤源码中找到；按 inspect_raw 文件清单核对路径，不恢复已排除的凭据或运行数据。"
              : (hint?.message ?? diagnostic.message)
        }
      ],
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "BUSINESS_MOD_CATALOG_INVALID"
    )
  }
}
