import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"

/** Trusted fixture root only: native realpath expands Windows 8.3 TEMP aliases consistently. */
export function canonicalTmpdir(base = tmpdir()): string {
  return realpathSync.native(base)
}
