import { parseSkillHookDocument } from "../skills/hook-document"
import type { HookConfig } from "../hooks/types"
import type { BotExternalSkill } from "./skill-catalog-contract"
import { readSkillResource } from "./skill-resource-files"

/** The installed skill revision already pins these exact files. Reuse Cmb's
 * native/Claude Hook parser; never discover a path mentioned by the model. */
export async function readBotSkillHooks(skill: BotExternalSkill): Promise<HookConfig[]> {
  const hooks: HookConfig[] = []
  for (const relative of ["SKILL.md", "hooks.json", "hooks/hooks.json"]) {
    const entry = skill.resources.find((item) => item.path === relative && item.kind === "file")
    if (!entry) continue
    if (entry.size > 256 * 1024) throw new Error("技能 Hook 配置超过 256 KiB")
    const { bytes } = await readSkillResource(skill, relative)
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    hooks.push(...parseSkillHookDocument(text, relative, skill))
    if (hooks.length > 128) throw new Error("单个技能的 Hook 超过 128 项")
  }
  return hooks
}
