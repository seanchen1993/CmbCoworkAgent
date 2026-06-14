import { resolve } from "path"

export interface HarnessPlaceholderContext {
  pluginRoot?: string
  pluginWorkspace?: string
  projectCode?: string
  featureId?: string
}

function normalizePlaceholderPath(value: string): string {
  return resolve(value).replace(/\\/g, "/")
}

export function hasCompleteHarnessPlaceholderContext(
  context: Pick<HarnessPlaceholderContext, "pluginWorkspace" | "projectCode" | "featureId">
): boolean {
  return (
    Boolean(context.pluginWorkspace) && Boolean(context.projectCode) && Boolean(context.featureId)
  )
}

export function replaceHarnessPlaceholders(
  content: string,
  context: HarnessPlaceholderContext
): string {
  const replacements: Record<string, string | undefined> = {
    PLUGIN_ROOT:
      context.pluginRoot !== undefined && context.pluginRoot !== ""
        ? normalizePlaceholderPath(context.pluginRoot)
        : undefined,
    PLUGIN_WORKSPACE:
      context.pluginWorkspace !== undefined && context.pluginWorkspace !== ""
        ? normalizePlaceholderPath(context.pluginWorkspace)
        : undefined,
    PROJECT_CODE:
      context.projectCode !== undefined && context.projectCode !== ""
        ? context.projectCode
        : undefined,
    FEATURE_ID:
      context.featureId !== undefined && context.featureId !== "" ? context.featureId : undefined
  }

  return content.replace(
    /\{(PLUGIN_ROOT|PLUGIN_WORKSPACE|PROJECT_CODE|FEATURE_ID)\}/g,
    (match, key: string) => replacements[key] ?? match
  )
}
