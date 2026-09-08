import { stripUserInputTransportDecorations } from "../../../shared/user-input-transport"

const TEN_ASCII_ENGLISH_LETTERS_PATTERN = /(?:[A-Za-z][^A-Za-z]*){10}/

/**
 * Low-cost heuristic requested by the project-operations dashboard.
 *
 * A turn is considered a suspected technical-detail supplement when its full
 * user input contains at least ten ASCII English letters in total. Separators,
 * digits, punctuation, and Chinese text do not reset the count.
 *
 * The count runs on what the user *wrote*, so the composer's own transport
 * decorations are peeled off first. Left in, they decide the metric on their
 * own: the skill-use block alone spends its budget on the tag name and the
 * SKILL.md path, so every explicitly-chosen skill scored true even when the
 * user typed nothing but Chinese — and attachment XML, the built-in browser
 * prefix and a `[coordinator]` token did the same.
 */
export function hasSuspectedTechnicalDetailSupplement(userMessage: string): boolean {
  return TEN_ASCII_ENGLISH_LETTERS_PATTERN.test(stripUserInputTransportDecorations(userMessage))
}
