import { createSkillsMiddleware } from "deepagents"

export function combineSkillMiddlewareSources(
  standaloneSkillSources: string[],
  pluginSkillSources: string[]
): string[] {
  return [...pluginSkillSources, ...standaloneSkillSources]
}

/** Refresh checkpointed skill metadata at the start of each agent invocation. */
export function createRefreshingSkillsMiddleware(
  options: Parameters<typeof createSkillsMiddleware>[0]
): ReturnType<typeof createSkillsMiddleware> {
  const middleware = createSkillsMiddleware(options)
  const beforeAgent = middleware.beforeAgent
  const wrapModelCall = middleware.wrapModelCall
  if (typeof beforeAgent !== "function" || typeof wrapModelCall !== "function") return middleware

  return {
    ...middleware,
    beforeAgent: async (state, runtime) => {
      // deepagents otherwise treats nonempty checkpoint metadata as current.
      return beforeAgent({ ...state, skillsMetadata: [] }, runtime)
    },
    wrapModelCall: (request, handler) =>
      // When the refreshed catalogue is empty, deepagents falls back to request.state.
      // Hide checkpoint metadata there too, so no removed skill reaches the model.
      wrapModelCall({ ...request, state: { ...request.state, skillsMetadata: [] } }, handler)
  }
}
