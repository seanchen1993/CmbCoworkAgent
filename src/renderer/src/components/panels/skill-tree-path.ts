// NOTE: relative import (not "@/...") so this module stays importable from
// the bare `tsx` test runner, which doesn't resolve TS path aliases.
import type { SkillMetadata } from "../../types"

/**
 * Collapse a value into a single path segment safe to feed into the tree
 * builder. We only ever split on "/", so any embedded slashes (forward or back)
 * or whitespace inside a name would silently introduce extra hierarchy or
 * leading-blank segments. Replace them with "-" and trim.
 */
function sanitizePathSegment(raw: string): string {
  return raw.replace(/[\\/]+/g, "-").trim()
}

/**
 * Compute the slash-delimited tree path for a skill row in the right-panel
 * Skills section.
 *
 * Plugin skills are namespaced by their owning plugin so two plugins exposing
 * the same skill name don't collapse into a single tree node. We prefer
 * `pluginId` for the scope (stable, slug-shaped, no spaces/emoji) and only
 * fall back to a sanitised `pluginName` when no id is available.
 */
export function getRightPanelSkillPath(skill: SkillMetadata): string {
  const stripPluginPrefix = (raw: string): string =>
    raw.startsWith("plugin:") ? raw.split("/").slice(1).join("/") : raw
  const id = skill.id ? stripPluginPrefix(skill.id) : ""
  const local = String(skill.relativePath || id || skill.name || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")

  if (skill.pluginId || skill.pluginName) {
    const rawScope = skill.pluginId?.trim() || skill.pluginName?.trim() || ""
    const scope = sanitizePathSegment(rawScope)
    if (scope) return local ? `${scope}/${local}` : scope
  }

  return local
}
