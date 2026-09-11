import type { HarnessDynamicWorkflowConfig } from "./harness-board-types"

export function defaultWorkflowTemplateId(config: HarnessDynamicWorkflowConfig | null): string {
  return config?.templates[0]?.id ?? ""
}

export function requiredWorkflowNodeIds(
  config: HarnessDynamicWorkflowConfig | null,
  templateId: string
): Set<string> {
  const template = config?.templates.find((item) => item.id === templateId)
  return new Set(template?.templateType === "custom" ? template.requiredNodes : [])
}

/** Inputs may include live UI state before persisted metadata, in that order. */
export async function resolveHarnessSessionWorkspace(
  configured: unknown,
  sessions: Array<{ threadId: string; lastActiveAt: string; workspacePaths: unknown[] }>,
  readPersisted: (threadId: string) => Promise<string | null>
): Promise<string | null> {
  const path = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value : null
  const configuredPath = path(configured)
  if (configuredPath) return configuredPath
  const sorted = [...sessions].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
  for (const session of sorted) {
    for (const value of session.workspacePaths) {
      const candidate = path(value)
      if (candidate) return candidate
    }
  }
  if (!sorted[0]) return null
  try {
    return path(await readPersisted(sorted[0].threadId))
  } catch {
    return null
  }
}
