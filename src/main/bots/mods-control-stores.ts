import { lstatSync, realpathSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { ModControlStore } from "../mods/control-store"
import { ModError } from "../mods/errors"

type Entry = { store: ModControlStore; refs: number; device: bigint; inode: bigint }
const openStores = new Map<string, Entry>()

/** A Bot's parent and concurrent workflow children share the same control DB.
 * Opening another execution must not run crash recovery over live calls.
 * The exclusive Bot Host owns this process-local pool; guests never receive it. */
export function acquireBotModControlStore(path: string): {
  store: ModControlStore
  release(): void
} {
  const canonical = join(realpathSync(dirname(path)), basename(path))
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical
  let entry = openStores.get(key)
  if (entry) {
    const info = lstatSync(canonical, { bigint: true })
    if (!info.isFile() || info.dev !== entry.device || info.ino !== entry.inode)
      throw new ModError("MODS_CONTROL_RECOVERY_REQUIRED")
  } else {
    const store = new ModControlStore(canonical)
    try {
      const info = lstatSync(canonical, { bigint: true })
      if (!info.isFile()) throw new ModError("MODS_CONTROL_RECOVERY_REQUIRED")
      entry = { store, refs: 0, device: info.dev, inode: info.ino }
      openStores.set(key, entry)
    } catch (error) {
      store.close()
      throw error
    }
  }
  const current = entry
  current.refs++
  let released = false
  return {
    store: current.store,
    release() {
      if (released) return
      released = true
      if (--current.refs === 0) {
        try {
          current.store.close()
        } finally {
          openStores.delete(key)
        }
      }
    }
  }
}
