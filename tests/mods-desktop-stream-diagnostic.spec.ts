import assert from "node:assert/strict"
import {
  DESKTOP_STREAM_DIAGNOSTIC_MARKER,
  desktopStreamCanonicalTarget,
  desktopStreamDiagnostic,
  parseDesktopStreamDiagnostic,
  rethrowAfterDesktopStreamEvidence
} from "./support/mods-desktop-stream-diagnostic"

async function main() {
  assert.equal(desktopStreamDiagnostic(undefined), false)
  assert.equal(desktopStreamDiagnostic("1"), true)
  for (const value of ["", "0", "true", "false", " 1", "1 ", "2"])
    assert.throws(() => desktopStreamDiagnostic(value), /FLAG_INVALID/)

  const base = {
    schemaVersion: 1,
    callKey: "round0-enabled-warmup",
    actualText: "word000 ",
    actualLength: 8,
    expectedLength: 320,
    textEqual: false,
    firstDefined: true,
    first: 123.5,
    last: 123.5,
    started: 120,
    events: { head: [{ type: "stream", mode: "messages", contentMode: "snapshot" }], tail: [] }
  }
  const error = (value: unknown) =>
    new Error("DESKTOP_STREAM_CONTENT:8" + DESKTOP_STREAM_DIAGNOSTIC_MARKER + JSON.stringify(value))
  const parsed = parseDesktopStreamDiagnostic(error(base))
  assert.deepEqual(parsed, base, "Parsing must preserve the failed lengths, flags and timestamps")
  const canonical = {
    type: "stream",
    mode: "messages",
    className: "AIMessage",
    kwargsId: "ea7230b7-3f28-45ac-be30-f7c0e070d12a",
    providerSourceId: "desktop-stream-2",
    providerOccurrence: 1,
    wire: { content: "snapshot", reasoning: "snapshot", tool: "snapshot" }
  }
  const trace = (events: unknown[], extras: Record<string, unknown> = {}) => {
    const result = parseDesktopStreamDiagnostic(
      error({
        ...base,
        eventCount: events.length,
        events: { head: events, tail: [], overflow: 0, byteBudgetTruncated: false },
        ...extras
      })
    )
    assert(result)
    return result
  }
  const matched = {
    state: "matched",
    messageId: canonical.kwargsId,
    providerSourceId: canonical.providerSourceId,
    providerOccurrence: 1
  }
  assert.deepEqual(desktopStreamCanonicalTarget(trace([canonical]), ["desktop-stream-2"]), matched)
  assert.deepEqual(
    desktopStreamCanonicalTarget(trace([canonical, canonical]), ["desktop-stream-2"]),
    matched
  )
  const inTail = trace([], {
    eventCount: 1,
    events: { head: [], tail: [canonical], overflow: 1, byteBudgetTruncated: false }
  })
  assert.deepEqual(desktopStreamCanonicalTarget(inTail, ["desktop-stream-2"]), matched)
  for (const value of [null, [], {}, { ...base, schemaVersion: 2 }])
    assert.equal(desktopStreamCanonicalTarget(value, ["desktop-stream-2"]).state, "unknown")
  for (const events of [
    [],
    [{ ...canonical, className: "AIMessageChunk" }],
    [{ ...canonical, kwargsId: "not-a-uuid" }],
    [{ ...canonical, providerOccurrence: 0 }],
    [{ ...canonical, providerOccurrence: 1.5 }],
    [{ ...canonical, providerSourceId: "other" }],
    [{ ...canonical, wire: { ...canonical.wire, content: "delta" } }],
    [canonical, { ...canonical, kwargsId: "aa7230b7-3f28-45ac-be30-f7c0e070d12a" }],
    [canonical, { ...canonical, providerOccurrence: 2 }],
    [canonical, { ...canonical, providerSourceId: "other" }]
  ])
    assert.equal(desktopStreamCanonicalTarget(trace(events), ["desktop-stream-2"]).state, "unknown")
  for (const responseIds of [
    [],
    ["desktop-stream-2", "desktop-stream-2"],
    [""],
    ["bad id"],
    ["x".repeat(129)]
  ])
    assert.equal(desktopStreamCanonicalTarget(trace([canonical]), responseIds).state, "unknown")
  for (const extras of [
    { eventCount: 2 },
    { eventCount: -1 },
    { eventCount: 1.5 },
    { events: { head: [canonical], tail: [], overflow: 1, byteBudgetTruncated: false } },
    { events: { head: [canonical], tail: [], overflow: 0, byteBudgetTruncated: true } },
    { events: { head: [canonical], tail: [], byteBudgetTruncated: false } }
  ])
    assert.equal(
      desktopStreamCanonicalTarget(trace([canonical], extras), ["desktop-stream-2"]).state,
      "unknown"
    )
  for (const newline of ["\n", "\r\n"]) {
    const transported = new Error(
      "page.evaluate: Error: DESKTOP_STREAM_CONTENT:8" +
        DESKTOP_STREAM_DIAGNOSTIC_MARKER +
        JSON.stringify(base) +
        newline +
        "    at eval (eval at evaluate (:290:30), <anonymous>:1:916)" +
        newline +
        "    at call (desktop-performance.ts:127:33)"
    )
    assert.deepEqual(parseDesktopStreamDiagnostic(transported), base)
  }
  for (const tail of [
    "invalid first line\n" + JSON.stringify(base),
    JSON.stringify(base) + "\n" + JSON.stringify(base),
    JSON.stringify(base) + "\n    at " + "x".repeat(65536)
  ])
    assert.throws(() =>
      parseDesktopStreamDiagnostic(new Error(DESKTOP_STREAM_DIAGNOSTIC_MARKER + tail))
    )
  assert.equal(parseDesktopStreamDiagnostic(new Error("original without marker")), null)
  assert.equal(parseDesktopStreamDiagnostic({ message: error(base).message }), null)
  assert.equal(parseDesktopStreamDiagnostic(null), null)
  let getterCalls = 0
  const accessor = new Error()
  Object.defineProperty(accessor, "message", {
    get() {
      getterCalls++
      return error(base).message
    }
  })
  assert.equal(parseDesktopStreamDiagnostic(accessor), null)
  assert.equal(getterCalls, 0)
  for (const value of [
    null,
    [],
    {},
    { ...base, schemaVersion: 2 },
    { ...base, callKey: "" },
    { ...base, callKey: "x".repeat(129) },
    { ...base, actualText: "x".repeat(4097) },
    { ...base, events: { head: Array(129).fill(null), tail: [] } },
    { ...base, events: { head: [], tail: Array(17).fill(null) } },
    { ...base, first: "x".repeat(4097) }
  ])
    assert.throws(() => parseDesktopStreamDiagnostic(error(value)))
  for (const json of [
    "not JSON",
    "{",
    " ".repeat(65537),
    JSON.stringify(base).replace('"first":123.5', '"first":1e999'),
    JSON.stringify(base).slice(0, -1) + ',"__proto__":{}}'
  ])
    assert.throws(() =>
      parseDesktopStreamDiagnostic(new Error(DESKTOP_STREAM_DIAGNOSTIC_MARKER + json))
    )
  let nested: unknown = 1
  for (let index = 0; index < 14; index++) nested = { nested }
  assert.throws(() => parseDesktopStreamDiagnostic(error({ ...base, nested })), /STRUCTURE/)

  const original = new Error("original stream failure")
  const captureFailure = new Error("DOM unavailable")
  let calls = 0
  await assert.rejects(
    rethrowAfterDesktopStreamEvidence(
      original,
      async () => {
        calls++
      },
      () => {}
    ),
    (received) => received === original
  )
  assert.equal(calls, 1)
  let unavailable: unknown
  await assert.rejects(
    rethrowAfterDesktopStreamEvidence(
      original,
      async () => {
        throw captureFailure
      },
      (received) => {
        unavailable = received
        throw Error("unavailable recorder failed too")
      }
    ),
    (received) => received === original
  )
  assert.equal(unavailable, captureFailure)
  const arbitrary = Object.freeze({ original: true })
  try {
    await rethrowAfterDesktopStreamEvidence(
      arbitrary,
      async () => {
        parseDesktopStreamDiagnostic(error({ ...base, schemaVersion: 2 }))
      },
      () => {}
    )
    assert.fail("Original thrown value required")
  } catch (received) {
    assert.equal(received, arbitrary)
  }
  console.log(
    JSON.stringify({
      passed: 5,
      checks: [
        "strict flag",
        "bounded DTO",
        "canonical observed identity",
        "no getter",
        "original throw identity"
      ]
    })
  )
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
