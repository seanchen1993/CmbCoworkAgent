import { redactAndTruncateSensitiveText } from "./log-redaction"

const MAX_KNOWN_SECRETS = 64
const HIDDEN = "[已隐藏凭据]"

/** Longest proper credential prefix at the truncated text boundary, in linear
 * time. Arbitrarily long credentials cannot turn redaction into a quadratic scan. */
function credentialSuffixLength(text: string, credential: string): number {
  const failure = new Uint16Array(credential.length)
  for (let index = 1, matched = 0; index < credential.length; index++) {
    while (matched > 0 && credential[index] !== credential[matched]) matched = failure[matched - 1]!
    if (credential[index] === credential[matched]) matched++
    failure[index] = matched
  }
  let matched = 0
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    while (matched > 0 && character !== credential[matched]) matched = failure[matched - 1]!
    if (character === credential[matched]) matched++
    if (matched === credential.length) matched = failure[matched - 1]!
  }
  return matched
}

export function maskKnownErrorCredentials(
  text: string,
  limit: number,
  knownSecrets: readonly string[]
): string {
  let prefix = text.slice(0, limit)
  for (const secret of knownSecrets.slice(0, MAX_KNOWN_SECRETS)) {
    if (!secret) continue
    const raw = secret.slice(0, limit + 1)
    const json = JSON.stringify(raw).slice(1, -1)
    let encoded: string | undefined
    try {
      encoded = encodeURIComponent(raw)
    } catch {
      // A malformed Unicode credential is still covered by raw/JSON forms.
    }
    const forms = new Set([
      raw,
      json,
      JSON.stringify(json).slice(1, -1),
      encoded,
      encoded?.replace(/%[0-9A-F]{2}/g, (value) => value.toLowerCase())
    ])
    for (const form of forms) {
      if (!form) continue
      const bounded = form.slice(0, limit + 1)
      prefix = prefix.replaceAll(bounded, HIDDEN)
      // A bounded prefix may end inside an opaque credential. Its proper prefix
      // is also sensitive even when generic api_key/token patterns are absent.
      const length = credentialSuffixLength(prefix, bounded)
      if (length > 0 && (text.length >= limit || length >= Math.min(8, bounded.length)))
        prefix = prefix.slice(0, -length) + HIDDEN
    }
    prefix = prefix.slice(0, limit)
  }
  return prefix
}

/** Bound before scanning. Mask complete and truncation-boundary forms of the
 * invocation's known credentials, then reuse Cmb's general sensitive-text rules.
 * Credentials are call-local inputs and are never retained by a notification. */
export function safeSensitiveErrorText(
  text: string,
  maximum: number,
  knownSecrets: readonly string[] = []
): string {
  const limit = Number.isFinite(maximum) ? Math.max(0, Math.min(8000, Math.floor(maximum))) : 0
  const prefix = maskKnownErrorCredentials(text, limit, knownSecrets)
  // The existing helper can append its own marker; enforce the wire cap after it.
  return redactAndTruncateSensitiveText(prefix, limit, "").slice(0, limit)
}
