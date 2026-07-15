export interface WhitelistedPlaceholderRenderOptions {
  allowedKeys?: Iterable<string>
}

const PLACEHOLDER_PATTERN = /\$\{([A-Za-z][A-Za-z0-9_]*)\}/g

export function renderWhitelistedPlaceholders(
  content: string,
  replacements: Record<string, string | undefined>,
  options: WhitelistedPlaceholderRenderOptions = {}
): string {
  const allowedKeys = new Set(options.allowedKeys ?? Object.keys(replacements))

  return content.replace(PLACEHOLDER_PATTERN, (match, key: string) => {
    if (!allowedKeys.has(key)) return match

    const value = replacements[key]
    return value === undefined ? match : value
  })
}
