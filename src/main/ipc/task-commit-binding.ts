import { randomUUID } from "node:crypto"
import { BrowserWindow, dialog, type IpcMain, type IpcMainInvokeEvent } from "electron"
import type { TaskCommitBindingEditor } from "../../shared/task-commit-binding"
import { getAgentAutoCommitWorkspaceCard } from "../storage"
import { isTrustedRendererUrl } from "../main-log-forwarding"
import {
  onFeatureRepositoryMappingChange,
  onHarnessFeatureCatalogChange
} from "../harness-board/feature-catalog-lifecycle"
import { discoverWorkspaceGitRepositories } from "../services/git-repository-discovery"
import {
  authorizeTaskCommitBinding,
  beginTaskCommitBindingEdit,
  canonicalCommitRepository,
  checkoutIdentity,
  invalidateMissingTaskCommitFeatures,
  invalidateRemovedTaskCommitMappings,
  readTaskCommitBinding,
  readTaskFeatureMappings,
  revokeTaskCommitBinding
} from "../services/task-commit-binding"

interface Editor {
  owner: number
  token: string
  state: ReturnType<typeof beginTaskCommitBindingEdit>
  allowed: Map<string, string>
  mapped: Map<string, { id: string; sourcePath: string }>
}

/** A hosted desktop document may use fragment-based routes. Its HTTPS origin,
 * path and query must match the build's configured renderer entry. */
export function isTaskCommitRendererUrl(
  actual: string | undefined,
  bundled: string,
  configured: string | undefined
): boolean {
  if (isTrustedRendererUrl(actual, bundled) || isTrustedRendererUrl(actual, configured)) return true
  if (!actual || !configured) return false
  try {
    const expected = new URL(configured)
    const current = new URL(actual)
    if (expected.protocol !== "https:" || expected.username || expected.password) return false
    expected.hash = ""
    current.hash = ""
    return current.href === expected.href
  } catch {
    return false
  }
}

/** Only the app's top-level desktop UI can create or change a task authorization. */
export function registerTaskCommitBindingHandlers(
  ipc: IpcMain,
  trusted: (event: IpcMainInvokeEvent) => boolean,
  notifyChanged: (threadId: string) => void
): void {
  let editor: Editor | null = null
  onHarnessFeatureCatalogChange((id, slugs) => {
    invalidateMissingTaskCommitFeatures(id, slugs).forEach(notifyChanged)
    if (editor?.state.feature?.projectId === id && !slugs.has(editor.state.feature.slug))
      editor = null
  })
  onFeatureRepositoryMappingChange((projectId, slug, mappings) => {
    const paths = new Map(mappings.map((unit) => [unit.deployUnitIdMapping, unit.localRepoPath]))
    invalidateRemovedTaskCommitMappings(projectId, slug, paths).forEach(notifyChanged)
    if (
      editor?.state.feature?.projectId === projectId &&
      editor.state.feature.slug === slug &&
      [...editor.mapped.values()].some((unit) => paths.get(unit.id) !== unit.sourcePath)
    )
      editor = null
  })
  const assertOwner = (event: IpcMainInvokeEvent) => {
    if (!trusted(event)) throw new Error("请在桌面任务窗口设置提交授权")
  }
  const current = (event: IpcMainInvokeEvent, token: string): Editor => {
    assertOwner(event)
    if (!editor || editor.token !== token || editor.owner !== event.sender.id) {
      throw new Error("提交设置已过期，请重新打开")
    }
    return editor
  }

  ipc.handle("taskCommitBinding:read", async (event, threadId: string) => {
    assertOwner(event)
    const binding = await readTaskCommitBinding(threadId)
    if (!binding) return null
    const { cardNumber, repositoryPaths, version, workspacePath } = binding
    return { cardNumber, repositoryPaths, version, workspacePath }
  })

  ipc.handle(
    "taskCommitBinding:open",
    async (event, threadId: string): Promise<TaskCommitBindingEditor> => {
      assertOwner(event)
      await readTaskCommitBinding(threadId)
      const state = beginTaskCommitBindingEdit(threadId)
      const { workspacePath } = state.identity
      const token = randomUUID()
      const session: Editor = {
        owner: event.sender.id,
        token,
        state,
        allowed: new Map(),
        mapped: new Map()
      }
      editor = session
      const workspaceRepos = await discoverWorkspaceGitRepositories(workspacePath)
      let warning: string | undefined
      const mapped =
        state.feature && !state.isIsolated
          ? await readTaskFeatureMappings(state.feature).catch(() => {
              warning = "当前项目的发布单元配置不可用。可重新选择本地仓库或撤销现有授权。"
              return null
            })
          : null
      const candidates = new Set([
        ...(state.binding?.repositoryPaths ?? []),
        ...(mapped?.selectedDeployUnitMappings.map((unit) => unit.localRepoPath) ?? []),
        ...workspaceRepos.map((repo) => repo.repoPath)
      ])
      for (const candidate of candidates) {
        try {
          const root = await canonicalCommitRepository(candidate, workspacePath, state.isIsolated)
          session.allowed.set(root, checkoutIdentity(root))
          const mapping = mapped?.selectedDeployUnitMappings.find(
            (unit) => unit.localRepoPath === candidate
          )
          if (mapping)
            session.mapped.set(root, { id: mapping.deployUnitIdMapping, sourcePath: candidate })
        } catch {
          // A removed/moved checkout cannot be authorized. The user can still revoke or replace it.
        }
      }
      current(event, token)
      const repositories = Array.from(session.allowed.keys())
      const defaults = session.mapped.size
        ? Array.from(session.mapped.keys())
        : repositories.length === 1
          ? repositories
          : []
      const selected = state.binding
        ? repositories.filter((item) => state.binding!.repositoryPaths.includes(item))
        : defaults
      return {
        token,
        repositories,
        selected,
        active: state.configured,
        warning,
        cardNumber:
          state.binding?.cardNumber ??
          getAgentAutoCommitWorkspaceCard(workspacePath).cardNumber ??
          ""
      }
    }
  )

  ipc.handle("taskCommitBinding:choose", async (event, token: string) => {
    const { state, allowed } = current(event, token)
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner) throw new Error("找不到当前任务窗口")
    const result = await dialog.showOpenDialog(owner, {
      title: "选择本任务可以提交的 Git 工作树根目录",
      properties: ["openDirectory", "multiSelections"]
    })
    if (result.canceled) return []
    const roots = await Promise.all(
      result.filePaths.map((selected) =>
        canonicalCommitRepository(selected, state.identity.workspacePath, state.isIsolated)
      )
    )
    current(event, token)
    for (const root of roots) allowed.set(root, checkoutIdentity(root))
    return roots
  })

  ipc.handle(
    "taskCommitBinding:save",
    async (event, token: string, card: string, roots: string[]) => {
      const { state, allowed, mapped } = current(event, token)
      if (!Array.isArray(roots) || !roots.length || !roots.every((value) => allowed.has(value))) {
        throw new Error("请选择本次设置中显示的仓库")
      }
      const pathsByMappingId: Record<string, string> = Object.create(null)
      for (const root of roots) {
        const entry = mapped.get(root)
        if (entry) pathsByMappingId[entry.id] = entry.sourcePath
      }
      const feature =
        state.feature && Object.keys(pathsByMappingId).length
          ? { ...state.feature, pathsByMappingId }
          : undefined
      const result = await authorizeTaskCommitBinding(
        state.identity,
        card,
        [...new Set(roots)],
        state.isIsolated,
        feature,
        () => {
          current(event, token)
          if (roots.some((root) => checkoutIdentity(root) !== allowed.get(root))) {
            throw new Error("仓库已更换，请重新打开设置")
          }
        }
      )
      if (editor?.token === token) editor = null
      notifyChanged(state.identity.threadId)
      return result
    }
  )

  ipc.handle("taskCommitBinding:revoke", (event, token: string) => {
    const { state } = current(event, token)
    revokeTaskCommitBinding(state.identity)
    notifyChanged(state.identity.threadId)
    editor = null
  })
}
