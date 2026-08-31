import { createHash } from "node:crypto"

export const DISABLED_SKILL_STORE_MISSING_FINGERPRINT = "missing"

export function fingerprintDisabledSkillStoreText(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`
}

export function isDisabledSkillStoreFingerprint(value: unknown): value is string {
  return (
    value === DISABLED_SKILL_STORE_MISSING_FINGERPRINT ||
    (typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value))
  )
}
