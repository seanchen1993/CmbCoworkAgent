import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createAuthoringSourceBundle, type AuthoringSourceBundle } from "./authoring-bundle"
import { createProjectTemplate, type ProjectTemplateKind } from "./project-template"
import { compileProjectHarness } from "./project-harness"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"
import { isProjectSourcePath } from "./project-source"
import { inspectProjectSource } from "./project-doctor"
import { testProjectSource } from "./project-contract"
import { packProjectPlugin } from "./project-tooling"
import { readProjectSource } from "./project-source"
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

export function projectDraftLimitHint(reason: ProjectDraftLimitError["reason"]): string {
  if (reason === "revision")
    return "这个草稿已保留 8 个版本，原稿和试用仍保留。先 project_read 读取完整 source.files，再用未占用的新草稿 id、revision:0、原 name 和完整 files 调用 project_save。只换草稿 id，不改 plugin.json 的名称/版本、运行声明或公开动作锁；随后用新草稿返回的 revision 编译并检查。旧试用不会切换。每个制作会话最多 4 个草稿；槽位满时按草稿限额提示导出。"
  return (
    (reason === "drafts"
      ? "这个制作会话的 4 个草稿槽位已满。"
      : "本次应用进程的 16 个制作会话名额已满。") +
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

  configurePersistence(settings: AuthoringAtomicSettings, directory: string) {
    if (this.sessions.size) throw Error("PROJECT_DRAFT_PERSISTENCE_BUSY")
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
    if (value?.schemaVersion !== 1 || !Array.isArray(value.drafts) || value.drafts.length > 4)
      throw Error("PROJECT_DRAFT_STORAGE_INVALID")
    const session: Session = { root: join(this.persistence.directory, key), drafts: new Map(), stored }
    for (const row of value.drafts) {
      if (!row || typeof row.id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(row.id) || session.drafts.has(row.id) ||
        typeof row.name !== "string" || !row.name.trim() || row.name.length > 100 ||
        !Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision > 8)
        throw Error("PROJECT_DRAFT_STORAGE_INVALID")
      const source = createAuthoringSourceBundle(row.source?.files)
      const resourcePaths = normalizeProjectResourcePaths(row.resourcePaths ?? [])
      if (source.digest !== row.source?.digest ||
        source.files.some(file => !isProjectSourcePath(file.path, resourcePaths)))
        throw Error("PROJECT_DRAFT_STORAGE_INVALID")
      session.drafts.set(row.id, { id: row.id, name: row.name, revision: row.revision, source,
        ...(resourcePaths.length ? { resourcePaths } : {}),
        directory: join(session.root, `${row.id}-r${row.revision}-${source.digest}`) })
    }
    this.sessions.set(key, session)
    return session
  }

  private persist(scope: DevelopmentScope, session: Session, next: ProjectDraft, guard: () => void) {
    if (!this.persistence) return
    const drafts = new Map(session.drafts)
    drafts.set(next.id, next)
    const text = JSON.stringify({ schemaVersion: 1,
      drafts: [...drafts.values()].map(({ id, name, revision, source, resourcePaths }) =>
        ({ id, name, revision, source, ...(resourcePaths?.length ? { resourcePaths } : {}) })) })
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw Error("PROJECT_DRAFT_STORAGE_INVALID")
    guard()
    if (!this.persistence.settings.compareAndSetSetting(`project-authoring-source:${this.key(scope)}`,
      session.stored, text)) throw Error("PROJECT_DRAFT_REVISION_CHANGED")
    session.stored = text
  }

  private trialRequests = new Map<string, DevelopmentProjectTrialRequest>()

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
    const draft = this.session(scope)?.drafts.get(request.draftId)
    if (!draft || draft.revision !== request.revision || draft.source.digest !== request.digest)
      return undefined
    if (request.origin && (request.origin.kind !== "business-assembly" ||
      !/^[a-f0-9-]{36}$/.test(request.origin.planId) ||
      !/^[a-f0-9-]{36}$/.test(request.origin.copyId) ||
      !/^[a-f0-9]{64}$/.test(request.origin.digest))) return undefined
    return { id: request.id, draftId: request.draftId, name: draft.name,
      revision: request.revision, digest: request.digest, goal: request.goal,
      ...(request.origin ? { origin: structuredClone(request.origin) } : {}) }
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
    await mkdir(draft.directory, { recursive: true })
    for (const file of draft.source.files) {
      guard()
      const path = join(draft.directory, file.path)
      await mkdir(dirname(path), { recursive: true })
      guard()
      await writeFile(path, file.text, { flag: "wx", encoding: "utf8" })
    }
    guard()
    if ((await readProjectSource(draft.directory, draft.resourcePaths)).bundle.digest !== draft.source.digest)
      throw Error("PROJECT_SOURCE_CHANGED")
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
    const source = compileProjectHarness(draft.source)
    const manifest = parseProjectRuntimeManifest(
      JSON.parse(source.files.find((file) => file.path === "devclaw.project-runtime.json")!.text)
    )
    const tests = await testProjectSource(source, manifest)
    guard()
    if (!tests.valid) throw Error("PROJECT_HARNESS_CONTRACT_FAILED")
    return this.save(scope, { id, name: draft.name, revision, files: source.files }, guard)
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
    checkedResourcePaths?: readonly string[]
  ): Promise<ProjectDraft> {
    guard()
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(input.id) || !input.name.trim() || input.name.length > 100)
      throw Error("PROJECT_DRAFT_INPUT")
    const key = this.key(scope)
    if (this.busy.has(key)) throw Error("PROJECT_DRAFT_BUSY")
    this.busy.add(key)
    try {
      const source = createAuthoringSourceBundle(input.files)
      const resourcePaths = normalizeProjectResourcePaths(checkedResourcePaths ??
        this.session(scope)?.drafts.get(input.id)?.resourcePaths ?? [])
      if (source.files.some((file) => !isProjectSourcePath(file.path, resourcePaths)))
        throw Error("PROJECT_DRAFT_FILE_UNSUPPORTED")
      let session = this.session(scope)
      if (!session) {
        if (this.sessions.size >= 16) throw new ProjectDraftLimitError("sessions")
        const root = this.persistence ? join(this.persistence.directory, key)
          : await mkdtemp(join(tmpdir(), "devclaw-project-authoring-"))
        if (this.persistence) await mkdir(root, { recursive: true })
        guard()
        session = { root, drafts: new Map() }
        this.sessions.set(key, session)
      }
      const previous = session.drafts.get(input.id)
      if ((previous?.revision ?? 0) !== input.revision)
        throw Error("PROJECT_DRAFT_REVISION_CHANGED")
      if ((previous?.revision ?? 0) >= 8) throw new ProjectDraftLimitError("revision")
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
      this.persist(scope, session, draft, guard)
      session.drafts.set(input.id, draft)
      if (this.development.read(scope, input.id)) {
        try {
          const actions = source.files.some(
            (file) => file.path === "devclaw.project-actions.lock.json"
          )
            ? await this.actions(scope.workspace, scope.threadId)
            : []
          guard()
          await this.development.stage(scope, draft, session.root, guard, actions)
        } catch {
          guard()
          this.development.block(scope, input.id, revision, "PROJECT_DEV_UPDATE_UNAVAILABLE")
        }
      }
      guard()
      this.changed(scope.threadId)
      return this.read(scope, input.id)
    } finally {
      this.busy.delete(key)
    }
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
    if (action === "doctor") return report
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
