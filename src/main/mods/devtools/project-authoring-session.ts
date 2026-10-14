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

export interface ProjectDraft {
  id: string
  name: string
  revision: number
  directory: string
  source: AuthoringSourceBundle
  development?: ProjectDevelopmentView
}
interface Session {
  root: string
  drafts: Map<string, ProjectDraft>
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
    "已有草稿仍可读取、检查和打包。先 project_read 核对完整源码与 directory，检查通过后 project_pack 导出 ZIP，并把源码目录复制到自己保存的新目录，用 CLI 继续编辑/编译。检查未通过时先保存完整源码，在副本中修复，不能把失败包称为可安装。带公开动作依赖的检查/打包仍需制作会话的真实授权目录。换聊天或重启不会自动恢复草稿；不要关闭仍有未核对试用的会话。"
  )
}

/** Project documents share creator-session authority but never enter the pure-function trial path. */
export class ProjectAuthoringSessions {
  private sessions = new Map<string, Session>()
  private busy = new Set<string>()
  private development = new ProjectDevelopmentSessions()
  private changed: (threadId: string) => void = () => undefined

  setChanged(callback: (threadId: string) => void) {
    this.changed = callback
  }

  constructor(private readonly actions = getProjectActionCatalog) {}

  list(scope: DevelopmentScope): ProjectDraft[] {
    return [...(this.sessions.get(this.key(scope))?.drafts.keys() ?? [])].map((id) =>
      this.read(scope, id)
    )
  }

  developmentStatus(scope: DevelopmentScope, id: string) {
    return this.development.read(scope, id)
  }

  acquireDevelopment(scope: DevelopmentScope, id: string, revision: number, guard: () => void) {
    if (this.read(scope, id).revision !== revision) throw Error("PROJECT_DRAFT_REVISION_CHANGED")
    const lease = this.development.acquire(scope, id, revision, guard)
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
    const draft = this.sessions.get(this.key(scope))?.drafts.get(id)
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
    guard: () => void
  ): Promise<ProjectDraft> {
    guard()
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(input.id) || !input.name.trim() || input.name.length > 100)
      throw Error("PROJECT_DRAFT_INPUT")
    const key = this.key(scope)
    if (this.busy.has(key)) throw Error("PROJECT_DRAFT_BUSY")
    this.busy.add(key)
    try {
      const source = createAuthoringSourceBundle(input.files)
      if (source.files.some((file) => !isProjectSourcePath(file.path)))
        throw Error("PROJECT_DRAFT_FILE_UNSUPPORTED")
      let session = this.sessions.get(key)
      if (!session) {
        if (this.sessions.size >= 16) throw new ProjectDraftLimitError("sessions")
        const root = await mkdtemp(join(tmpdir(), "devclaw-project-authoring-"))
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
      await mkdir(directory)
      for (const file of source.files) {
        guard()
        const path = join(directory, file.path)
        await mkdir(dirname(path), { recursive: true })
        guard()
        await writeFile(path, file.text, { encoding: "utf8", flag: "wx" })
      }
      guard()
      const draft: ProjectDraft = { id: input.id, name: input.name, revision, directory, source }
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
    let result: unknown
    if (action === "test") {
      const preview = this.development.read(scope, id)
      if (!preview) result = await testProjectSource(draft.source, manifest)
      else {
        const lease = this.development.acquire(scope, id, revision, guard)
        try {
          const source = await readProjectSource(lease.snapshot.packagePath)
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
        availableActions
      )
    }
    guard()
    if (this.read(scope, id).revision !== revision) throw Error("PROJECT_DRAFT_REVISION_CHANGED")
    if (action === "dev") this.changed(scope.threadId)
    return result
  }
}

export const projectAuthoringSessions = new ProjectAuthoringSessions()
