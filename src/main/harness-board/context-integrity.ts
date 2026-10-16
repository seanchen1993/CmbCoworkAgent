import type { HarnessAgentmdLoadStatusItem } from "../../shared/harness-board-types"

export const HARNESS_SESSION_CONTEXT_MAX_CHARS = 60_000
export const HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES = 512
export const HARNESS_FRAMEWORK_DEPLOY_UNIT_CONTEXT_MAX_ENTRIES = 64
export const HARNESS_SESSION_CONTEXT_LIMIT_EXCEEDED =
  "HARNESS_SESSION_CONTEXT_LIMIT_EXCEEDED"
export const HARNESS_DEPLOY_UNIT_CONTEXT_LIMIT_EXCEEDED =
  "HARNESS_DEPLOY_UNIT_CONTEXT_LIMIT_EXCEEDED"
export const HARNESS_REQUIRED_CONTEXT_UNAVAILABLE = "HARNESS_REQUIRED_CONTEXT_UNAVAILABLE"

export class HarnessRequiredContextError extends Error {
  readonly code = HARNESS_REQUIRED_CONTEXT_UNAVAILABLE
  constructor(readonly missingDeployUnitIds: string[]) {
    const names = missingDeployUnitIds.filter(id => /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id))
      .slice(0, 8).join("、")
    super(`必需项目知识未完整装载（${missingDeployUnitIds.length} 项${names ? `：${names}` : ""}），已阻止本次任务；请核对知识来源和装载记录。`)
    this.name = HARNESS_REQUIRED_CONTEXT_UNAVAILABLE
  }
}

/** The selected project inputs cannot be downgraded by an overall ok or an optional flag. */
export function requireLoadedHarnessContext(
  statuses: readonly HarnessAgentmdLoadStatusItem[],
  selectedDeployUnitIds: readonly string[] = []
): void {
  const selected = new Set(selectedDeployUnitIds)
  const missing = new Set<string>()
  for (const status of statuses) {
    if (!status.loaded && (status.required !== false || selected.has(status.deployUnitId)))
      missing.add(status.deployUnitId)
  }
  for (const id of selected) {
    if (!statuses.some(status => status.deployUnitId === id && status.loaded)) missing.add(id)
  }
  if (missing.size) throw new HarnessRequiredContextError([...missing])
}

export type HarnessContextInjectionSource = "cmbdevclaw" | "plugin"

export class HarnessSessionContextLimitError extends Error {
  readonly code = HARNESS_SESSION_CONTEXT_LIMIT_EXCEEDED

  constructor(
    readonly actualCharacters: number,
    readonly maximumCharacters = HARNESS_SESSION_CONTEXT_MAX_CHARS
  ) {
    super(
      `Harness session_context_inject 返回 ${actualCharacters} 个字符，超过 ` +
        `${maximumCharacters} 字符安全上限；为避免遗漏需求，已阻止本次任务。`
    )
    this.name = HARNESS_SESSION_CONTEXT_LIMIT_EXCEEDED
  }
}

export class HarnessDeployUnitContextLimitError extends Error {
  readonly code = HARNESS_DEPLOY_UNIT_CONTEXT_LIMIT_EXCEEDED

  constructor(
    readonly source: HarnessContextInjectionSource,
    readonly actualEntries: number,
    readonly maximumEntries =
      source === "plugin"
        ? HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES
        : HARNESS_FRAMEWORK_DEPLOY_UNIT_CONTEXT_MAX_ENTRIES
  ) {
    super(
      `Harness ${source} deploy-unit context exceeded ${maximumEntries} entries; ` +
        `received ${actualEntries}, no entries were omitted`
    )
    this.name = HARNESS_DEPLOY_UNIT_CONTEXT_LIMIT_EXCEEDED
  }
}

export function requireCompleteHarnessSessionContext(value: string): string {
  if (value.length > HARNESS_SESSION_CONTEXT_MAX_CHARS) {
    throw new HarnessSessionContextLimitError(value.length)
  }
  return value
}

export function requireCompleteHarnessDeployUnitContext(
  entries: number,
  source: HarnessContextInjectionSource
): void {
  const maximumEntries =
    source === "plugin"
      ? HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES
      : HARNESS_FRAMEWORK_DEPLOY_UNIT_CONTEXT_MAX_ENTRIES
  if (entries > maximumEntries) {
    throw new HarnessDeployUnitContextLimitError(source, entries, maximumEntries)
  }
}
