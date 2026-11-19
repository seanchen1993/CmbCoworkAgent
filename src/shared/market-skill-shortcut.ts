export const PROJECT_PLUGIN_SKILL_SHORTCUT_SLOT = "project-plugin-creation"
export const PROJECT_PLUGIN_SKILL_SHORTCUT_LABEL = "开发项目模式插件"

export interface MarketSkillShortcutTarget {
  itemId: string
  name: string
  description: string
  skillName: string
}

export interface MarketSkillShortcutBinding {
  revision: string
  target: MarketSkillShortcutTarget | null
  canManage: boolean
  assignedItemId: string | null
}

export interface MarketSkillShortcutSelection {
  itemId: string
  revision: string
}

export interface MarketSkillShortcutUpdate {
  itemId: string
  marketName: string
  enabled: boolean
  revision: string
}

export type MarketSkillShortcutResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "changed" | "forbidden" | "unavailable"; error: string }

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
