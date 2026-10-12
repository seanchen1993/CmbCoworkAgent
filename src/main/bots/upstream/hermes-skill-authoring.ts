/** Adapted from Hermes agent/learn_prompt.py; MIT, Nous Research.
 * Keep this instruction immutable for a model session's tool/prompt cache.
 * Hermes-specific schemas, tool names and runtime paths are deliberately omitted.
 */
export const HERMES_SKILL_AUTHORING_GUIDANCE =
  "Include when to use, inputs, prerequisites/platforms, ordered steps, verification, outputs, failure handling and approval boundaries. Use observed evidence and available tool names; parameterize task-specific paths, never save credentials, and do not claim unverified checks passed."
