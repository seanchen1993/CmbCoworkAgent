import { statSync } from "node:fs"

function fingerprint(path: string): string {
  const stat = statSync(path, { bigint: true })
  if (!stat.isFile()) throw new Error("MODS_SETTINGS_NOT_FILE")
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
}

/** Cache only a denial. Enabled authority is always read again from the settings store. */
export function createDisabledSwitchReader(path: string, load: () => boolean) {
  let disabledFingerprint: string | undefined
  return {
    invalidate() {
      disabledFingerprint = undefined
    },
    read(): boolean {
      try {
        const before = fingerprint(path)
        if (disabledFingerprint === before) return false
        disabledFingerprint = undefined
        const enabled = load() === true
        // A concurrent settings write must not authorize work using the previous value.
        if (fingerprint(path) !== before) return false
        if (!enabled) disabledFingerprint = before
        return enabled
      } catch {
        disabledFingerprint = undefined
        return false
      }
    }
  }
}
