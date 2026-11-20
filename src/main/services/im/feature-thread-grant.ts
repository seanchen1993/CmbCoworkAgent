import { builtinRobotManager } from "./manager"
import { imRemoteAccessService } from "./remote-access-service"
import type { ImGrantRouteIdentity } from "./remote-grant-store"
import { getHarnessFeatureBinding } from "../../harness-board/service"
import type { HarnessFeatureThreadGrantResult } from "../../../shared/harness-board-types"

export async function materializeHarnessFeatureThreadGrant(input: {
  projectId: string
  featureId: string
  threadId: string
  route?: ImGrantRouteIdentity
}): Promise<HarnessFeatureThreadGrantResult> {
  const binding = await getHarnessFeatureBinding(input.projectId, input.featureId)
  const required = Boolean(input.route || binding?.imManagementEnabled)
  if (!required) return { required: false, granted: false }
  try {
    if (input.route) {
      await imRemoteAccessService.enableThread({ route: input.route, threadId: input.threadId })
    } else {
      await builtinRobotManager.setThreadRemoteAccess(input.threadId, true)
    }
    return { required: true, granted: true }
  } catch (error) {
    return {
      required: true,
      granted: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
