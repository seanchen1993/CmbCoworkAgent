import { createTwoFilesPatch } from "diff"
import type {
  BuiltinChangeReview,
  BuiltinChangeReviewFile,
  BuiltinChangeReviewBaseline
} from "../../../shared/mods/builtin-change-review"
import { CHANGE_REVIEW_LIMITS, readReviewTree, type ReviewTree } from "./change-review-reader"
import { readBuiltinProjectFacts, type ProjectFactObservation } from "./project-facts"

export interface ChangeReviewScope {
  threadId: string
  workspace: string
  incarnationKey: string
  runId: string
}

const limitations = [
  "比较适用范围内的文件内容；排除环境、凭据和密钥文件，不显示被排除文件的正文。",
  "改动可能来自并行任务或外部编辑，无法仅凭快照确定本任务归属。",
  "重命名显示为删除与新增；二进制仅比较摘要；未核验文件权限变化。",
  "仅本次应用会话内保存基线；检查记录为当时结果，不代表改动归属或当前文件已重新通过检查。"
]

const labels: Record<BuiltinChangeReviewBaseline, string> = {
  head: "工作区相对 HEAD",
  task: "本次尝试开始快照",
  stage: "本阶段首次执行快照",
  project: "本项目首次执行快照"
}

function unavailable(baseline: BuiltinChangeReviewBaseline, code: string): BuiltinChangeReview {
  const messages: Record<string, string> = {
    REVIEW_NOT_REPOSITORY: "当前工作区不是可读取的 Git 仓库。",
    REVIEW_UNBORN: "仓库尚无 HEAD 提交，不能显示相对 HEAD 的变更。",
    REVIEW_BASELINE_MISSING: "没有此任务开始时的有效快照，不能判断本次改动。",
    REVIEW_PROJECT_BASELINE_MISSING:
      "没有此范围首次执行时的有效快照。可能已重启、记录已移除，或此项目使用原插件流程；不会用现在的文件补作开始快照。",
    REVIEW_FILE_LIMIT: "仓库文件数超出审阅上限，本次基线不可用。",
    REVIEW_BYTE_LIMIT: "文件大小或总字节数超出审阅上限，本次基线不可用。",
    REVIEW_SPECIAL_FILE: "范围内包含符号链接、硬链接、子模块或特殊文件，尚不能完整捕获基线。",
    REVIEW_WORKSPACE_CHANGED: "读取时工作区或分支发生变化，请在稳定状态重试。",
    REVIEW_BRANCH_CHANGED: "任务开始后分支已切换，或读取期间 HEAD 已变化；不能将其计为本次改动。"
  }
  return {
    status: "unavailable",
    baseline,
    baselineLabel: labels[baseline],
    head: null,
    files: [],
    message: messages[code] ?? "审阅读取失败或超时；未生成可信基线。",
    limitations: [...limitations]
  }
}

function compare(
  before: ReviewTree,
  after: ReviewTree,
  baseline: BuiltinChangeReviewBaseline,
  expires: number
): BuiltinChangeReview {
  if (
    before.root !== after.root ||
    before.branch !== after.branch ||
    ((baseline === "head" || before.branch === null) && before.head !== after.head)
  ) {
    return unavailable(baseline, "REVIEW_BRANCH_CHANGED")
  }
  const files: BuiltinChangeReviewFile[] = []
  let patchBytes = 0
  for (const path of [...new Set([...before.contents.keys(), ...after.contents.keys()])].sort()) {
    if (performance.now() >= expires) return unavailable(baseline, "REVIEW_DIFF_LIMIT")
    const prior = before.contents.get(path)
    const current = after.contents.get(path)
    if (prior?.fingerprint === current?.fingerprint) continue
    const binary = !!(
      (prior && prior.text === undefined) ||
      (current && current.text === undefined)
    )
    let patch: string | undefined
    if (!binary) {
      // Bounded edit search prevents adversarial large text from occupying the main process.
      patch = createTwoFilesPatch(path, path, prior?.text ?? "", current?.text ?? "", "", "", {
        context: 3,
        timeout: 100,
        maxEditLength: 20000
      })
      if (patch === undefined) return unavailable(baseline, "REVIEW_DIFF_LIMIT")
      if (performance.now() >= expires) return unavailable(baseline, "REVIEW_DIFF_LIMIT")
      patchBytes += Buffer.byteLength(patch)
      if (patchBytes > CHANGE_REVIEW_LIMITS.commandBytes)
        return unavailable(baseline, "REVIEW_DIFF_LIMIT")
    }
    files.push({
      path,
      status: !prior ? "added" : !current ? "deleted" : "modified",
      binary,
      beforeFingerprint: prior?.fingerprint ?? null,
      afterFingerprint: current?.fingerprint ?? null,
      ...(patch === undefined ? {} : { patch })
    })
  }
  return {
    status: "available",
    baseline,
    baselineLabel:
      baseline === "head"
        ? "全部工作区内容相对 HEAD（包括任务前改动）"
        : `${labels[baseline]}（归属未确认）`,
    head: after.head,
    capturedAt: before.capturedAt,
    fingerprint: after.fingerprint,
    files,
    message: files.length ? `发现 ${files.length} 个内容变化。` : "适用范围内未发现文件内容变化。",
    limitations: [...limitations, `排除 ${Math.max(before.excluded, after.excluded)} 个敏感路径。`]
  }
}

function sameScope(a: ChangeReviewScope, b: ChangeReviewScope): boolean {
  return (
    a.threadId === b.threadId &&
    a.workspace === b.workspace &&
    a.incarnationKey === b.incarnationKey &&
    a.runId === b.runId
  )
}

/** Explicit task-start capture only; reading a panel never creates a baseline. */
export class BuiltinChangeReviewService {
  private sequence = 0
  private projectBaselines = new Map<string, ReviewTree>()
  private records = new Map<
    string,
    {
      scope: ChangeReviewScope
      token: number
      baseline?: ReviewTree
      failure?: string
      capturing?: boolean
    }
  >()

  constructor(
    private readonly capacity = 4,
    private readonly projectFacts: typeof readBuiltinProjectFacts = readBuiltinProjectFacts
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw Error("Invalid review capacity")
  }

  private projectKey(
    scope: ChangeReviewScope,
    context: NonNullable<ProjectFactObservation["review"]>,
    baseline: "stage" | "project"
  ) {
    return JSON.stringify([
      scope.workspace,
      context.projectId,
      context.pluginDigest,
      baseline,
      baseline === "stage" ? context.stageId : null
    ])
  }

  private rememberProjectBaselines(
    scope: ChangeReviewScope,
    tree: ReviewTree,
    context: ProjectFactObservation["review"]
  ) {
    if (!context) return
    for (const kind of ["project", "stage"] as const) {
      const first = kind === "project" ? context.firstProjectAttempt : context.firstStageAttempt
      const key = this.projectKey(scope, context, kind)
      if (first && !this.projectBaselines.has(key)) this.projectBaselines.set(key, tree)
    }
    while (this.projectBaselines.size > this.capacity * 2)
      this.projectBaselines.delete(this.projectBaselines.keys().next().value!)
  }

  begin(scope: ChangeReviewScope): number {
    const current = this.records.get(scope.threadId)
    if (current && sameScope(current.scope, scope)) return current.token
    const project = this.projectFacts(scope.threadId, scope.workspace).review
    if (
      current &&
      project &&
      current.scope.workspace === scope.workspace &&
      current.scope.incarnationKey === scope.incarnationKey &&
      current.scope.runId === `project-operation:${project.evidence.operationId}`
    ) {
      // Only a host-bound operation can hand its pre-Hook snapshot to the actual model turn.
      // Preserve failed captures too: a later snapshot would silently omit Hook side effects.
      current.scope = { ...scope }
      return current.token
    }
    const token = ++this.sequence
    this.records.delete(scope.threadId)
    this.records.set(scope.threadId, { scope: { ...scope }, token })
    while (this.records.size > this.capacity) this.records.delete(this.records.keys().next().value!)
    return token
  }

  async capture(scope: ChangeReviewScope, token: number, signal?: AbortSignal): Promise<boolean> {
    const current = this.records.get(scope.threadId)
    if (
      !current ||
      current.token !== token ||
      !sameScope(current.scope, scope) ||
      current.baseline ||
      current.failure ||
      current.capturing
    )
      return false
    current.capturing = true
    try {
      const facts = this.projectFacts(scope.threadId, scope.workspace)
      const baseline = await readReviewTree(scope.workspace, "worktree", signal)
      if (this.records.get(scope.threadId) !== current) return false
      if (this.projectFacts(scope.threadId, scope.workspace).identity !== facts.identity)
        return false
      current.baseline = baseline
      this.rememberProjectBaselines(scope, baseline, facts.review)
      return true
    } catch (error) {
      if (this.records.get(scope.threadId) === current) {
        current.failure = error instanceof Error ? error.message : "REVIEW_FAILED"
      }
      return false
    }
  }

  async read(
    scope: ChangeReviewScope,
    baseline: BuiltinChangeReviewBaseline,
    signal?: AbortSignal
  ): Promise<BuiltinChangeReview> {
    const current = this.records.get(scope.threadId)
    const facts = this.projectFacts(scope.threadId, scope.workspace)
    const projectBaseline =
      (baseline === "stage" || baseline === "project") && facts.review
        ? this.projectBaselines.get(this.projectKey(scope, facts.review, baseline))
        : undefined
    if ((baseline === "stage" || baseline === "project") && !projectBaseline)
      return unavailable(baseline, "REVIEW_PROJECT_BASELINE_MISSING")
    if (
      baseline === "task" &&
      (!current || !sameScope(current.scope, scope) || !current.baseline)
    ) {
      return unavailable(
        baseline,
        current && sameScope(current.scope, scope)
          ? (current.failure ?? "REVIEW_BASELINE_MISSING")
          : "REVIEW_BASELINE_MISSING"
      )
    }
    const deadline = AbortSignal.any([
      AbortSignal.timeout(CHANGE_REVIEW_LIMITS.milliseconds),
      ...(signal ? [signal] : [])
    ])
    const expires = performance.now() + CHANGE_REVIEW_LIMITS.milliseconds
    try {
      const before =
        baseline === "task"
          ? current!.baseline!
          : (projectBaseline ?? (await readReviewTree(scope.workspace, "head", deadline)))
      const after = await readReviewTree(scope.workspace, "worktree", deadline)
      if (baseline === "task" && this.records.get(scope.threadId) !== current) {
        return unavailable(baseline, "REVIEW_BASELINE_MISSING")
      }
      if (this.projectFacts(scope.threadId, scope.workspace).identity !== facts.identity)
        return unavailable(baseline, "REVIEW_WORKSPACE_CHANGED")
      const result = compare(before, after, baseline, expires)
      if (facts.review) result.evidence = facts.review.evidence
      else if (baseline === "task") {
        result.baselineLabel = "原插件会话的模型执行开始快照（此前启动检查改动未纳入）"
        result.limitations.push("原插件启动检查先于本快照；本范围不代表其完整阶段或业务批次。")
      }
      return result
    } catch (error) {
      return unavailable(baseline, error instanceof Error ? error.message : "REVIEW_FAILED")
    }
  }
}

export const builtinChangeReviewService = new BuiltinChangeReviewService()
