export interface ProjectCompositionSource {
  pluginId: string
  capabilityId: string
  packageDigest: string
}
export interface ProjectCompositionUnit {
  id: string
  kind: "capability" | "flow"
  source: ProjectCompositionSource
  inputs: Array<{ inputId: string; fromUnitId: string; artifactId: string }>
  outputs: Array<{ id: string; path: string }>
  workflow?: { templateId: string; nodeIds: string[]; includeOptionalDependencies?: boolean }
}
export interface ProjectCompositionDefinition {
  apiVersion: "devclaw.project-composition/v1"
  parentProjectId: string
  workspace: string
  goal?: string
  units: ProjectCompositionUnit[]
}
export interface CompositionArtifact {
  id: string
  path: string
  digest: string
}
export interface CompositionCompletionProof {
  kind: "flow-completed" | "capability-completed"
  engineRunId: string
  evidenceDigest: string
  artifacts: CompositionArtifact[]
}

export function compositionText(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    // eslint-disable-next-line no-control-regex -- Reject untrusted identifier controls.
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw Error("COMPOSITION_TEXT_INVALID")
  return value
}
export function compositionDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw Error("COMPOSITION_DIGEST_INVALID")
  return value
}
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][\w.-]{0,79}$/.test(value) ||
    ["constructor", "prototype", "__proto__"].includes(value)
  )
    throw Error("COMPOSITION_ID_INVALID")
  return value
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw Error("COMPOSITION_OBJECT_INVALID")
  return value as Record<string, unknown>
}
function list(value: unknown, max = 32): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw Error("COMPOSITION_LIST_INVALID")
  return value
}
export function compositionRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    // eslint-disable-next-line no-control-regex -- Portable artifact paths cannot contain controls.
    /[\\:%<>"|?*\u0000-\u001f\u007f-\u009f]/.test(value) ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.trim() !== part ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
      )
  )
    throw Error("COMPOSITION_PATH_INVALID")
  return value
}
function unique(values: string[]): void {
  if (new Set(values).size !== values.length) throw Error("COMPOSITION_DUPLICATE_ID")
}

/** Ordered references can only point backwards, making cycles and implicit handoffs impossible. */
export function parseProjectComposition(value: unknown): ProjectCompositionDefinition {
  const raw = object(value, ["apiVersion", "parentProjectId", "workspace", "units", "goal"])
  if (raw.apiVersion !== "devclaw.project-composition/v1")
    throw Error("COMPOSITION_VERSION_INVALID")
  const workspace = compositionText(raw.workspace)
  if (!/^(?:\/|[a-zA-Z]:[\\/])/.test(workspace)) throw Error("COMPOSITION_WORKSPACE_INVALID")
  const units = list(raw.units, 16).map((value): ProjectCompositionUnit => {
    const item = object(value, ["id", "kind", "source", "inputs", "outputs", "workflow"])
    if (item.kind !== "capability" && item.kind !== "flow") throw Error("COMPOSITION_KIND_INVALID")
    const source = object(item.source, ["pluginId", "capabilityId", "packageDigest"])
    const inputs = list(item.inputs).map((value) => {
      const input = object(value, ["inputId", "fromUnitId", "artifactId"])
      return {
        inputId: id(input.inputId),
        fromUnitId: id(input.fromUnitId),
        artifactId: id(input.artifactId)
      }
    })
    const outputs = list(item.outputs).map((value) => {
      const output = object(value, ["id", "path"])
      return { id: id(output.id), path: compositionRelativePath(output.path) }
    })
    unique(inputs.map((input) => input.inputId))
    unique(outputs.map((output) => output.id))
    unique(outputs.map((output) => output.path.toLowerCase()))
    let workflow: ProjectCompositionUnit["workflow"]
    if (item.workflow !== undefined) {
      if (item.kind !== "flow") throw Error("COMPOSITION_WORKFLOW_INVALID")
      const selection = object(item.workflow, ["templateId", "nodeIds", "includeOptionalDependencies"])
      if (selection.includeOptionalDependencies !== undefined && typeof selection.includeOptionalDependencies !== "boolean")
        throw Error("COMPOSITION_WORKFLOW_INVALID")
      const nodeIds = list(selection.nodeIds, 128).map(id)
      if (!nodeIds.length) throw Error("COMPOSITION_WORKFLOW_INVALID")
      unique(nodeIds)
      workflow = { templateId: id(selection.templateId), nodeIds,
        ...(selection.includeOptionalDependencies !== undefined
          ? { includeOptionalDependencies: selection.includeOptionalDependencies as boolean } : {}) }
    }
    return {
      id: id(item.id),
      kind: item.kind,
      source: {
        pluginId: compositionText(source.pluginId),
        capabilityId: id(source.capabilityId),
        packageDigest: compositionDigest(source.packageDigest)
      },
      inputs,
      outputs,
      ...(workflow ? { workflow } : {})
    }
  })
  if (!units.length) throw Error("COMPOSITION_EMPTY")
  unique(units.map((unit) => unit.id))
  const previous = new Map<string, ProjectCompositionUnit>()
  for (const unit of units) {
    for (const input of unit.inputs)
      if (!previous.get(input.fromUnitId)?.outputs.some((output) => output.id === input.artifactId))
        throw Error("COMPOSITION_HANDOFF_INVALID")
    previous.set(unit.id, unit)
  }
  if (raw.goal !== undefined && (typeof raw.goal !== "string" || !raw.goal.trim() || raw.goal.length > 16000 ||
    // eslint-disable-next-line no-control-regex -- Text supports newlines but rejects hidden controls.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw.goal))) throw Error("COMPOSITION_GOAL_INVALID")
  const result = {
    ...(typeof raw.goal === "string" ? { goal: raw.goal } : {}),
    apiVersion: "devclaw.project-composition/v1" as const,
    parentProjectId: compositionText(raw.parentProjectId),
    workspace,
    units
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > 65536)
    throw Error("COMPOSITION_SIZE_LIMIT")
  return result
}

/** A structurally valid proof still needs host verification against the original engine. */
export function parseCompositionCompletion(
  value: unknown,
  unit: ProjectCompositionUnit
): CompositionCompletionProof {
  const raw = object(value, ["kind", "engineRunId", "evidenceDigest", "artifacts"])
  const kind = unit.kind === "flow" ? "flow-completed" : "capability-completed"
  if (raw.kind !== kind) throw Error("COMPOSITION_COMPLETE_PROOF_REQUIRED")
  const artifacts = list(raw.artifacts).map((value) => {
    const artifact = object(value, ["id", "path", "digest"])
    return {
      id: id(artifact.id),
      path: compositionRelativePath(artifact.path),
      digest: compositionDigest(artifact.digest)
    }
  })
  unique(artifacts.map((artifact) => artifact.id))
  if (
    artifacts.length !== unit.outputs.length ||
    artifacts.some(
      (artifact) =>
        !unit.outputs.some((output) => output.id === artifact.id && output.path === artifact.path)
    )
  )
    throw Error("COMPOSITION_ARTIFACT_PROOF_REQUIRED")
  return {
    kind,
    engineRunId: compositionText(raw.engineRunId),
    evidenceDigest: compositionDigest(raw.evidenceDigest),
    artifacts
  }
}
