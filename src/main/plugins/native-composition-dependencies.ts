import type { ClawActionDescriptor } from "../../shared/mods/claw-actions"
import { clawActionObject } from "../../shared/mods/claw-actions"
import type { ModObject } from "../../shared/mods/types"
import { isModObject } from "../../shared/mods/v2/contracts"
import { PROJECT_ARTIFACT_REFERENCE_PROTOCOL } from "../../shared/project-runtime/artifact-reference"
import { createProjectActionBinding } from "../harness-board/project-runtime/action-input"
import { validateRegisteredToolInput } from "../mods/v2/tool-schema"
import type { NativeComposition } from "./native-composition"

export interface NativeCompositionActionRequirement {
  plugin: string
  actionId: string
  usedBy: string
  role: "context" | "artifact-check"
  moduleId?: string
  artifactId?: string
  artifactContract?: string
  format?: "json" | "text" | "artifact-reference-v1"
  configurationKeys?: string[]
  input?: ModObject
  inputSchema?: ModObject
  config: ModObject
  bindProviderIdentity?: string
}

export interface NativeCompositionActionIssue {
  code: string
  field?: string
  detail: string
}

export interface NativeCompositionDependencyDiagnostic extends NativeCompositionActionRequirement {
  state: "missing-or-not-authorized" | "ambiguous" | "contract-mismatch"
  candidates: Array<{ pluginId: string; digest: string }>
  issues?: NativeCompositionActionIssue[]
  next: string
}

export class NativeCompositionDependencyError extends Error {
  constructor(readonly dependencies: NativeCompositionDependencyDiagnostic[]) {
    super(
      dependencies.some((item) => item.state === "contract-mismatch")
        ? "NATIVE_COMPOSITION_PROVIDER_CONTRACT_MISMATCH"
        : "NATIVE_COMPOSITION_PROVIDER_UNRESOLVED"
    )
  }
}

/** Requirements describe what the Host actually supplies, never a suggested provider identity. */
export function nativeCompositionActionRequirements(source: NativeComposition) {
  const requirements: NativeCompositionActionRequirement[] = []
  if (source.contextAction)
    requirements.push({
      ...source.contextAction.provider,
      usedBy: source.contextAction.id,
      role: "context",
      input: clawActionObject(source.contextAction.input),
      config: clawActionObject(source.contextAction.config ?? {})
    })
  for (const module of source.modules)
    for (const check of module.checks) {
      if (check.kind !== "action") continue
      const artifact = module.outputs.find((item) => item.id === check.artifactId)
      const schemas = module.checks
        .filter((item) => item.kind === "json-schema" && item.artifactId === check.artifactId)
        .map((item) => clawActionObject("schema" in item ? item.schema : {}))
      requirements.push({
        ...check.provider,
        usedBy: check.id,
        role: "artifact-check",
        moduleId: module.id,
        artifactId: check.artifactId,
        ...(artifact ? { artifactContract: artifact.contract } : {}),
        format: check.format,
        ...(check.configurationKeys ? { configurationKeys: [...check.configurationKeys] } : {}),
        ...(check.format === "json" && schemas.length
          ? { inputSchema: schemas.length === 1 ? schemas[0] : { allOf: schemas } }
          : {}),
        config: clawActionObject(check.config ?? {}),
        ...(check.bindProviderIdentity ? { bindProviderIdentity: check.bindProviderIdentity } : {})
      })
    }
  return requirements
}

function suppliedSchema(requirement: NativeCompositionActionRequirement): ModObject | undefined {
  if (requirement.format === "text")
    return {
      type: "object",
      required: ["content"],
      additionalProperties: false,
      properties: { content: { type: "string" } }
    }
  if (requirement.format === "artifact-reference-v1")
    return {
      type: "object",
      additionalProperties: false,
      required: [
        "protocol",
        "projectId",
        "stageId",
        "version",
        "pluginDigest",
        "workspaceIdentity",
        "current",
        "sources",
        ...(requirement.configurationKeys ? ["configuration"] : [])
      ],
      properties: {
        protocol: { type: "string", const: PROJECT_ARTIFACT_REFERENCE_PROTOCOL },
        projectId: { type: "string" },
        stageId: { type: "string" },
        version: { type: "integer" },
        pluginDigest: { type: "string" },
        workspaceIdentity: { type: "string" },
        current: { type: "object" },
        sources: { type: "array" },
        ...(requirement.configurationKeys ? {
          configuration: { type: "object", required: requirement.configurationKeys }
        } : {})
      }
    }
  return requirement.inputSchema
}

/** Conservative shape checks only. No examples are executed and no schema is treated as a proof. */
function inputIssues(
  supplied: ModObject,
  accepted: ModObject,
  depth = 0
): NativeCompositionActionIssue[] {
  if (depth > 8) return []
  for (const key of ["anyOf", "oneOf"] as const) {
    const choices = accepted[key]
    if (Array.isArray(choices)) {
      const branches = choices
        .filter(isModObject)
        .map((choice) => inputIssues(supplied, choice, depth + 1))
      if (branches.length && branches.every((issues) => issues.length))
        return [
          {
            code: "INPUT_ALTERNATIVES_MISMATCH",
            detail: branches
              .map((issues) => issues.map((issue) => issue.detail).join("; "))
              .join(" | ")
          }
        ]
    }
  }
  const issues: NativeCompositionActionIssue[] = []
  if (Array.isArray(accepted.allOf))
    for (const branch of accepted.allOf)
      if (isModObject(branch)) issues.push(...inputIssues(supplied, branch, depth + 1))
  // Complex producer schemas need their actual runtime validator; do not flatten unions or $ref.
  if (["anyOf", "oneOf", "allOf", "$ref"].some((key) => supplied[key] !== undefined)) return issues
  const provided = isModObject(supplied.properties) ? supplied.properties : {}
  const properties = isModObject(accepted.properties) ? accepted.properties : {}
  const guaranteed = Array.isArray(supplied.required) ? supplied.required : []
  for (const field of Array.isArray(accepted.required) ? accepted.required : []) {
    if (typeof field === "string" && !guaranteed.includes(field))
      issues.push({
        code: "INPUT_REQUIRED_NOT_GUARANTEED",
        field,
        detail: `Host input contract does not guarantee required field ${field}. Action config is not action input.`
      })
  }
  for (const [field, rule] of Object.entries(provided)) {
    if (accepted.additionalProperties === false && !Object.hasOwn(properties, field))
      issues.push({
        code: "INPUT_FIELD_REJECTED",
        field,
        detail: `Host input field ${field} is rejected by provider additionalProperties:false.`
      })
    const expected = properties[field]
    if (!isModObject(rule) || !isModObject(expected)) continue
    const producedTypes = Array.isArray(rule.type) ? rule.type : rule.type ? [rule.type] : []
    const acceptedTypes = Array.isArray(expected.type)
      ? expected.type
      : expected.type
        ? [expected.type]
        : []
    if (
      producedTypes.length &&
      acceptedTypes.length &&
      producedTypes.every(
        (type) =>
          !acceptedTypes.includes(type) && !(type === "integer" && acceptedTypes.includes("number"))
      )
    )
      issues.push({
        code: "INPUT_TYPE_MISMATCH",
        field,
        detail: `Input field ${field} has incompatible types.`
      })
  }
  return issues
}

export function evaluateNativeCompositionAction(
  requirement: NativeCompositionActionRequirement,
  action: ClawActionDescriptor
) {
  const issues: NativeCompositionActionIssue[] = []
  if (requirement.format === "artifact-reference-v1" && !action.platform)
    issues.push({
      code: "ARTIFACT_REFERENCE_PLATFORM_REQUIRED",
      detail: "artifact-reference-v1 is supplied only to a public platform action, not a command."
    })
  const config = clawActionObject(requirement.config)
  if (requirement.bindProviderIdentity) {
    if (Object.hasOwn(config, requirement.bindProviderIdentity))
      throw Error("NATIVE_COMPOSITION_PROVIDER_IDENTITY_CONFLICT")
    config[requirement.bindProviderIdentity] = {
      pluginId: action.pluginId,
      plugin: action.plugin,
      digest: action.digest,
      actionId: action.actionId
    }
  }
  try {
    // The production validator checks provider schemas/config; mapped input remains a runtime check.
    createProjectActionBinding(
      requirement.usedBy,
      action,
      requirement.input ?? {},
      config,
      requirement.role === "artifact-check"
        ? { kind: "artifact", artifactId: requirement.artifactId!, pointer: "", format: "json" }
        : undefined
    )
  } catch (error) {
    issues.push({
      code: "PROVIDER_SCHEMA_OR_CONFIG_INVALID",
      detail: error instanceof Error ? error.message : "Provider schema/config is invalid."
    })
  }
  if (requirement.role === "context") {
    try {
      validateRegisteredToolInput(action.inputSchema, requirement.input ?? {})
    } catch {
      issues.push({
        code: "CONTEXT_INPUT_MISMATCH",
        detail: "Declared context input fails the provider input schema."
      })
    }
  } else {
    const supplied = suppliedSchema(requirement)
    if (supplied) issues.push(...inputIssues(supplied, action.inputSchema))
  }
  return {
    status: issues.length ? ("incompatible" as const) : ("no-static-blocker" as const),
    issues,
    businessSemanticsVerified: false,
    hint: "No static blocker is not execution or business equivalence. Inspect actual source and validate actual artifacts through the native project runner."
  }
}

export function assertNativeCompositionDependencies(
  source: NativeComposition,
  catalog: readonly ClawActionDescriptor[]
) {
  const dependencies: NativeCompositionDependencyDiagnostic[] = []
  for (const requirement of nativeCompositionActionRequirements(source)) {
    const matches = catalog.filter(
      (action) => action.plugin === requirement.plugin && action.actionId === requirement.actionId
    )
    if (matches.length !== 1)
      dependencies.push({
        ...requirement,
        state: matches.length ? "ambiguous" : "missing-or-not-authorized",
        candidates: matches.map((action) => ({ pluginId: action.pluginId, digest: action.digest })),
        next: matches.length
          ? "核对重复安装并经原生插件管理保留唯一目标，再读取 project_actions 重新编译。"
          : "project_actions(id,localActionId=usedBy) 检查真实动作及契约；catalog(project-dependencies) 读取未安装依赖源码。用 save/check/request_reuse 准备依赖，结束本轮等原生安装/授权确认，再重读 project_actions 并修正 source provider 后 compile。缺失不能区分未安装和未授权，禁止猜身份或自动授权。"
      })
    else {
      const evaluation = evaluateNativeCompositionAction(requirement, matches[0])
      if (evaluation.status === "incompatible")
        dependencies.push({
          ...requirement,
          state: "contract-mismatch",
          candidates: matches.map((action) => ({
            pluginId: action.pluginId,
            digest: action.digest
          })),
          issues: evaluation.issues,
          next: "按实际 Host 产物输入契约选择或创作独立 validator；config 不会补入 input，不能把执行命令冒充产物检查。保留原源码、Hooks、知识、配置和检查，原生安装/授权确认后重读 project_actions 并编译。"
        })
    }
  }
  if (dependencies.length) throw new NativeCompositionDependencyError(dependencies)
}
