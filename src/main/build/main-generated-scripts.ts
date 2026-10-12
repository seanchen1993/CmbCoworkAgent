import { lstat, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"
import type { Plugin } from "vite"

export const MAIN_GENERATED_SCRIPTS = [
  "generated/injectedScriptSource.js",
  "generated/pollingRecorderSource.js"
] as const
const sourceLimit = 4 * 1024 * 1024

/** These vendored recorder scripts remain relative require() dependencies of
 * Main. Emit them before generateBundle so the code seal covers their bytes. */
export function mainGeneratedScriptsPlugin(
  directory = resolve("src/main/browser/record/common/playwright-codegen/generated")
): Plugin {
  return {
    name: "emit-main-generated-scripts",
    async buildStart() {
      if ((await realpath(directory)) !== directory || !(await lstat(directory)).isDirectory())
        throw new Error("Generated Main script directory is not physical")
      for (const name of MAIN_GENERATED_SCRIPTS) {
        const file = join(directory, name.slice("generated/".length))
        this.addWatchFile(file)
        const before = await lstat(file, { bigint: true })
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
          throw new Error("Generated Main script is not physical")
        const opened = await openStableFileHandle(directory, file)
        try {
          if (
            opened.filePath !== file ||
            opened.identity.device !== before.dev ||
            opened.identity.inode !== before.ino ||
            opened.identity.size !== before.size ||
            opened.identity.modifiedNs !== before.mtimeNs ||
            opened.identity.changedNs !== before.ctimeNs
          )
            throw new Error("Generated Main script changed before reading")
          this.emitFile({
            type: "asset",
            fileName: name,
            source: await readStableFileHandleBounded(opened, sourceLimit)
          })
        } finally {
          await opened.handle.close()
        }
      }
    }
  }
}
