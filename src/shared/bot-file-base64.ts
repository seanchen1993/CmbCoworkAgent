/** Strict RFC 4648 byte count without decoding or allocating a second full string. */
export function canonicalBotFileBase64Bytes(raw: string, byteLimit: number): number | null {
  if (
    !Number.isSafeInteger(byteLimit) ||
    byteLimit < 0 ||
    raw.length % 4 !== 0 ||
    raw.length > Math.ceil(byteLimit / 3) * 4
  )
    return null
  const padding = raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0
  const bytes = (raw.length / 4) * 3 - padding
  if (bytes < 0 || bytes > byteLimit) return null
  let last = 0
  for (let i = 0; i < raw.length - padding; i++) {
    const code = raw.charCodeAt(i)
    const value =
      code >= 65 && code <= 90
        ? code - 65
        : code >= 97 && code <= 122
          ? code - 71
          : code >= 48 && code <= 57
            ? code + 4
            : code === 43
              ? 62
              : code === 47
                ? 63
                : -1
    if (value < 0) return null
    last = value
  }
  // Node's decoder silently discards these bits; canonical padding requires zero.
  if ((padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) return null
  return bytes
}
