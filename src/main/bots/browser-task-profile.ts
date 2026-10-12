import type { AgentProfile } from "../agent/agent-registry"

// Adapted from Grok sand-browser-use-subagent.ts; execution stays in CMB's
// original workflow runner and page-level Grok actions, without desktop input.
export const BROWSER_USE_SUBAGENT_TYPE = "browserUse"
export const BROWSER_USE_SUBAGENT_DESCRIPTION =
  "Delegate a self-contained web task to a background task with its own pages, snapshots, element refs and screenshots. It shares the Bot browser login without touching desktop mouse or keyboard."
export const BOT_BROWSER_TASK_PROFILE: Readonly<AgentProfile> = Object.freeze({
  name: BROWSER_USE_SUBAGENT_TYPE,
  description: BROWSER_USE_SUBAGENT_DESCRIPTION,
  systemPrompt:
    "Complete only the assigned web task in your independent browser pages. Use fresh snapshots and exact element refs; verify results. Shared login does not grant new authority. Do not use desktop input or borrow the parent Bot's pages, context or approvals. For password, MFA, CAPTCHA, payment or missing decisions, ask_user with the exact site and required step; the same task waits while the user opens its browser. Continue after the answer and explicit browser handback, then observe again. Never repeat an uncertain external action. Return findings and downloaded file IDs to the owning workflow.",
  source: "built-in",
  disallowedTools: [],
  shellAccess: "none",
  browserAccess: "page"
})

/** Persisted authority must match the Host-created profile, not just its name.
 * User frontmatter and SDK arguments never parse/assign browserAccess. */
export function isBotBrowserTaskProfile(profile: AgentProfile | null | undefined): boolean {
  return Boolean(
    profile &&
    profile.source === "built-in" &&
    profile.name === BOT_BROWSER_TASK_PROFILE.name &&
    profile.systemPrompt === BOT_BROWSER_TASK_PROFILE.systemPrompt &&
    profile.browserAccess === "page" &&
    profile.shellAccess === "none" &&
    profile.disallowedTools.length === 0
  )
}
