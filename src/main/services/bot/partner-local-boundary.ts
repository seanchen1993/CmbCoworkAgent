const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export class PartnerLocalFault extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
export function partnerId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value) || /[\r\n]/.test(value))
    throw new PartnerLocalFault("INVALID_PAYLOAD")
  return value
}
export function partnerObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw new PartnerLocalFault("INVALID_PAYLOAD")
  return value as Record<string, unknown>
}
