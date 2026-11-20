import { copyFileSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { resolve } from "node:path"

function copyDirectoryRecursive(sourceDir: string, destinationDir: string): void {
  mkdirSync(destinationDir, { recursive: true })
  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = resolve(sourceDir, entry)
    const destinationPath = resolve(destinationDir, entry)
    const sourceStat = lstatSync(sourcePath)
    if (sourceStat.isSymbolicLink()) {
      throw new Error(`Refusing to mirror a symbolic link: ${sourcePath}`)
    }
    if (sourceStat.isDirectory()) {
      copyDirectoryRecursive(sourcePath, destinationPath)
    } else if (sourceStat.isFile()) {
      copyFileSync(sourcePath, destinationPath)
    } else {
      throw new Error(`Refusing to mirror a non-file entry: ${sourcePath}`)
    }
  }
}

/**
 * Replace one generated directory with an exact copy of its source.
 *
 * Build outputs must not retain files deleted from source, because Electron
 * Builder packages the complete output directory into the application ASAR.
 */
export function mirrorRequiredDirectorySync(sourceDir: string, destinationDir: string): void {
  let sourceStat: ReturnType<typeof lstatSync>
  try {
    sourceStat = lstatSync(sourceDir)
  } catch (error) {
    throw new Error(`Required build resource directory is unavailable: ${sourceDir}`, {
      cause: error
    })
  }
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error(`Required build resource must be a physical directory: ${sourceDir}`)
  }

  rmSync(destinationDir, { recursive: true, force: true })
  copyDirectoryRecursive(sourceDir, destinationDir)
}
