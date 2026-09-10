/**
 * Generate a short, descriptive title from a user's first message.
 *
 * Uses heuristics to extract a meaningful title:
 * - For short messages: use as-is
 * - For questions: use the first sentence/question
 * - For longer text: use first N words
 *
 * @param message - The user's first message
 * @returns A short title (max ~50 chars)
 */
export function generateTitle(message: string): string {
  // Clean up the message
  const cleaned = message.trim().replace(/\s+/g, " ")
  const maxLength = 50

  // If already short enough, use as-is
  if (cleaned.length <= maxLength) {
    return cleaned
  }

  // Try to extract first sentence/question
  const sentenceMatch = cleaned.match(/^[^。！？.!?]+[。！？.!?]/)
  if (sentenceMatch && sentenceMatch[0].length <= 60) {
    return sentenceMatch[0].trim()
  }

  // Extract first N words. Languages such as Chinese often have no spaces, so
  // fall back to a character slice when the first token alone is too long.
  const words = cleaned.split(/\s+/)
  let title = ""

  for (const word of words) {
    if ((title + " " + word).length > 47) {
      break
    }
    title = title ? title + " " + word : word
  }

  if (!title) {
    return cleaned.slice(0, maxLength)
  }

  // Add ellipsis if we truncated
  if (words.join(" ").length > title.length) {
    title += "..."
  }

  return title
}

export function defaultThreadTitle(date = new Date()): string {
  return `Thread ${date.toLocaleDateString()}`
}

/**
 * Check if the title generator is ready (always true for heuristic approach)
 */
export function isModelReady(): boolean {
  return true
}
