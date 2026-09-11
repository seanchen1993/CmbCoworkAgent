import { runWithGitReadSignal } from "../services/git-read-context"

export type GitReadFamily = "panel" | "changed-summary" | "summary" | "workspace-probe"

export interface GitReadSender {
  id: number
  once(event: "destroyed", listener: () => void): unknown
}

interface GitReadGroup {
  threadId: string
  controllers: Set<AbortController>
}

export class GitReadRequestCoordinator {
  private readonly groups = new Map<string, GitReadGroup>()
  private readonly cleanupInstalled = new Set<number>()

  private familyPrefix(webContentsId: number, family: GitReadFamily): string {
    return `${webContentsId}:${family}:`
  }

  private key(webContentsId: number, family: GitReadFamily, lane: string): string {
    return `${this.familyPrefix(webContentsId, family)}${lane}`
  }

  private abortGroup(group: GitReadGroup): void {
    for (const controller of group.controllers) {
      controller.abort(new DOMException("Git panel read was superseded", "AbortError"))
    }
    group.controllers.clear()
  }

  cancel(webContentsId: number, family?: GitReadFamily): void {
    const prefix = `${webContentsId}:`
    for (const [key, group] of this.groups) {
      if (
        !key.startsWith(prefix) ||
        (family && !key.startsWith(this.familyPrefix(webContentsId, family)))
      ) {
        continue
      }
      this.abortGroup(group)
      this.groups.delete(key)
    }
  }

  private installCleanup(sender: GitReadSender): void {
    if (this.cleanupInstalled.has(sender.id)) return
    this.cleanupInstalled.add(sender.id)
    sender.once("destroyed", () => {
      this.cancel(sender.id)
      this.cleanupInstalled.delete(sender.id)
    })
  }

  run<T>(
    sender: GitReadSender,
    family: GitReadFamily,
    lane: string,
    threadId: string,
    action: () => Promise<T>
  ): Promise<T> {
    this.installCleanup(sender)
    const key = this.key(sender.id, family, lane)
    let group = this.groups.get(key)
    if (group) {
      this.abortGroup(group)
      this.groups.delete(key)
      group = undefined
    }
    group ??= { threadId, controllers: new Set() }
    this.groups.set(key, group)
    const controller = new AbortController()
    group.controllers.add(controller)
    return runWithGitReadSignal(controller.signal, action).finally(() => {
      group?.controllers.delete(controller)
      if (this.groups.get(key) === group && group?.controllers.size === 0) {
        this.groups.delete(key)
      }
    })
  }

  activeRequestCount(): number {
    let count = 0
    for (const group of this.groups.values()) count += group.controllers.size
    return count
  }
}

export const gitReadRequestCoordinator = new GitReadRequestCoordinator()
