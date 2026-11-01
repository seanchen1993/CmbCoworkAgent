import type { AuthoringScope } from "../../../shared/mods/authoring"
import type {
  ProjectPromptDraftIdentity,
  ProjectPromptDraftList,
  ProjectStagePromptsView,
  SaveProjectStagePromptInput
} from "../../../shared/mods/project-stage-prompts"
import { nativeCompositionSchema, NATIVE_COMPOSITION_PATH } from "../../plugins/native-composition"
import { parseSkillFrontmatter } from "../../skills/frontmatter"
import type { DevelopmentScope } from "../v2/development-session"
import { AUTHORING_BUNDLE_LIMITS } from "./authoring-bundle"
import type { ProjectAuthoringSessions, ProjectDraft } from "./project-authoring-session"

function identity(draft: ProjectDraft): ProjectPromptDraftIdentity {
  return {
    id: draft.id,
    name: draft.name,
    revision: draft.revision,
    sourceDigest: draft.source.digest
  }
}

function skillParts(text: string) {
  const prefix = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0]
  const parsed = parseSkillFrontmatter(text)
  const valid =
    !!prefix &&
    ["name", "description"].every(
      (key) => typeof parsed.frontmatter[key] === "string" && parsed.frontmatter[key].trim()
    )
  return {
    prefix,
    body: prefix ? text.slice(prefix.length) : parsed.body,
    valid,
    description:
      typeof parsed.frontmatter.description === "string"
        ? parsed.frontmatter.description
        : undefined
  }
}

/** Project only declared author sources; compiled native Skills are never editing targets. */
export function projectStagePromptsView(
  scope: Pick<DevelopmentScope, "threadId" | "workspace">,
  draft: ProjectDraft
): ProjectStagePromptsView {
  const base = { threadId: scope.threadId, workspace: scope.workspace, draft: identity(draft) }
  const file = draft.source.files.find((item) => item.path === NATIVE_COMPOSITION_PATH)
  if (!file)
    return { ...base, stages: [], diagnostic: "此草稿没有原生组合作者源码，请在对话中处理。" }
  let value: unknown
  try {
    value = JSON.parse(file.text)
  } catch {
    return { ...base, stages: [], diagnostic: "组合声明无法解析，请先在对话中修复。" }
  }
  const parsed = nativeCompositionSchema.safeParse(value)
  if (!parsed.success)
    return { ...base, stages: [], diagnostic: "组合声明无效，请先在对话中修复。" }
  const modules = parsed.data.modules
  if (new Set(modules.map((module) => module.id)).size !== modules.length)
    return { ...base, stages: [], diagnostic: "组合阶段标识重复，请先在对话中修复。" }
  return {
    ...base,
    stages: modules.map((module) => {
      const source = draft.source.files.find((item) => item.path === module.skill)
      const parts = source ? skillParts(source.text) : undefined
      const shared = modules.filter((item) => item.skill === module.skill).length > 1
      const diagnostic = !source
        ? "阶段作者文件缺失，请在对话中修复。"
        : /^skills\/native-[^/]+\/SKILL\.md$/.test(module.skill)
          ? "此路径属于生成文件，请在对话中修复作者源码声明。"
          : shared
            ? "多个阶段共用此提示词，请在对话中明确影响范围后修改。"
            : !parts?.valid
              ? "提示词元数据或正文边界无效，请先在对话中修复。"
              : undefined
      return {
        id: module.id,
        title: module.title,
        description: parts?.description,
        skillPath: module.skill,
        inputs: module.inputs.map((input) => input.artifactId),
        outputs: module.outputs.map((output) => ({ id: output.id, path: output.path })),
        checks: module.checks.map((check) => `${check.id} (${check.kind})`),
        body: parts?.body ?? "",
        editable: !diagnostic,
        ...(diagnostic ? { diagnostic } : {})
      }
    })
  }
}

/** UI edits use the same immutable author session and CAS as model-authored patches. */
export class ProjectStagePrompts {
  constructor(
    private readonly dependencies: {
      sessions: Pick<ProjectAuthoringSessions, "list" | "read" | "patch">
      context(threadId: string): { scope: DevelopmentScope; assertCurrent(): void }
      workspaceKey(workspace: string): string
    }
  ) {}

  private context(input: AuthoringScope) {
    const context = this.dependencies.context(input.threadId)
    context.assertCurrent()
    if (context.scope.workspace !== this.dependencies.workspaceKey(input.expectedWorkspace))
      throw Error("DEVELOPMENT_SCOPE_CHANGED")
    return context
  }

  list(input: AuthoringScope): ProjectPromptDraftList {
    const context = this.context(input)
    const drafts = this.dependencies.sessions.list(context.scope).map(identity)
    context.assertCurrent()
    return { threadId: context.scope.threadId, workspace: context.scope.workspace, drafts }
  }

  read(input: AuthoringScope & { id: string }): ProjectStagePromptsView {
    const context = this.context(input)
    const result = projectStagePromptsView(
      context.scope,
      this.dependencies.sessions.read(context.scope, input.id)
    )
    context.assertCurrent()
    return result
  }

  async save(input: SaveProjectStagePromptInput): Promise<ProjectStagePromptsView> {
    const context = this.context(input)
    const previous = this.dependencies.sessions.read(context.scope, input.id)
    if (previous.revision !== input.revision) throw Error("PROJECT_DRAFT_REVISION_CHANGED")
    if (previous.source.digest !== input.sourceDigest) throw Error("PROJECT_DRAFT_SOURCE_CHANGED")
    const view = projectStagePromptsView(context.scope, previous)
    const stage = view.stages.find((item) => item.id === input.stageId)
    if (!stage) throw Error("PROJECT_PROMPT_STAGE_MISSING")
    if (!stage.editable) throw Error("PROJECT_PROMPT_READ_ONLY")
    if (typeof input.body !== "string" || input.body.includes("\0"))
      throw Error("DEVELOPMENT_INPUT")
    const file = previous.source.files.find((item) => item.path === stage.skillPath)!
    const text = skillParts(file.text).prefix! + input.body
    if (Buffer.byteLength(text, "utf8") > AUTHORING_BUNDLE_LIMITS.fileBytes)
      throw Error("AUTHORING_SOURCE_LIMIT")
    // A no-op does not consume the bounded revision history.
    if (text === file.text) return view
    const updated = await this.dependencies.sessions.patch(
      context.scope,
      {
        id: input.id,
        revision: input.revision,
        sourceDigest: input.sourceDigest,
        files: [{ path: stage.skillPath, text }]
      },
      context.assertCurrent
    )
    context.assertCurrent()
    return projectStagePromptsView(context.scope, updated)
  }
}
