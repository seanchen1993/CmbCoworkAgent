import type { BrowserScriptLibraryEntry } from "../../../shared/browser-types"

function normalizeBrowserRecordingName(name: string): string {
  return name.trim().toLocaleLowerCase()
}

export function hasBrowserRecordingNameConflict(
  entries: BrowserScriptLibraryEntry[],
  displayName: string
): boolean {
  const normalizedName = normalizeBrowserRecordingName(displayName)
  return (
    Boolean(normalizedName) &&
    entries.some((entry) => normalizeBrowserRecordingName(entry.displayName) === normalizedName)
  )
}
