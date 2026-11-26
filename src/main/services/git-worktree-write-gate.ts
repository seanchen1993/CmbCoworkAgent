import { realpath } from "node:fs/promises"
import path from "node:path"

type WorktreeWriteKind = "checkout" | "panel"

const activeWrites = new Map<string, { kind: WorktreeWriteKind; count: number }>()
const preparingPanelWrites = new Set<Set<string>>()

export function gitWorktreeWriteKey(gitDir: string): string {
  return process.platform === "win32" ? gitDir.toLowerCase() : gitDir
}

export function normalizeGitDirPath(gitDir: string, workingDir: string): string {
  if (process.platform === "win32") {
    const posixDriveMatch = gitDir.match(/^\/([a-zA-Z])\/(.*)$/)
    if (posixDriveMatch) {
      const windowsPath = `${posixDriveMatch[1].toUpperCase()}:\\${posixDriveMatch[2].replace(/\//g, "\\")}`
      return path.resolve(windowsPath)
    }
  }

  return path.resolve(workingDir, gitDir)
}

function beginWrite(gitDir: string, kind: WorktreeWriteKind): () => void {
  const key = gitWorktreeWriteKey(gitDir)
  const active = activeWrites.get(key) ?? { kind, count: 0 }
  if (active.kind !== kind) {
    throw new Error(
      kind === "checkout"
        ? "当前工作树正在执行 Git 面板写入，请等待操作完成后再切换或创建分支"
        : "当前工作树正在切换或创建分支，请等待操作完成后重试"
    )
  }
  activeWrites.set(key, active)
  active.count++
  return () => {
    if (--active.count === 0) activeWrites.delete(key)
  }
}

// The checkout reservation includes queued checkouts. Panel writes can overlap
// with one another, and no panel write may start between queued checkouts.
export function beginGitCheckoutWrite(gitDir: string): (headChanged: boolean) => void {
  const release = beginWrite(gitDir, "checkout")
  return (headChanged) => {
    if (headChanged) {
      const key = gitWorktreeWriteKey(gitDir)
      for (const changedWorktrees of preparingPanelWrites) changedWorktrees.add(key)
    }
    release()
  }
}

export interface GitPanelWritePreparation {
  reserve(worktreePath: string, readGitDir: Promise<string>): Promise<() => void>
  dispose(): void
}

// The panel cannot identify its worktree until after async repository discovery.
// Remember checkouts that finish in that gap, then compare the physical Git directory.
export function prepareGitPanelWrite(): GitPanelWritePreparation {
  const changedWorktrees = new Set<string>()
  preparingPanelWrites.add(changedWorktrees)
  return {
    async reserve(worktreePath, readGitDir) {
      const gitDir = (await readGitDir).replace(process.platform === "win32" ? /\r?\n$/ : /\n$/, "")
      if (!gitDir) throw new Error("无法读取 Git 仓库目录")
      const base = path.isAbsolute(gitDir) ? worktreePath : await realpath(worktreePath)
      const canonicalGitDir = await realpath(normalizeGitDirPath(gitDir, base))
      if (changedWorktrees.has(gitWorktreeWriteKey(canonicalGitDir))) {
        throw new Error("当前工作树已切换分支，请刷新后重试")
      }
      return beginWrite(canonicalGitDir, "panel")
    },
    dispose() {
      preparingPanelWrites.delete(changedWorktrees)
    }
  }
}
