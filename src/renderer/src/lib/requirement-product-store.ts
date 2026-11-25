import { create } from "zustand"

import type { RequirementDesignEntry } from "./requirement-design-entry"
import type {
  RequirementDevelopmentAssociation,
  RequirementDevelopmentOnboardingIntent
} from "./requirement-development"

export const REQUIREMENT_RELATIONS_STORAGE_KEY = "requirement:relations"
export const REQUIREMENT_SETTINGS_STORAGE_KEY = "requirement:user-settings"

const LEGACY_DESIGN_RELATIONS_KEY = "requirement-design-associations"
const LEGACY_DEVELOPMENT_RELATIONS_KEY = "requirement-development-associations"
const LEGACY_SELECTED_SYSTEM_KEY = "requirement:last-selected-system-id"
const LEGACY_CUSTOM_SYSTEMS_KEY = "requirement:custom-systems"
const LEGACY_PERSONA_KEY = "requirement:quick-start-persona"
const LEGACY_SKIP_PERSONA_KEY = "requirement:quick-start-skip-persona"
const LEGACY_DESIGN_NAVIGATION_KEY = "pending-requirement-design"
const LEGACY_REQUIREMENT_NAVIGATION_KEY = "pending-requirement-conversation"
const LEGACY_DEVELOPMENT_NAVIGATION_KEY = "requirement-development:onboarding"

export type RequirementPersona = "business" | "design" | "development"

export type RequirementUserSettings = {
  version: 1
  selectedSystemId: string | null
  customSystems: unknown[]
  quickStart: {
    persona: RequirementPersona | null
    skipPersonaSelection: boolean
  }
}

export type RequirementRelations = {
  version: 1
  requirements: Record<
    string,
    {
      designSessions: Record<string, RequirementDesignEntry>
      developmentThreads: Record<string, RequirementDevelopmentAssociation>
    }
  >
}

type RequirementProductState = {
  hydrated: boolean
  settings: RequirementUserSettings
  relations: RequirementRelations
  navigation: RequirementNavigation | null
}

export type RequirementNavigation =
  | { target: "design"; entries: RequirementDesignEntry[] }
  | { target: "requirement"; requirementId: string; threadId?: string }
  | { target: "development"; intent: RequirementDevelopmentOnboardingIntent }

const defaultSettings = (): RequirementUserSettings => ({
  version: 1,
  selectedSystemId: null,
  customSystems: [],
  quickStart: { persona: null, skipPersonaSelection: false }
})

const defaultRelations = (): RequirementRelations => ({ version: 1, requirements: {} })

export const useRequirementProductStore = create<RequirementProductState>(() => ({
  hydrated: false,
  settings: defaultSettings(),
  relations: defaultRelations(),
  navigation: null
}))

let initializing = false

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function parsePersona(value: unknown): RequirementPersona | null {
  return value === "business" || value === "design" || value === "development" ? value : null
}

function readSettings(storage: Storage): RequirementUserSettings {
  const current = parseObject(storage.getItem(REQUIREMENT_SETTINGS_STORAGE_KEY))
  if (current?.version === 1) {
    const quickStart = parseObject(JSON.stringify(current.quickStart ?? {})) ?? {}
    return {
      version: 1,
      selectedSystemId:
        typeof current.selectedSystemId === "string" ? current.selectedSystemId : null,
      customSystems: Array.isArray(current.customSystems) ? current.customSystems : [],
      quickStart: {
        persona: parsePersona(quickStart.persona),
        skipPersonaSelection: quickStart.skipPersonaSelection === true
      }
    }
  }

  const customSystems = (() => {
    try {
      const value = JSON.parse(storage.getItem(LEGACY_CUSTOM_SYSTEMS_KEY) || "[]")
      return Array.isArray(value) ? value : []
    } catch {
      return []
    }
  })()
  const migrated: RequirementUserSettings = {
    version: 1,
    selectedSystemId: storage.getItem(LEGACY_SELECTED_SYSTEM_KEY),
    customSystems,
    quickStart: {
      persona: parsePersona(storage.getItem(LEGACY_PERSONA_KEY)),
      skipPersonaSelection: storage.getItem(LEGACY_SKIP_PERSONA_KEY) === "true"
    }
  }
  storage.setItem(REQUIREMENT_SETTINGS_STORAGE_KEY, JSON.stringify(migrated))
  for (const key of [
    LEGACY_SELECTED_SYSTEM_KEY,
    LEGACY_CUSTOM_SYSTEMS_KEY,
    LEGACY_PERSONA_KEY,
    LEGACY_SKIP_PERSONA_KEY
  ]) storage.removeItem(key)
  return migrated
}

function validRelations(value: Record<string, unknown> | null): RequirementRelations | null {
  if (value?.version !== 1 || !value.requirements || typeof value.requirements !== "object") return null
  return value as RequirementRelations
}

function readRelations(storage: Storage): RequirementRelations {
  const current = validRelations(parseObject(storage.getItem(REQUIREMENT_RELATIONS_STORAGE_KEY)))
  if (current) return current

  const migrated = defaultRelations()
  const design = parseObject(storage.getItem(LEGACY_DESIGN_RELATIONS_KEY)) ?? {}
  for (const [sessionId, raw] of Object.entries(design)) {
    const entry = raw as RequirementDesignEntry
    if (!entry?.requirementId || entry.htmlId !== sessionId) continue
    const node = (migrated.requirements[entry.requirementId] ??= {
      designSessions: {},
      developmentThreads: {}
    })
    node.designSessions[sessionId] = entry
  }
  const development = parseObject(storage.getItem(LEGACY_DEVELOPMENT_RELATIONS_KEY)) ?? {}
  for (const [threadId, raw] of Object.entries(development)) {
    const entry = raw as RequirementDevelopmentAssociation
    if (!entry?.requirementId || entry.threadId !== threadId) continue
    const node = (migrated.requirements[entry.requirementId] ??= {
      designSessions: {},
      developmentThreads: {}
    })
    node.developmentThreads[threadId] = entry
  }
  storage.setItem(REQUIREMENT_RELATIONS_STORAGE_KEY, JSON.stringify(migrated))
  storage.removeItem(LEGACY_DESIGN_RELATIONS_KEY)
  storage.removeItem(LEGACY_DEVELOPMENT_RELATIONS_KEY)
  return migrated
}

/** Lazily hydrate once, immediately before the product mode is first shown. */
export function initializeRequirementProductState(storage: Storage = localStorage): void {
  if (useRequirementProductStore.getState().hydrated || initializing) return
  initializing = true
  try {
    const settings = readSettings(storage)
    const relations = readRelations(storage)
    let navigation: RequirementNavigation | null = null
    const designPayload = parseObject(storage.getItem(LEGACY_DESIGN_NAVIGATION_KEY))
    if (designPayload) {
      const entries = Array.isArray(designPayload.entries)
        ? (designPayload.entries as RequirementDesignEntry[])
        : [designPayload as RequirementDesignEntry]
      navigation = { target: "design", entries }
    } else {
      const requirementId = storage.getItem(LEGACY_REQUIREMENT_NAVIGATION_KEY)
      const developmentIntent = parseObject(storage.getItem(LEGACY_DEVELOPMENT_NAVIGATION_KEY))
      if (requirementId) navigation = { target: "requirement", requirementId }
      else if (developmentIntent) {
        navigation = {
          target: "development",
          intent: developmentIntent as RequirementDevelopmentOnboardingIntent
        }
      }
    }
    for (const key of [
      LEGACY_DESIGN_NAVIGATION_KEY,
      LEGACY_REQUIREMENT_NAVIGATION_KEY,
      LEGACY_DEVELOPMENT_NAVIGATION_KEY
    ]) storage.removeItem(key)
    useRequirementProductStore.setState({ settings, relations, navigation, hydrated: true })
  } finally {
    initializing = false
  }
}

function ensureHydrated(): RequirementProductState {
  initializeRequirementProductState()
  return useRequirementProductStore.getState()
}

export function getRequirementSettings(): RequirementUserSettings {
  return ensureHydrated().settings
}

export function updateRequirementSettings(
  updater: (current: RequirementUserSettings) => RequirementUserSettings
): void {
  const current = ensureHydrated().settings
  const next = updater(current)
  if (next === current) return
  useRequirementProductStore.setState({ settings: next })
  localStorage.setItem(REQUIREMENT_SETTINGS_STORAGE_KEY, JSON.stringify(next))
}

function isDefaultStorage(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">): boolean {
  return typeof localStorage !== "undefined" && storage === localStorage
}

export function getRequirementRelations(
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">
): RequirementRelations {
  if (storage && !isDefaultStorage(storage)) {
    return validRelations(parseObject(storage.getItem(REQUIREMENT_RELATIONS_STORAGE_KEY))) ?? defaultRelations()
  }
  return ensureHydrated().relations
}

export function setRequirementNavigation(navigation: RequirementNavigation | null): void {
  useRequirementProductStore.setState({ navigation })
}

export function removeRequirementRelations(requirementId: string): void {
  commitRequirementRelations((current) => {
    if (!current.requirements[requirementId]) return current
    const requirements = { ...current.requirements }
    delete requirements[requirementId]
    return { ...current, requirements }
  })
}

export function commitRequirementRelations(
  updater: (current: RequirementRelations) => RequirementRelations,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage
): void {
  if (!isDefaultStorage(storage)) {
    const current = getRequirementRelations(storage)
    const next = updater(current)
    if (next !== current) storage.setItem(REQUIREMENT_RELATIONS_STORAGE_KEY, JSON.stringify(next))
    return
  }
  initializeRequirementProductState()
  const current = useRequirementProductStore.getState().relations
  const next = updater(current)
  if (next === current) return
  useRequirementProductStore.setState({ relations: next })
  storage.setItem(REQUIREMENT_RELATIONS_STORAGE_KEY, JSON.stringify(next))
}

export function resetRequirementProductStoreForTests(): void {
  initializing = false
  useRequirementProductStore.setState({
    hydrated: false,
    settings: defaultSettings(),
    relations: defaultRelations(),
    navigation: null
  })
}
