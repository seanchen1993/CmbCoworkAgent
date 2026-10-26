import { parseClawActionIdentity } from "../mods/claw-actions"
import {
  PROJECT_RUNTIME_V2_API_VERSION,
  projectRuntimeExtensionContract,
  type ExtensionContract
} from "./extension-contract"
import {
  PROJECT_RUNTIME_API_VERSION,
  PROJECT_RUNTIME_MAX_BYTES,
  type ProjectRuntimeManifest
} from "./types"

function invalid(): never {
  throw new Error("PROJECT_RUNTIME_MANIFEST_INVALID")
}

function assertJson(value: unknown, depth = 0): void {
  if (depth > 24) return invalid()
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number" && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) return invalid()
      assertJson(value[i], depth + 1)
    }
    return
  }
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return invalid()
    for (const key of Object.keys(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) return invalid()
      assertJson((value as Record<string, unknown>)[key], depth + 1)
    }
    return
  }
  return invalid()
}

function record(value: unknown, required: string[], optional: string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid()
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return invalid()
  const raw = value as Record<string, unknown>
  if (
    required.some((key) => !Object.hasOwn(raw, key)) ||
    Object.keys(raw).some((key) => !required.includes(key) && !optional.includes(key))
  )
    return invalid()
  return raw
}

function text(value: unknown, max = 256): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    // eslint-disable-next-line no-control-regex -- Reject hidden controls in declarations.
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  )
    return invalid()
  return value.trim()
}

function id(value: unknown): string {
  const result = text(value, 100)
  if (!/^[a-zA-Z0-9][\w.-]*$/.test(result)) return invalid()
  return result
}

function list(value: unknown, max = 64): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid()
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) return invalid()
  return value
}

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") return invalid()
  return value
}

function relativePath(value: unknown): string {
  const result = text(value, 512)
  if (
    result.includes("\\") ||
    result.includes(":") ||
    result.startsWith("/") ||
    result
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[<>"|?*]|[. ]$/u.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)
      )
  )
    return invalid()
  return result
}

function unique<T extends { id: string }>(items: T[]): T[] {
  if (new Set(items.map((item) => item.id)).size !== items.length) return invalid()
  return items
}

function refs(value: unknown): string[] {
  const result = list(value).map(id)
  if (new Set(result).size !== result.length) return invalid()
  return result
}

/** Separate from project/v1: unknown executable fields and dangling references fail closed. */
export function parseProjectRuntimeManifestV1(value: unknown): ProjectRuntimeManifest {
  try {
    assertJson(value)
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PROJECT_RUNTIME_MAX_BYTES)
      return invalid()
    const raw = record(value, [
      "apiVersion",
      "plugin",
      "mode",
      "stateOwner",
      "stages",
      "actions",
      "artifacts",
      "checks",
      "environment",
      "capabilities"
    ])
    if (
      raw.apiVersion !== PROJECT_RUNTIME_API_VERSION ||
      (raw.mode !== "host" && raw.mode !== "legacy") ||
      raw.stateOwner !== (raw.mode === "host" ? "host" : "plugin")
    )
      return invalid()
    const plugin = record(raw.plugin, ["id", "version"])
    const capabilityKeys = [
      "execution",
      "conditionalTransition",
      "idempotency",
      "reconciliation",
      "cancellation"
    ]
    const capabilities = record(raw.capabilities, capabilityKeys)
    const manifest: ProjectRuntimeManifest = {
      apiVersion: PROJECT_RUNTIME_API_VERSION,
      plugin: { id: text(plugin.id), version: text(plugin.version, 100) },
      mode: raw.mode,
      stateOwner: raw.stateOwner as "host" | "plugin",
      stages: unique(
        list(raw.stages).map((value) => {
          const stage = record(
            value,
            ["id", "title", "actionIds", "artifactIds", "checkIds", "approval"],
            ["skill", "resultApproval", "executionMode"]
          )
          if (stage.approval !== "none" && stage.approval !== "human") return invalid()
          if (
            stage.resultApproval !== undefined &&
            stage.resultApproval !== "none" && stage.resultApproval !== "human"
          ) return invalid()
          if (raw.mode !== "host" && stage.resultApproval !== undefined) return invalid()
          if (stage.executionMode !== undefined) {
            if (raw.mode !== "host" ||
                !["normal", "workflow"].includes(String(stage.executionMode)) ||
                typeof stage.executionMode !== "string" ||
                (stage.executionMode === "workflow" && stage.skill === undefined)) return invalid()
          }
          return {
            id: id(stage.id),
            title: text(stage.title),
            actionIds: refs(stage.actionIds),
            artifactIds: refs(stage.artifactIds),
            checkIds: refs(stage.checkIds),
            approval: stage.approval,
            ...(stage.executionMode === undefined ? {} : {
              executionMode: stage.executionMode as "normal" | "workflow"
            }),
            ...(stage.resultApproval === undefined ? {} : {
              resultApproval: stage.resultApproval as "none" | "human"
            }),
            ...(stage.skill === undefined ? {} : { skill: relativePath(stage.skill) })
          }
        })
      ),
      actions: unique(
        list(raw.actions, 32).map((value) => {
          const action = record(value, ["id", "ref"])
          record(action.ref, ["pluginId", "plugin", "digest", "actionId"])
          return { id: id(action.id), ref: parseClawActionIdentity(action.ref) }
        })
      ),
      artifacts: unique(
        list(raw.artifacts).map((value) => {
          const artifact = record(value, ["id", "path", "required"])
          return {
            id: id(artifact.id),
            path: relativePath(artifact.path),
            required: bool(artifact.required)
          }
        })
      ),
      checks: unique(
        list(raw.checks).map((value) => {
          const check = record(
            value,
            ["id", "kind", "artifactId", "sideEffect"],
            ["schema", "actionId"]
          )
          if (
            !["file-exists", "json-schema", "action"].includes(String(check.kind)) ||
            !["read", "report", "external"].includes(String(check.sideEffect))
          )
            return invalid()
          if (check.kind === "json-schema") {
            if (!check.schema || check.actionId !== undefined) return invalid()
            record(check.schema, [], Object.keys(check.schema as object))
          } else if (check.schema !== undefined) return invalid()
          if (check.kind === "action" ? check.actionId === undefined : check.actionId !== undefined)
            return invalid()
          if (check.kind !== "action" && check.sideEffect !== "read") return invalid()
          return {
            id: id(check.id),
            kind: check.kind as "file-exists" | "json-schema" | "action",
            artifactId: id(check.artifactId),
            sideEffect: check.sideEffect as "read" | "report" | "external",
            ...(check.schema === undefined
              ? {}
              : { schema: structuredClone(check.schema as Record<string, unknown>) }),
            ...(check.actionId === undefined ? {} : { actionId: id(check.actionId) })
          }
        })
      ),
      environment: unique(
        list(raw.environment, 16).map((value) => {
          const env = record(value, ["id", "description", "required"])
          return {
            id: id(env.id),
            description: text(env.description, 2048),
            required: bool(env.required)
          }
        })
      ),
      capabilities: {
        execution: bool(capabilities.execution),
        conditionalTransition: bool(capabilities.conditionalTransition),
        idempotency: bool(capabilities.idempotency),
        reconciliation: bool(capabilities.reconciliation),
        cancellation: bool(capabilities.cancellation)
      }
    }
    if (manifest.mode === "host" && !manifest.stages.length) return invalid()
    const has = (items: { id: string }[], ref: string) => items.some((item) => item.id === ref)
    for (const stage of manifest.stages) {
      if (
        stage.actionIds.some((ref) => !has(manifest.actions, ref)) ||
        stage.artifactIds.some((ref) => !has(manifest.artifacts, ref)) ||
        stage.checkIds.some((ref) => !has(manifest.checks, ref))
      )
        return invalid()
      if (
        stage.checkIds.some(
          (ref) =>
            !stage.artifactIds.includes(
              manifest.checks.find((check) => check.id === ref)!.artifactId
            )
        )
      )
        return invalid()
    }
    for (const check of manifest.checks) {
      if (
        !has(manifest.artifacts, check.artifactId) ||
        (check.actionId !== undefined && !has(manifest.actions, check.actionId))
      )
        return invalid()
    }
    return manifest
  } catch {
    return invalid()
  }
}

/** V2 negotiates host guarantees, then reuses the unchanged v1 execution model. */
export function parseProjectRuntimeManifest(value: unknown): ProjectRuntimeManifest {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).apiVersion === PROJECT_RUNTIME_V2_API_VERSION
  ) {
    assertJson(value)
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PROJECT_RUNTIME_MAX_BYTES)
      return invalid()
    projectRuntimeExtensionContract(value)
    return parseProjectRuntimeManifestV1((value as Record<string, unknown>).runtime)
  }
  return parseProjectRuntimeManifestV1(value)
}

export function wrapProjectRuntimeManifest(
  runtime: ProjectRuntimeManifest,
  extensionContract: ExtensionContract
): {
  apiVersion: typeof PROJECT_RUNTIME_V2_API_VERSION
  runtime: ProjectRuntimeManifest
  extensionContract: ExtensionContract
} {
  const envelope = {
    apiVersion: PROJECT_RUNTIME_V2_API_VERSION,
    runtime: parseProjectRuntimeManifestV1(runtime),
    extensionContract
  }
  parseProjectRuntimeManifest(envelope)
  return structuredClone(envelope)
}

/** Authoring transforms must retain negotiated guarantees when rewriting a v2 source. */
export function preserveProjectRuntimeEnvelope(
  original: unknown,
  runtime: ProjectRuntimeManifest
): unknown {
  const contract = projectRuntimeExtensionContract(original)
  return contract
    ? wrapProjectRuntimeManifest(runtime, contract)
    : parseProjectRuntimeManifestV1(runtime)
}
