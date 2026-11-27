import { randomUUID } from "node:crypto"
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { isValidTaskCommitCard, type TaskCommitBinding } from "../../shared/task-commit-binding"
import { getDb, getThreadCore } from "../db"
import { captureThreadIncarnation } from "./thread-incarnation"
import { getGitRootForPath } from "./git-repository-discovery"
import { captureTaskCommitBaselines } from "./task-commit-baseline"
import { getOpenworkDir } from "../storage"
import { FEATURE_V2_FILE } from "../harness-board/config-v2"

export interface MappingGuard {
  projectId: string
  slug: string
  pathsByMappingId: Record<string, string>
}

interface Guards {
  workspace: string
  checkouts: Record<string, string>
  checkoutRoots?: Record<string, string>
  feature?: MappingGuard
}

function directoryIdentity(root: string): string {
  const canonical = realpathSync.native(root)
  const info = statSync(canonical, { bigint: true })
  if (!info.isDirectory()) throw new Error("仓库目录已更换")
  return JSON.stringify([canonical, String(info.dev), String(info.ino), String(info.birthtimeNs)])
}

function gitPathFile(file: string): string {
  const info = lstatSync(file)
  if (!info.isFile() || info.size > 8192) throw new Error("Git 管理目录无效")
  return readFileSync(file, "utf8").trim()
}

function findCheckoutRoot(scope: string): string {
  let directory = scope
  while (true) {
    try {
      lstatSync(path.join(directory, ".git"))
      return directory
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const parent = path.dirname(directory)
      if (parent === directory) throw error
      directory = parent
    }
  }
}

export function checkoutIdentity(root: string): string {
  const marker = path.join(findCheckoutRoot(root), ".git")
  let dir = marker
  if (!lstatSync(marker).isDirectory()) {
    const target = gitPathFile(marker).match(/^gitdir: (.+)$/)?.[1]
    if (!target) throw new Error("Git 工作树指针无效")
    dir = path.resolve(path.dirname(marker), target)
  }
  let common = dir
  try {
    common = path.resolve(dir, gitPathFile(path.join(dir, "commondir")))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return JSON.stringify([
    directoryIdentity(root),
    directoryIdentity(dir),
    directoryIdentity(common)
  ])
}

function mappingRevision(): string {
  const info = statSync(path.join(getOpenworkDir(), FEATURE_V2_FILE), { bigint: true })
  return [info.dev, info.ino, info.ctimeNs, info.mtimeNs, info.size].join(":")
}

// A synchronous last check is allowed only for a mapping already verified against this file revision.
const checkedMappings = new Map<string, string>()

export async function readTaskFeatureMappings(feature: { projectId: string; slug: string }) {
  const { getHarnessFeatureBinding, getHarnessProjectRootPath } =
    await import("../harness-board/service")
  getHarnessProjectRootPath(feature.projectId)
  return getHarnessFeatureBinding(feature.projectId, feature.slug)
}

async function validateMapping(feature: MappingGuard): Promise<string> {
  const revision = mappingRevision()
  const binding = await readTaskFeatureMappings(feature)
  if (
    !binding ||
    !Object.entries(feature.pathsByMappingId).every(([id, root]) =>
      binding.selectedDeployUnitMappings.some(
        (mapping) =>
          mapping.deployUnitIdMapping === id && path.relative(mapping.localRepoPath, root) === ""
      )
    ) ||
    mappingRevision() !== revision
  ) {
    throw new Error("项目的发布单元仓库已更改，请重新确认提交授权")
  }
  return revision
}

interface CommitAuthorization extends TaskCommitBinding {
  dirtyAtSelection?: Record<string, string[]>
  checkoutRoots?: Record<string, string>
}

export interface CommitBindingIdentity {
  threadId: string
  workspacePath: string
  incarnation: string
  version: string
}

function loadTask(threadId: string) {
  const row = getThreadCore(threadId)
  if (!row) return null
  let metadata
  try {
    metadata = JSON.parse(row.metadata ?? "{}")
  } catch {
    return null
  }
  if (typeof metadata?.workspacePath !== "string" || !path.isAbsolute(metadata.workspacePath)) {
    return null
  }
  const incarnation = JSON.stringify(captureThreadIncarnation(row))
  return { workspacePath: metadata.workspacePath as string, incarnation, metadata }
}

function storedVersion(threadId: string, incarnation: string, workspacePath: string) {
  return getDb().exec(
    `SELECT version, card, repositories, dirty_at_selection, guards FROM task_commit_bindings
     WHERE thread_id = ? AND incarnation = ? AND workspace = ?`,
    [threadId, incarnation, workspacePath]
  )[0]?.values[0]
}

function bindingRecord(threadId: string) {
  const task = loadTask(threadId)
  if (!task) return null
  const row = storedVersion(threadId, task.incarnation, task.workspacePath)
  if (
    !row ||
    typeof row[1] !== "string" ||
    typeof row[2] !== "string" ||
    typeof row[4] !== "string"
  )
    return null
  const guards: Guards = JSON.parse(row[4])
  const binding: CommitAuthorization = {
    version: String(row[0]),
    workspacePath: task.workspacePath,
    cardNumber: row[1],
    repositoryPaths: JSON.parse(row[2]),
    dirtyAtSelection: typeof row[3] === "string" ? JSON.parse(row[3]) : undefined,
    checkoutRoots: guards.checkoutRoots
  }
  return { guards, binding }
}

export function readCurrentTaskCommitBinding(threadId: string): CommitAuthorization | null {
  const record = bindingRecord(threadId)
  if (!record) return null
  const { binding, guards } = record
  try {
    if (guards.feature && checkedMappings.get(binding.version) !== mappingRevision()) return null
    if (directoryIdentity(binding.workspacePath) !== guards.workspace) return null
    return binding.repositoryPaths.every(
      (root) =>
        !path.relative(guards.checkoutRoots?.[root] ?? root, findCheckoutRoot(root)) &&
        checkoutIdentity(root) === guards.checkouts[root]
    )
      ? binding
      : null
  } catch {
    return null
  }
}

export async function readTaskCommitBinding(threadId: string): Promise<CommitAuthorization | null> {
  const record = bindingRecord(threadId)
  if (!record) return null
  if (record.guards.feature) {
    try {
      if (checkedMappings.get(record.binding.version) !== mappingRevision()) {
        checkedMappings.set(record.binding.version, await validateMapping(record.guards.feature))
      }
    } catch {
      return null
    }
  }
  const current = readCurrentTaskCommitBinding(threadId)
  return current?.version === record.binding.version ? current : null
}

export function beginTaskCommitBindingEdit(threadId: string) {
  if (threadId.includes("__wf_")) throw new Error("隔离工作流使用已分配的原生 Git 工作树。")
  const task = loadTask(threadId)
  if (!task) throw new Error("请先为当前任务选择工作目录")
  getDb().run(
    `INSERT INTO task_commit_bindings(thread_id, incarnation, workspace, version)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET incarnation = excluded.incarnation,
       workspace = excluded.workspace, version = excluded.version, card = NULL,
       repositories = NULL, dirty_at_selection = NULL, guards = NULL
     WHERE incarnation != excluded.incarnation OR workspace != excluded.workspace`,
    [threadId, task.incarnation, task.workspacePath, randomUUID()]
  )
  const stored = storedVersion(threadId, task.incarnation, task.workspacePath)!
  const version = String(stored[0])
  const identity = {
    threadId,
    incarnation: task.incarnation,
    workspacePath: task.workspacePath,
    version
  }
  const feature = task.metadata.harnessFeature
  return {
    identity,
    configured: typeof stored[1] === "string",
    isIsolated: task.metadata.isWorktree === true,
    feature:
      typeof feature?.projectId === "string" && typeof feature.slug === "string"
        ? { projectId: feature.projectId as string, slug: feature.slug as string }
        : null,
    binding: readCurrentTaskCommitBinding(threadId)
  }
}

/** Only the session itself can be selected as a scope below its worktree root. */
export async function canonicalCommitRepository(
  selected: string,
  workspace: string,
  isolated: boolean
): Promise<string> {
  if (!path.isAbsolute(selected)) throw new Error("请选择本地 Git 仓库根目录")
  const [candidate, workspaceRoot] = await Promise.all([realpath(selected), realpath(workspace)])
  const root = await getGitRootForPath(candidate)
  if (
    !root ||
    (path.relative(candidate, await realpath(root)) !== "" &&
      path.relative(candidate, workspaceRoot) !== "")
  ) {
    throw new Error(`请选择 Git 工作树的根目录：${selected}`)
  }
  const relative = path.relative(candidate, workspaceRoot)
  if (
    relative &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  ) {
    throw new Error("仓库根目录包含当前会话子目录，请保留会话子目录的提交范围")
  }
  if (isolated && path.relative(workspaceRoot, candidate) !== "") {
    throw new Error("独立工作树任务只能绑定当前工作树")
  }
  return candidate
}

function replaceBinding(
  identity: CommitBindingIdentity,
  card: string | null,
  repos: string[] | null,
  dirtyAtSelection: Record<string, string[]> | null,
  guards: Guards | null
) {
  const { threadId, incarnation, workspacePath, version } = identity
  const next = randomUUID()
  getDb().run(
    `UPDATE task_commit_bindings SET version = ?, card = ?, repositories = ?, dirty_at_selection = ?, guards = ?
     WHERE thread_id = ? AND incarnation = ? AND workspace = ? AND version = ?`,
    [
      next,
      card,
      repos ? JSON.stringify(repos) : null,
      dirtyAtSelection ? JSON.stringify(dirtyAtSelection) : null,
      guards ? JSON.stringify(guards) : null,
      threadId,
      incarnation,
      workspacePath,
      version
    ]
  )
  if (getDb().getRowsModified() !== 1) throw new Error("当前任务或提交授权已更改，请重新打开设置")
  checkedMappings.delete(version)
  return next
}

export async function authorizeTaskCommitBinding(
  identity: CommitBindingIdentity,
  card: string,
  repositoryPaths: string[],
  isolated: boolean,
  feature?: MappingGuard,
  checkEditor?: () => void
): Promise<TaskCommitBinding> {
  const cardNumber = card.trim()
  if (cardNumber && !isValidTaskCommitCard(cardNumber)) {
    throw new Error("请输入有效的任务卡号")
  }
  if (!repositoryPaths.length) throw new Error("请至少选择一个提交仓库")
  const checkoutRoots: Record<string, string> = {}
  const guards: Guards = {
    workspace: directoryIdentity(identity.workspacePath),
    checkouts: {},
    checkoutRoots,
    feature
  }
  for (const selected of repositoryPaths) {
    const root = await canonicalCommitRepository(selected, identity.workspacePath, isolated)
    if (path.relative(selected, root) !== "") throw new Error("仓库位置已更改，请重新选择")
    guards.checkouts[root] = checkoutIdentity(root)
    checkoutRoots[root] = findCheckoutRoot(root)
  }
  const baseline = await captureTaskCommitBaselines(repositoryPaths)
  const revision = feature ? await validateMapping(feature) : null
  checkEditor?.()
  if (
    guards.workspace !== directoryIdentity(identity.workspacePath) ||
    repositoryPaths.some((root) => guards.checkouts[root] !== checkoutIdentity(root))
  ) {
    throw new Error("仓库位置已更改，请重新选择")
  }
  const version = replaceBinding(identity, cardNumber, repositoryPaths, baseline, guards)
  if (revision) checkedMappings.set(version, revision)
  return { version, cardNumber, workspacePath: identity.workspacePath, repositoryPaths }
}

export function revokeTaskCommitBinding(identity: CommitBindingIdentity): void {
  replaceBinding(identity, null, null, null, null)
}

/** A removed deployment unit must not regain an old authorization if it is later re-added. */
export function invalidateRemovedTaskCommitMappings(
  projectId: string,
  slug: string,
  current: Map<string, string>
): string[] {
  const invalidated: string[] = []
  const db = getDb()
  const rows =
    db.exec(
      `SELECT thread_id, version, guards FROM task_commit_bindings
     WHERE json_extract(guards, '$.feature.projectId') = ? AND json_extract(guards, '$.feature.slug') = ?`,
      [projectId, slug]
    )[0]?.values ?? []
  for (const [id, version, encoded] of rows) {
    const { feature } = JSON.parse(String(encoded)) as Guards
    if (
      feature &&
      Object.entries(feature.pathsByMappingId).some(([key, value]) => current.get(key) !== value)
    ) {
      db.run("DELETE FROM task_commit_bindings WHERE thread_id = ? AND version = ?", [id, version])
      checkedMappings.delete(String(version))
      invalidated.push(String(id))
    }
  }
  return invalidated
}

export function invalidateMissingTaskCommitFeatures(
  projectId: string,
  slugs: ReadonlySet<string>
): string[] {
  const invalidated: string[] = []
  const db = getDb()
  const rows =
    db.exec(
      `SELECT thread_id, version, json_extract(guards, '$.feature.slug') FROM task_commit_bindings
     WHERE json_extract(guards, '$.feature.projectId') = ?`,
      [projectId]
    )[0]?.values ?? []
  for (const [id, version, slug] of rows) {
    if (slugs.has(String(slug))) continue
    db.run("DELETE FROM task_commit_bindings WHERE thread_id = ? AND version = ?", [id, version])
    checkedMappings.delete(String(version))
    invalidated.push(String(id))
  }
  return invalidated
}
