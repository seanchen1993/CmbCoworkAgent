const TEN_ASCII_ENGLISH_LETTERS_PATTERN = /(?:[A-Za-z][^A-Za-z]*){10}/

/**
 * Low-cost heuristic requested by the project-operations dashboard.
 *
 * A turn is considered a suspected technical-detail supplement when its full
 * user input contains at least ten ASCII English letters in total. Separators,
 * digits, punctuation, and Chinese text do not reset the count.
 */
export function hasSuspectedTechnicalDetailSupplement(userMessage: string): boolean {
  return TEN_ASCII_ENGLISH_LETTERS_PATTERN.test(userMessage)
}
