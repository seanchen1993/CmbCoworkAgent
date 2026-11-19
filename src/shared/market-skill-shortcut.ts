export const PROJECT_PLUGIN_SKILL_SHORTCUT_LABEL = "开发项目模式插件"

export interface MarketSkillShortcutConfig {
  itemId: string
  marketName: string
  skillName?: string
  sha256?: string
  allowSourceForAll?: boolean
}

export interface ConversationShortcutsConfig {
  projectPluginCreation?: MarketSkillShortcutConfig | null
}

export interface MarketSkillShortcutTarget {
  itemId: string
  marketName: string
  name: string
  description: string
  skillName: string
}

export interface MarketSkillShortcutBinding {
  revision: string
  target: MarketSkillShortcutTarget | null
}

export interface MarketSkillShortcutSelection {
  itemId: string
  revision: string
}

export type MarketSkillShortcutResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "changed" | "unavailable"; error: string }

export type MarketSkillShortcutSkillState<Skill> =
  | { kind: "available"; skill: Skill }
  | { kind: "disabled" | "missing" }
  | { kind: "failed"; error: string }

export function isMarketSkillShortcutKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value === value.trim() &&
    !/\p{Cc}/u.test(value)
  )
}

function isMarketName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    value !== "." &&
    value !== ".." &&
    !/\p{Cc}/u.test(value)
  )
}

export function parseMarketSkillShortcutConfig(value: unknown): MarketSkillShortcutConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const { itemId, marketName, skillName, sha256, allowSourceForAll } = value as Record<string, unknown>
  if (
    !isMarketSkillShortcutKey(itemId) ||
    !isMarketName(marketName) ||
    (skillName !== undefined && !isMarketName(skillName)) ||
    (sha256 !== undefined && (typeof sha256 !== "string" || !/^[a-f\d]{64}$/i.test(sha256))) ||
    (allowSourceForAll !== undefined && typeof allowSourceForAll !== "boolean") ||
    (allowSourceForAll === true && !sha256)
  ) {
    return null
  }
  return {
    itemId,
    marketName,
    skillName,
    sha256: sha256?.toLowerCase(),
    ...(allowSourceForAll === true ? { allowSourceForAll } : {})
  }
}
