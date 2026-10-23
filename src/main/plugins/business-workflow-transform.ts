import { createHash } from "node:crypto"
import type { BusinessModDefinition } from "../../shared/business-mods"
import { businessModId, businessModObject, businessModPath } from "./business-mod-manifest"

export type BusinessWorkflowChange =
  | { kind: "insert"; before: string; module: BusinessModDefinition }
  | { kind: "replace_step"; id: string; module: BusinessModDefinition }
  | {
      kind: "replace_skill"
      id: string
      skillName: string
      skill: BusinessModDefinition["skill"]
    }

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b, "en"))
            .map(([key, item]) => [key, canonical(item)])
        )
      : value
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")
const objects = (value: unknown) =>
  value === undefined ? [] : Array.isArray(value) ? value.map(businessModObject) : invalid()
function invalid(): never {
  throw Error("BUSINESS_WORKFLOW_CONTRACT_INVALID")
}
export class BusinessWorkflowLinkError extends Error {
  readonly code = "BUSINESS_WORKFLOW_LINKS_INVALID"
  constructor(readonly diagnostics: Array<{ code: string; stageId: string; artifactId?: string }>) {
    super("BUSINESS_WORKFLOW_LINKS_INVALID")
  }
}
export class BusinessWorkflowSkillRenameError extends Error {
  readonly code = "BUSINESS_WORKFLOW_SKILL_RENAME_REQUIRES_HOOK_MAPPING"
  constructor() {
    super("BUSINESS_WORKFLOW_SKILL_RENAME_REQUIRES_HOOK_MAPPING")
  }
}

/** Names can be executable Hook matchers; renaming requires an explicit migration protocol. */
export function assertWorkflowSkillHookIdentity(
  previous: BusinessModDefinition,
  next: BusinessModDefinition,
  hasDeclaredHooks: boolean
) {
  if (hasDeclaredHooks && previous.node.skill !== next.node.skill)
    throw new BusinessWorkflowSkillRenameError()
}

/** Read-only, deterministic view of the existing executor declarations; never a second writer. */
export function inspectBusinessWorkflow(
  modules: BusinessModDefinition[],
  extensionIds: string[] = []
) {
  if (!Array.isArray(modules) || !modules.length || modules.length > 32) invalid()
  if (Buffer.byteLength(JSON.stringify(modules)) > 256 * 1024) invalid()
  if (
    !Array.isArray(extensionIds) ||
    extensionIds.length > 32 ||
    new Set(extensionIds).size !== extensionIds.length
  )
    invalid()
  extensionIds.forEach(businessModId)
  const identities = new Set<string>(),
    states = new Set<string>()
  const stages = modules.map((mod) => {
    businessModId(mod.id)
    if (identities.has(mod.id.toLowerCase())) invalid()
    identities.add(mod.id.toLowerCase())
    const contract = businessModObject(mod.node.artifacts ?? {})
    const inputs = objects(contract.inputs)
    const outputs = mod.host
      ? mod.host.artifacts.map((artifact): Record<string, unknown> => {
          const schema = mod.host!.checks.find((check) => check.artifactId === artifact.id)?.schema
          return { ...artifact, ...(schema ? { schema } : {}) }
        })
      : objects(contract.outputs)
    for (const artifact of [...inputs, ...outputs]) {
      if (typeof artifact.id !== "string" || typeof artifact.path !== "string") invalid()
      businessModId(artifact.id)
      // Artifacts can include the original executor's safe template placeholders.
      if (
        !artifact.path ||
        /[\0:\r\n]/.test(artifact.path) ||
        artifact.path.includes("\\") ||
        /[:<>"|]/.test(artifact.path) ||
        [...artifact.path].some((character) => character.charCodeAt(0) < 32) ||
        artifact.path.startsWith("/") ||
        artifact.path.split("/").includes("..")
      )
        invalid()
      if (
        artifact.schemaVersion !== undefined &&
        (typeof artifact.schemaVersion !== "string" ||
          !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(artifact.schemaVersion))
      )
        invalid()
    }
    const declaredStates = mod.host
      ? [`${mod.id}:active`, `${mod.id}:done`]
      : Array.isArray(mod.node.checkpoints)
        ? mod.node.checkpoints
        : []
    if (
      ![1, 2].includes(declaredStates.length) ||
      declaredStates.some((state) => typeof state !== "string" || !state)
    )
      invalid()
    for (const state of declaredStates as string[]) {
      if (states.has(state)) invalid()
      states.add(state)
    }
    return {
      id: mod.id,
      skill: { name: String(mod.node.skill), ...structuredClone(mod.skill) },
      states: declaredStates as string[],
      inputs: structuredClone(inputs),
      outputs: structuredClone(outputs),
      checkIds: mod.host
        ? [...mod.host.stage.checkIds]
        : [...mod.checks.validators, ...mod.checks.guards],
      dependencies: [...mod.dependencies.required]
    }
  })
  const diagnostics: Array<{ code: string; stageId: string; artifactId?: string }> = []
  const producers = new Map<string, { stageId: string; output: Record<string, unknown> }>()
  for (const stage of stages) {
    for (const dependency of stage.dependencies)
      if (
        !extensionIds.includes(dependency) &&
        !stages.slice(0, stages.indexOf(stage)).some((previous) => previous.id === dependency)
      )
        diagnostics.push({ code: "UPSTREAM_DEPENDENCY_MISSING", stageId: stage.id })
    for (const input of stage.inputs) {
      if (input.required === false) continue
      const producer = producers.get(String(input.path))
      if (!producer) {
        const extract = input.extract ? businessModObject(input.extract) : undefined
        if (!extract || typeof extract.degrade !== "string" || !extract.degrade.trim())
          diagnostics.push({
            code: "INPUT_PRODUCER_MISSING",
            stageId: stage.id,
            artifactId: String(input.id)
          })
      } else if (
        input.schemaVersion !== producer.output.schemaVersion &&
        (input.schemaVersion !== undefined || producer.output.schemaVersion !== undefined)
      )
        diagnostics.push({
          code: "INPUT_VERSION_MISMATCH",
          stageId: stage.id,
          artifactId: String(input.id)
        })
    }
    for (const output of stage.outputs) {
      const previous = producers.get(String(output.path))
      const orderedUpdate =
        previous &&
        stage.inputs.some(
          (input) =>
            input.required !== false &&
            input.path === output.path &&
            input.id === output.id &&
            previous.output.id === output.id &&
            input.schemaVersion === previous.output.schemaVersion &&
            output.schemaVersion === previous.output.schemaVersion
        )
      if (previous && !orderedUpdate)
        diagnostics.push({
          code: "OUTPUT_PRODUCER_AMBIGUOUS",
          stageId: stage.id,
          artifactId: String(output.id)
        })
      producers.set(String(output.path), { stageId: stage.id, output })
    }
  }
  const transitions = stages.flatMap((stage, index) => [
    ...(stage.states.length === 2
      ? [{ from: stage.states[0], to: stage.states[1], stageId: stage.id, checks: stage.checkIds }]
      : []),
    ...(stages[index + 1]
      ? [
          {
            from: stage.states.at(-1)!,
            to: stages[index + 1].states[0],
            stageId: stages[index + 1].id,
            checks: []
          }
        ]
      : [])
  ])
  return {
    apiVersion: "devclaw.workflow-composition/v1" as const,
    routeKind: "selected-linear-order" as const,
    stateAuthority: "original-executor" as const,
    runtimeGraph: "resolve-from-native-executor" as const,
    digest: hash({ modules, extensionIds: [...extensionIds].sort() }),
    stages,
    transitions,
    diagnostics,
    execution: "unverified" as const
  }
}

export function assertWorkflowReplacementPreservesChecks(
  previous: BusinessModDefinition,
  next: BusinessModDefinition
) {
  if (
    previous.id !== next.id ||
    previous.checks.validators.some((id) => !next.checks.validators.includes(id)) ||
    previous.checks.guards.some((id) => !next.checks.guards.includes(id)) ||
    previous.host?.checks.some(
      (check) => !next.host?.checks.some((item) => hash(item) === hash(check))
    ) ||
    previous.host?.actions.some(
      (action) => !next.host?.actions.some((item) => hash(item) === hash(action))
    ) ||
    previous.host?.artifacts
      .filter((artifact) => artifact.required)
      .some((artifact) => !next.host?.artifacts.some((item) => hash(item) === hash(artifact))) ||
    previous.host?.environment.some(
      (item) => !next.host?.environment.some((value) => hash(value) === hash(item))
    ) ||
    previous.host?.stage.checkIds.some((id) => !next.host?.stage.checkIds.includes(id)) ||
    previous.host?.stage.actionIds.some((id) => !next.host?.stage.actionIds.includes(id)) ||
    previous.host?.stage.artifactIds.some((id) => !next.host?.stage.artifactIds.includes(id)) ||
    (previous.host?.stage.approval === "human" && next.host?.stage.approval !== "human") ||
    previous.skill.resources.some(
      (path) => !next.skill.resources.includes(path) && !next.resources.includes(path)
    ) ||
    previous.dependencies.required.some((id) => !next.dependencies.required.includes(id)) ||
    previous.resources.some((path) => !next.resources.includes(path)) ||
    Object.entries(businessModObject(previous.node.validatorBindings ?? {})).some(
      ([id, binding]) =>
        hash(businessModObject(next.node.validatorBindings ?? {})[id] ?? null) !== hash(binding)
    ) ||
    Object.entries(previous.userConfig ?? {}).some(
      ([key, value]) => hash(next.userConfig?.[key] ?? null) !== hash(value)
    ) ||
    Object.entries(previous.node).some(
      ([key, value]) =>
        ![
          "id",
          "skill",
          "order",
          "title",
          "description",
          "artifacts",
          "validators",
          "guards",
          "validatorBindings"
        ].includes(key) && hash(next.node[key] ?? null) !== hash(value)
    )
  )
    throw Error("BUSINESS_WORKFLOW_REQUIRED_CHECK_REMOVED")
  const previousOutputs = objects(businessModObject(previous.node.artifacts ?? {}).outputs)
  const nextOutputs = objects(businessModObject(next.node.artifacts ?? {}).outputs)
  if (
    previousOutputs
      .filter((output) => output.required !== false)
      .some((output) => !nextOutputs.some((item) => hash(item) === hash(output)))
  )
    throw Error("BUSINESS_WORKFLOW_REQUIRED_OUTPUT_REMOVED")
  const previousInputs = objects(businessModObject(previous.node.artifacts ?? {}).inputs)
  const nextInputs = objects(businessModObject(next.node.artifacts ?? {}).inputs)
  if (
    previousInputs
      .filter((item) => item.required !== false)
      .some((item) => !nextInputs.some((value) => hash(value) === hash(item)))
  )
    throw Error("BUSINESS_WORKFLOW_REQUIRED_INPUT_REMOVED")
}

/** Applies a complete bounded transaction in memory; callers persist only after normal parsing. */
export function transformBusinessWorkflow(input: {
  modules: BusinessModDefinition[]
  sourceDigest: string
  expectedWorkflowDigest: string
  changes: BusinessWorkflowChange[]
  extensionIds?: string[]
  /** Host-only authoring policy. Omitted callers protect every current stage by default. */
  protectedModules?: BusinessModDefinition[]
}) {
  if (!/^[a-f0-9]{64}$/.test(input.sourceDigest)) invalid()
  if (Buffer.byteLength(JSON.stringify(input)) > 512 * 1024) invalid()
  const before = inspectBusinessWorkflow(input.modules, input.extensionIds)
  if (before.digest !== input.expectedWorkflowDigest) throw Error("BUSINESS_WORKFLOW_CHANGED")
  if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > 16) invalid()
  const modules = structuredClone(input.modules),
    protectedModules = input.protectedModules ?? input.modules,
    replacements = new Set<string>(),
    changed = new Set<string>()
  if (
    !Array.isArray(protectedModules) ||
    protectedModules.length > 64 ||
    new Set(protectedModules.map((mod) => businessModId(mod.id).toLowerCase())).size !==
      protectedModules.length
  )
    invalid()
  const baseline = new Map(protectedModules.map((mod) => [mod.id, mod]))
  for (const change of input.changes) {
    if (change.kind === "insert") {
      const index = modules.findIndex((mod) => mod.id === change.before)
      if (
        index < 0 ||
        modules.some((mod) => mod.id.toLowerCase() === change.module.id.toLowerCase())
      )
        invalid()
      modules.splice(index, 0, structuredClone(change.module))
      changed.add(change.module.id)
    } else {
      const index = modules.findIndex((mod) => mod.id === change.id)
      if (index < 0 || changed.has(change.id)) invalid()
      const previous = modules[index]
      if (change.kind === "replace_step") {
        if (change.module.id !== previous.id) invalid()
        // Published/source stages retain their immutable baseline. Unpublished additions
        // remain editable instead of turning their first draft into permanent policy.
        const original = baseline.get(change.id)
        if (original) assertWorkflowReplacementPreservesChecks(original, change.module)
        modules[index] = structuredClone(change.module)
      } else if (change.kind === "replace_skill") {
        businessModId(change.skillName)
        businessModPath(change.skill.entry)
        modules[index] = {
          ...previous,
          skill: {
            ...structuredClone(change.skill),
            resources: [...new Set([...change.skill.resources, ...previous.skill.resources])]
          },
          node: { ...previous.node, skill: change.skillName }
        }
      } else invalid()
      replacements.add(change.id)
      changed.add(change.id)
    }
  }
  for (const mod of modules) {
    const original = baseline.get(mod.id)
    if (original) assertWorkflowReplacementPreservesChecks(original, mod)
  }
  const workflow = inspectBusinessWorkflow(modules, input.extensionIds)
  if (workflow.diagnostics.length) {
    throw new BusinessWorkflowLinkError(workflow.diagnostics)
  }
  return {
    modules,
    order: modules.map((mod) => mod.id),
    replacements: [...replacements],
    changedIds: [...changed],
    sourceDigest: input.sourceDigest,
    previousWorkflowDigest: before.digest,
    workflow,
    evidence: "invalidated" as const,
    execution: "unverified" as const
  }
}
