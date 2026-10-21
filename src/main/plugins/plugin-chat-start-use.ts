import type { PluginStartUseReport } from "../../shared/plugin-start-use"
import type { FunctionPluginStatus } from "../../shared/mods/v2/commands"
import type { SkillMetadata } from "../types"

/** Native discovery projection only. It neither loads a guest nor invokes a skill. */
export function pluginChatStartUseEntries(
  pluginId: string,
  mods: readonly FunctionPluginStatus[],
  skills: readonly SkillMetadata[]
): NonNullable<PluginStartUseReport["chat"]> {
  const own = mods.filter((mod) => mod.pluginId === pluginId)
  if (own.length > 1) throw Error("PLUGIN_START_USE_IDENTITY_CHANGED")
  return {
    ...(own[0] ? { functionMod: structuredClone(own[0]) } : {}),
    skills: skills
      .filter(
        (skill) =>
          skill.pluginId === pluginId &&
          skill.id &&
          skill.metadata?.["user-invocable"]?.toLowerCase() !== "false" &&
          skill.metadata?.hidden?.toLowerCase() !== "true"
      )
      .slice(0, 128)
      .map((skill) => ({ id: skill.id!, name: skill.name, description: skill.description }))
  }
}
