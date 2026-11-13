import { create } from "zustand"
import type { DesignSystemInfo } from "../design/types"

export const ALL_REQUIREMENT_SYSTEMS_VALUE = "all"
const LAST_SELECTED_REQUIREMENT_SYSTEM_KEY = "requirement:last-selected-system-id"
const CUSTOM_REQUIREMENT_SYSTEMS_KEY = "requirement:custom-systems"

export type RequirementSystemInfo = DesignSystemInfo & { theme?: string }

function readCustomSystems(): RequirementSystemInfo[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(CUSTOM_REQUIREMENT_SYSTEMS_KEY) || "[]")
    return Array.isArray(value)
      ? value.filter(
          (system): system is RequirementSystemInfo =>
            Boolean(system && typeof system.id === "string" && typeof system.name === "string")
        )
      : []
  } catch {
    return []
  }
}

function persistCustomSystems(systems: RequirementSystemInfo[]): void {
  try {
    window.localStorage.setItem(CUSTOM_REQUIREMENT_SYSTEMS_KEY, JSON.stringify(systems))
  } catch {
    // localStorage may be unavailable in restricted renderer contexts.
  }
}

function mergeCustomSystems(
  systems: DesignSystemInfo[],
  customSystems: RequirementSystemInfo[] = readCustomSystems()
): RequirementSystemInfo[] {
  const ids = new Set(systems.map((system) => system.id))
  return [...systems, ...customSystems.filter((system) => !ids.has(system.id))]
}

function readLastSelectedSystemId(): string | null {
  try {
    return window.localStorage.getItem(LAST_SELECTED_REQUIREMENT_SYSTEM_KEY)
  } catch {
    return null
  }
}

function persistLastSelectedSystemId(systemId: string | null): void {
  try {
    if (systemId) {
      window.localStorage.setItem(LAST_SELECTED_REQUIREMENT_SYSTEM_KEY, systemId)
    } else {
      window.localStorage.removeItem(LAST_SELECTED_REQUIREMENT_SYSTEM_KEY)
    }
  } catch {
    // localStorage may be unavailable in restricted renderer contexts.
  }
}

function findSystem(systems: DesignSystemInfo[], systemId: string | null): DesignSystemInfo | null {
  if (!systemId) return null
  return systems.find((system) => system.id === systemId) ?? null
}

type RequirementStore = {
  systemList: RequirementSystemInfo[]
  selectedSystemId: string | null
  setSystemList: (systems: DesignSystemInfo[]) => void
  setSelectedSystemId: (systemId: string | null) => void
  addCustomSystem: (name: string) => RequirementSystemInfo
}

export const useRequirementStore = create<RequirementStore>((set) => ({
  systemList: readCustomSystems(),
  selectedSystemId: readLastSelectedSystemId(),
  setSystemList: (systems) => {
    set((state) => {
      const systemList = mergeCustomSystems(
        systems,
        state.systemList.filter((system) => system.theme === "")
      )
      const selectedSystemId = findSystem(systemList, state.selectedSystemId)?.id ?? null
      if (selectedSystemId !== state.selectedSystemId) persistLastSelectedSystemId(selectedSystemId)
      return { systemList, selectedSystemId }
    })
  },
  setSelectedSystemId: (systemId) => {
    set((state) => {
      const selectedSystemId = findSystem(state.systemList, systemId)?.id ?? null
      persistLastSelectedSystemId(selectedSystemId)
      return { selectedSystemId }
    })
  },
  addCustomSystem: (name) => {
    const trimmedName = name.trim()
    const existing = useRequirementStore
      .getState()
      .systemList.find((system) => system.name.toLocaleLowerCase() === trimmedName.toLocaleLowerCase())
    if (existing) return existing
    const system: RequirementSystemInfo = {
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmedName,
      description: "用户自定义业务系统",
      category: "自定义",
      ownership: "user",
      path: "",
      theme: ""
    }
    const customSystems = [...readCustomSystems(), system]
    persistCustomSystems(customSystems)
    set((state) => ({ systemList: [...state.systemList, system] }))
    return system
  }
}))

export function getSelectedRequirementSystem(systemId: string | null): DesignSystemInfo | null {
  return findSystem(useRequirementStore.getState().systemList, systemId)
}
