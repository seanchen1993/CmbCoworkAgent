import { ensureVersionedSkillIdentifier } from "./skill-identifiers"

export interface PluginSkillSourceRef {
  source: "plugin"
  pluginId: string
  pluginName?: string
  skill: string
}

export function makePluginSkillSourceRef(
  pluginId: string,
  skill: string,
  pluginName?: string | null
): string {
  const normalizedPluginId = pluginId.trim()
  const normalizedSkill = ensureVersionedSkillIdentifier(skill)
  if (!normalizedPluginId || !normalizedSkill) return ""
  const base = `plugin:${encodeURIComponent(normalizedPluginId)}/${encodeURIComponent(normalizedSkill)}`
  const normalizedPluginName = pluginName?.trim()
  return normalizedPluginName ? `${base}?name=${encodeURIComponent(normalizedPluginName)}` : base
}

export function parsePluginSkillSourceRef(ref: string): PluginSkillSourceRef | null {
  const prefix = "plugin:"
  if (!ref.startsWith(prefix)) return null
  const rest = ref.slice(prefix.length)
  const separatorIndex = rest.indexOf("/")
  if (separatorIndex <= 0 || separatorIndex >= rest.length - 1) return null

  try {
    const pluginId = decodeURIComponent(rest.slice(0, separatorIndex)).trim()
    const rawSkillAndQuery = rest.slice(separatorIndex + 1)
    const queryIndex = rawSkillAndQuery.indexOf("?")
    const rawSkill = queryIndex >= 0 ? rawSkillAndQuery.slice(0, queryIndex) : rawSkillAndQuery
    const rawQuery = queryIndex >= 0 ? rawSkillAndQuery.slice(queryIndex + 1) : ""
    const skill = ensureVersionedSkillIdentifier(decodeURIComponent(rawSkill))
    if (!pluginId || !skill) return null
    const query = new URLSearchParams(rawQuery)
    const pluginName = query.get("name")?.trim() || undefined
    return { source: "plugin", pluginId, ...(pluginName ? { pluginName } : {}), skill }
  } catch {
    return null
  }
}

export function normalizeSkillSourceRefs(
  refs: unknown,
  usedSkills?: readonly string[]
): string[] {
  if (!Array.isArray(refs)) return []
  const usedSkillSet = usedSkills ? new Set(usedSkills) : null
  const result = new Set<string>()
  for (const ref of refs) {
    if (typeof ref !== "string") continue
    const parsed = parsePluginSkillSourceRef(ref)
    if (!parsed) continue
    if (usedSkillSet && !usedSkillSet.has(parsed.skill)) continue
    const normalized = makePluginSkillSourceRef(parsed.pluginId, parsed.skill, parsed.pluginName)
    if (normalized) result.add(normalized)
  }
  return Array.from(result)
}
