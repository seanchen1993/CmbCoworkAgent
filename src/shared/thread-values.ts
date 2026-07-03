export type ThreadValuesObject = Record<string, unknown>

const MESSAGE_TIMES_KEY = "messageTimes"
const MESSAGE_TIME_ORDER_KEY = "messageTimeOrder"
const INTERNAL_GOAL_MESSAGE_TIMES_KEY = "internalGoalMessageTimes"
const INTERNAL_GOAL_MESSAGE_TIME_ORDER_KEY = "internalGoalMessageTimeOrder"
const ID_MERGE_ARRAY_KEYS = new Set([
  MESSAGE_TIME_ORDER_KEY,
  INTERNAL_GOAL_MESSAGE_TIME_ORDER_KEY
])

const isRecord = (value: unknown): value is ThreadValuesObject => {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

const isEntryWithId = (value: unknown): value is ThreadValuesObject & { id: string } => {
  return isRecord(value) && typeof value.id === "string"
}

const isEntryWithIdArray = (
  value: unknown
): value is Array<ThreadValuesObject & { id: string }> => {
  return Array.isArray(value) && value.every(isEntryWithId)
}

const cloneValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (isRecord(value)) return mergeThreadValueObjects({}, value)
  return value
}

const orderEntriesFromTimeMap = (
  value: unknown
): Array<ThreadValuesObject & { id: string }> | undefined => {
  if (!isRecord(value)) return undefined

  const entries = Object.entries(value)
    .filter((entry): entry is [string, ThreadValuesObject] => isRecord(entry[1]))
    .map(([id, time]) => ({ id, ...time }))

  return entries.length > 0 ? entries : undefined
}

const seedOrderArrayFromLegacyMap = (
  state: ThreadValuesObject,
  orderKey: string
): Array<ThreadValuesObject & { id: string }> | undefined => {
  const existingOrder = state[orderKey]
  if (isEntryWithIdArray(existingOrder)) return existingOrder

  if (existingOrder !== undefined) return undefined

  if (orderKey === MESSAGE_TIME_ORDER_KEY) {
    return orderEntriesFromTimeMap(state[MESSAGE_TIMES_KEY])
  }

  if (orderKey === INTERNAL_GOAL_MESSAGE_TIME_ORDER_KEY) {
    return orderEntriesFromTimeMap(state[INTERNAL_GOAL_MESSAGE_TIMES_KEY])
  }

  return undefined
}

const mergeEntryArraysById = (
  existing: Array<ThreadValuesObject & { id: string }>,
  patch: Array<ThreadValuesObject & { id: string }>
): Array<ThreadValuesObject & { id: string }> => {
  // Arrays with stable ids are additive patches: an empty patch intentionally
  // means "no changes", not "clear the existing array".
  const next = existing.map((entry) => ({ ...entry }))
  const indexes = new Map(next.map((entry, index) => [entry.id, index]))

  for (const patchEntry of patch) {
    const existingIndex = indexes.get(patchEntry.id)
    if (existingIndex === undefined) {
      indexes.set(patchEntry.id, next.length)
      next.push({ ...patchEntry })
      continue
    }

    next[existingIndex] = mergeThreadValueObjects(
      next[existingIndex],
      patchEntry
    ) as ThreadValuesObject & {
      id: string
    }
  }

  return next
}

export function mergeThreadValueObjects(
  existing: ThreadValuesObject | undefined,
  patch: ThreadValuesObject | undefined
): ThreadValuesObject {
  const next: ThreadValuesObject = isRecord(existing) ? { ...existing } : {}
  if (!isRecord(patch)) return next

  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) continue

    const existingValue = seedOrderArrayFromLegacyMap(next, key) ?? next[key]
    if (
      ID_MERGE_ARRAY_KEYS.has(key) &&
      isEntryWithIdArray(existingValue) &&
      isEntryWithIdArray(patchValue)
    ) {
      next[key] = mergeEntryArraysById(existingValue, patchValue)
    } else if (isRecord(existingValue) && isRecord(patchValue)) {
      next[key] = mergeThreadValueObjects(existingValue, patchValue)
    } else {
      next[key] = cloneValue(patchValue)
    }
  }

  return next
}
