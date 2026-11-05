export type ProjectModeMetricRange = { from: string; to: string } | null

/** null explicitly requests project lifetime; the overview still supplies its selected range. */
export function projectModeMetricTimeFilters(
  field: string,
  range: ProjectModeMetricRange
): Record<string, unknown>[] {
  return range ? [{ range: { [field]: { gte: range.from, lte: range.to } } }] : []
}

export function assertProjectModeResultComplete(raw: unknown): void {
  const value = raw as { timed_out?: boolean; _shards?: { failed?: number } }
  if (value?.timed_out || Number(value?._shards?.failed) > 0) {
    throw new Error("项目统计未完整返回，请重试")
  }
}
