import type { HarnessKnowledgeApi } from "../shared/harness-board-types"

/** Share exact signatures with Window.api; IPC still validates and resolves every identity. */
export function createHarnessKnowledgeApi(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
): HarnessKnowledgeApi {
  return {
    syncProjectConstraints: (adapterId, target) =>
      invoke("harnessBoard:syncProjectConstraints", adapterId, target) as
        ReturnType<HarnessKnowledgeApi["syncProjectConstraints"]>,
    getKnowledgePreview: (adapterId, target) =>
      invoke("harnessBoard:getKnowledgePreview", adapterId, target) as
        ReturnType<HarnessKnowledgeApi["getKnowledgePreview"]>,
    getPublicAgentmdDeployUnits: (projectId, featureId) =>
      invoke("harnessBoard:getPublicAgentmdDeployUnits", projectId, featureId) as Promise<string[]>
  }
}
