import { createHarnessFeatureThread } from "@/lib/harness-feature-thread"
import { MISSING_FEATURE_WORKSPACE } from "../../../../shared/harness-feature-workspace"

type PrepareSessionParams = Parameters<typeof createHarnessFeatureThread>[0]

/** A grant failure must not turn an already-created conversation into a retryable creation. */
export async function prepareProjectCapabilitySession(
  params: PrepareSessionParams,
  onPartialFailure: (message: string) => void
): Promise<string> {
  const workspacePath = params.workspacePath?.trim()
  if (!workspacePath) throw new Error(MISSING_FEATURE_WORKSPACE)
  let createdThreadId: string | undefined
  try {
    const thread = await createHarnessFeatureThread({
      ...params,
      workspacePath,
      createThread: async (...args) => {
        const created = await params.createThread(...args)
        createdThreadId = created.thread_id
        return created
      }
    })
    return thread.thread_id
  } catch (error) {
    if (!createdThreadId) throw error
    onPartialFailure("会话已创建，但招乎接入未完成，请继续使用已创建的会话。")
    return createdThreadId
  }
}
