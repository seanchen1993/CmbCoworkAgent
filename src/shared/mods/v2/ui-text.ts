/** Bounded display text only. Call after the full input has passed content protection. */
export function functionUiTextProjection(text: string, limit: 2000 | 10000 | 100000): string {
  return text
    .slice(0, limit)
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (part) =>
      part.length === 2 ? part : "\uFFFD"
    )
}
