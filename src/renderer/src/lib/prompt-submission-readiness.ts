/** Pending display authorization is distinct from a confirmed native/Mods-off route. */
export function isPromptSubmissionReady(state: {
  workspace: string | null | undefined
  modsEnabled: boolean
  modsReady: boolean
  editorReady: boolean
  isCurrent(): boolean
}): boolean {
  if (state.workspace?.trim() && (!state.modsReady || !state.isCurrent())) return false
  return !state.modsEnabled || state.editorReady
}
