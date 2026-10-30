import { randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { stat, rename, unlink } from "node:fs/promises"
import { pipeline } from "node:stream/promises"
import { createGunzip } from "node:zlib"

const pending = new Map<string, Promise<void>>()

/** App-owned resource only. Share extraction between model turns and explicit Mods commands. */
export function ensureCodexExe(exePath: string): Promise<void> {
  const existing = pending.get(exePath)
  if (existing) return existing
  const work = (async () => {
    const gzPath = `${exePath}.gz`
    const compressed = await stat(gzPath).catch(() => null)
    if (!compressed) return
    const executable = await stat(exePath).catch(() => null)
    if (executable && executable.mtimeMs >= compressed.mtimeMs) return
    const temporary = `${exePath}.${randomUUID()}.tmp`
    try {
      await pipeline(
        createReadStream(gzPath),
        createGunzip(),
        createWriteStream(temporary, { flags: "wx" })
      )
      await rename(temporary, exePath)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  })()
  pending.set(exePath, work)
  void work.finally(() => pending.delete(exePath)).catch(() => {})
  return work
}
