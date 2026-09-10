import {
  makeDashboardCodeStats,
  normalizeCodeStatsFromAggs,
  normalizeSkillCodeAdoptionBuckets,
  type DashboardSkillCodeAdoptionStats
} from "../ipc/dashboard-code-stats"
import { parsePluginSkillSourceRef } from "../utils/skill-source"
import type { DashboardEsProjection } from "./dashboard-es-protocol"

type CheckCancelled = () => void

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value)
}

function buckets(container: unknown): unknown[] {
  return asArray(asRecord(container).buckets)
}

function aggValue(container: unknown): number {
  return asNumber(asRecord(container).value)
}

function checkIndex(index: number, checkCancelled: CheckCancelled): void {
  if ((index & 0x7f) === 0) checkCancelled()
}

function formatTrendTime(
  isoString: string,
  granularity: "day" | "week" | "month" | "custom"
): string {
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return isoString
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  const hour = String(date.getHours()).padStart(2, "0")
  const minute = String(date.getMinutes()).padStart(2, "0")
  if (granularity === "day") return `${hour}:${minute}`
  if (granularity === "week" || granularity === "month") return `${month}-${day}`
  return `${month}-${day} ${hour}:${minute}`
}

interface SkillUsageItem {
  id?: string
  sourceRef?: string
  skill: string
  count: number
  isPlugin?: boolean
  pluginName?: string
}

function combineSkillUsage(
  rawSkillBuckets: unknown,
  rawSourceBuckets: unknown,
  checkCancelled: CheckCancelled
): SkillUsageItem[] {
  const pluginItems = new Map<string, SkillUsageItem>()
  const pluginCountsBySkill = new Map<string, number>()
  for (const [index, rawBucket] of asArray(rawSourceBuckets).entries()) {
    checkIndex(index, checkCancelled)
    const bucket = asRecord(rawBucket)
    const sourceRef = asString(bucket.key)
    const parsed = parsePluginSkillSourceRef(sourceRef)
    if (!parsed?.skill || !parsed.pluginId) continue
    const id = `plugin:${encodeURIComponent(parsed.pluginId)}/${encodeURIComponent(parsed.skill)}`
    const count = asNumber(bucket.doc_count)
    const existing = pluginItems.get(id)
    if (existing) existing.count += count
    else {
      pluginItems.set(id, {
        id,
        sourceRef,
        skill: parsed.skill,
        count,
        isPlugin: true,
        pluginName: parsed.pluginName || parsed.pluginId
      })
    }
    pluginCountsBySkill.set(parsed.skill, (pluginCountsBySkill.get(parsed.skill) ?? 0) + count)
  }

  const result = Array.from(pluginItems.values())
  for (const [index, rawBucket] of asArray(rawSkillBuckets).entries()) {
    checkIndex(index, checkCancelled)
    const bucket = asRecord(rawBucket)
    const skill = asString(bucket.key)
    if (!skill) continue
    const count = Math.max(0, asNumber(bucket.doc_count) - (pluginCountsBySkill.get(skill) ?? 0))
    if (count > 0) result.push({ id: skill, skill, count })
  }
  result.sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill, "zh-CN"))
  return result
}

function addSkillStats(
  left: DashboardSkillCodeAdoptionStats,
  right: DashboardSkillCodeAdoptionStats
): DashboardSkillCodeAdoptionStats {
  return {
    ...makeDashboardCodeStats({
      generatedLines: left.generatedLines + right.generatedLines,
      deletedLines: left.deletedLines + right.deletedLines,
      measuredGeneratedLines: left.measuredGeneratedLines + right.measuredGeneratedLines,
      effectiveGeneratedLines: left.effectiveGeneratedLines + right.effectiveGeneratedLines,
      adoptedLines: left.adoptedLines + right.adoptedLines,
      pushedMeasuredGeneratedLines:
        left.pushedMeasuredGeneratedLines + right.pushedMeasuredGeneratedLines,
      pushedEffectiveGeneratedLines:
        left.pushedEffectiveGeneratedLines + right.pushedEffectiveGeneratedLines,
      pushedAdoptedLines: left.pushedAdoptedLines + right.pushedAdoptedLines,
      pushedCommitCount: left.pushedCommitCount + right.pushedCommitCount
    }),
    id: left.id ?? left.skill,
    skill: left.skill,
    commitCount: left.commitCount + right.commitCount
  }
}

function subtractSkillStats(
  item: DashboardSkillCodeAdoptionStats,
  subtract: DashboardSkillCodeAdoptionStats
): DashboardSkillCodeAdoptionStats {
  return {
    ...makeDashboardCodeStats({
      generatedLines: item.generatedLines - subtract.generatedLines,
      deletedLines: item.deletedLines - subtract.deletedLines,
      measuredGeneratedLines: item.measuredGeneratedLines - subtract.measuredGeneratedLines,
      effectiveGeneratedLines: item.effectiveGeneratedLines - subtract.effectiveGeneratedLines,
      adoptedLines: item.adoptedLines - subtract.adoptedLines,
      pushedMeasuredGeneratedLines:
        item.pushedMeasuredGeneratedLines - subtract.pushedMeasuredGeneratedLines,
      pushedEffectiveGeneratedLines:
        item.pushedEffectiveGeneratedLines - subtract.pushedEffectiveGeneratedLines,
      pushedAdoptedLines: item.pushedAdoptedLines - subtract.pushedAdoptedLines,
      pushedCommitCount: item.pushedCommitCount - subtract.pushedCommitCount
    }),
    id: item.id ?? item.skill,
    skill: item.skill,
    commitCount: Math.max(0, item.commitCount - subtract.commitCount)
  }
}

function hasSkillStats(item: DashboardSkillCodeAdoptionStats): boolean {
  return (
    item.generatedLines > 0 ||
    item.effectiveGeneratedLines > 0 ||
    item.adoptedLines > 0 ||
    item.pushedAdoptedLines > 0 ||
    item.commitCount > 0 ||
    item.pushedCommitCount > 0
  )
}

function combineSkillCodeAdoption(
  usedSkillItems: DashboardSkillCodeAdoptionStats[],
  sourceItems: DashboardSkillCodeAdoptionStats[],
  checkCancelled: CheckCancelled
): DashboardSkillCodeAdoptionStats[] {
  const pluginItems = new Map<string, DashboardSkillCodeAdoptionStats>()
  const pluginStatsBySkill = new Map<string, DashboardSkillCodeAdoptionStats>()
  for (const [index, sourceItem] of sourceItems.entries()) {
    checkIndex(index, checkCancelled)
    const parsed = parsePluginSkillSourceRef(sourceItem.skill)
    if (!parsed?.skill || !parsed.pluginId) continue
    const id = `plugin:${encodeURIComponent(parsed.pluginId)}/${encodeURIComponent(parsed.skill)}`
    const item: DashboardSkillCodeAdoptionStats = {
      ...sourceItem,
      id,
      sourceRef: sourceItem.skill,
      skill: parsed.skill,
      isPlugin: true,
      pluginName: parsed.pluginName || parsed.pluginId
    }
    const existing = pluginItems.get(id)
    if (existing) {
      pluginItems.set(id, {
        ...addSkillStats(existing, item),
        id,
        sourceRef: existing.sourceRef || item.sourceRef,
        skill: item.skill,
        isPlugin: true,
        pluginName: existing.pluginName || item.pluginName
      })
    } else {
      pluginItems.set(id, item)
    }
    const existingBySkill = pluginStatsBySkill.get(parsed.skill)
    pluginStatsBySkill.set(
      parsed.skill,
      existingBySkill ? addSkillStats(existingBySkill, item) : item
    )
  }

  const result = Array.from(pluginItems.values())
  for (const [index, item] of usedSkillItems.entries()) {
    checkIndex(index, checkCancelled)
    const pluginStats = pluginStatsBySkill.get(item.skill)
    const remaining = pluginStats
      ? subtractSkillStats(item, pluginStats)
      : { ...item, id: item.id ?? item.skill }
    if (hasSkillStats(remaining)) result.push(remaining)
  }
  result.sort(
    (a, b) =>
      b.adoptedLines - a.adoptedLines ||
      b.generatedLines - a.generatedLines ||
      a.skill.localeCompare(b.skill, "zh-CN")
  )
  return result
}

function projectOverviewTrace(
  raw: unknown,
  granularity: "day" | "week" | "month" | "custom",
  checkCancelled: CheckCancelled
): Record<string, unknown> {
  const aggs = asRecord(asRecord(raw).aggregations)
  const combinedSkills = combineSkillUsage(
    buckets(aggs.by_skill_all ?? aggs.by_skill),
    buckets(aggs.skill_source),
    checkCancelled
  )
  return {
    totalCalls: aggValue(aggs.total_calls),
    activeUsers: aggValue(aggs.active_users),
    avgDurationMs: aggValue(aggs.avg_duration),
    inputTokens: aggValue(aggs.total_input_tokens),
    outputTokens: aggValue(aggs.total_output_tokens),
    totalSkills: aggValue(aggs.total_skills),
    totalTools: aggValue(aggs.total_tools),
    totalSkillCalls: aggValue(aggs.total_skill_calls),
    totalToolCalls: aggValue(aggs.total_tool_calls),
    trend: buckets(aggs.trend).map((entry, index) => {
      checkIndex(index, checkCancelled)
      const bucket = asRecord(entry)
      const iso = asString(bucket.key_as_string) || new Date(asNumber(bucket.key)).toISOString()
      return {
        time: formatTrendTime(iso, granularity),
        count: asNumber(bucket.doc_count),
        users: aggValue(bucket.users)
      }
    }),
    bySkill: combinedSkills.slice(0, 20),
    bySkillAll: combinedSkills,
    byTool: buckets(aggs.by_tool).map((entry) => {
      const bucket = asRecord(entry)
      return { tool: asString(bucket.key) || "unknown", count: asNumber(bucket.doc_count) }
    }),
    byToolAll: buckets(aggs.by_tool_all).map((entry) => {
      const bucket = asRecord(entry)
      return { tool: asString(bucket.key) || "unknown", count: asNumber(bucket.doc_count) }
    }),
    byToolFilteredAll: buckets(aggs.by_tool_filtered_all ?? aggs.by_tool).map((entry) => {
      const bucket = asRecord(entry)
      return { tool: asString(bucket.key) || "unknown", count: asNumber(bucket.doc_count) }
    }),
    byToolAllFull: buckets(aggs.by_tool_all_full ?? aggs.by_tool_all).map((entry) => {
      const bucket = asRecord(entry)
      return { tool: asString(bucket.key) || "unknown", count: asNumber(bucket.doc_count) }
    })
  }
}

function projectOverviewCode(
  raw: unknown,
  checkCancelled: CheckCancelled
): Record<string, unknown> {
  const stats = normalizeCodeStatsFromAggs(raw)
  const bySkillAdoption = combineSkillCodeAdoption(
    normalizeSkillCodeAdoptionBuckets(raw),
    normalizeSkillCodeAdoptionBuckets(raw, "by_skill_source_adoption"),
    checkCancelled
  )
  return {
    codeGeneratedLines: stats.generatedLines,
    codeDeletedLines: stats.deletedLines,
    codeEffectiveGeneratedLines: stats.effectiveGeneratedLines,
    codeMeasuredGeneratedLines: stats.measuredGeneratedLines,
    codeUnmeasuredGeneratedLines: stats.unmeasuredGeneratedLines,
    codeInclusiveEffectiveGeneratedLines: stats.inclusiveEffectiveGeneratedLines,
    codeAdoptedLines: stats.adoptedLines,
    codePushedMeasuredGeneratedLines: stats.pushedMeasuredGeneratedLines,
    codePushedEffectiveGeneratedLines: stats.pushedEffectiveGeneratedLines,
    codePushedAdoptedLines: stats.pushedAdoptedLines,
    codePushedCommitCount: stats.pushedCommitCount,
    codeMeasuredAdoptionRate: stats.measuredAdoptionRate,
    codeInclusiveAdoptionRate: stats.inclusiveAdoptionRate,
    codePushedAdoptionRate: stats.pushedAdoptionRate,
    codeInclusivePushedAdoptionRate: stats.inclusivePushedAdoptionRate,
    codeAdoptionRate: stats.measuredAdoptionRate,
    bySkillAdoption
  }
}

function projectModelStats(raw: unknown): Record<string, unknown> {
  const aggs = asRecord(asRecord(raw).aggregations)
  return {
    byModel: buckets(aggs.by_model).map((entry) => {
      const bucket = asRecord(entry)
      return {
        model: asString(bucket.key) || "unknown",
        count: asNumber(bucket.doc_count),
        inputTokens: aggValue(bucket.total_input_tokens),
        outputTokens: aggValue(bucket.total_output_tokens)
      }
    }),
    byTier: buckets(aggs.by_tier).map((entry) => {
      const bucket = asRecord(entry)
      return { tier: asString(bucket.key), count: asNumber(bucket.doc_count) }
    }),
    byLayer: buckets(aggs.by_layer).map((entry) => {
      const bucket = asRecord(entry)
      return { layer: asString(bucket.key), count: asNumber(bucket.doc_count) }
    }),
    smartByTier: buckets(asRecord(aggs.smart_by_tier).by_tier).map((entry) => {
      const bucket = asRecord(entry)
      return { tier: asString(bucket.key), count: asNumber(bucket.doc_count) }
    })
  }
}

function latestUserMetric(bucket: Record<string, unknown>, field: string): string {
  const latestInfo = asRecord(asArray(asRecord(asRecord(bucket.latest_user_info).hits).hits)[0])
  return asString(asRecord(latestInfo._source)[field])
}

function latestUserCollectionTime(bucket: Record<string, unknown>): string {
  const hit = asRecord(asArray(asRecord(asRecord(bucket.latest_user_info).hits).hits)[0])
  return asString(asRecord(hit._source).startedAt) || asString(asArray(hit.sort)[0])
}

function formatUserOrg(orgName: string, upperOrgLv1: string, upperOrgLv0: string): string {
  if (upperOrgLv1 && upperOrgLv0) return `${upperOrgLv1}/${upperOrgLv0}`
  return upperOrgLv1 || orgName
}

function compareVersionLike(a: string, b: string): number {
  const left = a.match(/\d+|[a-zA-Z]+/g) ?? []
  const right = b.match(/\d+|[a-zA-Z]+/g) ?? []
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const leftPart = left[index] ?? "0"
    const rightPart = right[index] ?? "0"
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null
    if (leftNumber !== null && rightNumber !== null) {
      if (leftNumber !== rightNumber) return leftNumber - rightNumber
    } else {
      const comparison = leftPart.localeCompare(rightPart)
      if (comparison !== 0) return comparison
    }
  }
  return 0
}

function projectUserStats(
  raw: unknown,
  selectedUpperOrgLv1: string | null,
  checkCancelled: CheckCancelled
): Record<string, unknown> {
  const aggs = asRecord(asRecord(raw).aggregations)
  const topBuckets = buckets(aggs.top_users)
  const topUsers = topBuckets.map((entry, index) => {
    checkIndex(index, checkCancelled)
    const bucket = asRecord(entry)
    const upperOrgLv1 = latestUserMetric(bucket, "upperOrgLv1")
    const upperOrgLv0 = latestUserMetric(bucket, "upperOrgLv0")
    return {
      sapId: asString(bucket.key),
      userName: latestUserMetric(bucket, "userName") || asString(bucket.key),
      orgName: formatUserOrg(latestUserMetric(bucket, "orgName"), upperOrgLv1, upperOrgLv0),
      count: asNumber(bucket.doc_count)
    }
  })
  const orgBuckets = (container: unknown): unknown[] => {
    const record = asRecord(container)
    return buckets(record).length > 0 ? buckets(record) : buckets(record.items)
  }
  const mapOrgs = (entries: unknown[], unique: boolean) =>
    entries
      .map((entry) => asRecord(entry))
      .filter((entry) => asString(entry.key).trim())
      .map((entry) => {
        const uniqueUserValue = asRecord(entry.unique_users).value
        return {
          key: asString(entry.key),
          org: asString(entry.key),
          count: unique
            ? uniqueUserValue == null
              ? asNumber(entry.doc_count)
              : asNumber(uniqueUserValue)
            : asNumber(entry.doc_count)
        }
      })
  const byOrgPv = mapOrgs(orgBuckets(aggs.by_org_pv ?? aggs.by_org), false)
  const byOrgUv = mapOrgs(orgBuckets(aggs.by_org_uv ?? aggs.by_org), true)
  const versionBuckets = buckets(aggs.by_version)
  const byVersion = versionBuckets.map((entry) => {
    const bucket = asRecord(entry)
    const uniqueUserValue = asRecord(bucket.unique_users).value
    return {
      version: asString(bucket.key) || "未知",
      count: uniqueUserValue == null ? asNumber(bucket.doc_count) : asNumber(uniqueUserValue)
    }
  })
  const latestVersion =
    byVersion
      .map((entry) => entry.version)
      .filter((version) => version && version !== "未知")
      .sort(compareVersionLike)
      .at(-1) ?? ""
  const versionUsers = versionBuckets.flatMap((versionEntry, versionIndex) => {
    checkIndex(versionIndex, checkCancelled)
    const versionBucket = asRecord(versionEntry)
    return buckets(versionBucket.users).map((userEntry) => {
      const user = asRecord(userEntry)
      const upperOrgLv1 = latestUserMetric(user, "upperOrgLv1")
      const upperOrgLv0 = latestUserMetric(user, "upperOrgLv0")
      return {
        sapId: asString(user.key),
        userName: latestUserMetric(user, "userName") || asString(user.key),
        orgName: formatUserOrg(latestUserMetric(user, "orgName"), upperOrgLv1, upperOrgLv0),
        version: latestUserMetric(user, "appVersion") || asString(versionBucket.key) || "未知",
        collectionTime: latestUserCollectionTime(user)
      }
    })
  })
  const fallbackVersionUsers = topUsers.map((user, index) => {
    const bucket = asRecord(topBuckets[index])
    return {
      sapId: user.sapId,
      userName: user.userName,
      orgName: user.orgName,
      version: latestUserMetric(bucket, "appVersion") || "未知",
      collectionTime: latestUserCollectionTime(bucket)
    }
  })
  const resolvedVersionUsers = versionUsers.length > 0 ? versionUsers : fallbackVersionUsers
  return {
    topUsers,
    byOrg: byOrgPv,
    byOrgPv,
    byOrgUv,
    byVersion,
    latestVersion,
    versionUsers: resolvedVersionUsers,
    userVersionUsage: resolvedVersionUsers
      .map((user) => ({
        ...user,
        isLatestVersion: Boolean(latestVersion && user.version === latestVersion)
      }))
      .filter((user) => !user.isLatestVersion),
    userTrend: buckets(aggs.user_trend).map((entry) => {
      const bucket = asRecord(entry)
      return {
        time: asString(bucket.key_as_string) || new Date(asNumber(bucket.key)).toISOString(),
        users: aggValue(bucket.users)
      }
    }),
    selectedUpperOrgLv1
  }
}

function trendBucketRange(
  bucketIso: string,
  granularity: "day" | "week" | "month" | "custom",
  range: { from: string; to: string }
): { from: string; to: string } {
  let interval: "hour" | "day" | "week" = granularity === "day" ? "hour" : "day"
  if (granularity === "custom") {
    const days = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000
    interval = days <= 1 ? "hour" : days <= 14 ? "day" : "week"
  }
  const duration = interval === "hour" ? 3_600_000 : interval === "day" ? 86_400_000 : 604_800_000
  const start = Date.parse(bucketIso)
  return {
    from: new Date(Math.max(start, Date.parse(range.from))).toISOString(),
    to: new Date(Math.min(start + duration - 1, Date.parse(range.to))).toISOString()
  }
}

function projectProductivityCommit(
  raw: unknown,
  granularity: "day" | "week" | "month" | "custom",
  range: { from: string; to: string }
): Record<string, unknown> {
  const aggs = asRecord(asRecord(raw).aggregations)
  return {
    commitTrend: buckets(aggs.commit_trend).map((entry) => {
      const bucket = asRecord(entry)
      const iso = asString(bucket.key_as_string) || new Date(asNumber(bucket.key)).toISOString()
      return {
        time: formatTrendTime(iso, granularity),
        count: asNumber(bucket.doc_count),
        ...trendBucketRange(iso, granularity, range)
      }
    }),
    totalFilesChanged: aggValue(aggs.total_files_changed),
    totalCommits: aggValue(aggs.total_commits),
    activeUsers: aggValue(aggs.active_users)
  }
}

function projectAdvancedEvent(raw: unknown): Record<string, unknown> {
  const aggs = asRecord(asRecord(raw).aggregations)
  const countByKey = (container: unknown, key: string): number => {
    const bucket = buckets(container).find((entry) => asString(asRecord(entry).key) === key)
    return asNumber(asRecord(bucket).doc_count)
  }
  const heartbeat = asRecord(aggs.heartbeat)
  const evolution = asRecord(aggs.evo_run)
  const im = asRecord(aggs.im)
  const hooks = asRecord(aggs.hooks)
  return {
    hbActionable: countByKey(heartbeat.by_outcome, "actionable"),
    hbSilent: countByKey(heartbeat.by_outcome, "silent"),
    hbError: countByKey(heartbeat.by_outcome, "error"),
    hbCancelled: countByKey(heartbeat.by_outcome, "cancelled"),
    memWrite: asNumber(asRecord(aggs.memory_write).doc_count),
    evoCandidates: countByKey(evolution.by_outcome, "candidates"),
    evoEmpty: countByKey(evolution.by_outcome, "empty"),
    evoRunError: countByKey(evolution.by_outcome, "error"),
    evoAccepted: asNumber(asRecord(aggs.evo_accepted).doc_count),
    evoRejected: asNumber(asRecord(aggs.evo_rejected).doc_count),
    evoCloud: asNumber(asRecord(aggs.evo_cloud).doc_count),
    cloudPublished: asNumber(asRecord(aggs.evo_published).doc_count),
    proposalTriggered: asNumber(asRecord(aggs.proposal_triggered).doc_count),
    proposalAccepted: asNumber(asRecord(aggs.proposal_accepted).doc_count),
    imCompleted: countByKey(im.by_outcome, "completed"),
    imCancelled: countByKey(im.by_outcome, "cancelled"),
    imError: countByKey(im.by_outcome, "error") + countByKey(im.by_outcome, "outcome_unknown"),
    hookTotal: asNumber(hooks.doc_count),
    hookBlocked: asNumber(asRecord(hooks.blocked).doc_count)
  }
}

function projectAdvancedTrace(raw: unknown): Record<string, unknown> {
  const aggs = asRecord(asRecord(raw).aggregations)
  const tools = buckets(aggs.by_tool)
  const countTool = (key: string): number => {
    const bucket = tools.find((entry) => asString(asRecord(entry).key) === key)
    return asNumber(asRecord(bucket).doc_count)
  }
  return {
    memSearch: countTool("memory_search"),
    memGet: countTool("memory_get"),
    lsp: countTool("java_lsp"),
    evolvedTraces: asNumber(asRecord(aggs.evolved_traces).doc_count),
    evolvedUsages: aggValue(aggs.evolved_usages),
    codeExec: countTool("code_exec"),
    savedTool: countTool("save_code_exec_tool")
  }
}

function projectUserDirectory(
  raw: unknown,
  checkCancelled: CheckCancelled
): Record<string, unknown> {
  const aggs = asRecord(asRecord(raw).aggregations)
  const bySap = asRecord(aggs.by_sap)
  const items = buckets(bySap).flatMap((entry, index) => {
    checkIndex(index, checkCancelled)
    const bucket = asRecord(entry)
    const sapId = asString(asRecord(bucket.key).sapId || bucket.key).trim()
    if (!sapId) return []
    const latestHit = asRecord(asArray(asRecord(asRecord(bucket.latest_user_info).hits).hits)[0])
    const latest = asRecord(latestHit._source)
    const firstKey = (container: unknown): string =>
      asString(asRecord(asArray(asRecord(container).buckets)[0]).key)
    return [
      {
        sapId,
        userName: asString(latest.userName) || firstKey(bucket.user_name),
        orgName: asString(latest.orgName) || firstKey(bucket.org_name),
        upperOrgLv0: asString(latest.upperOrgLv0),
        upperOrgLv1: asString(latest.upperOrgLv1)
      }
    ]
  })
  return {
    items,
    afterKey: Object.keys(asRecord(bySap.after_key)).length > 0 ? asRecord(bySap.after_key) : null
  }
}

export function projectDashboardEsResponse(
  raw: unknown,
  projection: DashboardEsProjection,
  checkCancelled: CheckCancelled = () => undefined
): unknown {
  switch (projection.kind) {
    case "overview-trace":
      return projectOverviewTrace(raw, projection.granularity, checkCancelled)
    case "overview-code":
      return projectOverviewCode(raw, checkCancelled)
    case "model-stats":
      return projectModelStats(raw)
    case "user-stats":
      return projectUserStats(raw, projection.selectedUpperOrgLv1, checkCancelled)
    case "productivity-commit":
      return projectProductivityCommit(raw, projection.granularity, projection.range)
    case "productivity-code": {
      const aggs = asRecord(asRecord(raw).aggregations)
      return {
        totalInsertions: aggValue(aggs.code_generated_lines),
        totalDeletions: aggValue(aggs.code_deleted_lines)
      }
    }
    case "advanced-event":
      return projectAdvancedEvent(raw)
    case "advanced-trace":
      return projectAdvancedTrace(raw)
    case "user-directory":
      return projectUserDirectory(raw, checkCancelled)
  }
}
