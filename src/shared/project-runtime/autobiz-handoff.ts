/** Opt-in output for new reviewed AutoBiz copies; existing frozen definitions stay unchanged. */
export const AUTOBIZ_CONTEXT_OUTPUT = {
  id: "verified-context",
  path: ".devclaw/handoffs/verified-context.json"
} as const
export const AUTOBIZ_CONTEXT_MAX_BYTES = 256 * 1024
export const SOURCE_HANDOFF_PATH = "devclaw.source-handoff.json"
export const SOURCE_HANDOFF_DECLARATION = {
  apiVersion: "devclaw.source-handoff/v1", scopes: ["src"]
} as const
export interface AutobizContextFile {
  id: string
  path: string
  digest: string
  outputNodeId: string
  checkedBy: { nodeId: string; checkId: string; contractDigest: string }
  content: string
}
export const isAutobizContextOutput = (output: { id: string; path: string }): boolean =>
  output.id === AUTOBIZ_CONTEXT_OUTPUT.id && output.path === AUTOBIZ_CONTEXT_OUTPUT.path
