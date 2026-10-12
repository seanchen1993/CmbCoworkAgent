import { runHooksEnriched } from "../hooks/required-skill"
import { createToolHookMiddlewareCore, type ToolHookMiddlewareOptions } from "./tool-hooks-core"
export type { ToolHookMiddlewareOptions } from "./tool-hooks-core"

/** The desktop supplies its original skill-enrichment runner. Independent Hosts
 * use the same middleware with their own leased hook execution adapter. */
export function createToolHookMiddleware(options: ToolHookMiddlewareOptions) {
  return createToolHookMiddlewareCore(options, runHooksEnriched)
}
