import { resolve } from "node:path"
import { normalizePathKey } from "../hooks/path-key"
import { renderWhitelistedPlaceholders } from "../placeholders/template"

const HARNESS_MARKDOWN_PLACEHOLDER_KEYS = [
  "pluginPath",
  "pluginWorkspace",
  "projectDir",
  "feature",
  "systemId"
] as const

export interface HarnessMarkdownPlaceholderContext {
  pluginWorkspace?: string
  projectDir?: string
  featureId?: string
  systemId?: string
}

export interface PluginMarkdownDocumentOwner {
  pluginRoot?: string
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function normalizePlaceholderPath(value: string | undefined): string | undefined {
  const normalized = nonEmpty(value)
  return normalized ? resolve(normalized).replace(/\\/g, "/") : undefined
}

export function hasHarnessFeatureMarkdownPlaceholderContext(
  context: HarnessMarkdownPlaceholderContext
): boolean {
  return Boolean(nonEmpty(context.featureId))
}

export function isSameMarkdownDocumentPath(left: string, right: string): boolean {
  return normalizePathKey(resolve(left)) === normalizePathKey(resolve(right))
}

export function renderPluginSkillMarkdownPlaceholders(
  content: string,
  owner: PluginMarkdownDocumentOwner,
  context: HarnessMarkdownPlaceholderContext
): string {
  const pluginPath = normalizePlaceholderPath(owner.pluginRoot)
  if (!pluginPath || !hasHarnessFeatureMarkdownPlaceholderContext(context)) return content

  return renderWhitelistedPlaceholders(
    content,
    {
      pluginPath,
      pluginWorkspace: normalizePlaceholderPath(context.pluginWorkspace),
      projectDir: nonEmpty(context.projectDir),
      feature: nonEmpty(context.featureId),
      systemId: nonEmpty(context.systemId)
    },
    { allowedKeys: HARNESS_MARKDOWN_PLACEHOLDER_KEYS }
  )
}
