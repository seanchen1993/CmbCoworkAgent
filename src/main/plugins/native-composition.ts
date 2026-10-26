import { z } from "zod"
import type { ClawActionDescriptor } from "../../shared/mods/claw-actions"
import { clawActionObject } from "../../shared/mods/claw-actions"
import type { ProjectActionBinding } from "../../shared/project-runtime/action-bindings"
import { PROJECT_ACTION_LOCK_PATH } from "../../shared/project-runtime/action-bindings"
import {
  wrapProjectRuntimeManifest,
  parseExtensionContract,
  EXTENSION_CONTRACT_API_VERSION,
  REQUIRED_BUSINESS_CHECKS_PROTOCOL,
  CONTEXT_HANDOFF_PROTOCOL,
  DECLARED_CONTEXT_FILES_PROTOCOL,
  CONTEXT_MATERIALS_PROTOCOL,
  EXECUTION_RESOURCES_PROTOCOL,
  type ProjectRuntimeManifest
} from "../../shared/project-runtime"
import {
  assertProjectActionLock,
  createProjectActionBinding
} from "../harness-board/project-runtime/action-input"
import { assertHostRuntimeSupported } from "../harness-board/project-runtime/host-validators"
import {
  readRuntimeScopedFile,
  runtimeDigest,
  runtimeRelativePath
} from "../harness-board/project-runtime/safe-files"
import { parseSkillNameFromFrontmatterYaml } from "../skills/frontmatter"
import { businessModExtensionContract } from "./business-mod-assembly-contract"
import { parsePortableBusinessModUserConfig } from "./business-mod-user-config"
import { parseFunctionUserConfigSchema } from "../../shared/mods/v2/user-config-schema"

export const NATIVE_COMPOSITION_PATH = "composition/source.json"
const id = z.string().regex(/^[a-zA-Z0-9][\w.-]{0,63}$/)
const text = z.string().trim().min(1).max(2000)
const path = z.string().min(1).max(512).transform(runtimeRelativePath)
const schema = z.record(z.string(), z.unknown())
const artifact = z.object({ id, path, contract: text }).strict()

/** Author source is deliberately smaller than a runtime manifest, with no self-issued grants. */
export const nativeCompositionSchema = z
  .object({
    apiVersion: z.literal("devclaw.native-composition/v1"),
    plugin: z
      .object({ id, version: z.string().regex(/^\d+\.\d+\.\d+$/), title: text, description: text })
      .strict(),
    resources: z.array(path).max(256),
    configuration: z
      .object({ userConfig: schema, userConfigSchema: schema.optional() })
      .strict()
      .optional(),
    context: z.unknown().optional(),
    executionResources: z.unknown().optional(),
    contextAction: z
      .object({
        id,
        provider: z.object({ plugin: id, actionId: id }).strict(),
        input: schema,
        config: schema.optional()
      })
      .strict()
      .optional(),
    environment: z
      .array(z.object({ id, description: text, required: z.boolean() }).strict())
      .max(16),
    modules: z
      .array(
        z
          .object({
            id,
            version: z.string().regex(/^\d+\.\d+\.\d+$/),
            title: text,
            skill: path,
            executionMode: z.enum(["normal", "workflow"]).optional(),
            inputs: z.array(z.object({ artifactId: id, contract: text }).strict()).max(32),
            outputs: z.array(artifact).min(1).max(16),
            checks: z
              .array(
                z.discriminatedUnion("kind", [
                  z.object({ id, kind: z.literal("json-schema"), artifactId: id, schema }).strict(),
                  z
                    .object({
                      id,
                      kind: z.literal("action"),
                      artifactId: id,
                      provider: z.object({ plugin: id, actionId: id }).strict(),
                      format: z.enum(["json", "text", "artifact-reference-v1"]),
                      maxBytes: z
                        .number()
                        .int()
                        .min(1)
                        .max(512 * 1024)
                        .optional(),
                      bindProviderIdentity: id.optional(),
                      config: schema.optional()
                    })
                    .strict()
                ])
              )
              .min(1)
              .max(32),
            approval: z.enum(["none", "human"]).default("none"),
            resultApproval: z.enum(["none", "human"]).default("none")
          })
          .strict()
      )
      .min(1)
      .max(32)
  })
  .strict()

export type NativeComposition = z.infer<typeof nativeCompositionSchema>
export interface NativeCompositionFile {
  path: string
  bytes: Buffer
}

export interface NativeCompositionDependencyDiagnostic {
  plugin: string
  actionId: string
  usedBy: string
  state: "missing-or-not-authorized" | "ambiguous"
  candidates: Array<{ pluginId: string; digest: string }>
  next: string
}
export class NativeCompositionDependencyError extends Error {
  constructor(readonly dependencies: NativeCompositionDependencyDiagnostic[]) {
    super("NATIVE_COMPOSITION_PROVIDER_UNRESOLVED")
  }
}
function assertDependencies(source: NativeComposition, catalog: readonly ClawActionDescriptor[]) {
  const references = [
    ...(source.contextAction
      ? [{ ...source.contextAction.provider, usedBy: source.contextAction.id }]
      : []),
    ...source.modules.flatMap((module) =>
      module.checks.flatMap((check) =>
        check.kind === "action" ? [{ ...check.provider, usedBy: check.id }] : []
      )
    )
  ]
  const dependencies: NativeCompositionDependencyDiagnostic[] = []
  for (const reference of references) {
    const matches = catalog.filter(
      (action) => action.plugin === reference.plugin && action.actionId === reference.actionId
    )
    if (matches.length !== 1)
      dependencies.push({
        ...reference,
        state: matches.length ? "ambiguous" : "missing-or-not-authorized",
        candidates: matches.map((action) => ({ pluginId: action.pluginId, digest: action.digest })),
        next: matches.length
          ? "作者需核对重复安装并经原生插件管理保留唯一目标，再读取 project_actions 重新编译。"
          : "作者提供检查 Mod 源码；用户在原生安装/授权界面确认该依赖，再读取 project_actions 重新编译。目录缺失不能区分未安装与未授权，不可猜测身份或自动授权。"
      })
  }
  if (dependencies.length) throw new NativeCompositionDependencyError(dependencies)
}

function unique(values: string[], error: string) {
  if (new Set(values).size !== values.length) throw Error(error)
}

/** All bytes come from a retained, scoped source or the caller's explicitly supplied file set. */
export function readNativeCompositionFiles(root: string, source: NativeComposition) {
  return [...new Set([...source.resources, ...source.modules.map((module) => module.skill)])].map(
    (path) => {
      const file = readRuntimeScopedFile(root, path, 1024 * 1024)
      if (!file.bytes) throw Error("NATIVE_COMPOSITION_RESOURCE_MISSING")
      return { path, bytes: file.bytes }
    }
  )
}

/** Compilation never installs, executes a provider, or treats catalog selection as authority. */
export function compileNativeComposition(
  value: unknown,
  options: {
    files: readonly NativeCompositionFile[]
    actionCatalog: readonly ClawActionDescriptor[]
  }
) {
  const encoded = JSON.stringify(value)
  if (!encoded || Buffer.byteLength(encoded) > 256 * 1024) throw Error("NATIVE_COMPOSITION_LIMIT")
  const source = nativeCompositionSchema.parse(value)
  assertDependencies(source, options.actionCatalog)
  const userConfig = parsePortableBusinessModUserConfig(source.configuration?.userConfig)
  const userConfigSchema = parseFunctionUserConfigSchema(
    source.configuration?.userConfigSchema,
    userConfig
  )
  let extension =
    source.context === undefined
      ? businessModExtensionContract(undefined)
      : parseExtensionContract({
          apiVersion: EXTENSION_CONTRACT_API_VERSION,
          requires: [
            REQUIRED_BUSINESS_CHECKS_PROTOCOL,
            CONTEXT_HANDOFF_PROTOCOL,
            ...(typeof source.context === "object" &&
            source.context !== null &&
            "provider" in source.context &&
            typeof source.context.provider === "object" &&
            source.context.provider !== null &&
            "files" in source.context.provider
              ? [DECLARED_CONTEXT_FILES_PROTOCOL]
              : []),
            ...(typeof source.context === "object" &&
            source.context !== null &&
            "provider" in source.context &&
            typeof source.context.provider === "object" &&
            source.context.provider !== null &&
            "materials" in source.context.provider
              ? [CONTEXT_MATERIALS_PROTOCOL]
              : [])
          ],
          context: source.context
        })
  if (source.executionResources !== undefined) {
    extension = parseExtensionContract({ ...extension,
      requires: [...extension.requires, EXECUTION_RESOURCES_PROTOCOL],
      executionResources: source.executionResources })
    for (const path of extension.executionResources!.profiles)
      if (!source.resources.includes(path)) throw Error("NATIVE_COMPOSITION_PROFILE_RESOURCE_MISSING")
    for (const { binding } of extension.executionResources!.workspaces) {
      const field = userConfig?.[binding]
      if (!field || field.type !== "directory" || field.sensitive || field.multiple || !field.required)
        throw Error("NATIVE_COMPOSITION_WORKSPACE_BINDING_INVALID")
    }
  }
  const contextProvider = extension.context?.provider
  for (const key of contextProvider?.materials?.configuration ?? []) {
    const field = userConfig?.[key]
    if (!field || field.sensitive || !["string", "number", "boolean"].includes(field.type))
      throw Error("NATIVE_COMPOSITION_CONTEXT_CONFIGURATION_INVALID")
  }
  for (const root of contextProvider?.materials?.roots ?? []) {
    if (
      root.source === "package" &&
      root.path &&
      !source.resources.some((path) => path === root.path || path.startsWith(root.path + "/"))
    )
      throw Error("NATIVE_COMPOSITION_CONTEXT_RESOURCE_MISSING")
  }
  for (const file of contextProvider?.files ?? []) {
    if (file.source === "package" && !source.resources.includes(file.path))
      throw Error("NATIVE_COMPOSITION_CONTEXT_RESOURCE_MISSING")
    if (file.stages?.some((id) => !source.modules.some((module) => module.id === id)))
      throw Error("NATIVE_COMPOSITION_CONTEXT_STAGE_MISSING")
  }
  if (contextProvider?.entry && !source.resources.includes(contextProvider.entry))
    throw Error("NATIVE_COMPOSITION_CONTEXT_RESOURCE_MISSING")
  if (
    Boolean(contextProvider?.actionId) !== Boolean(source.contextAction) ||
    (source.contextAction && source.contextAction.id !== contextProvider?.actionId)
  )
    throw Error("NATIVE_COMPOSITION_CONTEXT_ACTION_MISMATCH")
  const knowledgeBinding = extension.context?.knowledge.binding
  if (knowledgeBinding) {
    const field = userConfig?.[knowledgeBinding]
    if (!field || field.type !== "directory" || field.sensitive || field.multiple)
      throw Error("NATIVE_COMPOSITION_KNOWLEDGE_BINDING_INVALID")
  }
  unique(
    source.modules.map((module) => module.id),
    "NATIVE_COMPOSITION_MODULE_DUPLICATE"
  )
  unique(
    source.environment.map((item) => item.id),
    "NATIVE_COMPOSITION_ENVIRONMENT_DUPLICATE"
  )
  const retained = new Map<string, Buffer>()
  const supplied = new Map<string, Buffer>()
  for (const file of options.files) {
    runtimeRelativePath(file.path)
    if (supplied.has(file.path.toLowerCase())) throw Error("NATIVE_COMPOSITION_PATH_COLLISION")
    supplied.set(file.path.toLowerCase(), file.bytes)
  }
  for (const resource of [...source.resources, ...source.modules.map((module) => module.skill)]) {
    if (
      /(?:^|\/)(?:\.env(?:\.|$)|\.mcp(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$))/i.test(
        resource
      )
    )
      throw Error("NATIVE_COMPOSITION_SENSITIVE_RESOURCE")
    const file = options.files.find((file) => file.path === resource)
    if (!file || file.bytes.length > 1024 * 1024) throw Error("NATIVE_COMPOSITION_RESOURCE_MISSING")
    retained.set(resource, Buffer.from(file.bytes))
  }
  if ([...retained.values()].reduce((sum, bytes) => sum + bytes.length, 0) > 8 * 1024 * 1024)
    throw Error("NATIVE_COMPOSITION_LIMIT")
  const artifacts = source.modules.flatMap((module) => module.outputs)
  unique(
    artifacts.map((item) => item.id),
    "NATIVE_COMPOSITION_ARTIFACT_DUPLICATE"
  )
  unique(
    artifacts.map((item) => item.path.toLowerCase()),
    "NATIVE_COMPOSITION_ARTIFACT_PATH_COLLISION"
  )
  unique(
    source.modules.flatMap((module) => module.checks.map((check) => check.id)),
    "NATIVE_COMPOSITION_CHECK_DUPLICATE"
  )
  const produced = new Map<string, (typeof artifacts)[number]>()
  const bindings: ProjectActionBinding[] = []
  if (source.contextAction) {
    const contextAction = source.contextAction
    const providers = options.actionCatalog.filter(
      (action) =>
        action.plugin === contextAction.provider.plugin &&
        action.actionId === contextAction.provider.actionId
    )
    if (providers.length !== 1) throw Error("NATIVE_COMPOSITION_PROVIDER_UNRESOLVED")
    bindings.push(
      createProjectActionBinding(
        contextAction.id,
        providers[0],
        clawActionObject(contextAction.input),
        clawActionObject(contextAction.config ?? {})
      )
    )
  }
  const checks: ProjectRuntimeManifest["checks"] = []
  const stages: ProjectRuntimeManifest["stages"] = []
  for (const module of source.modules) {
    unique(
      module.inputs.map((input) => input.artifactId),
      "NATIVE_COMPOSITION_INPUT_DUPLICATE"
    )
    for (const input of module.inputs) {
      const output = produced.get(input.artifactId)
      if (!output) throw Error("NATIVE_COMPOSITION_INPUT_NOT_PRIOR")
      if (output.contract !== input.contract) throw Error("NATIVE_COMPOSITION_CONTRACT_MISMATCH")
    }
    for (const output of module.outputs) {
      if (!module.checks.some((check) => check.artifactId === output.id))
        throw Error("NATIVE_COMPOSITION_OUTPUT_UNCHECKED")
    }
    for (const check of module.checks) {
      if (!module.outputs.some((output) => output.id === check.artifactId))
        throw Error("NATIVE_COMPOSITION_CHECK_NOT_OUTPUT")
      if (check.kind === "json-schema") {
        checks.push({
          id: check.id,
          artifactId: check.artifactId,
          kind: check.kind,
          sideEffect: "read",
          schema: check.schema
        })
      } else {
        if ((check.format === "artifact-reference-v1") !== (check.maxBytes !== undefined))
          throw Error("NATIVE_COMPOSITION_REFERENCE_BUDGET_INVALID")
        const providers = options.actionCatalog.filter(
          (action) =>
            action.plugin === check.provider.plugin && action.actionId === check.provider.actionId
        )
        if (providers.length !== 1) throw Error("NATIVE_COMPOSITION_PROVIDER_UNRESOLVED")
        const provider = providers[0]
        const config = clawActionObject(check.config ?? {})
        if (check.bindProviderIdentity) {
          if (Object.hasOwn(config, check.bindProviderIdentity))
            throw Error("NATIVE_COMPOSITION_PROVIDER_IDENTITY_CONFLICT")
          config[check.bindProviderIdentity] = {
            pluginId: provider.pluginId,
            plugin: provider.plugin,
            digest: provider.digest,
            actionId: provider.actionId
          }
        }
        const actionId = check.id
        bindings.push(
          createProjectActionBinding(actionId, provider, {}, config, {
            kind: "artifact",
            artifactId: check.artifactId,
            pointer: "",
            ...(check.format === "artifact-reference-v1"
              ? { format: check.format, maxBytes: check.maxBytes! }
              : { format: check.format })
          })
        )
        checks.push({
          id: check.id,
          artifactId: check.artifactId,
          kind: "action",
          sideEffect: "read",
          actionId
        })
      }
    }
    const skill = retained.get(module.skill)!.toString("utf8")
    if (!parseSkillNameFromFrontmatterYaml(skill)) throw Error("NATIVE_COMPOSITION_SKILL_INVALID")
    const compiledSkill = `skills/native-${module.id}/SKILL.md`
    const context = [
      "\n\n## Compiled stage contract",
      "The Host owns execution, validation and stage advancement. Produce the declared outputs; request missing user input through the current task. Only the Host can approve and commit this operation.",
      "Inputs: " + JSON.stringify(module.inputs.map((input) => produced.get(input.artifactId))),
      "Outputs: " + JSON.stringify(module.outputs),
      "Package resources: " + JSON.stringify(source.resources),
      "Required configuration: " +
        JSON.stringify(source.environment.filter((item) => item.required).map((item) => item.id))
    ].join("\n")
    if (retained.has(compiledSkill)) throw Error("NATIVE_COMPOSITION_GENERATED_PATH_COLLISION")
    retained.set(compiledSkill, Buffer.from(skill + context))
    stages.push({
      id: module.id,
      title: module.title,
      skill: compiledSkill,
      ...(module.executionMode === undefined ? {} : { executionMode: module.executionMode }),
      actionIds: [],
      artifactIds: module.outputs.map((output) => output.id),
      checkIds: module.checks.map((check) => check.id),
      approval: module.approval,
      ...(module.resultApproval === "human" ? { resultApproval: "human" as const } : {})
    })
    for (const output of module.outputs) produced.set(output.id, output)
  }
  const runtime: ProjectRuntimeManifest = {
    apiVersion: "devclaw.project-runtime/v1",
    plugin: { id: source.plugin.id, version: source.plugin.version },
    mode: "host",
    stateOwner: "host",
    stages,
    actions: bindings.map(({ id, ref }) => ({ id, ref })),
    artifacts: artifacts.map(({ id, path }) => ({ id, path, required: true })),
    checks,
    environment: source.environment,
    capabilities: {
      execution: true,
      conditionalTransition: false,
      idempotency: false,
      reconciliation: false,
      cancellation: true
    }
  }
  assertHostRuntimeSupported(runtime)
  const actionLock = assertProjectActionLock(runtime, {
    apiVersion: "devclaw.project-actions-lock/v1",
    bindings
  })
  const envelope = wrapProjectRuntimeManifest(runtime, extension)
  const lock = {
    apiVersion: "devclaw.native-composition-lock/v1",
    sourceDigest: runtimeDigest(JSON.stringify(source)),
    modules: source.modules.map(({ id, version }) => ({ id, version })),
    resources: [...retained].map(([path, bytes]) => ({ path, digest: runtimeDigest(bytes) })),
    runtimeDigest: runtimeDigest(JSON.stringify(envelope)),
    actionLockDigest: runtimeDigest(JSON.stringify(actionLock))
  }
  for (const [path, value] of [
    [NATIVE_COMPOSITION_PATH, source],
    ["composition/lock.json", lock],
    [
      "plugin.json",
      {
        name: source.plugin.id,
        version: source.plugin.version,
        description: source.plugin.description,
        skills: "skills",
        ...(userConfig ? { userConfig } : {}),
        ...(userConfigSchema
          ? {
              userConfigSchema,
              cmbCompatibility: { userConfigMigrations: "v1" }
            }
          : {})
      }
    ],
    ["devclaw.project-runtime.json", envelope],
    [PROJECT_ACTION_LOCK_PATH, actionLock]
  ] as const) {
    if (retained.has(path)) throw Error("NATIVE_COMPOSITION_GENERATED_PATH_COLLISION")
    retained.set(path, Buffer.from(JSON.stringify(value, null, 2) + "\n"))
  }
  return {
    source,
    runtime: envelope,
    actionLock,
    lock,
    files: [...retained].map(([path, bytes]) => ({ path, bytes }))
  }
}
