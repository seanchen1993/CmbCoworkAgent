import assert from "node:assert/strict"

export const DESKTOP_STREAM_DIAGNOSTIC_MARKER = "\nCMB_DESKTOP_STREAM_DIAGNOSTIC:"

export interface DesktopStreamDiagnosticRecord extends Record<string, unknown> {
  schemaVersion: 1
  callKey: string
  events: { head: unknown[]; tail: unknown[]; [key: string]: unknown }
  actualText: string
}

export function desktopStreamDiagnostic(value: string | undefined): boolean {
  assert(value === undefined || value === "1", "DESKTOP_STREAM_DIAGNOSTIC_FLAG_INVALID")
  return value === "1"
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** This validates a diagnostic copy only; it never repairs content or stream timestamps. */
export function parseDesktopStreamDiagnostic(error: unknown): DesktopStreamDiagnosticRecord | null {
  if (!(error instanceof Error)) return null
  const message = Object.getOwnPropertyDescriptor(error, "message")
  if (!message || !("value" in message) || typeof message.value !== "string") return null
  const marker = message.value.indexOf(DESKTOP_STREAM_DIAGNOSTIC_MARKER)
  if (marker < 0) return null
  const text = message.value.slice(marker + DESKTOP_STREAM_DIAGNOSTIC_MARKER.length)
  assert(Buffer.byteLength(text, "utf8") <= 65536, "DESKTOP_STREAM_DIAGNOSTIC_SIZE")
  // Playwright appends its call stack to page.evaluate errors. The browser's JSON.stringify
  // payload is one line; a later stack line must never be interpreted as another payload.
  const [json, ...stack] = text.split(/\r?\n/)
  assert(
    stack.every((line) => line.trim() === "" || /^\s+at\s/.test(line)),
    "DESKTOP_STREAM_DIAGNOSTIC_SUFFIX"
  )
  const value: unknown = JSON.parse(json)
  let nodes = 0
  const bounded = (item: unknown, depth: number): void => {
    assert(depth <= 12 && ++nodes <= 8192, "DESKTOP_STREAM_DIAGNOSTIC_STRUCTURE")
    if (item === null || typeof item === "boolean") return
    if (typeof item === "number") {
      assert(Number.isFinite(item), "DESKTOP_STREAM_DIAGNOSTIC_NUMBER")
      return
    }
    if (typeof item === "string") {
      assert(item.length <= 4096, "DESKTOP_STREAM_DIAGNOSTIC_STRING")
      return
    }
    assert(typeof item === "object", "DESKTOP_STREAM_DIAGNOSTIC_JSON")
    if (Array.isArray(item)) {
      assert(item.length <= 128, "DESKTOP_STREAM_DIAGNOSTIC_ARRAY")
      for (const child of item) bounded(child, depth + 1)
      return
    }
    for (const [key, child] of Object.entries(item)) {
      assert(
        key.length <= 128 && !["__proto__", "prototype", "constructor"].includes(key),
        "DESKTOP_STREAM_DIAGNOSTIC_KEY"
      )
      bounded(child, depth + 1)
    }
  }
  bounded(value, 0)
  assert(
    record(value) &&
      value.schemaVersion === 1 &&
      typeof value.callKey === "string" &&
      value.callKey.length > 0 &&
      value.callKey.length <= 128 &&
      typeof value.actualText === "string" &&
      value.actualText.length <= 4096 &&
      record(value.events) &&
      Array.isArray(value.events.head) &&
      value.events.head.length <= 128 &&
      Array.isArray(value.events.tail) &&
      value.events.tail.length <= 16,
    "DESKTOP_STREAM_DIAGNOSTIC_DTO"
  )
  return value as DesktopStreamDiagnosticRecord
}

/** Auxiliary evidence failure must not replace the original stream failure. */
export async function rethrowAfterDesktopStreamEvidence(
  error: unknown,
  capture: () => Promise<void>,
  unavailable: (error: unknown) => void
): Promise<never> {
  try {
    await capture()
  } catch (evidenceError) {
    try {
      unavailable(evidenceError)
    } catch {
      /* The original error remains authoritative. */
    }
  }
  throw error
}
