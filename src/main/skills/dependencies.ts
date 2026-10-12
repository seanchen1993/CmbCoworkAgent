import { z } from "zod"
import { SKILL_IMPORT_MARKDOWN_BYTES } from "../../shared/skill-import"
import {
  CMBDEVCLAW_SKILL_DEPENDENCY_SCHEMA_VERSION,
  SKILL_DEPENDENCY_MAX_CHECKS,
  skillDependencyCheck,
  skillDependencyDeclaration,
  type SkillDependencyCheck,
  type SkillDependencyDeclaration
} from "../../shared/skill-dependencies"
import { getFrontmatterString, parseSkillFrontmatterChecked } from "./frontmatter"

const nativeKey = "cmbdevclaw-dependencies"
const nativeDeclaration = z
  .object({
    schemaVersion: z.literal(CMBDEVCLAW_SKILL_DEPENDENCY_SCHEMA_VERSION),
    checks: z.array(skillDependencyCheck).max(SKILL_DEPENDENCY_MAX_CHECKS)
  })
  .strict()

function record(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

type MetadataResult =
  | { state: "absent" }
  | { state: "unstructured" | "invalid" }
  | { state: "structured"; manifest: unknown }

/** Cmb already parses nested YAML. Only an explicit JSON object is accepted when
 * metadata is a scalar; arbitrary compatibility prose is never interpreted. */
function openclawMetadata(frontmatter: Record<string, unknown>): MetadataResult {
  if (!Object.hasOwn(frontmatter, "metadata")) return { state: "absent" }
  let metadata: unknown = frontmatter.metadata
  if (typeof metadata === "string") {
    const text = metadata.trim()
    if (!text.startsWith("{") && !text.startsWith("[")) return { state: "unstructured" }
    try {
      metadata = JSON.parse(text)
    } catch {
      return { state: "invalid" }
    }
  }
  if (!record(metadata)) return { state: "invalid" }
  // A malformed current manifest must never fall back to an easier legacy one.
  const key = Object.hasOwn(metadata, "openclaw")
    ? "openclaw"
    : Object.hasOwn(metadata, "clawdbot")
      ? "clawdbot"
      : null
  return key ? { state: "structured", manifest: metadata[key] } : { state: "absent" }
}

function result(
  source: SkillDependencyDeclaration["source"],
  state: Exclude<SkillDependencyDeclaration["state"], "structured">,
  reason: string
): SkillDependencyDeclaration {
  return { source, state, checks: [], reason }
}

/** Preserve OpenClaw's documented CSV/trim syntax, but never discard invalid
 * members as its permissive normalizer does. Absence differs from an empty list. */
function stringList(value: unknown, maximum: number): string[] | null {
  const values = typeof value === "string" ? value.split(",") : value
  if (!Array.isArray(values) || values.length > maximum) return null
  const normalized: string[] = []
  for (const item of values) {
    if (typeof item !== "string" || !item.trim() || item.length > 512) return null
    normalized.push(item.trim())
  }
  return new Set(normalized).size === normalized.length ? normalized : null
}

function unsupported(id: string, label: string, reason: string): SkillDependencyCheck {
  return {
    id,
    kind: "unsupported",
    // Keep only a bounded declaration key, never the field value or parser error.
    // eslint-disable-next-line no-control-regex
    label: label.replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 120),
    reason
  }
}

function mapOpenclaw(manifest: unknown): SkillDependencyCheck[] | null {
  if (!record(manifest)) return null
  const checks: SkillDependencyCheck[] = []
  if (Object.hasOwn(manifest, "os")) {
    const platforms = stringList(manifest.os, 3)
    if (!platforms) return null
    if (platforms.length) {
      const check = skillDependencyCheck.safeParse({
        id: "openclaw:os",
        kind: "platform",
        platforms
      })
      if (!check.success) return null
      checks.push(check.data)
    }
  }
  if (!Object.hasOwn(manifest, "requires")) return checks
  if (!record(manifest.requires)) return null
  const requires = manifest.requires
  if (Object.keys(requires).length > SKILL_DEPENDENCY_MAX_CHECKS) return null
  for (const field of ["bins", "anyBins", "env", "config"] as const) {
    if (!Object.hasOwn(requires, field)) continue
    const values = stringList(
      requires[field],
      field === "anyBins" ? 16 : SKILL_DEPENDENCY_MAX_CHECKS
    )
    if (!values) return null
    if (field === "config") {
      if (values.length)
        checks.push(
          unsupported(
            "openclaw:config",
            "requires.config",
            "OpenClaw 配置路径没有对应的 CMBDevClaw 核验规则"
          )
        )
    } else if (field === "anyBins") {
      if (values.length) {
        const check = skillDependencyCheck.safeParse({
          id: "openclaw:anyBins",
          kind: "any-executable",
          names: values
        })
        if (!check.success) return null
        checks.push(check.data)
      }
    } else {
      for (const [index, value] of values.entries()) {
        const check = skillDependencyCheck.safeParse(
          field === "bins"
            ? { id: `openclaw:bins:${index}`, kind: "executable", name: value }
            : { id: `openclaw:env:${index}`, kind: "environment", name: value }
        )
        if (!check.success) return null
        checks.push(check.data)
      }
    }
    if (checks.length > SKILL_DEPENDENCY_MAX_CHECKS) return null
  }
  const known = new Set(["bins", "anyBins", "env", "config"])
  for (const [index, field] of Object.keys(requires).entries()) {
    if (known.has(field)) continue
    checks.push(
      unsupported(
        `openclaw:unsupported:${index}`,
        `requires.${field}`,
        "该依赖类型尚无受支持的核验规则"
      )
    )
    if (checks.length > SKILL_DEPENDENCY_MAX_CHECKS) return null
  }
  return checks
}

/** Pure declaration parsing only. Running probes, reading environment values or
 * granting tools belongs to the existing authorized Bot task execution path. */
export function parseSkillDependencies(content: string): SkillDependencyDeclaration {
  if (
    content.length > SKILL_IMPORT_MARKDOWN_BYTES ||
    new TextEncoder().encode(content).byteLength > SKILL_IMPORT_MARKDOWN_BYTES
  ) {
    return result("none", "invalid", "技能内容超过现有 Markdown 读取限制")
  }
  const parsed = parseSkillFrontmatterChecked(content)
  if (parsed.status === "invalid")
    return result("none", "invalid", "技能 frontmatter 格式无效，依赖未核验")
  const { frontmatter } = parsed
  const hasNative = Object.hasOwn(frontmatter, nativeKey)
  const metadata = openclawMetadata(frontmatter)
  const hasOpenclaw = metadata.state === "structured"
  const source: SkillDependencyDeclaration["source"] =
    hasNative && hasOpenclaw
      ? "mixed"
      : hasNative
        ? "cmbdevclaw"
        : hasOpenclaw
          ? "openclaw"
          : "none"
  if (metadata.state === "invalid")
    return result(source, "invalid", "技能 metadata 格式无效，依赖未核验")
  if (metadata.state === "unstructured")
    return result(source, "unstructured", "技能 metadata 未提供受支持的结构化依赖声明")
  const checks: SkillDependencyCheck[] = []
  if (hasNative) {
    const native = nativeDeclaration.safeParse(frontmatter[nativeKey])
    if (!native.success) return result(source, "invalid", "CMBDevClaw 依赖声明无效或超过支持范围")
    checks.push(...native.data.checks)
  }
  if (metadata.state === "structured") {
    const imported = mapOpenclaw(metadata.manifest)
    if (!imported) return result(source, "invalid", "OpenClaw 依赖声明无效或超过支持范围")
    checks.push(...imported)
  }
  const compatibility = getFrontmatterString(frontmatter, "compatibility")
  if (!checks.length)
    return result(
      source,
      compatibility || hasNative || hasOpenclaw ? "unstructured" : "absent",
      compatibility
        ? "兼容性说明为自由文本，依赖未核验"
        : hasNative || hasOpenclaw
          ? "依赖声明未包含可核验的要求"
          : "技能未声明可核验的依赖要求"
    )
  // A free-text requirement remains unverified even beside explicit checks.
  if (compatibility)
    checks.push(unsupported("compatibility", "compatibility", "兼容性说明为自由文本，无法自动核验"))
  const declaration = skillDependencyDeclaration.safeParse({
    source,
    state: "structured",
    checks
  })
  return declaration.success
    ? declaration.data
    : result(source, "invalid", "依赖声明超限或检查 ID 重复，依赖未核验")
}
