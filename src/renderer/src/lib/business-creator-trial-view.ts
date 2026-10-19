import type {
  DevelopmentBusinessStatus,
  DevelopmentBusinessTrialSession,
  DevelopmentBusinessTrialScope,
  DevelopmentBusinessTrialStatus
} from "../../../shared/mods/development"
import type { Thread, ThreadMessagesPage, ThreadMessagesPageOptions } from "../../../main/types"
import { isSameWorkspacePath } from "../../../shared/workspace-path"

type Review = NonNullable<DevelopmentBusinessStatus["review"]>

/** Display eligibility only. Every action still requires the original main-process checks. */
export function businessCreatorTrialView(review: Review, trial?: DevelopmentBusinessTrialStatus) {
  const current = !!trial && trial.planId === review.planId && trial.digest === review.digest
  const unsettled =
    !!trial &&
    (trial.canStop || ["unknown", "preparing", "starting", "running"].includes(trial.phase))
  return {
    current,
    canRequest:
      !unsettled &&
      (!current || (!!trial && ["completed", "failed", "cancelled"].includes(trial.phase))),
    canPrepare: !!trial && current && trial.phase === "needs-confirmation" && trial.canPrepare,
    showConfiguration: !!trial && current && ["needs-configuration", "ready"].includes(trial.phase)
  }
}

export function businessCreatorTrialScope(
  threadId: string,
  workspace: string,
  trial: Pick<DevelopmentBusinessTrialStatus, "id" | "digest" | "version">
): DevelopmentBusinessTrialScope {
  return {
    threadId,
    expectedWorkspace: workspace,
    trialId: trial.id,
    digest: trial.digest,
    expectedVersion: trial.version
  }
}

/** Selection never follows a new executing thread once the user is reading an existing session. */
export function businessCreatorTrialSessionView(
  trial: DevelopmentBusinessTrialStatus,
  selectedThreadId?: string | null
) {
  const observation = trial.observation
  const sessions = observation?.sessions ?? []
  const selected = sessions.find(
    (item) => item.threadId === (selectedThreadId ?? observation?.threadId)
  )
  const live =
    !!selected &&
    !selected.endedAt &&
    !selected.outcome &&
    trial.phase === "running" &&
    observation?.status === "running" &&
    selected.threadId === observation.threadId
  return { selected, mode: live ? ("live" as const) : ("history" as const) }
}

/** A native page reader only: no ChatContainer, FunctionSite, guest mount or tool approval call. */
export async function readBusinessCreatorTrialHistory(
  observation: Pick<
    NonNullable<DevelopmentBusinessTrialStatus["observation"]>,
    "projectId" | "featureId" | "runId" | "workspace" | "sessions"
  >,
  session: DevelopmentBusinessTrialSession,
  api: {
    get(threadId: string): Promise<Thread | null>
    getMessagesPage(
      threadId: string,
      options?: ThreadMessagesPageOptions
    ): Promise<ThreadMessagesPage>
  },
  cursor?: Pick<ThreadMessagesPageOptions, "beforeOrdinal" | "beforeMessageId">
) {
  const assertThread = (thread: Thread | null) => {
    const feature = thread?.metadata?.harnessFeature as Record<string, unknown> | undefined
    const rawToken = thread?.metadata?.cmb_thread_incarnation
    const token = typeof rawToken === "string" && rawToken ? rawToken : null
    const incarnation = session.incarnation
    if (
      !observation.sessions?.some(
        (item) =>
          item.threadId === session.threadId &&
          item.incarnation.token === incarnation.token &&
          item.incarnation.legacyCreatedAt === incarnation.legacyCreatedAt
      ) ||
      !thread ||
      thread.thread_id !== session.threadId ||
      feature?.projectId !== observation.projectId ||
      feature.slug !== observation.featureId ||
      feature.runId !== observation.runId ||
      typeof thread.metadata?.workspacePath !== "string" ||
      !isSameWorkspacePath(thread.metadata?.workspacePath as string, observation.workspace) ||
      token !== incarnation.token ||
      thread.created_at.getTime() !== incarnation.legacyCreatedAt
    )
      throw Error("BUSINESS_TRIAL_HISTORY_THREAD_CHANGED")
  }
  assertThread(await api.get(session.threadId))
  const page = await api.getMessagesPage(session.threadId, {
    ...cursor,
    limit: 40,
    byteBudget: 256 * 1024
  })
  assertThread(await api.get(session.threadId))
  return page
}
