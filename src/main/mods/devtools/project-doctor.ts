import {
  parseProjectRuntimeManifest,
  type ProjectRuntimeManifest
} from "../../../shared/project-runtime"
import type { ClawActionDescriptor } from "../../../shared/mods/claw-actions"
import type { ModObject } from "../../../shared/mods/types"
import type { AuthoringSourceBundle } from "./authoring-bundle"
import { validateToolSchema } from "../v2/tool-schema"
import { readProjectSource } from "./project-source"
import { parseSkillNameFromFrontmatterYaml } from "../../skills/frontmatter"
import { assertHostRuntimeSupported } from "../../harness-board/project-runtime/host-validators"
import {
  assertProjectActionLock,
  assertProjectActionProviders
} from "../../harness-board/project-runtime/action-input"
import { PROJECT_ACTION_LOCK_PATH } from "../../../shared/project-runtime/action-bindings"
import { compileProjectHarness, HARNESS_SOURCE_PATH } from "./project-harness"
import { parsePluginCapabilities } from "../../../shared/plugin-capabilities"
import { assertProjectPackageExtensions } from "./project-package-extensions"
import {
  compileNativeComposition,
  nativeCompositionLegacyGeneratedPretty,
  NATIVE_COMPOSITION_PATH
} from "../../plugins/native-composition"

export interface ProjectDoctorReport {
  valid: boolean
  digest: string
  packageId?: string
  version?: string
  diagnostics: Array<{ code: string; message: string; path?: string }>
  excluded: string[]
  scope: "static-project-package"
  executed: false
}

/** Uses the same source digest, manifest parser and schema validator as production. */
export function inspectProjectSource(
  bundle: AuthoringSourceBundle,
  excluded: string[] = [],
  availableActions: readonly ClawActionDescriptor[] = []
): { report: ProjectDoctorReport; manifest?: ProjectRuntimeManifest } {
  const report: ProjectDoctorReport = {
    valid: true,
    digest: bundle.digest,
    diagnostics: [],
    excluded,
    scope: "static-project-package",
    executed: false
  }
  const issue = (code: string, message: string, path?: string) => {
    report.valid = false
    report.diagnostics.push({ code, message, ...(path ? { path } : {}) })
  }
  const get = (path: string) => bundle.files.find((file) => file.path === path)?.text
  const capabilityText = get("devclaw.capabilities.json")
  if (capabilityText !== undefined) {
    try {
      const capabilities = parsePluginCapabilities(JSON.parse(capabilityText))!
      for (const capability of capabilities.capabilities) {
        if (!get(capability.entry))
          issue(
            "PROJECT_CAPABILITY_ENTRY_MISSING",
            "能力引用的技能或流程文件不存在。",
            capability.entry
          )
      }
    } catch {
      issue(
        "PROJECT_CAPABILITIES_INVALID",
        "能力声明格式不正确，请检查使用范围和依赖。",
        "devclaw.capabilities.json"
      )
    }
  }
  let manifest: ProjectRuntimeManifest
  try {
    manifest = parseProjectRuntimeManifest(
      JSON.parse(get("devclaw.project-runtime.json") ?? "null")
    )
    report.packageId = manifest.plugin.id
    report.version = manifest.plugin.version
  } catch {
    issue(
      "PROJECT_RUNTIME_INVALID",
      "运行声明缺失或不符合当前生产协议。",
      "devclaw.project-runtime.json"
    )
    return { report }
  }
  if (get(HARNESS_SOURCE_PATH)) {
    try {
      const compiled = compileProjectHarness(bundle)
      const expected = parseProjectRuntimeManifest(
        JSON.parse(
          compiled.files.find((file) => file.path === "devclaw.project-runtime.json")!.text
        )
      )
      if (JSON.stringify(expected) !== JSON.stringify(manifest))
        issue(
          "PROJECT_HARNESS_STALE",
          "节点定义已改变；请显式 compile 后再检查。",
          HARNESS_SOURCE_PATH
        )
    } catch {
      issue(
        "PROJECT_HARNESS_INVALID",
        "节点定义、技能或示例无效；请修复后显式 compile。",
        HARNESS_SOURCE_PATH
      )
    }
  }
  if (get(NATIVE_COMPOSITION_PATH)) {
    try {
      if (get(HARNESS_SOURCE_PATH) || get("mods/business/manifest.json"))
        throw Error("NATIVE_COMPOSITION_MULTIPLE_SOURCES")
      const compiled = compileNativeComposition(JSON.parse(get(NATIVE_COMPOSITION_PATH)!), {
        files: bundle.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.text) })),
        actionCatalog: availableActions,
        legacyGeneratedPretty: nativeCompositionLegacyGeneratedPretty(get(PROJECT_ACTION_LOCK_PATH)),
        // Reproduce old, already locked all-preceding projections without silently upgrading them.
        // Source, generated Skills, runtime, action lock and composition lock still compare byte-for-byte.
        legacyInputArtifactStages: new Set(
          manifest.stages
            .filter((stage) => stage.inputArtifactIds === undefined)
            .map((stage) => stage.id)
        )
      })
      if (compiled.files.some((file) => get(file.path) !== file.bytes.toString("utf8")))
        issue(
          "NATIVE_COMPOSITION_STALE",
          "组合源或已生成文件已改变；请重新编译并复核检查。",
          NATIVE_COMPOSITION_PATH
        )
    } catch {
      issue(
        "NATIVE_COMPOSITION_INVALID",
        "组合契约、资源或实际检查提供器不匹配；不能静默降级。",
        NATIVE_COMPOSITION_PATH
      )
    }
  }
  try {
    const plugin: unknown = JSON.parse(get("plugin.json") ?? "null")
    if (
      !plugin ||
      typeof plugin !== "object" ||
      Array.isArray(plugin) ||
      Object.keys(plugin).some(
        (key) =>
          ![
            "name",
            "version",
            "description",
            "author",
            "mods",
            "hooks",
            "mcpServers",
            "userConfig",
            "userConfigSchema",
            "skills",
            "cmbCompatibility"
          ].includes(key)
      ) ||
      !("name" in plugin) ||
      plugin.name !== manifest.plugin.id ||
      !("version" in plugin) ||
      plugin.version !== manifest.plugin.version
    ) {
      issue(
        "PROJECT_PLUGIN_IDENTITY",
        "plugin.json 的包名和版本必须与运行声明一致；不要填写安装 UUID。",
        "plugin.json"
      )
    }
    if (plugin && typeof plugin === "object" && !Array.isArray(plugin))
      assertProjectPackageExtensions(plugin as Record<string, unknown>, get)
  } catch {
    issue("PROJECT_PLUGIN_INVALID", "插件元数据无效。", "plugin.json")
  }
  if (manifest.mode !== "host")
    issue("PROJECT_MODE_UNSUPPORTED", "此向导只处理 host 轻量包；旧适配器仍走原插件检查。")
  try {
    assertHostRuntimeSupported(manifest)
  } catch {
    issue("PROJECT_HOST_CAPABILITY_UNSUPPORTED", "声明含当前轻量宿主尚未开放的执行或校验能力。")
  }
  if (manifest.actions.length || get(PROJECT_ACTION_LOCK_PATH)) {
    try {
      const lock = assertProjectActionLock(
        manifest,
        JSON.parse(get(PROJECT_ACTION_LOCK_PATH) ?? "null")
      )
      assertProjectActionProviders(lock, availableActions)
    } catch {
      issue(
        "PROJECT_ACTION_LOCK_INVALID",
        "动作锁、映射或当前授权目录不匹配；重新列举公开动作并核对版本与 schema。",
        PROJECT_ACTION_LOCK_PATH
      )
    }
  }
  for (const stage of manifest.stages) {
    if (!stage.skill || !get(stage.skill))
      issue("PROJECT_SKILL_MISSING", `阶段 ${stage.id} 缺少真实 Skill 文件。`, stage.skill)
    else if (!parseSkillNameFromFrontmatterYaml(get(stage.skill)!)) {
      issue("PROJECT_SKILL_FRONTMATTER", "Skill 必须有 YAML frontmatter 和 name。", stage.skill)
    }
    if (
      !stage.checkIds.length ||
      stage.artifactIds.some(
        (id) =>
          manifest.artifacts.find((artifact) => artifact.id === id)?.required &&
          !stage.checkIds.some(
            (checkId) => manifest.checks.find((check) => check.id === checkId)?.artifactId === id
          )
      )
    ) {
      issue("PROJECT_VALIDATION_REQUIRED", `阶段 ${stage.id} 的必需产物必须有真实检查。`)
    }
  }
  for (const check of manifest.checks) {
    if (check.kind === "json-schema") {
      try {
        validateToolSchema(check.schema as ModObject, { allowReservedKeys: true })
      } catch {
        issue("PROJECT_SCHEMA_UNSUPPORTED", `检查 ${check.id} 的 JSON Schema 超出宿主支持范围。`)
      }
    }
    // Native composition binds every check to captured artifact bytes and a current public
    // provider above; the original Host check phase supplies its durable execution facts.
    if (check.kind === "action" && !get(NATIVE_COMPOSITION_PATH))
      issue("PROJECT_ACTION_CHECK_NOT_ENABLED", `动作校验 ${check.id} 需要经已验证的执行链接入。`)
  }
  for (const action of manifest.actions) {
    const found = availableActions.find(
      (candidate) =>
        candidate.pluginId === action.ref.pluginId &&
        candidate.plugin === action.ref.plugin &&
        candidate.digest === action.ref.digest &&
        candidate.actionId === action.ref.actionId
    )
    if (!found)
      issue(
        "PROJECT_ACTION_DEPENDENCY_MISSING",
        `缺少固定身份和摘要的公开动作 ${action.id}；请从已安装动作目录选择，不能猜测安装 ID。`
      )
    else {
      try {
        validateToolSchema(found.inputSchema)
        if (found.outputSchema) validateToolSchema(found.outputSchema)
      } catch {
        issue("PROJECT_ACTION_SCHEMA_UNSUPPORTED", `动作 ${action.id} 的输入输出类型不受支持。`)
      }
    }
  }
  if (!get("tests/project-contract.json"))
    issue("PROJECT_CONTRACT_MISSING", "缺少隔离校验样例。", "tests/project-contract.json")
  return { report, manifest }
}

export async function doctorProjectPlugin(
  directory: string,
  options: {
    availableActions?: readonly ClawActionDescriptor[]
  } = {}
): Promise<ProjectDoctorReport> {
  const source = await readProjectSource(directory)
  return inspectProjectSource(source.bundle, source.excluded, options.availableActions).report
}
