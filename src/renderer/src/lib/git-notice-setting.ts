type State = {
  gitChangeNoticeRevision: number
  gitChangeNoticePendingByThread: Record<string, boolean>
}

/** A slow save/read reply cannot overwrite a newer actual setting broadcast. */
export function gitNoticeSettingPatch(state: State, received: unknown) {
  if (!received || typeof received !== "object") return {}
  const current = received as { value?: unknown; revision?: unknown }
  if (
    typeof current.value !== "boolean" ||
    typeof current.revision !== "string" ||
    !/^\d+$/.test(current.revision)
  )
    return {}
  const revision = Number(current.revision)
  if (!Number.isSafeInteger(revision) || revision < state.gitChangeNoticeRevision) return {}
  return {
    gitChangeNoticeEnabled: current.value,
    gitChangeNoticeRevision: revision,
    ...(current.value ? {} : { gitChangeNoticePendingByThread: {} })
  }
}
