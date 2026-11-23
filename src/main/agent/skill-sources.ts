import { createSkillsMiddleware } from "deepagents"

export function combineSkillMiddlewareSources(
  standaloneSkillSources: string[],
  pluginSkillSources: string[]
): string[] {
  return [...pluginSkillSources, ...standaloneSkillSources]
}

/** Refresh checkpointed skill metadata at the start of each agent invocation. */
export function createRefreshingSkillsMiddleware(
  options: Parameters<typeof createSkillsMiddleware>[0],
  botCommunication = false
): ReturnType<typeof createSkillsMiddleware> {
  const middleware = createSkillsMiddleware(options)
  const beforeAgent = middleware.beforeAgent
  const wrapModelCall = middleware.wrapModelCall
  if (typeof beforeAgent !== "function" || typeof wrapModelCall !== "function") return middleware

  let directory = ""
  return {
    ...middleware,
    beforeAgent: async (state, runtime) => {
      // deepagents otherwise treats nonempty checkpoint metadata as current.
      const update = await beforeAgent({ ...state, skillsMetadata: [] }, runtime)
      if (botCommunication && update && Array.isArray(update.skillsMetadata)) {
        const entries = update.skillsMetadata.map(({ name, description, path }) =>
          JSON.stringify({ name, description, path }))
        directory = entries.length
          ? "\n\n## Available skills\nFor a skill you discover here from the user's goal, call bot_work_create directly and put its name in the goal (bot_work_send for an existing task). Only pass a name to bot_skill_dispatch when the user supplied that name in their instruction or selected it with /. A catalogue match alone is not a user selection.\n" + entries.join("\n")
          : ""
      }
      return update
    },
    wrapModelCall: (request, handler) => {
      if (botCommunication)
        return handler(directory ? { ...request, systemMessage: request.systemMessage.concat(directory) } : request)
      // When the refreshed catalogue is empty, deepagents falls back to request.state.
      // Hide checkpoint metadata there too, so no removed skill reaches the model.
      return wrapModelCall({ ...request, state: { ...request.state, skillsMetadata: [] } }, handler)
    }
  }
}
