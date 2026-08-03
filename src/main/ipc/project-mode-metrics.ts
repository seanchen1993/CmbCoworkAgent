import { isHarnessDevStageNodeName } from "../../shared/harness-stage-bucket"

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/** Sum conversations whose current workflow node belongs to the Dev group. */
export function countDevStageConversations(rawNodeBuckets: unknown): number {
  if (!Array.isArray(rawNodeBuckets)) return 0
  return rawNodeBuckets.reduce((total, bucket) => {
    const item = asRecord(bucket)
    return isHarnessDevStageNodeName(asString(item.key)) ? total + asNumber(item.doc_count) : total
  }, 0)
}

/**
 * Count distinct bound Features that contributed at least one Dev-stage conversation.
 *
 * The ES query supplies one `by_feature` bucket per `harnessFeatureSlug`, with that
 * Feature's workflow-node buckets nested below it. Missing/empty slugs are ignored,
 * so unbound Dev conversations remain part of the Dev conversation total without
 * inflating this metric. The Set also keeps the parser correct for duplicated buckets.
 */
export function countDevAssociatedFeatures(rawFeatureBuckets: unknown): number {
  if (!Array.isArray(rawFeatureBuckets)) return 0

  const featureSlugs = new Set<string>()
  for (const bucket of rawFeatureBuckets) {
    const feature = asRecord(bucket)
    const featureSlug = asString(feature.key).trim()
    if (!featureSlug) continue

    const nodeBuckets = asRecord(feature.by_node).buckets
    if (
      Array.isArray(nodeBuckets) &&
      nodeBuckets.some((node) => isHarnessDevStageNodeName(asString(asRecord(node).key)))
    ) {
      featureSlugs.add(featureSlug)
    }
  }
  return featureSlugs.size
}
