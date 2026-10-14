import type { RuntimePluginSourceBinding } from "../../plugins/runtime-source-scope"

type LegacyGate = (
  projectId: string,
  featureId: string,
  workspace: string,
  source: Readonly<RuntimePluginSourceBinding> | undefined
) => void
export const LEGACY_PROJECT_SESSION_SCOPE = "__project_session__"
let gate: LegacyGate | undefined
export function registerLegacyProjectEntryGate(next: LegacyGate): () => void {
  if (gate && gate !== next) throw Error("LEGACY_ENTRY_GATE_ALREADY_REGISTERED")
  gate = next
  return () => {
    if (gate === next) gate = undefined
  }
}
/** Applies only to explicitly enabled project bindings; never changes unconfigured projects. */
export function assertLegacyProjectEntry(
  projectId: string,
  featureId: string,
  workspace: string,
  source: Readonly<RuntimePluginSourceBinding> | undefined
): void {
  gate?.(projectId, featureId || LEGACY_PROJECT_SESSION_SCOPE, workspace, source)
}
