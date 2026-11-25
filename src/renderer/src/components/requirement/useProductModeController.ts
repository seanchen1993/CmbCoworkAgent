import { useCallback, useEffect, useState } from "react"
import { useAppStore } from "@/lib/store"
import {
  initializeRequirementProductState,
  setRequirementNavigation,
  useRequirementProductStore
} from "@/lib/requirement-product-store"

export function useProductModeController(): {
  activeModeTab: "design" | "requirements"
  productEntryKey: number
  openDesignGallery: boolean
  productNavigationVisible: boolean
  setProductNavigationVisible: (visible: boolean) => void
  selectRequirementHistory: () => void
  selectProductModeTab: (tab: "design" | "requirements") => void
} {
  const [activeModeTab, setActiveModeTab] = useState<"design" | "requirements">("requirements")
  const [productEntryKey, setProductEntryKey] = useState(0)
  const [openDesignGallery, setOpenDesignGallery] = useState(false)
  const [productNavigationVisible, setProductNavigationVisible] = useState(true)

  const selectRequirementHistory = useCallback(() => {
    const wasHydrated = useRequirementProductStore.getState().hydrated
    initializeRequirementProductState()
    if (wasHydrated) setRequirementNavigation(null)
    setProductNavigationVisible(true)
    setProductEntryKey((current) => current + 1)
    setActiveModeTab("requirements")
    useAppStore.getState().setMainView("design")
  }, [])

  const selectProductModeTab = useCallback((tab: "design" | "requirements") => {
    setProductNavigationVisible(true)
    if (tab === "design") {
      setOpenDesignGallery(true)
    } else {
      setRequirementNavigation(null)
      setProductEntryKey((current) => current + 1)
    }
    setActiveModeTab(tab)
  }, [])

  useEffect(() => {
    return useRequirementProductStore.subscribe((state, previous) => {
      if (state.navigation === previous.navigation) return
      if (state.navigation?.target === "design") {
        setProductNavigationVisible(false)
        setOpenDesignGallery(false)
        setActiveModeTab("design")
        useAppStore.getState().setMainView("design")
      } else if (state.navigation?.target === "requirement") {
        setProductNavigationVisible(false)
        setActiveModeTab("requirements")
        useAppStore.getState().setMainView("design")
      }
    })
  }, [])

  return {
    activeModeTab,
    productEntryKey,
    openDesignGallery,
    productNavigationVisible,
    setProductNavigationVisible,
    selectRequirementHistory,
    selectProductModeTab
  }
}
