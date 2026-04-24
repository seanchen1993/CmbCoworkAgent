/**
 * Renderer-side slash-command types.
 *
 * Mirror of main/slash-commands/types.ts. We duplicate the list/invocation
 * shapes instead of importing across the process boundary because the renderer
 * tsconfig only opts in individual main files (see tsconfig.web.json). Keeping
 * these structurally identical is enforced at the IPC edge — the preload layer
 * does a runtime shape check before forwarding to main.
 */
export type SlashCommandKind = "skill" | "local" | "prompt" | "ui"

export interface SlashCommandListItem {
  kind: "skill"
  id: string
  name: string
  description: string
  source: "project" | "user" | "plugin"
}

export interface SlashInvocation {
  kind: "skill"
  id: string
  args?: string
}

export interface SlashSkillRef {
  kind: "skill"
  id: string
  name: string
  source: "project" | "user" | "plugin"
}
