export const HARNESS_PROJECT_STORE_MAX_BYTES = 4 * 1024 * 1024
export const HARNESS_PROJECT_STORE_MAX_PROJECTS = 2_048
export const HARNESS_PROJECT_TEXT_MAX_CHARS = 8 * 1024
export const HARNESS_PROJECT_PATH_MAX_CHARS = 8 * 1024
export const HARNESS_PROJECT_DESCRIPTION_MAX_CHARS = 16 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function assertStringBudget(value: unknown, maxChars: number, label: string): void {
  if (typeof value === "string" && value.length > maxChars) {
    throw new Error(`${label} exceeded ${maxChars} characters`)
  }
}

/**
 * One project-field boundary shared by the main-process writer and the catalog worker reader.
 * This prevents either side from silently truncating identifiers or paths differently.
 */
export function assertHarnessProjectFieldBudgets(value: unknown): void {
  if (!isRecord(value)) return
  const adapter = isRecord(value["harness-adapter"]) ? value["harness-adapter"] : {}
  const oldWorkspace = isRecord(value.workspace) ? value.workspace : {}
  const lifecycle = isRecord(value.lifecycle) ? value.lifecycle : {}
  const creator = isRecord(value.creator) ? value.creator : {}

  for (const [label, field] of [
    ["Harness project id", value.projectId],
    ["Harness project name", value.name],
    ["Harness project code", value.projectCode],
    ["Harness project directory", value.projectDir],
    ["Harness project system id", value.systemId],
    ["Harness project system name", value.systemName],
    ["Harness project adapter id", adapter.id],
    ["Harness project adapter name", adapter.name],
    ["Harness project adapter version", adapter.version],
    ["Harness project creator sapId", creator.sapId],
    ["Harness project creator ystId", creator.ystId],
    ["Harness project creator userName", creator.userName],
    ["Harness project creator orgName", creator.orgName],
    ["Harness project creator upperOrgLv0", creator.upperOrgLv0],
    ["Harness project creator upperOrgLv1", creator.upperOrgLv1]
  ] as const) {
    assertStringBudget(field, HARNESS_PROJECT_TEXT_MAX_CHARS, label)
  }

  assertStringBudget(
    value.description,
    HARNESS_PROJECT_DESCRIPTION_MAX_CHARS,
    "Harness project description"
  )
  for (const [label, field] of [
    ["Harness project workspace path", value.workspacePath],
    ["Harness legacy project workspace path", oldWorkspace.path],
    ["Harness project session workspace path", value.sessionWorkspacePath],
    ["Harness project creator pathName", creator.pathName]
  ] as const) {
    assertStringBudget(field, HARNESS_PROJECT_PATH_MAX_CHARS, label)
  }
  for (const [label, field] of [
    ["Harness project system constraint timestamp", value.systemConstraintFirstLoadedAt],
    ["Harness project create timestamp", lifecycle.createAt],
    ["Harness project update timestamp", lifecycle.updateAt]
  ] as const) {
    assertStringBudget(field, 128, label)
  }
}
