export const PROJECT_CAPABILITY_MAX_BYTES = 64 * 1024

export interface ProjectCapabilityManifest {
  apiVersion: "devclaw.project/v1"
  name: string
  description: string
  help: Array<{ title: string; body: string }>
  stages: Array<{ nodeId: string; guidance: string; before: string[]; after: string[] }>
}

export type ProjectCapabilityView =
  | { status: "ready"; manifest: ProjectCapabilityManifest }
  | { status: "invalid"; message: string }

function invalid(): never {
  throw new Error("项目能力声明格式无效或超过限制")
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid()
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return invalid()
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !keys.includes(key))
  )
    return invalid()
  return record
}

function text(value: unknown, max: number, multiline = false): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) return invalid()
  // Plain text may have paragraphs and tabs; other controls and bidi overrides are rejected.
  const forbidden = multiline
    ? // eslint-disable-next-line no-control-regex -- Reject hidden controls in untrusted guidance.
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u
    : // eslint-disable-next-line no-control-regex -- Single-line identities cannot contain controls.
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u
  if (forbidden.test(value)) return invalid()
  return value.trim()
}

function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid()
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return invalid()
  }
  return value
}

/** Static guidance only. Unknown keys are rejected, including commands and execution results. */
export function parseProjectCapabilityManifest(value: unknown): ProjectCapabilityManifest {
  const raw = object(value, ["apiVersion", "name", "description", "help", "stages"])
  if (raw.apiVersion !== "devclaw.project/v1") return invalid()
  const seen = new Set<string>()
  const manifest: ProjectCapabilityManifest = {
    apiVersion: "devclaw.project/v1",
    name: text(raw.name, 128),
    description: text(raw.description, 2048, true),
    help: list(raw.help, 16).map((item) => {
      const help = object(item, ["title", "body"])
      return { title: text(help.title, 128), body: text(help.body, 8192, true) }
    }),
    stages: list(raw.stages, 64).map((item) => {
      const stage = object(item, ["nodeId", "guidance", "before", "after"])
      const nodeId = text(stage.nodeId, 128)
      if (seen.has(nodeId) || /\s/u.test(nodeId)) return invalid()
      seen.add(nodeId)
      return {
        nodeId,
        guidance: text(stage.guidance, 4096, true),
        before: list(stage.before, 16).map((rule) => text(rule, 2048, true)),
        after: list(stage.after, 16).map((rule) => text(rule, 2048, true))
      }
    })
  }
  if (
    new TextEncoder().encode(JSON.stringify(manifest)).byteLength > PROJECT_CAPABILITY_MAX_BYTES
  ) {
    return invalid()
  }
  return manifest
}
