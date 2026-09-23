import { join } from "node:path"

/** The compiler requires real file identities; ASAR virtual files cannot supply them. */
export function bundledModExamplesRoot(mainDirectory: string): string {
  return join(mainDirectory, "../resources/mods").replace(
    /\.asar([\\/]out[\\/]resources[\\/]mods)$/,
    ".asar.unpacked$1"
  )
}
