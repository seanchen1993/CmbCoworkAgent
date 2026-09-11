const APPLE_INTELLIGENCE_GLOW_STORAGE_KEY = "cmb:apple-intelligence-glow-enabled"
const APPLE_INTELLIGENCE_GLOW_CHANGED_EVENT = "cmb:apple-intelligence-glow-changed"

export function getAppleIntelligenceGlowEnabled(): boolean {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(APPLE_INTELLIGENCE_GLOW_STORAGE_KEY) === "true"
  } catch {
    return false
  }
}

export function setAppleIntelligenceGlowEnabled(enabled: boolean): void {
  if (enabled) {
    window.localStorage.setItem(APPLE_INTELLIGENCE_GLOW_STORAGE_KEY, "true")
  } else {
    window.localStorage.removeItem(APPLE_INTELLIGENCE_GLOW_STORAGE_KEY)
  }
  window.dispatchEvent(new Event(APPLE_INTELLIGENCE_GLOW_CHANGED_EVENT))
}

export function subscribeAppleIntelligenceGlow(
  onStoreChange: () => void
): () => void {
  const handlePreferenceChange = (): void => onStoreChange()
  const handleStorageChange = (event: StorageEvent): void => {
    if (event.key === APPLE_INTELLIGENCE_GLOW_STORAGE_KEY) onStoreChange()
  }

  window.addEventListener(APPLE_INTELLIGENCE_GLOW_CHANGED_EVENT, handlePreferenceChange)
  window.addEventListener("storage", handleStorageChange)
  return () => {
    window.removeEventListener(APPLE_INTELLIGENCE_GLOW_CHANGED_EVENT, handlePreferenceChange)
    window.removeEventListener("storage", handleStorageChange)
  }
}
