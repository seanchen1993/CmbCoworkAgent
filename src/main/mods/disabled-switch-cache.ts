import { statSync } from "node:fs"

function fingerprint(path: string): string {
  const stat = statSync(path, { bigint: true })
  if (!stat.isFile()) throw new Error("MODS_SETTINGS_NOT_FILE")
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
}

/** Recheck file identity on every admission; reuse parsing only for exactly unchanged facts. */
export function createDisabledSwitchReader(path: string, load: () => boolean | undefined) {
  let parsed: { fingerprint: string; enabled: boolean } | undefined
  function readState(): boolean | undefined {
    try {
      const before = fingerprint(path)
      if (parsed?.fingerprint === before) return parsed.enabled
      parsed = undefined
      const enabled = load()
      if (enabled === undefined || fingerprint(path) !== before) return undefined
      parsed = { fingerprint: before, enabled }
      return enabled
    } catch {
      parsed = undefined
      return undefined
    }
  }
  return {
    invalidate() {
      parsed = undefined
    },
    readState,
    read(): boolean {
      return readState() === true
    }
  }
}
