import { isOrdinaryFlowMetadata } from "./flows/scope"

/** Development overlays belong to ordinary local chats, never background or project executions. */
export function isDevelopmentThreadMetadata(value: unknown): boolean {
  if (!isOrdinaryFlowMetadata(value)) return false
  const metadata = value as Record<string, unknown>
  if (metadata.agentMode !== undefined && metadata.agentMode !== "normal") return false
  return ![
    "pluginId",
    "pluginRoot",
    "isHarnessProjectSession",
    "harnessProjectSession",
    "harnessFeature",
    "harnessProjectId",
    "featureId"
  ].some((key) => Boolean(metadata[key]))
}
