import type { SkillPluginVisibilityMetadata } from "../../shared/skill-visibility"

export interface DerivationFamily {
  familyId: string
  originalId?: string
  members: string[]
  sources?: Array<{ name: string; digest: string }>
}
let families: DerivationFamily[] = []
let installationObserver:
  | ((pluginId: string, directory: string, name: string) => Promise<void>)
  | undefined

export function setDerivationInstallationObserver(
  observer: (pluginId: string, directory: string, name: string) => Promise<void>
): void {
  installationObserver = observer
}

export async function observeDerivationInstallation(
  pluginId: string,
  directory: string,
  name: string
): Promise<void> {
  await installationObserver?.(pluginId, directory, name)
}

/** Supplied only by the host-owned derivation ledger, never package manifests. */
export function setDerivationFamilies(value: DerivationFamily[]): void {
  families = structuredClone(value)
}

export function derivationVisibility(
  pluginId: string
): Pick<SkillPluginVisibilityMetadata, "derivationFamilyMembers" | "isDerivedPlugin"> {
  const family = families.find((item) => item.members.includes(pluginId))
  return family
    ? {
        derivationFamilyMembers: [...family.members],
        isDerivedPlugin: family.originalId !== pluginId
      }
    : {}
}

export function isDerivedPlugin(pluginId: string): boolean {
  return derivationVisibility(pluginId).isDerivedPlugin === true
}

export function derivationFamilyFor(pluginId: string): DerivationFamily | undefined {
  const family = families.find((item) => item.members.includes(pluginId))
  return family ? structuredClone(family) : undefined
}
