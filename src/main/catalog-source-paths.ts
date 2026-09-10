import { stat } from "node:fs/promises"
import { join } from "node:path"
import { app } from "electron"
import { getCmbCoworkAgentDataRoot } from "./app-data-root"

export interface CatalogSourcePaths {
  openworkDir: string
  builtinSkillsDir: string
  customSkillsDir: string
}

let cachedPaths: Promise<CatalogSourcePaths> | null = null

async function firstReadableDirectory(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) return candidate
    } catch {
      // Try the next supported packaged/development layout.
    }
  }
  return candidates[0]
}

/** Resolve catalog paths without blocking filesystem calls on Electron's main thread. */
export function getCatalogSourcePaths(): Promise<CatalogSourcePaths> {
  cachedPaths ??= (async () => {
    const openworkDir = getCmbCoworkAgentDataRoot()
    const developmentSkills = join(process.cwd(), "skills")
    const candidates = app?.isPackaged
      ? [
          join(app.getAppPath(), "out", "skills"),
          join(process.resourcesPath, "out", "skills"),
          join(process.resourcesPath, "skills"),
          developmentSkills
        ]
      : [
          developmentSkills,
          join(__dirname, "..", "..", "skills"),
          join(__dirname, "..", "..", "..", "skills")
        ]
    return {
      openworkDir,
      builtinSkillsDir: await firstReadableDirectory(candidates),
      customSkillsDir: join(openworkDir, "skills")
    }
  })().catch((error) => {
    cachedPaths = null
    throw error
  })
  return cachedPaths
}

export function resetCatalogSourcePathsForTests(): void {
  cachedPaths = null
}
