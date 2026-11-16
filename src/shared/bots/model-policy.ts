/** Only Bot-created desktop work has a local routing choice. Existing conversations keep theirs. */
export function isBotCreatedWorkMetadata(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.botHostId === "local" &&
    metadata.botLocalConversation === true && metadata.botWorkOrigin === "created" &&
    metadata.botAudienceKey === "desktop" &&
    typeof metadata.botId === "string" && metadata.botId.length > 0 &&
    typeof metadata.botWorkId === "string" && metadata.botWorkId.length > 0 &&
    metadata.botGroupId == null && metadata.botMockBindingId == null
}

export function botWorkModelRoutingMode(
  metadata: Record<string, unknown> | null | undefined
): "pinned" | undefined {
  if (!isBotCreatedWorkMetadata(metadata)) return undefined
  const mode = metadata?.botWorkModelRoutingMode
  return mode === "pinned" ? mode : undefined
}

export function botWorkFollowsGlobalModel(
  metadata: Record<string, unknown> | null | undefined
): boolean {
  return isBotCreatedWorkMetadata(metadata) && metadata?.botWorkModelRoutingMode === "default"
}

/** Use the existing custom-config order, not the catalog's default-first display order. */
export function resolveLegacyBotWorkModelRef(
  modelRef: string, customConfigs: ReadonlyArray<{ id: string; model: string }>
): string {
  if (!modelRef.startsWith("custom:")) return modelRef
  const value = modelRef.slice("custom:".length)
  const config = customConfigs.find(item => item.id === value) ??
    customConfigs.find(item => item.model === value)
  return config ? `custom:${config.id}` : modelRef
}

/** Initialize a newly bound work. Never infer a new policy for already-bound legacy work. */
export function inheritBotWorkModelRouting(
  metadata: Record<string, unknown>, modelRef: string | null
): Record<string, unknown> {
  if (!isBotCreatedWorkMetadata(metadata)) return metadata
  const mode = metadata.botWorkModelRoutingMode
  if (mode === "default" || mode === "pinned") return metadata
  return {
    ...metadata,
    botWorkModelRoutingMode: modelRef ? "pinned" : "default",
    // The first binding inherits policy and model from the same current Bot setting.
    // An earlier unbound turn may have used a different model.
    ...(modelRef ? { model: modelRef } : {})
  }
}
