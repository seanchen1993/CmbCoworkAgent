/** Draft identities need uniqueness; getRandomValues also works in local/opaque origins. */
export function flowDraftId(prefix: "flow" | "step" | "claw"): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}
