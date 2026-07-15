export const PROJECT_MODE_MEMORY_ENV = "VITE_PROJECT_MODE_MEMORY_ENABLED"

export function isProjectModeMemoryEnabled(): boolean {
  return (import.meta.env[PROJECT_MODE_MEMORY_ENV] as string | undefined)?.trim() === "1"
}

export function isMemoryAllowedForProjectMode(featureId?: string): boolean {
  return !featureId || isProjectModeMemoryEnabled()
}
