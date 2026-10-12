import { createHash } from "node:crypto"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { resolve } from "node:path"
import type { BotNativeDistributionPin } from "../bots/native-shell-release"

/** Shared by the desktop and independent service builders. */
export const BOT_PROCESS_ENTRIES = Object.freeze({
  "bot-host": "src/main/bots/host-entry.ts",
  "bot-backup": "src/main/bots/backup-entry.ts",
  "bot-browser-maintenance": "src/main/bots/browser-maintenance-entry.ts",
  "bot-workspace-maintenance": "src/main/bots/workspace-maintenance-entry.ts",
  "bot-computer-checkpoint": "src/main/bots/computer-checkpoint-entry.ts",
  "bot-computer-checkpoint-native": "src/main/bots/computer-checkpoint-native-entry.ts",
  "bot-backup-snapshot": "src/main/bots/backup-snapshot-entry.ts",
  "bot-shell": "src/main/bots/shell-worker-entry.ts",
  "bot-shell-owner": "src/main/bots/owned-shell-helper-entry.ts",
  "bot-native-desktop-owner": "src/main/bots/native-desktop-owner-entry.ts",
  "bot-document": "src/main/bots/document-worker-entry.ts",
  "bot-workflow": "src/main/bots/workflow-worker-entry.ts",
  "bot-worktree": "src/main/bots/worktree-worker-entry.ts",
  "bot-skill-catalog": "src/main/bots/skill-catalog-entry.ts",
  "bot-harness-catalog": "src/main/bots/harness-catalog-entry.ts",
  "mod-host": "src/main/mods/host-entry.ts",
  "function-mod-host": "src/main/mods/v2/host-entry.ts"
})

export function botBuildIdentity(
  root: string,
  nativeDistribution?: BotNativeDistributionPin
): string {
  const hash = createHash("sha256")
  const visit = (path: string): void => {
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(resolve(path, name))
    } else if (!/\.(test|spec)\./.test(path)) {
      hash.update(path.replace(resolve(root), ""))
      hash.update(readFileSync(path))
    }
  }
  for (const path of ["src/main", "src/shared", "package-lock.json", "electron.vite.config.ts"])
    visit(resolve(root, path))
  if (nativeDistribution !== undefined) hash.update(JSON.stringify({ nativeDistribution }))
  return hash.digest("hex").slice(0, 24)
}
