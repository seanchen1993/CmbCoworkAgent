/**
 * Shared types for the expert-team (专家团) feature, crossing
 * main → preload → renderer. Single source of truth for the IPC payload shape
 * so the four layers can't drift independently.
 */

/** Coarse capability tier shown as a badge in the settings UI.
 * read_only = no file writes + read-only shell; verify = no file writes but
 * full shell (can run tests/audits); full = unrestricted tools. */
export type ExpertAgentAccess = "read_only" | "verify" | "full"

export interface ExpertAgentEntry {
  name: string
  description: string
  /** Built-ins are always on and cannot be toggled off in the UI. */
  builtIn: boolean
  enabled: boolean
  access: ExpertAgentAccess
}
