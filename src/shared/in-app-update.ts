export function supportsInAppUpdates(platform: string | undefined): boolean {
  // macOS installs each version as a complete app bundle from a DMG.
  return platform !== "darwin"
}
