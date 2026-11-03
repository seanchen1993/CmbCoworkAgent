import { create } from "zustand"
import type { DesignSystemInfo } from "../design/types"

export const ALL_REQUIREMENT_SYSTEMS_VALUE = "all"
const LAST_SELECTED_REQUIREMENT_SYSTEM_KEY = "requirement:last-selected-system-id"

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
  systemList: DesignSystemInfo[]
  selectedSystemId: string | null
  setSystemList: (systems: DesignSystemInfo[]) => void
  setSelectedSystemId: (systemId: string | null) => void
}

export const useRequirementStore = create<RequirementStore>((set) => ({
  systemList: [],
  selectedSystemId: readLastSelectedSystemId(),
  setSystemList: (systemList) => {
    set((state) => {
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
  }
}))

export function getSelectedRequirementSystem(systemId: string | null): DesignSystemInfo | null {
  return findSystem(useRequirementStore.getState().systemList, systemId)
}
