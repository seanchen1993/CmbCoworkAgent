import { SKILL_USE_TAG_NAME } from "./skill-use-block"

// ── Composer-injected transport decorations ───────────────────────────────────
// What reaches the main process as a "user message" is not what the user typed:
// the composer wraps that text in blocks the model needs (a selected skill's
// SKILL.md pointer, attachment/@file XML, the built-in browser prefix) plus the
// mode prefixes the user may have typed as a control token rather than as prose.
// Anything that reads the payload as *user input* — not as a model payload —
// has to peel these off first, or it measures the wrapper instead of the person.
//
// The built-in browser prefixes are owned here (rather than in the renderer
// feature that prepends them) so main-process consumers, which must not import
// renderer modules, share one spelling with the composer.

export const BUILTIN_BROWSER_PROMPT_PREFIX = "使用内置浏览器 browser_*工具："
export const BUILTIN_BROWSER_NO_SCREENSHOT_PROMPT_PREFIX =
  "使用内置浏览器 browser_*工具（不允许使用截图功能）："

const SKILL_USE_BLOCK_PATTERN = new RegExp(
  `<${SKILL_USE_TAG_NAME}>[\\s\\S]*?</${SKILL_USE_TAG_NAME}>`,
  "g"
)
/** Paired blocks carry the file body; @file mentions resolve to the self-closing form. */
const ATTACHMENT_BLOCK_PATTERN = /<attachment\b[^>]*\/>|<attachment\b[^>]*>[\s\S]*?<\/attachment>/gi
const COORDINATOR_PREFIX_PATTERN = /^\s*(?:\[coordinator\]|#coordinator)\s*[:-]?\s*/i
/** Lower-case only, so a message opening with an absolute path is left alone. */
const SLASH_COMMAND_PATTERN = /^\s*\/[a-z][a-z0-9-]*(?=\s|$)/

/**
 * Reduce a transported user message back to the text the user actually wrote.
 *
 * Prefixes are peeled outermost-first (the browser prefix wraps the whole text,
 * including a `[coordinator]` token the user typed), then the embedded blocks go.
 * A stripped block leaves a space behind so the words on either side of it stay
 * separate rather than fusing into one token.
 */
export function stripUserInputTransportDecorations(content: string): string {
  let text = content
  if (text.startsWith(BUILTIN_BROWSER_NO_SCREENSHOT_PROMPT_PREFIX)) {
    text = text.slice(BUILTIN_BROWSER_NO_SCREENSHOT_PROMPT_PREFIX.length)
  } else if (text.startsWith(BUILTIN_BROWSER_PROMPT_PREFIX)) {
    text = text.slice(BUILTIN_BROWSER_PROMPT_PREFIX.length)
  }
  return text
    .replace(COORDINATOR_PREFIX_PATTERN, "")
    .replace(SLASH_COMMAND_PATTERN, "")
    .replace(SKILL_USE_BLOCK_PATTERN, " ")
    .replace(ATTACHMENT_BLOCK_PATTERN, " ")
    .trim()
}
