import type { createMiddleware } from "langchain"

/** Desktop services are supplied by runtime.ts; headless graphs opt in explicitly.
 * Requesting a capability without its service fails during assembly/use.
 * Type-only dependencies never load desktop state in the Bot host.
 */
export interface DeepAgentServices {
  getModsManager?: typeof import("../mods/manager").getModsManager
  createTrustedToolFilePreviewContextMiddleware?: (
    threadId: string
  ) => ReturnType<typeof createMiddleware>
  createTaskMmdMiddleware?: typeof import("./task-mmd/middleware").createTaskMmdMiddleware
  createFunctionChildTurnMiddleware?: typeof import("./mods-session-view").createFunctionChildTurnMiddleware
  currentFunctionExecution?: typeof import("../mods/v2/execution-context").currentFunctionExecution
  setCapturedSystemPromptPreview?: (preview: {
    threadId: string
    prompt: string
    updatedAt: number
  }) => void
  createFunctionSessionViewMiddleware?: typeof import("./mods-session-view").createFunctionSessionViewMiddleware
  isWorkflowActive?: (queueId: string) => boolean
}
