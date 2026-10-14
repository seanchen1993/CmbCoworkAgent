import { createContext, useContext } from "react"

export const SettingsReturnFocusContext = createContext<() => void>(() => {})

export const useSettingsComposerReturn = () => useContext(SettingsReturnFocusContext)
