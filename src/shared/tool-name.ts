/**
 * Whether a string can be a tool name at all.
 *
 * This is not a registry check, and deliberately so. A closed list would be
 * wrong here: MCP tools, saved code_exec tools and plugin-supplied tools are
 * named at runtime, and those are exactly the ones worth seeing in usage
 * statistics. `normalizeToolName` in agent-registry answers a different
 * question — "does this token map to a tool this project knows" — and returns
 * null for every dynamic one.
 *
 * The alphabet below is not invented. Every path that mints a tool name already
 * constrains it to the same characters:
 *
 *   MCP         `value.replace(/[^a-zA-Z0-9_]/g, "")`  (mcp/aliasing ensureIdentifier)
 *   saved tools `/^[A-Za-z0-9_-]+$/`                   (code-exec/saved-tool-store)
 *   built-ins   snake_case
 *
 * So no legitimate name can contain a space, quote, angle bracket, pipe or CJK
 * character — which is what a model's raw text looks like when a malformed tool
 * call is parsed as one. Those were reaching usage statistics as "tools",
 * outranking the real ones: the dashboard's filter excludes built-ins by exact
 * name, so `read_file` was hidden while `read_file</think> <|DSML|…` was not.
 *
 * Callers that validate at creation time keep their own copies of the pattern,
 * because they answer with a specific message about what the user typed. This
 * one only decides whether to record something.
 */

const TOOL_NAME_SHAPE = /^[A-Za-z0-9_-]+$/

/**
 * Comfortably above the longest name any minting path produces — an MCP tool is
 * `mcp__<provider>__<tool>` of trimmed identifiers — and low enough that a
 * runaway identifier cannot become an aggregation term.
 */
const MAX_TOOL_NAME_LENGTH = 128

export function isPlausibleToolName(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= MAX_TOOL_NAME_LENGTH && TOOL_NAME_SHAPE.test(value)
  )
}
