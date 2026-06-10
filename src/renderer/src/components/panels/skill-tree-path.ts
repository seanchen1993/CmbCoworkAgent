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

export type RightPanelSkillPathSegment = {
  /** Stable collision-safe segment used for tree identity. */
  key: string
  /** Human-readable segment shown in the tree UI. */
  label: string
  /** Optional hover text for internal IDs or full source names. */
  title?: string
}

function getLocalSkillPath(skill: SkillMetadata): string {
  const stripPluginPrefix = (raw: string): string =>
    raw.startsWith("plugin:") ? raw.split("/").slice(1).join("/") : raw
  const id = skill.id ? stripPluginPrefix(skill.id) : ""
  return String(skill.relativePath || id || skill.name || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
}

function pathSegments(value: string): string[] {
  return value.split("/").map((segment) => segment.trim()).filter(Boolean)
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
  const local = getLocalSkillPath(skill)

  if (skill.pluginId || skill.pluginName) {
    const rawScope = skill.pluginId?.trim() || skill.pluginName?.trim() || ""
    const scope = sanitizePathSegment(rawScope)
    if (scope) return local ? `${scope}/${local}` : scope
  }

  return local
}

/**
 * Same identity model as getRightPanelSkillPath(), but with separate display
 * labels. Plugin skills are not grouped under a plugin folder in the UI; the
 * final skill segment carries plugin identity in its key so same-name plugin
 * skills remain distinct while users see a flat skill list with source badges.
 */
export function getRightPanelSkillPathSegments(skill: SkillMetadata): RightPanelSkillPathSegment[] {
  const localSegments: RightPanelSkillPathSegment[] = pathSegments(getLocalSkillPath(skill)).map(
    (segment) => ({
      key: segment,
      label: segment
    })
  )

  if (skill.pluginId || skill.pluginName) {
    const rawScope = skill.pluginId?.trim() || skill.pluginName?.trim() || ""
    const scopeKey = sanitizePathSegment(rawScope)
    if (!scopeKey) return localSegments

    const pluginLabel = skill.pluginName?.trim() || skill.pluginId?.trim() || scopeKey
    const title =
      skill.pluginName && skill.pluginId && skill.pluginName !== skill.pluginId
        ? `插件：${skill.pluginName}\nID：${skill.pluginId}`
        : `插件：${pluginLabel}`
    const segments =
      localSegments.length > 0
        ? localSegments.map((segment) => ({ ...segment }))
        : [{ key: skill.name || scopeKey, label: skill.name || pluginLabel }]
    const last = segments[segments.length - 1]
    last.key = `${last.key}::plugin:${scopeKey}`
    last.title = title

    return segments
  }

  return localSegments
}
