import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"

/** Trusted fixture root only: Windows TEMP may use an 8.3 alias of the physical directory. */
export function canonicalTmpdir(base = tmpdir()): string {
  return realpathSync(base)
}
