import { readFile } from "fs/promises"
import { join } from "path"
import { getOpenworkDir } from "../storage"
import { nowIsoLocal } from "../util/local-time"

export function getRegisteredReposPath(): string {
  return join(getOpenworkDir(), "git-hooks", "repos.json")
}

export interface RegisteredGitHookRepo {
  gitRoot: string
  enabled: boolean
  registeredAt: string
  updatedAt: string
  lastSyncedAt?: string
  lastErrorAt?: string
  lastError?: string
}

export async function readRegisteredRepos(): Promise<RegisteredGitHookRepo[]> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(getRegisteredReposPath(), "utf-8"))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw.flatMap((repo): RegisteredGitHookRepo[] => {
    if (!repo || typeof repo.gitRoot !== "string" || !repo.gitRoot.trim()) return []
    return [
      {
        gitRoot: repo.gitRoot,
        enabled: repo.enabled !== false,
        registeredAt: repo.registeredAt || nowIsoLocal(),
        updatedAt: repo.updatedAt || repo.registeredAt || nowIsoLocal(),
        ...(repo.lastSyncedAt ? { lastSyncedAt: repo.lastSyncedAt } : {}),
        ...(repo.lastErrorAt ? { lastErrorAt: repo.lastErrorAt } : {}),
        ...(repo.lastError ? { lastError: repo.lastError } : {})
      }
    ]
  })
}
