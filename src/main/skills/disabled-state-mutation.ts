import type { SkillPluginCatalogPage, SkillPluginCatalogPageInput } from "../types"
import {
  SKILL_PLUGIN_CATALOG_MAX_PAGE_SIZE,
  SKILL_PLUGIN_CATALOG_MAX_DISABLED_STORE_BYTES,
  SKILL_PLUGIN_CATALOG_MAX_SKILLS
} from "../skill-plugin-catalog/protocol"
import {
  MAX_CANONICAL_STANDALONE_SKILL_ID_LENGTH,
  MAX_DISABLED_STANDALONE_SKILL_IDS
} from "./ids"
import { isDisabledSkillStoreFingerprint } from "./disabled-store-fingerprint"
import { waitForSkillCatalogTopologyIdle } from "../skill-plugin-catalog/topology-mutation-gate"

export type DisabledSkillCatalogPageReader = (
  input: SkillPluginCatalogPageInput
) => Promise<SkillPluginCatalogPage>

export interface CanonicalDisabledSkillSnapshot {
  disabledSkillIds: string[]
  sourceKey: string
  catalogGlobalRevision: number
  sourceRevision: number
  storeFingerprint: string
}

export const MAX_DISABLED_SKILL_CAS_ATTEMPTS = 4

export function normalizeDisabledSkillMigrationEntries(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError("Invalid disabled-skill migration payload")
  if (value.length > MAX_DISABLED_STANDALONE_SKILL_IDS) {
    throw new RangeError("Disabled-skill migration entry limit reached")
  }
  const entries: string[] = []
  let serializedBytes = 2
  for (const entry of value) {
    if (typeof entry !== "string") continue
    if (entry.length > MAX_CANONICAL_STANDALONE_SKILL_ID_LENGTH) {
      throw new RangeError("Disabled-skill migration entry is too long")
    }
    serializedBytes += Buffer.byteLength(JSON.stringify(entry), "utf-8") + 1
    if (serializedBytes > SKILL_PLUGIN_CATALOG_MAX_DISABLED_STORE_BYTES) {
      throw new RangeError("Disabled-skill migration payload is too large")
    }
    entries.push(entry)
  }
  return entries
}

/**
 * Resolve legacy display-name aliases in the catalog worker, then return one
 * complete canonical snapshot to the small synchronous persistence edge. The
 * pagination bound and cursor checks keep a corrupt worker response from
 * turning a toggle into an unbounded main-process loop.
 */
export async function readCanonicalDisabledSkillSnapshot(
  readPage: DisabledSkillCatalogPageReader
): Promise<CanonicalDisabledSkillSnapshot> {
  const disabledSkillIds: string[] = []
  const seenCursors = new Set<string>()
  let cursor: string | null = null
  let sourceKey: string | null = null
  let catalogGlobalRevision: number | null = null
  let sourceRevision: number | null = null
  let storeFingerprint: string | null = null

  do {
    const page = await readPage({
      kind: "disabled",
      cursor,
      limit: SKILL_PLUGIN_CATALOG_MAX_PAGE_SIZE
    })
    if (page.kind !== "disabled") {
      throw new Error("Unexpected disabled-skill catalog projection")
    }
    if (
      !page.sourceKey ||
      !Number.isSafeInteger(page.catalogGlobalRevision) ||
      page.catalogGlobalRevision < 0 ||
      !Number.isSafeInteger(page.disabledSkillsRevision) ||
      page.disabledSkillsRevision < 0
    ) {
      throw new Error("Disabled-skill catalog omitted its source identity")
    }
    if (page.truncated) {
      throw new Error(
        `技能目录扫描不完整，已拒绝覆盖禁用状态：${page.truncatedReasons.join(", ") || "unknown"}`
      )
    }
    if (!isDisabledSkillStoreFingerprint(page.disabledStoreFingerprint)) {
      throw new Error("Disabled-skill catalog omitted its store fingerprint")
    }
    sourceKey ??= page.sourceKey
    catalogGlobalRevision ??= page.catalogGlobalRevision
    sourceRevision ??= page.disabledSkillsRevision
    storeFingerprint ??= page.disabledStoreFingerprint
    if (
      page.sourceKey !== sourceKey ||
      page.catalogGlobalRevision !== catalogGlobalRevision ||
      page.disabledSkillsRevision !== sourceRevision ||
      page.disabledStoreFingerprint !== storeFingerprint
    ) {
      throw new Error("Disabled-skill catalog source changed while paging")
    }
    disabledSkillIds.push(...page.disabledSkillIds)
    if (disabledSkillIds.length > SKILL_PLUGIN_CATALOG_MAX_SKILLS) {
      throw new Error("Disabled-skill catalog exceeded its bounded entry limit")
    }

    cursor = page.cursor
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw new Error("Disabled-skill catalog returned a repeated cursor")
      }
      seenCursors.add(cursor)
    }
  } while (cursor)

  if (
    sourceKey === null ||
    catalogGlobalRevision === null ||
    sourceRevision === null ||
    storeFingerprint === null
  ) {
    throw new Error("Disabled-skill catalog returned no source identity")
  }
  return {
    disabledSkillIds,
    sourceKey,
    catalogGlobalRevision,
    sourceRevision,
    storeFingerprint
  }
}

/**
 * Retry only source conflicts (revision or content fingerprint). Worker
 * failures and truncated projections are surfaced to the caller; silently
 * applying either would risk data loss.
 */
export async function commitCanonicalDisabledSkillMutation<T>(
  readPage: DisabledSkillCatalogPageReader,
  commit: (snapshot: CanonicalDisabledSkillSnapshot) => T | null,
  maxAttempts = MAX_DISABLED_SKILL_CAS_ATTEMPTS
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await waitForSkillCatalogTopologyIdle()
    const snapshot = await readCanonicalDisabledSkillSnapshot(readPage)
    const result = commit(snapshot)
    if (result !== null) return result
  }
  throw new Error("技能禁用状态正在被其他窗口修改，请重试")
}

/** Cross-window mutations share one async worker-scan/write critical section. */
export class DisabledSkillMutationQueue {
  private tail: Promise<void> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
