/** Marketplace usage rule: bare skill names or any identifier starting with `${name}-v`. */
export function buildSkillUsageMatchFilter(
  bases: readonly string[],
  fields: readonly string[]
): Record<string, unknown> {
  const should = fields.flatMap((field) =>
    Array.from(new Set(bases)).flatMap((base) => [
      { term: { [field]: base } },
      { prefix: { [field]: `${base}-v` } }
    ])
  )
  return { bool: { should, minimum_should_match: 1 } }
}
