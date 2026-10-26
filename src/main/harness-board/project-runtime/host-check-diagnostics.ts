import type { HostCheckDiagnostic, HostProjectOperation } from "../../../shared/project-runtime/host-types"

/** Old diagnostics are useful only for the exact retained stage and admitted input identity. */
export function previousHostCheckOperation(current: HostProjectOperation, history: HostProjectOperation[]) {
  return history.find(item => item.operationId !== current.operationId && item.status === "failed" &&
    item.projectId === current.projectId && item.stageId === current.stageId &&
    item.expectedVersion === current.expectedVersion && item.pluginDigest === current.pluginDigest &&
    item.inputFingerprint === current.inputFingerprint)
}

const MAX_BYTES = 32 * 1024
const invalid = (): never => { throw Error("PROJECT_HOST_CHECK_DIAGNOSTICS_INVALID") }
const record = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))
    return invalid()
  return value as Record<string, unknown>
}
const text = (value: unknown, bytes: number, nonempty = false): string => {
  if (typeof value !== "string" || (nonempty && !value.trim()) ||
    Buffer.byteLength(value) > bytes ||
    // eslint-disable-next-line no-control-regex -- Allow readable newlines, never hidden controls.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) return invalid()
  return value
}
const digest = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return invalid()
  return value
}

/** Strict persisted schema. Optional on old records; diagnostic text grants no authority. */
export function parseHostCheckDiagnostics(value: unknown): HostCheckDiagnostic[] {
  if (!Array.isArray(value) || !value.length || value.length > 16 ||
    Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) return invalid()
  const messages = (value: unknown) => {
    if (!Array.isArray(value) || value.length > 8) return invalid()
    return value.map(item => {
      const raw = record(item, ["code", "message"])
      return { code: text(raw.code, 128), message: text(raw.message, 512) }
    })
  }
  return value.map(item => {
    const raw = record(item, ["checkId", "actionId", "runId", "executionId", "provider",
      "inputFingerprint", "resultDigest", "summary", "errors", "warnings", "truncated"])
    const provider = record(raw.provider, ["pluginId", "plugin", "digest", "actionId"])
    if (typeof raw.truncated !== "boolean") return invalid()
    return {
      checkId: text(raw.checkId, 256, true), actionId: text(raw.actionId, 256, true),
      runId: text(raw.runId, 256, true), executionId: text(raw.executionId, 256, true),
      provider: { pluginId: text(provider.pluginId, 256, true),
        plugin: text(provider.plugin, 256, true), digest: digest(provider.digest),
        actionId: text(provider.actionId, 256, true) },
      inputFingerprint: digest(raw.inputFingerprint), resultDigest: digest(raw.resultDigest),
      summary: text(raw.summary, 1024), errors: messages(raw.errors), warnings: messages(raw.warnings),
      truncated: raw.truncated
    }
  })
}

/** Select only human-readable diagnostic fields; never copy stdout, inputs or arbitrary output. */
export function boundHostCheckDiagnostic(
  identity: Omit<HostCheckDiagnostic, "summary" | "errors" | "warnings" | "truncated">,
  summary: string,
  output?: Record<string, unknown>
): HostCheckDiagnostic {
  let truncated = false
  const bounded = (value: unknown, max: number) => {
    if (typeof value !== "string") return ""
    // eslint-disable-next-line no-control-regex -- Strip hidden controls in untrusted diagnostics.
    const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    let result = ""
    let bytes = 0
    for (const char of clean) {
      const next = Buffer.byteLength(char)
      if (bytes + next > max) { truncated = true; break }
      result += char
      bytes += next
    }
    if (clean !== value) truncated = true
    return result
  }
  const messages = (value: unknown) => {
    if (!Array.isArray(value)) return []
    if (value.length > 8) truncated = true
    return value.slice(0, 8).map(item => {
      if (typeof item === "string") return { code: "", message: bounded(item, 512) }
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        truncated = true
        return { code: "", message: "" }
      }
      const raw = item as Record<string, unknown>
      return { code: bounded(raw.code, 128), message: bounded(raw.message ?? raw.detail, 512) }
    })
  }
  const result = { ...identity, summary: bounded(summary, 1024),
    errors: messages(output?.errors), warnings: messages(output?.warnings), truncated }
  return parseHostCheckDiagnostics([result])[0]
}

export function boundHostCheckDiagnostics(items: HostCheckDiagnostic[]): HostCheckDiagnostic[] {
  const result: HostCheckDiagnostic[] = []
  for (const item of items) {
    if (result.length === 16 || Buffer.byteLength(JSON.stringify([...result, item])) > MAX_BYTES) {
      if (result.length) result[result.length - 1].truncated = true
      break
    }
    result.push(item)
  }
  return result.length ? parseHostCheckDiagnostics(result) : []
}
