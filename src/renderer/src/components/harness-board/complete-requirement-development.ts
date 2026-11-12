import { createHarnessFeatureThread } from "@/lib/harness-feature-thread"
import { getHarnessRunNextAction } from "@/lib/harness-run-next-action"
import {
  clearRequirementDevelopmentIntent,
  type RequirementDevelopmentIntent
} from "@/lib/requirement-development"
import type { Thread } from "@/types"

type CreateThread = (
  config: {
    workspacePath: string | null
    harnessFeature: { projectId: string; slug: string; source: string }
    requirementDevelopment?: Record<string, unknown>
  },
  options?: { preserveView?: boolean }
) => Promise<Thread>

export async function completeRequirementDevelopment(input: {
  intent: RequirementDevelopmentIntent
  projectId: string
  featureSlug: string
  createThread: CreateThread
}): Promise<string> {
  const { intent, projectId, featureSlug, createThread } = input
  const runDetail = await window.api.harnessBoard.getRunDetail(projectId, featureSlug)
  const workspacePath = runDetail.run.resolvedSessionWorkspacePath
  if (!workspacePath) throw new Error("请先配置特性会话工作区")

  const defaultNextAction = getHarnessRunNextAction(runDetail)
  const requirementContext = intent.requirementContent?.trim()
    ? `${intent.prompt}\n\n以下为随需求携带的完整 PRD 内容：\n\n${intent.requirementContent}`
    : intent.prompt
  const nextAction = defaultNextAction
    ? {
        ...defaultNextAction,
        userMessage: [requirementContext, defaultNextAction.userMessage]
          .map((item) => item?.trim())
          .filter(Boolean)
          .join("\n\n")
      }
    : { userMessage: requirementContext }

  const thread = await createHarnessFeatureThread({
    projectId,
    slug: featureSlug,
    workspacePath,
    nextAction,
    createThread,
    requirementDevelopment: {
      requirementId: intent.requirementId,
      requirementTitle: intent.requirementTitle,
      requirementFilePath: intent.requirementFilePath,
      prototypeFilePaths: intent.prototypeFilePaths,
      functionCount: intent.functionCount,
      hasPrototype: intent.hasPrototype
    }
  })

  if (!intent.requirementId.startsWith("space:") && !intent.requirementId.startsWith("quick-")) {
    const attached = await window.api.requirements.attachThread({
      reqId: intent.requirementId,
      threadId: thread.thread_id,
      development: true
    })
    if (!attached.success) throw new Error(attached.error || "开发会话未能关联需求")
  }

  clearRequirementDevelopmentIntent()
  return thread.thread_id
}
