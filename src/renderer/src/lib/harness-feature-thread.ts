import type { HarnessRunDetailViewModel, HarnessWorkflowNextAction, Thread } from "@/types"
import { setPendingHarnessNextAction } from "@/lib/harness-next-action"
import { getHarnessRunNextAction } from "@/lib/harness-run-next-action"
import { HARNESS_SOURCE } from "../../../shared/harness-board-types"
import { toast } from "sonner"

type CreateHarnessThread = (
  config: {
    workspacePath: string | null
    harnessFeature: { projectId: string; slug: string; source: string }
  },
  options?: { preserveView?: boolean }
) => Promise<Thread>

interface CreateHarnessFeatureThreadParams {
  projectId: string
  slug: string
  workspacePath: string | null
  createThread: CreateHarnessThread
  nextAction?: HarnessWorkflowNextAction
  runDetail?: HarnessRunDetailViewModel | null
}

type CreateHarnessFeatureThreadFromLatestRunParams = Omit<
  CreateHarnessFeatureThreadParams,
  "nextAction" | "runDetail"
>

export async function createHarnessFeatureThread({
  projectId,
  slug,
  workspacePath,
  createThread,
  nextAction,
  runDetail
}: CreateHarnessFeatureThreadParams): Promise<Thread> {
  const thread = await createThread(
    {
      workspacePath,
      harnessFeature: { projectId, slug, source: HARNESS_SOURCE }
    },
    { preserveView: true }
  )

  const resolvedNextAction = nextAction ?? getHarnessRunNextAction(runDetail)
  if (resolvedNextAction) {
    setPendingHarnessNextAction(thread.thread_id, resolvedNextAction)
  }

  const grant = await window.api.harnessBoard.ensureFeatureThreadImGrant({
    projectId,
    featureId: slug,
    threadId: thread.thread_id
  })
  if (grant.required && !grant.granted) {
    toast.error(grant.error || "会话已创建，但未能接入招乎")
  }

  return thread
}

export async function createHarnessFeatureThreadFromLatestRun(
  params: CreateHarnessFeatureThreadFromLatestRunParams
): Promise<Thread> {
  const runDetail = await window.api.harnessBoard.getRunDetail(params.projectId, params.slug)
  return createHarnessFeatureThread({ ...params, runDetail })
}
