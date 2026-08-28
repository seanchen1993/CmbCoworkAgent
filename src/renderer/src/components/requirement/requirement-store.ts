import { create } from "zustand"
import type { DesignSystemInfo } from "../design/types"

export const ALL_REQUIREMENT_SYSTEMS_VALUE = "all"

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
  selectedSystemId: null,
  setSystemList: (systemList) => {
    set({ systemList })
  },
  setSelectedSystemId: (systemId) => {
    set((state) => ({
      selectedSystemId: findSystem(state.systemList, systemId)?.id ?? null
    }))
  }
}))

export function getSelectedRequirementSystem(systemId: string | null): DesignSystemInfo | null {
  return findSystem(useRequirementStore.getState().systemList, systemId)
}
