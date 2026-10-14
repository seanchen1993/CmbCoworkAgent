import { createSkillsMiddleware, type SkillsMiddlewareOptions } from "deepagents"
import type { ClawSkillPolicy } from "../mods/claw-skills"
import { resolve } from "node:path"

function sourceKey(source: string): string {
  const normalized = resolve(source).replace(/\\/g, "/").replace(/\/+$/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

/** Checkpoint catalogs predate the current Claw binding and cannot grant skills. */
export function createClawSkillsMiddleware(
  options: SkillsMiddlewareOptions,
  policy?: ClawSkillPolicy
): ReturnType<typeof createSkillsMiddleware> {
  const allowedSources = policy && new Set(policy.middlewareSources.map(sourceKey))
  const middleware = createSkillsMiddleware(
    allowedSources
      ? {
          ...options,
          sources: options.sources.filter((source) => allowedSources.has(sourceKey(source)))
        }
      : options
  )
  if (!policy) return middleware
  const beforeAgent = middleware.beforeAgent
  const wrapModelCall = middleware.wrapModelCall
  if (typeof beforeAgent !== "function" || typeof wrapModelCall !== "function")
    throw Error("CLAW_SKILL_MIDDLEWARE_UNSUPPORTED")
  const assertCurrent = () => {
    policy.assertAllCurrent()
  }
  return {
    ...middleware,
    beforeAgent: async (state, runtime) => {
      assertCurrent()
      // Force discovery through the already filtered backend. The upstream
      // middleware otherwise trusts retained state and never touches that backend.
      const update = await beforeAgent({ ...state, skillsMetadata: [] }, runtime)
      assertCurrent()
      return update
    },
    wrapModelCall: (request, handler) => {
      assertCurrent()
      // Upstream falls back to request.state when its fresh catalog is empty.
      // Never resurrect a checkpoint catalog in that branch either.
      return wrapModelCall({ ...request, state: { ...request.state, skillsMetadata: [] } }, handler)
    }
  }
}
