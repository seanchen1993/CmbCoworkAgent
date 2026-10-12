import { realpath } from "node:fs/promises"
import { BotHostLock } from "./host-lock"
import {
  inspectBotOwnedShellMaintenance,
  ownedShellMaintenanceOwner,
  resolveBotOwnedShellResourceDiagnostics,
  resolveBotOwnedShellResourceRecord,
  type OwnedShellMaintenanceOwner
} from "./owned-shell-maintenance-fence"

export type { BotDesktopShellResourceReview as DesktopBotShellResourceReview } from "../../shared/bot-shell-resources"
import type { BotDesktopShellResourceReview as DesktopBotShellResourceReview } from "../../shared/bot-shell-resources"
async function withResourceReader<T>(
  directory: string,
  read: (
    directory: string,
    owner: OwnedShellMaintenanceOwner,
    mode: DesktopBotShellResourceReview["mode"]
  ) => Promise<T>
): Promise<T> {
  directory = await realpath(directory)
  const held = BotHostLock.acquire(directory)
  const lock = held ?? BotHostLock.observe(directory)
  try {
    return await read(
      directory,
      ownedShellMaintenanceOwner(lock),
      held ? "exclusive" : "active-owner"
    )
  } finally {
    held?.release()
  }
}

/** Main-only facade. Reached through IPC even if Host startup is blocked. It
 * never starts Host/RPC/Store, invokes a model, claims a task, or authorizes
 * mutation from a returned stale ready snapshot. The data path is Main-owned. */
export function inspectDesktopBotShellResources(
  directory: string
): Promise<DesktopBotShellResourceReview> {
  return withResourceReader(directory, async (root, owner, mode) => ({
    mode,
    review: await inspectBotOwnedShellMaintenance(root, owner)
  }))
}
export function revealDesktopBotShellResource(directory: string, nonce: string): Promise<string> {
  return withResourceReader(directory, (root, owner) =>
    resolveBotOwnedShellResourceRecord(root, nonce, owner)
  )
}
export function revealDesktopBotShellResourceDiagnostics(directory: string): Promise<string> {
  return withResourceReader(directory, (root, owner) =>
    resolveBotOwnedShellResourceDiagnostics(root, owner)
  )
}
