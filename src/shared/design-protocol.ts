export type DesignFramework = "html" | "react" | "vue"
export type DesignArtifactKind = "single-file" | "project"
export type DesignPreviewType = "html" | "jsx-sandbox" | "vue-sfc" | "vite-dev" | "export-only"
export type DesignTweakValue = string | number | boolean
export type DesignTweakSchemaType = "color" | "number" | "text" | "select" | "boolean"

export interface DesignTweakSchemaEntry {
  type: DesignTweakSchemaType
  label: string
  description?: string
  min?: number
  max?: number
  step?: number
  maxLength?: number
  options?: string[]
}

export interface DesignTweaksMetadata {
  defaults: Record<string, DesignTweakValue>
  current: Record<string, DesignTweakValue>
  schema: Record<string, DesignTweakSchemaEntry>
}

export const DEFAULT_DESIGN_FRAMEWORK: DesignFramework = "html"
export const DEFAULT_DESIGN_ARTIFACT_KIND: DesignArtifactKind = "single-file"

export function deriveDesignPreviewType(
  framework: DesignFramework,
  artifactKind: DesignArtifactKind
): DesignPreviewType {
  if (framework === "html" && artifactKind === "single-file") return "html"
  if (framework === "react" && artifactKind === "single-file") return "jsx-sandbox"
  if (framework === "vue" && artifactKind === "single-file") return "vue-sfc"
  if (artifactKind === "project") return "export-only"
  return "html"
}

export function normalizeDesignFramework(value: unknown): DesignFramework {
  return value === "react" || value === "vue" || value === "html" ? value : DEFAULT_DESIGN_FRAMEWORK
}

export function normalizeDesignArtifactKind(value: unknown): DesignArtifactKind {
  return value === "project" || value === "single-file" ? value : DEFAULT_DESIGN_ARTIFACT_KIND
}

export function normalizeDesignPreviewType(
  value: unknown,
  framework: DesignFramework,
  artifactKind: DesignArtifactKind
): DesignPreviewType {
  const derived = deriveDesignPreviewType(framework, artifactKind)
  const allowed: DesignPreviewType[] = ["html", "jsx-sandbox", "vue-sfc", "vite-dev", "export-only"]
  return typeof value === "string" && allowed.includes(value as DesignPreviewType) ? (value as DesignPreviewType) : derived
}

export function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
  return items.length > 0 ? items : undefined
}

export function isDesignTweakValue(value: unknown): value is DesignTweakValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
}

export function normalizeDesignTweaksMetadata(value: unknown): DesignTweaksMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const rawDefaults = raw.defaults
  const rawCurrent = raw.current
  const rawSchema = raw.schema
  if (!rawDefaults || typeof rawDefaults !== "object" || Array.isArray(rawDefaults)) return undefined

  const defaults: Record<string, DesignTweakValue> = {}
  for (const [key, nextValue] of Object.entries(rawDefaults as Record<string, unknown>)) {
    if (isDesignTweakValue(nextValue)) defaults[key] = nextValue
  }
  if (Object.keys(defaults).length === 0) return undefined

  const current: Record<string, DesignTweakValue> = { ...defaults }
  if (rawCurrent && typeof rawCurrent === "object" && !Array.isArray(rawCurrent)) {
    for (const [key, nextValue] of Object.entries(rawCurrent as Record<string, unknown>)) {
      if (isDesignTweakValue(nextValue)) current[key] = nextValue
    }
  }

  const schema: Record<string, DesignTweakSchemaEntry> = {}
  if (rawSchema && typeof rawSchema === "object" && !Array.isArray(rawSchema)) {
    for (const [key, item] of Object.entries(rawSchema as Record<string, unknown>)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue
      const entry = item as Record<string, unknown>
      const type = entry.type
      if (type !== "color" && type !== "number" && type !== "text" && type !== "select" && type !== "boolean") continue
      schema[key] = {
        type,
        label: typeof entry.label === "string" ? entry.label : key,
        description: typeof entry.description === "string" ? entry.description : undefined,
        min: typeof entry.min === "number" ? entry.min : undefined,
        max: typeof entry.max === "number" ? entry.max : undefined,
        step: typeof entry.step === "number" ? entry.step : undefined,
        maxLength: typeof entry.maxLength === "number" ? entry.maxLength : undefined,
        options: normalizeStringArray(entry.options),
      }
    }
  }

  return { defaults, current, schema }
}

export function extractDesignTweaksMetadataFromHtml(html: string): DesignTweaksMetadata | undefined {
  const v2 = html.match(/\/\*DESIGN_TWEAKS-BEGIN\*\/([\s\S]*?)\/\*DESIGN_TWEAKS-END\*\//)
  if (v2) {
    try {
      return normalizeDesignTweaksMetadata(JSON.parse(v2[1].trim()))
    } catch {
      return undefined
    }
  }

  const v1 = html.match(/\/\*EDITMODE-BEGIN\*\/([\s\S]*?)\/\*EDITMODE-END\*\//)
  if (!v1) return undefined
  try {
    const defaultsRaw = JSON.parse(v1[1].trim()) as unknown
    if (!defaultsRaw || typeof defaultsRaw !== "object" || Array.isArray(defaultsRaw)) return undefined
    return normalizeDesignTweaksMetadata({
      defaults: defaultsRaw,
      current: defaultsRaw,
      schema: {},
    })
  } catch {
    return undefined
  }
}
