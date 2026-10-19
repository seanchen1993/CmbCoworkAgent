import type { RuntimePluginSourceBinding } from "../../plugins/runtime-source-scope"
import type { PluginMetadata } from "../../types"

type LegacyGate = (
  projectId: string,
  featureId: string,
  workspace: string,
  source: Readonly<RuntimePluginSourceBinding> | undefined
) => void
export const LEGACY_PROJECT_SESSION_SCOPE = "__project_session__"
let gate: LegacyGate | undefined
export interface LegacyBoundSkillSource {
  readonly plugin: Readonly<PluginMetadata>
  /** Recheck the same durable binding, source bytes and current installed owner. */
  assertCurrent(): Promise<void>
}
type LegacySkillSourceReader = <T>(projectId: string, workspace: string,
  work: (source: LegacyBoundSkillSource | undefined) => Promise<T>) => Promise<T>
let skillSourceReader: LegacySkillSourceReader | undefined
export function registerLegacyProjectEntryGate(next: LegacyGate,
  readSkillSource?: LegacySkillSourceReader): () => void {
  if (gate && gate !== next) throw Error("LEGACY_ENTRY_GATE_ALREADY_REGISTERED")
  gate = next
  skillSourceReader = readSkillSource
  return () => {
    if (gate === next) {
      gate = undefined
      skillSourceReader = undefined
    }
  }
}

/** Main-process preparation only; supplies no runtime token, grant or execution authority. */
export function withLegacyProjectSkillSource<T>(projectId: string, workspace: string,
  work: (source: LegacyBoundSkillSource | undefined) => Promise<T>): Promise<T> {
  return skillSourceReader ? skillSourceReader(projectId, workspace, work) : work(undefined)
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
