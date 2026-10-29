import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdtemp, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { createAuthoringSourceBundle, readAuthoringFileChanges, type AuthoringSourceBundle } from "./authoring-bundle"
import { createProjectTemplate, type ProjectTemplateKind } from "./project-template"
import { compileProjectHarness } from "./project-harness"
import { compileNativeComposition, nativeCompositionSchema, NATIVE_COMPOSITION_PATH } from "../../plugins/native-composition"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"
import { isProjectSourcePath } from "./project-source"
import { inspectProjectSource } from "./project-doctor"
import {
  assertProjectAuthoringSkillMetadata,
  ProjectAuthoringSkillMetadataError,
  projectAuthoringSkillDiagnostics
} from "./project-authoring-skill-metadata"
import { assertProjectContractPassed, testProjectSource } from "./project-contract"
import { packProjectPlugin } from "./project-tooling"
import { readAuthoringProjectSource as readProjectSource } from "./project-source"
import {
  ProjectDevelopmentSessions,
  type ProjectDevelopmentView
} from "./project-development-session"
import { getProjectActionCatalog } from "../../harness-board/project-action-runtime"
import type { DevelopmentScope } from "../v2/development-session"
import { bindProjectPublicAction } from "./project-action-reuse"
import type { ClawActionDescriptor } from "../../../shared/mods/claw-actions"
import type { ProjectActionBinding } from "../../../shared/project-runtime/action-bindings"
import type { AuthoringAtomicSettings } from "./authoring-config-snapshot"
import type { DevelopmentProjectTrialRequest } from "../../../shared/mods/development"
import { normalizeProjectResourcePaths } from "./project-resource-paths"
import { ProjectDraftFileError } from "./project-draft-file-error"
import { patchProjectComposition, ProjectSourcePatchError } from "./project-source-patch"
import {
  parseProjectAuthorJson,
  parseProjectAuthorSchema,
  ProjectCompileDiagnosticError,
  ProjectCompilePatchDiagnosticError
} from "./project-compile-diagnostics"
import type { HostProjectOperation, HostProjectState } from "../../../shared/project-runtime/host-types"
import {
  projectCreatorTrialJourney,
  type CreatorTrialProjectReference
} from "./creator-trial-journey"

import { projectTrialEnded, readProjectTrialReference } from "./project-trial-archive"
import {
  compareProjectSource, decodeProjectHistory, encodeProjectHistory,
  PROJECT_HISTORY_IDENTITIES, type ProjectSourceHistory, type ProjectSourceVersion
} from "./project-authoring-history"

export interface ProjectDraft {
  id: string
  name: string
  revision: number
  directory: string
  source: AuthoringSourceBundle
  resourcePaths?: string[]
  development?: ProjectDevelopmentView
}
interface Session {
  history: ProjectSourceHistory
  root: string
  drafts: Map<string, ProjectDraft>
  stored?: string
}

/** Keep the existing error code while making bounded authoring recovery actionable. */
export class ProjectDraftLimitError extends Error {
  constructor(readonly reason: "revision" | "drafts" | "sessions") {
    super("PROJECT_DRAFT_LIMIT")
  }
}

export class ProjectDraftHistoryStorageLimitError extends Error {
  constructor() { super("PROJECT_DRAFT_HISTORY_STORAGE_LIMIT") }
}

export function projectDraftLimitHint(reason: ProjectDraftLimitError["reason"]): string {
  if (reason === "revision")
    return "这个草稿已保留 8 个版本，原稿和试用仍保留。用 project_read 核对真实 revision/sourceDigest，然后 project_continue(id,revision,sourceDigest,newId) 从原样源码可靠续作，无需转写文件。project_versions/project_compare 可比较保留的版本。新草稿不继承试用或权限，编译和业务试用须重新验证。最多4个活跃草稿；槽位满时可显式 project_archive 未在试用的旧草稿保留历史并释放槽位，不能归档在用草稿。"
  if (reason === "drafts")
    return "这个制作会话的 4 个活跃草稿槽位已满。先 project_list、project_read 核对源码和状态，显式 project_archive(id,revision,sourceDigest) 归档无试用或原 Host 已确认结束、没有在用租约的旧草稿，再 project_continue 可靠续作。待确认、运行中、unknown 或无法核对的试用不能归档。归档只释放编辑槽位，保留源码历史和试用证据，不取消或恢复执行。新草稿不继承权限和试用，须重新编译验证并请求试用。历史仍受 16 个身份和原 2 MiB 总预算限制，归档不释放历史字节；达到历史容量时保留源码，检查通过后可 project_pack 导出，不能放宽限制或静默淘汰。"
  return (
    "本次应用进程的 16 个制作会话名额已满。归档只释放草稿编辑槽位，不释放制作会话名额。" +
    "已有草稿仍可读取、检查和打包。先 project_read 核对完整源码与 directory，检查通过后 project_pack 导出 ZIP，并把源码目录复制到自己保存的新目录，用 CLI 继续编辑/编译。检查未通过时先保存完整源码，在副本中修复，不能把失败包称为可安装。带公开动作依赖的检查/打包仍需制作会话的真实授权目录。宿主配置持久存储时，同一聊天重启后可读取源码；运行、权限与未核对试用不会自动恢复。"
  )
}

/** Project documents share creator-session authority but never enter the pure-function trial path. */
export class ProjectAuthoringSessions {
  private sessions = new Map<string, Session>()
  private busy = new Set<string>()
  private development = new ProjectDevelopmentSessions()
  private changed: (threadId: string) => void = () => undefined
  private persistence?: { settings: AuthoringAtomicSettings; directory: string }

  configurePersistence(settings: AuthoringAtomicSettings, directory: string, trialRoot?: string) {
    if (this.sessions.size) throw Error("PROJECT_DRAFT_PERSISTENCE_BUSY")
    this.development = new ProjectDevelopmentSessions(trialRoot)
    this.persistence = { settings, directory }
  }

  private session(scope: DevelopmentScope): Session | undefined {
    const key = this.key(scope)
    const cached = this.sessions.get(key)
    if (cached || !this.persistence) return cached
    const stored = this.persistence.settings.getSetting(`project-authoring-source:${key}`, "")
    if (!stored) return undefined
    if (Buffer.byteLength(stored) > 2 * 1024 * 1024) throw Error("PROJECT_DRAFT_STORAGE_INVALID")
    const value = JSON.parse(stored)
    if (![1, 2].includes(value?.schemaVersion) || !Array.isArray(value.drafts) || value.drafts.length > 4)
      throw Error("PROJECT_DRAFT_STORAGE_INVALID")
    const session: Session = { root: join(this.persistence.directory, key), drafts: new Map(), stored,
      history: value.history === undefined && value.schemaVersion === 1
        ? new Map() : decodeProjectHistory(value.history) }
    for (const row of value.drafts) {
      if (!row || typeof row.id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(row.id) || session.drafts.has(row.id) ||
        typeof row.name !== "string" || !row.name.trim() || row.name.length > 100 ||
        !Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision > 8)
        throw Error("PROJECT_DRAFT_STORAGE_INVALID")
      const source = value.schemaVersion === 1 ? createAuthoringSourceBundle(row.source?.files)
        : session.history.get(row.id)?.at(-1)?.source
      if (!source) throw Error("PROJECT_DRAFT_STORAGE_INVALID")
      const resourcePaths = normalizeProjectResourcePaths(row.resourcePaths ?? [])
      if (source.digest !== (value.schemaVersion === 1 ? row.source?.digest : row.sourceDigest) ||
        source.files.some(file => !isProjectSourcePath(file.path, resourcePaths)))
        throw Error("PROJECT_DRAFT_STORAGE_INVALID")
      session.drafts.set(row.id, { id: row.id, name: row.name, revision: row.revision, source,
        ...(resourcePaths.length ? { resourcePaths } : {}),
        directory: join(session.root, `${row.id}-r${row.revision}-${source.digest}`) })
    }
    for (const draft of session.drafts.values()) {
      const versions = session.history.get(draft.id)
      if (versions && (versions.at(-1)?.revision !== draft.revision ||
        versions.at(-1)?.source.digest !== draft.source.digest)) throw Error("PROJECT_DRAFT_STORAGE_INVALID")
      if (!versions) session.history.set(draft.id, [this.version(draft)])
    }
    for (const versions of session.history.values()) for (const version of versions) {
      version.resourcePaths = normalizeProjectResourcePaths(version.resourcePaths ?? [])
      if (version.source.files.some(file => !isProjectSourcePath(file.path, version.resourcePaths)))
        throw Error("PROJECT_DRAFT_STORAGE_INVALID")
    }
    this.sessions.set(key, session)
    return session
  }

  private version(draft: ProjectDraft): ProjectSourceVersion {
    return { revision: draft.revision, name: draft.name, source: structuredClone(draft.source),
      ...(draft.resourcePaths ? { resourcePaths: [...draft.resourcePaths] } : {}) }
  }

  private persistState(scope: DevelopmentScope, session: Session,
    drafts: Map<string, ProjectDraft>, history: ProjectSourceHistory, guard: () => void) {
    const text = JSON.stringify({ schemaVersion: 2,
      drafts: [...drafts.values()].map(({ id, name, revision, source, resourcePaths }) =>
        ({ id, name, revision, sourceDigest: source.digest,
          ...(resourcePaths?.length ? { resourcePaths } : {}) })),
      history: encodeProjectHistory(history) })
    if (history.size > PROJECT_HISTORY_IDENTITIES) throw Error("PROJECT_DRAFT_HISTORY_LIMIT")
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new ProjectDraftHistoryStorageLimitError()
    guard()
    if (this.persistence && !this.persistence.settings.compareAndSetSetting(
      `project-authoring-source:${this.key(scope)}`, session.stored, text))
      throw Error("PROJECT_DRAFT_REVISION_CHANGED")
    if (this.persistence) session.stored = text
  }

  private persist(scope: DevelopmentScope, session: Session, next: ProjectDraft, guard: () => void,
    continuedFrom?: ProjectSourceVersion["continuedFrom"]) {
    const drafts = new Map(session.drafts)
    drafts.set(next.id, next)
    const history = new Map(session.history)
    history.set(next.id, [...(history.get(next.id) ?? []), { ...this.version(next),
      ...(continuedFrom ? { continuedFrom } : {}) }])
    this.persistState(scope, session, drafts, history, guard)
    session.history = history
  }

  private trialRequests = new Map<string, DevelopmentProjectTrialRequest>()
  private trialProjects = new Map<string, CreatorTrialProjectReference>()
  private trialObservation?: (projectId: string) => {
    project?: HostProjectState
    operations: HostProjectOperation[]
  }

  private trialRetained?: (scope: DevelopmentScope, draftId: string) => boolean

  /** Configure native readback only; neither reader restores or releases any preview lease. */
  configureTrialObservation(read: NonNullable<ProjectAuthoringSessions["trialObservation"]>,
    retained?: NonNullable<ProjectAuthoringSessions["trialRetained"]>) {
    this.trialObservation = read
    this.trialRetained = retained
  }

  private trialProject(scope: DevelopmentScope): CreatorTrialProjectReference | undefined {
    const key = this.key(scope)
    const cached = this.trialProjects.get(key)
    if (cached) return structuredClone(cached)
    const raw = this.persistence?.settings.getSetting(`project-authoring-trial-project:${key}`, "")
    if (!raw || Buffer.byteLength(raw) > 16000) return undefined
    let value: CreatorTrialProjectReference
    try { value = JSON.parse(raw) } catch { return undefined }
    return readProjectTrialReference(value)
  }

  bindTrialProject(scope: DevelopmentScope, draftId: string, project: HostProjectState,
    guard: () => void) {
    guard()
    const request = this.trialRequest(scope)
    // Preview tooling also supports manually authored projects without a creator request.
    if (!request || request.draftId !== draftId) return
    const draft = this.read(scope, draftId)
    if (draft.source.digest !== request.digest || draft.revision !== request.revision)
      throw Error("PROJECT_DRAFT_REVISION_CHANGED")
    if (!/^dev-project-preview:[a-f0-9-]{36}$/.test(project.installedPluginId))
      throw Error("PROJECT_PREVIEW_SCOPE_CHANGED")
    const reference: CreatorTrialProjectReference = {
      requestId: request.id, draftId, revision: request.revision,
      candidateDigest: request.digest, projectId: project.projectId,
      installedPluginId: project.installedPluginId, pluginDigest: project.pluginDigest,
      workspace: project.workspace
    }
    const key = this.key(scope)
    // Retain read-only provenance for older drafts before the current-card pointer changes.
    const session = this.session(scope)!
    const history = this.withTrialEvidence(session, draftId, reference)
    const untracked = new Set(this.trialProject(scope)?.untrackedDraftIds ?? [])
    try {
      this.persistState(scope, session, session.drafts, history, guard)
      session.history = history
    } catch (error) {
      // This project already exists in the original Host. Retain its current binding even
      // when optional source-history links cannot fit; no capacity/authority is expanded.
      if (!(error instanceof ProjectDraftHistoryStorageLimitError)) throw error
      untracked.add(draftId)
    }
    if (this.persistence) {
      const setting = `project-authoring-trial-project:${key}`
      const absent = "\0project-trial-project-absent"
      const before = this.persistence.settings.getSetting(setting, absent)
      if (before !== absent && before) {
        const prior = readProjectTrialReference(JSON.parse(before))
        if (!prior) throw Error("PROJECT_TRIAL_REFERENCE_INVALID")
        for (const id of prior.untrackedDraftIds ?? []) untracked.add(id)
      }
      if (untracked.size > PROJECT_HISTORY_IDENTITIES) throw Error("PROJECT_TRIAL_REFERENCE_INVALID")
      if (untracked.size) reference.untrackedDraftIds = [...untracked]
      guard()
      if (!this.persistence.settings.compareAndSetSetting(setting,
        before === absent ? undefined : before, JSON.stringify(reference)))
        throw Error("PROJECT_DRAFT_REVISION_CHANGED")
    }
    if (untracked.size) reference.untrackedDraftIds = [...untracked]
    this.trialProjects.set(key, reference)
    this.changed(scope.threadId)
  }

  private withTrialEvidence(session: Session, draftId: string, reference: CreatorTrialProjectReference) {
    const versions = session.history.get(draftId)
    if (!versions?.length) throw Error("PROJECT_DRAFT_MISSING")
    const latest = versions.at(-1)!
    const references = new Map((latest.trialEvidence ?? []).map(item => [item.projectId, item]))
    references.set(reference.projectId, structuredClone(reference))
    const history = new Map(session.history)
    history.set(draftId, [...versions.slice(0, -1), { ...latest, trialEvidence: [...references.values()] }])
    return history
  }

  notifyTrialProject(projectId: string) {
    // Only scopes already read in this process receive an update. Durable observation is
    // still available through the original scope after restart, without execution replay.
    for (const [key, session] of this.sessions) {
      const request = this.trialRequests.get(key)
      const reference = this.trialProjects.get(key)
      if (request && reference?.projectId === projectId && session.drafts.has(request.draftId)) {
        const scope = this.trialScopes.get(key)
        if (scope) {
          try { this.changed(scope.threadId) }
          catch { /* A closed observer must not change the original project's result. */ }
        }
      }
    }
  }
  private trialScopes = new Map<string, DevelopmentScope>()

  trialRequest(scope: DevelopmentScope): DevelopmentProjectTrialRequest | undefined {
    const key = this.key(scope)
    let request = this.trialRequests.get(key)
    if (!request && this.persistence) {
      const raw = this.persistence.settings.getSetting(`project-authoring-trial-request:${key}`, "")
      if (!raw || raw.length > 16000) return undefined
      try { request = JSON.parse(raw) } catch { return undefined }
    }
    if (!request || typeof request.id !== "string" || typeof request.draftId !== "string" ||
      typeof request.goal !== "string" || !request.goal.trim() || request.goal.length > 8000 ||
      !Number.isSafeInteger(request.revision) || !/^[a-f0-9]{64}$/.test(request.digest))
      return undefined
    const session = this.session(scope)
    const activeDraft = session?.drafts.get(request.draftId)
    const draft = activeDraft ?? session?.history.get(request.draftId)?.at(-1)
    const reference = this.trialProject(scope)
    const bound = reference?.requestId === request.id && reference.draftId === request.draftId &&
      reference.candidateDigest === request.digest && reference.revision === request.revision
    const candidateCurrent = !!activeDraft && activeDraft.revision === request.revision &&
      activeDraft.source.digest === request.digest
    if (!draft || (!candidateCurrent && !bound))
      return undefined
    if (request.origin && (request.origin.kind !== "business-assembly" ||
      !/^[a-f0-9-]{36}$/.test(request.origin.planId) ||
      !/^[a-f0-9-]{36}$/.test(request.origin.copyId) ||
      !/^[a-f0-9]{64}$/.test(request.origin.digest))) return undefined
    this.trialRequests.set(key, request)
    this.trialScopes.set(key, structuredClone(scope))
    if (bound) this.trialProjects.set(key, reference)
    let journey: DevelopmentProjectTrialRequest["journey"]
    if (bound) {
      let observed: { project?: HostProjectState; operations: HostProjectOperation[] }
      try { observed = this.trialObservation?.(reference.projectId) ?? { operations: [] } }
      catch { observed = { operations: [] } }
      journey = projectCreatorTrialJourney({ reference, creatorThreadId: scope.threadId,
        candidateCurrent, ...observed })
    }
    return { id: request.id, draftId: request.draftId, name: draft.name,
      revision: request.revision, digest: request.digest, goal: request.goal,
      ...(request.origin ? { origin: structuredClone(request.origin) } : {}),
      ...(journey ? { journey } : {}) }
  }

  /** Only prepares a trusted UI request; actual project creation/start remains a native action. */
  async requestTrial(scope: DevelopmentScope, id: string, revision: number,
    goal: string, guard: () => void, actions: readonly ClawActionDescriptor[] = [],
    origin?: DevelopmentProjectTrialRequest["origin"]) {
    guard()
    if (origin && (origin.kind !== "business-assembly" ||
      !/^[a-f0-9-]{36}$/.test(origin.planId) || !/^[a-f0-9-]{36}$/.test(origin.copyId) ||
      !/^[a-f0-9]{64}$/.test(origin.digest))) throw Error("PROJECT_TRIAL_ORIGIN_INVALID")
    if (!goal.trim() || goal.length > 8000) throw Error("PROJECT_TRIAL_GOAL_REQUIRED")
    const draft = this.read(scope, id)
    if (draft.revision !== revision) throw Error("PROJECT_DRAFT_REVISION_CHANGED")
    const previous = this.trialRequest(scope)
    const retainedRequest =
      !!previous &&
      previous.draftId === id &&
      previous.revision === revision &&
      previous.digest === draft.source.digest &&
      previous.goal === goal.trim() &&
      JSON.stringify(previous.origin) === JSON.stringify(origin)
    if (previous?.journey && retainedRequest)
      return { phase: "needs-approval" as const, executed: false as const, request: previous }
    if (previous?.journey && this.development.read(scope, previous.draftId)?.activeRuns)
      throw Error("PROJECT_DEV_RUNNING")
    // A retained exact request may be rechecked after restart. A new goal/source is new authoring.
    if (!retainedRequest) assertProjectAuthoringSkillMetadata(draft.source)
    const result = await this.inspect(scope, id, revision, "dev", guard, actions)
    if (!result || (result as ProjectDevelopmentView).status !== "prepared")
      throw Error("PROJECT_DEV_DOCTOR_FAILED")
    guard()
    const request: DevelopmentProjectTrialRequest = { id: randomUUID(), draftId: id,
      name: draft.name, revision, digest: draft.source.digest, goal: goal.trim(),
      ...(origin ? { origin: structuredClone(origin) } : {}) }
    if (this.persistence) {
      const settingKey = `project-authoring-trial-request:${this.key(scope)}`
      const absent = "\0project-trial-absent"
      const before = this.persistence.settings.getSetting(settingKey, absent)
      guard()
      if (!this.persistence.settings.compareAndSetSetting(settingKey,
        before === absent ? undefined : before, JSON.stringify(request)))
        throw Error("PROJECT_DRAFT_REVISION_CHANGED")
    }
    this.trialRequests.set(this.key(scope), request)
    this.changed(scope.threadId)
    return { phase: "needs-approval" as const, executed: false as const, request }
  }

  /** Recover immutable source files only; preview registrations, permissions and runs are absent. */
  private async materialize(draft: ProjectDraft, guard: () => void) {
    guard()
    try {
      const source = await readProjectSource(draft.directory, draft.resourcePaths)
      guard()
      if (source.bundle.digest !== draft.source.digest) throw Error("PROJECT_SOURCE_CHANGED")
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const missing = async () => {
      try {
        await lstat(draft.directory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
        throw error
      }
      return false
    }
    guard()
    if (!(await missing())) throw Error("PROJECT_SOURCE_CHANGED")
    const parent = resolve(dirname(draft.directory))
    await mkdir(parent, { recursive: true })
    const parentIdentity = await realpath(parent)
    const samePath = (left: string, right: string) => process.platform === "win32" ?
      left.toLowerCase() === right.toLowerCase() : left === right
    if (!samePath(parentIdentity, parent)) throw Error("PROJECT_SOURCE_CHANGED")
    guard()
    const staging = await mkdtemp(join(parent, ".project-source-"))
    const cleanup = async () => {
      if (dirname(resolve(staging)) !== parent || !basename(staging).startsWith(".project-source-"))
        throw Error("PROJECT_SOURCE_CHANGED")
      const stat = await lstat(staging).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
        return undefined
      })
      if (stat) {
        if (!stat.isDirectory() || stat.isSymbolicLink() ||
            !samePath(await realpath(staging), resolve(staging))) throw Error("PROJECT_SOURCE_CHANGED")
        await rm(staging, { recursive: true, force: false })
      }
    }
    try {
      for (const file of draft.source.files) {
        guard()
        const path = join(staging, file.path)
        await mkdir(dirname(path), { recursive: true })
        guard()
        await writeFile(path, file.text, { flag: "wx", encoding: "utf8" })
      }
      guard()
      if ((await readProjectSource(staging, draft.resourcePaths)).bundle.digest !== draft.source.digest)
        throw Error("PROJECT_SOURCE_CHANGED")
      guard()
      if (!samePath(await realpath(parent), parentIdentity)) throw Error("PROJECT_SOURCE_CHANGED")
      guard()
      if (await missing()) {
        try {
          await rename(staging, draft.directory)
        } catch (error) {
          // A concurrent recovery may publish the same source; only exact readback is accepted.
          if (await missing()) throw error
        }
      }
      guard()
      if ((await readProjectSource(draft.directory, draft.resourcePaths)).bundle.digest !== draft.source.digest)
        throw Error("PROJECT_SOURCE_CHANGED")
    } finally {
      // Remove only this owned mkdtemp result, never the final source directory.
      await cleanup()
    }
  }

  /** Recreate exact persisted author source only; never restore preview grants or execution. */
  async materializeForDelivery(scope: DevelopmentScope, id: string, revision: number,
    digest: string, guard: () => void) {
    const current = () => {
      guard()
      const request = this.trialRequest(scope)
      const draft = this.read(scope, id)
      if (request?.draftId !== id || request.revision !== revision || request.digest !== digest ||
          draft.revision !== revision || draft.source.digest !== digest)
        throw Error("PROJECT_DELIVERY_CANDIDATE_CHANGED")
      return draft
    }
    const draft = current()
    await this.materialize(draft, guard)
    const retained = current()
    if (retained.directory !== draft.directory) throw Error("PROJECT_DELIVERY_CANDIDATE_CHANGED")
    return retained
  }

  setChanged(callback: (threadId: string) => void) {
    this.changed = callback
  }

  constructor(private readonly actions = getProjectActionCatalog) {}

  list(scope: DevelopmentScope): ProjectDraft[] {
    return [...(this.session(scope)?.drafts.keys() ?? [])].map((id) =>
      this.read(scope, id)
    )
  }

  developmentStatus(scope: DevelopmentScope, id: string) {
    return this.development.read(scope, id)
  }

  acquireDevelopment(
    scope: DevelopmentScope,
    id: string,
    revision: number,
    guard: () => void,
    retainedWorkspace?: string
  ) {
    if (this.read(scope, id).revision !== revision) throw Error("PROJECT_DRAFT_REVISION_CHANGED")
    const lease = this.development.acquire(scope, id, revision, guard,
      retainedWorkspace ? { retainedWorkspace } : { freshWorkspace: true })
    this.changed(scope.threadId)
    return {
      snapshot: lease.snapshot,
      release: () => {
        lease.release()
        this.changed(scope.threadId)
      }
    }
  }

  private key(scope: DevelopmentScope): string {
    return createHash("sha256")
      .update(JSON.stringify([scope.threadId, scope.workspace, scope.incarnation]))
      .digest("hex")
  }

  read(scope: DevelopmentScope, id: string): ProjectDraft {
    const draft = this.session(scope)?.drafts.get(id)
    if (!draft) throw Error("PROJECT_DRAFT_MISSING")
    return { ...structuredClone(draft), development: this.development.read(scope, id) }
  }

  dependencySources(scope: DevelopmentScope) {
    const session = this.session(scope)
    return [...(session?.history ?? [])].map(([id, versions]) => ({ id,
      name: versions.at(-1)!.name, kind: "candidate" as const,
      archived: !session!.drafts.has(id), source: structuredClone(versions.at(-1)!.source) }))
  }

  versions(scope: DevelopmentScope, id: string) {
    const session = this.session(scope)
    const versions = session?.history.get(id)
    if (!versions) throw Error("PROJECT_DRAFT_MISSING")
    return { id, archived: !session!.drafts.has(id),
      trialEvidenceIncomplete: this.trialProject(scope)?.untrackedDraftIds?.includes(id) ?? false,
      versions: versions.map(version => ({
      revision: version.revision, sourceDigest: version.source.digest,
      fileCount: version.source.files.length, name: version.name,
      ...(version.continuedFrom ? { continuedFrom: version.continuedFrom } : {}),
      ...(version.trialEvidence?.length ? { trialProjectCount: version.trialEvidence.length,
        trialProjectIds: version.trialEvidence.slice(-4).map(item => item.projectId),
        trialProjectsTruncated: version.trialEvidence.length > 4 } : {})
    })), historyComplete: versions[0].revision === 1 }
  }

  private sourceVersion(scope: DevelopmentScope, id: string, revision: number) {
    const version = this.session(scope)?.history.get(id)?.find(item => item.revision === revision)
    if (!version) throw Error("PROJECT_DRAFT_VERSION_MISSING")
    return structuredClone(version)
  }

  compare(scope: DevelopmentScope, input: { id: string; revision: number;
    otherId?: string; otherRevision: number; assetPath?: string; cursor?: number }) {
    const before = this.sourceVersion(scope, input.id, input.revision)
    const after = this.sourceVersion(scope, input.otherId ?? input.id, input.otherRevision)
    return { before: { id: input.id, revision: before.revision, sourceDigest: before.source.digest },
      after: { id: input.otherId ?? input.id, revision: after.revision, sourceDigest: after.source.digest },
      ...compareProjectSource(before, after, input.assetPath, input.cursor) }
  }

  async continue(scope: DevelopmentScope, input: { id: string; revision: number;
    sourceDigest: string; newId: string }, guard: () => void) {
    guard()
    const original = this.sourceVersion(scope, input.id, input.revision)
    if (original.source.digest !== input.sourceDigest) throw Error("PROJECT_DRAFT_SOURCE_CHANGED")
    const current = this.session(scope)?.history.get(input.id)?.at(-1)
    if (current?.revision !== input.revision || current.source.digest !== input.sourceDigest)
      throw Error("PROJECT_DRAFT_REVISION_CHANGED")
    // Resource closure is inherited as checked source metadata, never reconstructed by the model.
    const origin = { id: input.id, revision: input.revision, sourceDigest: input.sourceDigest }
    const currentGuard = () => {
      guard()
      const latest = this.session(scope)?.history.get(input.id)?.at(-1)
      if (latest?.revision !== input.revision || latest.source.digest !== input.sourceDigest)
        throw Error("PROJECT_DRAFT_REVISION_CHANGED")
    }
    const saved = await this.save(scope, { id: input.newId, name: original.name,
      revision: 0, files: original.source.files }, currentGuard, original.resourcePaths, origin)
    return { ...saved, continuedFrom: { id: input.id, revision: input.revision,
      sourceDigest: input.sourceDigest }, previousTrialPreserved: true, executed: false }
  }

  archive(scope: DevelopmentScope, input: { id: string; revision: number; sourceDigest: string },
    guard: () => void) {
    guard()
    const session = this.session(scope)
    if (!session) throw Error("PROJECT_DRAFT_MISSING")
    if (this.busy.has(this.key(scope))) throw Error("PROJECT_DRAFT_BUSY")
    const draft = this.read(scope, input.id)
    if (draft.revision !== input.revision) throw Error("PROJECT_DRAFT_REVISION_CHANGED")
    if (draft.source.digest !== input.sourceDigest) throw Error("PROJECT_DRAFT_SOURCE_CHANGED")
    const preview = this.development.read(scope, input.id)
    if (preview && (preview.activeRuns || preview.pendingRevision !== null))
      throw Error("PROJECT_DRAFT_ARCHIVE_IN_USE")
    const reference = this.trialProject(scope)
    if (reference?.untrackedDraftIds?.includes(input.id)) throw Error("PROJECT_DRAFT_ARCHIVE_IN_USE")
    const references = new Map(session.history.get(input.id)!.flatMap(version =>
      (version.trialEvidence ?? []).map(item => [item.projectId, item] as const)))
    if (reference?.draftId === input.id) references.set(reference.projectId, reference)
    const request = this.trialRequest(scope)
    const pendingTrial = request?.draftId === input.id
    let retained = false
    try { retained = this.trialRetained?.(scope, input.id) ?? false }
    catch { throw Error("PROJECT_DRAFT_ARCHIVE_IN_USE") }
    // Legacy retained native previews and prepared-only sources need positive terminal proof.
    if ((preview || pendingTrial || retained) && !references.size)
      throw Error("PROJECT_DRAFT_ARCHIVE_IN_USE")
    if (pendingTrial && ![...references.values()].some(trial => trial.requestId === request.id &&
      trial.candidateDigest === request.digest && trial.revision === request.revision))
      throw Error("PROJECT_DRAFT_ARCHIVE_IN_USE")
    for (const trial of references.values()) {
      guard()
      let ended = false
      try {
        const observed = this.trialObservation?.(trial.projectId)
        ended = !!observed && projectTrialEnded(trial, observed, scope.threadId)
      } catch { /* Missing or unreadable original journals remain uncertain. */ }
      guard()
      if (!ended) throw Error("PROJECT_DRAFT_ARCHIVE_IN_USE")
    }
    const drafts = new Map(session.drafts)
    drafts.delete(input.id)
    let history = session.history
    // Backfill only the one verified reference actually retained by older app versions.
    if (reference?.draftId === input.id) history = this.withTrialEvidence(session, input.id, reference)
    this.persistState(scope, session, drafts, history, guard)
    session.history = history
    session.drafts = drafts
    this.changed(scope.threadId)
    return { id: input.id, archived: true, sourceHistoryPreserved: true,
      installedPluginsUnchanged: true, executed: false }
  }

  private hasRetainedSkillSource(scope: DevelopmentScope, draft: ProjectDraft): boolean {
    const prepared = this.development.read(scope, draft.id)
    if (
      prepared?.currentRevision === draft.revision &&
      prepared.currentDigest === draft.source.digest
    )
      return true
    const request = this.trialRequest(scope)
    return (
      request?.draftId === draft.id &&
      request.revision === draft.revision &&
      request.digest === draft.source.digest
    )
  }

  async scaffold(
    scope: DevelopmentScope,
    id: string,
    name: string,
    guard: () => void,
    template?: ProjectTemplateKind
  ) {
    const source = createProjectTemplate({ packageId: id, name, template })
    return this.save(scope, { id, name, revision: 0, files: source.files }, guard)
  }

  async compile(scope: DevelopmentScope, id: string, revision: number, guard: () => void) {
    guard()
    const draft = this.read(scope, id)
    if (draft.revision !== revision) throw Error("PROJECT_DRAFT_REVISION_CHANGED")
    const native = draft.source.files.find((file) => file.path === NATIVE_COMPOSITION_PATH)
    if (
      native &&
      draft.source.files.some(
        (file) =>
          file.path === "devclaw.harness.json" || file.path === "mods/business/manifest.json"
      )
    )
      throw Error("NATIVE_COMPOSITION_MULTIPLE_SOURCES")
    if (native) assertProjectAuthoringSkillMetadata(draft.source)
    const availableActions = native ? await this.actions(scope.workspace, scope.threadId) : []
    guard()
    const nativeValue = native
      ? parseProjectAuthorJson(NATIVE_COMPOSITION_PATH, native.text)
      : undefined
    const source = native
      ? createAuthoringSourceBundle(
          compileNativeComposition(nativeValue, {
            files: draft.source.files.map((file) => ({
              path: file.path,
              bytes: Buffer.from(file.text)
            })),
            actionCatalog: availableActions
          }).files.map((file) => ({ path: file.path, text: file.bytes.toString("utf8") }))
        )
      : compileProjectHarness(draft.source)
    if (native && !inspectProjectSource(source, [], availableActions).report.valid)
      throw Error("NATIVE_COMPOSITION_DOCTOR_FAILED")
    const manifest = parseProjectRuntimeManifest(
      JSON.parse(source.files.find((file) => file.path === "devclaw.project-runtime.json")!.text)
    )
    const tests = await testProjectSource(source, manifest)
    guard()
    assertProjectContractPassed(tests)
    const saved = await this.save(
      scope,
      { id, name: draft.name, revision, files: source.files },
      guard,
      draft.resourcePaths
    )
    return native
      ? {
          ...saved,
          validation: {
            doctor: inspectProjectSource(source, [], availableActions).report,
            tests,
            businessActionsExecuted: false
          }
        }
      : saved
  }
  async bindAction(
    scope: DevelopmentScope,
    input: {
      id: string
      revision: number
      stageId: string
      localActionId: string
      action: ClawActionDescriptor
      constants: unknown
      config?: unknown
      inputFrom?: ProjectActionBinding["inputFrom"]
    },
    guard: () => void
  ) {
    guard()
    const draft = this.read(scope, input.id)
    if (draft.revision !== input.revision) throw Error("PROJECT_DRAFT_REVISION_CHANGED")
    const source = bindProjectPublicAction({ ...input, source: draft.source })
    return this.save(
      scope,
      { id: draft.id, name: draft.name, revision: draft.revision, files: source.files },
      guard
    )
  }

  async save(
    scope: DevelopmentScope,
    input: {
      id: string
      name: string
      revision: number
      files: unknown
    },
    guard: () => void,
    checkedResourcePaths?: readonly string[],
    continuedFrom?: ProjectSourceVersion["continuedFrom"]
  ): Promise<ProjectDraft> {
    guard()
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(input.id) || !input.name.trim() || input.name.length > 100)
      throw Error("PROJECT_DRAFT_INPUT")
    const key = this.key(scope)
    if (this.busy.has(key)) throw Error("PROJECT_DRAFT_BUSY")
    this.busy.add(key)
    try {
      const source = createAuthoringSourceBundle(input.files)
      const nativeSource = source.files.find(file => file.path === NATIVE_COMPOSITION_PATH)
      const nativeResources = nativeSource
        ? parseProjectAuthorSchema(
            NATIVE_COMPOSITION_PATH,
            parseProjectAuthorJson(NATIVE_COMPOSITION_PATH, nativeSource.text),
            nativeCompositionSchema
          ).resources
        : undefined
      const resourcePaths = normalizeProjectResourcePaths(checkedResourcePaths ?? nativeResources ??
        this.session(scope)?.drafts.get(input.id)?.resourcePaths ?? [])
      const unsupportedPaths = source.files
        .filter((file) => !isProjectSourcePath(file.path, resourcePaths))
        .map((file) => file.path)
      if (unsupportedPaths.length)
        throw new ProjectDraftFileError(
          unsupportedPaths,
          nativeSource ? NATIVE_COMPOSITION_PATH : undefined
        )
      let session = this.session(scope)
      if (!session) {
        if (this.sessions.size >= 16) throw new ProjectDraftLimitError("sessions")
        const root = this.persistence ? join(this.persistence.directory, key)
          : await mkdtemp(join(tmpdir(), "devclaw-project-authoring-"))
        if (this.persistence) await mkdir(root, { recursive: true })
        guard()
        session = { root, drafts: new Map(), history: new Map() }
        this.sessions.set(key, session)
      }
      const previous = session.drafts.get(input.id)
      if ((previous?.revision ?? 0) !== input.revision)
        throw Error("PROJECT_DRAFT_REVISION_CHANGED")
      if ((previous?.revision ?? 0) >= 8) throw new ProjectDraftLimitError("revision")
      if (!previous && session.history.has(input.id)) throw Error("PROJECT_DRAFT_ID_ARCHIVED")
      if (!previous && session.drafts.size >= 4) throw new ProjectDraftLimitError("drafts")
      const revision = input.revision + 1
      const directory = join(session.root, `${input.id}-r${revision}-${randomUUID()}`)
      guard()
      if (this.persistence) await mkdir(session.root, { recursive: true })
      guard()
      await mkdir(directory)
      for (const file of source.files) {
        guard()
        const path = join(directory, file.path)
        await mkdir(dirname(path), { recursive: true })
        guard()
        await writeFile(path, file.text, { encoding: "utf8", flag: "wx" })
      }
      guard()
      const draft: ProjectDraft = { id: input.id, name: input.name, revision, directory, source,
        ...(resourcePaths.length ? { resourcePaths } : {}) }
      this.persist(scope, session, draft, guard, continuedFrom)
      session.drafts.set(input.id, draft)
      if (this.development.read(scope, input.id)) {
        try {
          // Saving a new revision must not turn an invalid new Skill into retained preparation.
          assertProjectAuthoringSkillMetadata(source)
          const actions = source.files.some(
            (file) => file.path === "devclaw.project-actions.lock.json"
          )
            ? await this.actions(scope.workspace, scope.threadId)
            : []
          guard()
          await this.development.stage(scope, draft, session.root, guard, actions)
        } catch (error) {
          guard()
          this.development.block(
            scope,
            input.id,
            revision,
            error instanceof ProjectAuthoringSkillMetadataError
              ? "PROJECT_AUTHORING_SKILL_METADATA_INVALID"
              : "PROJECT_DEV_UPDATE_UNAVAILABLE"
          )
        }
      }
      guard()
      this.changed(scope.threadId)
      return this.read(scope, input.id)
    } finally {
      this.busy.delete(key)
    }
  }

  /** Upserts exact files against one immutable revision; all omitted resources remain intact. */
  async patch(
    scope: DevelopmentScope,
    input: { id: string; revision: number; sourceDigest: string; files?: unknown; sourcePatch?: unknown },
    guard: () => void
  ): Promise<ProjectDraft> {
    guard()
    const previous = this.read(scope, input.id)
    if (previous.revision !== input.revision) throw Error("PROJECT_DRAFT_REVISION_CHANGED")
    if (previous.source.digest !== input.sourceDigest) throw Error("PROJECT_DRAFT_SOURCE_CHANGED")
    if (input.files === undefined && input.sourcePatch === undefined)
      throw Error("DEVELOPMENT_INPUT")
    const changes = input.files === undefined ? [] : readAuthoringFileChanges(input.files)
    const files = new Map(previous.source.files.map((file) => [file.path, file]))
    if (input.sourcePatch !== undefined) {
      if (changes.some(file => file.path === NATIVE_COMPOSITION_PATH))
        throw new ProjectSourcePatchError("CONFLICT")
      const nativeSource = files.get(NATIVE_COMPOSITION_PATH)
      if (!nativeSource) throw new ProjectSourcePatchError("NATIVE_REQUIRED")
      parseProjectAuthorJson(NATIVE_COMPOSITION_PATH, nativeSource.text)
      const text = patchProjectComposition(nativeSource.text, input.sourcePatch)
      try {
        parseProjectAuthorSchema(
          NATIVE_COMPOSITION_PATH,
          parseProjectAuthorJson(NATIVE_COMPOSITION_PATH, text),
          nativeCompositionSchema
        )
      } catch (error) {
        if (
          error instanceof ProjectCompileDiagnosticError &&
          ["PROJECT_AUTHORING_SCHEMA_INVALID", "PROJECT_CHECK_CONFIGURATION_KEYS_INVALID"].includes(
            error.message
          )
        )
          throw new ProjectCompilePatchDiagnosticError(error)
        throw error
      }
      files.set(NATIVE_COMPOSITION_PATH, {
        path: NATIVE_COMPOSITION_PATH,
        text
      })
    }
    for (const file of changes) files.set(file.path, file)
    // No await before save acquires its existing busy lock and performs native validation/CAS.
    return this.save(scope, {
      id: previous.id,
      name: previous.name,
      revision: previous.revision,
      files: [...files.values()]
    }, guard)
  }

  async inspect(
    scope: DevelopmentScope,
    id: string,
    revision: number,
    action: "doctor" | "test" | "dev" | "pack",
    guard: () => void,
    availableActions: readonly ClawActionDescriptor[] = []
  ) {
    guard()
    const draft = this.read(scope, id)
    if (draft.revision !== revision) throw Error("PROJECT_DRAFT_REVISION_CHANGED")
    const { report, manifest } = inspectProjectSource(draft.source, [], availableActions)
    if (action === "doctor") {
      const diagnostics = projectAuthoringSkillDiagnostics(draft.source)
      if (diagnostics.length) {
        report.valid = false
        report.diagnostics.push(...diagnostics)
      }
      return report
    }
    // Only main-process exact prepared/persisted identities retain the historical Host rule.
    if (!this.hasRetainedSkillSource(scope, draft))
      assertProjectAuthoringSkillMetadata(draft.source)
    if (!report.valid || !manifest) return { valid: false, doctor: report }
    if (action === "dev" || action === "pack") await this.materialize(draft, guard)
    let result: unknown
    if (action === "test") {
      const preview = this.development.read(scope, id)
      if (!preview) result = await testProjectSource(draft.source, manifest)
      else {
        const lease = this.development.acquire(scope, id, revision, guard)
        try {
          const source = await readProjectSource(lease.snapshot.packagePath, draft.resourcePaths)
          guard()
          if (source.bundle.digest !== lease.snapshot.digest) throw Error("PROJECT_SOURCE_CHANGED")
          result = await testProjectSource(source.bundle, manifest)
        } finally {
          lease.release()
        }
      }
    } else if (action === "dev") {
      const current = () => {
        guard()
        if (this.read(scope, id).revision !== revision)
          throw Error("PROJECT_DRAFT_REVISION_CHANGED")
      }
      result = await this.development.stage(
        scope,
        draft,
        this.sessions.get(this.key(scope))!.root,
        guard,
        availableActions,
        current
      )
    } else {
      const root = this.sessions.get(this.key(scope))!.root
      const output = join(
        root,
        `${id}-r${revision}-${randomUUID()}${action === "pack" ? ".zip" : "-dev"}`
      )
      guard()
      result = await packProjectPlugin(
        draft.directory,
        output,
        draft.source.digest,
        guard,
        availableActions,
        draft.resourcePaths
      )
    }
    guard()
    if (this.read(scope, id).revision !== revision) throw Error("PROJECT_DRAFT_REVISION_CHANGED")
    if (action === "dev") this.changed(scope.threadId)
    return result
  }
}

export const projectAuthoringSessions = new ProjectAuthoringSessions()
