/**
 * Unit tests for PR-13a — handler-type-aware timeout bounds.
 *
 * Run:
 *   npx tsx tests/hook-timeout-bounds.spec.ts
 */

import {
  HOOK_TIMEOUT_BOUNDS,
  getTimeoutBounds,
  type HookType
} from "../src/main/hooks/types.ts"

let pass = 0
let fail = 0

function assert(cond: unknown, msg: string): void {
  if (cond) {
    pass++
    console.log(`PASS ${msg}`)
  } else {
    fail++
    console.error(`FAIL ${msg}`)
  }
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg} (got ${String(actual)}, expected ${String(expected)})`)
}

// ── HOOK_TIMEOUT_BOUNDS shape ────────────────────────────────────────────────

assertEqual(
  HOOK_TIMEOUT_BOUNDS.command.sync.min,
  1_000,
  "T1 command sync min unchanged from old behaviour"
)
assertEqual(
  HOOK_TIMEOUT_BOUNDS.command.sync.max,
  60_000,
  "T2 command sync max unchanged from old behaviour"
)
assertEqual(
  HOOK_TIMEOUT_BOUNDS.command.sync.default,
  10_000,
  "T3 command sync default unchanged from old behaviour"
)

assertEqual(
  HOOK_TIMEOUT_BOUNDS.command.async.max,
  300_000,
  "T4 command async upper bound is 5 minutes (§13.2)"
)
assertEqual(
  HOOK_TIMEOUT_BOUNDS.prompt.async.max,
  300_000,
  "T5 prompt async upper bound is 5 minutes"
)

// ── getTimeoutBounds lookup ─────────────────────────────────────────────────

assertEqual(
  getTimeoutBounds("command", false).max,
  60_000,
  "T6 getTimeoutBounds('command', false) returns sync row"
)
assertEqual(
  getTimeoutBounds("command", true).max,
  300_000,
  "T7 getTimeoutBounds('command', true) returns async row"
)
assertEqual(
  getTimeoutBounds("prompt", undefined).max,
  60_000,
  "T8 undefined async treated as sync"
)
assertEqual(
  getTimeoutBounds(undefined, false).max,
  60_000,
  "T9 undefined type treated as 'command'"
)

// Unknown future type → permissive fallback (lets future code stay readable
// even when the validator runs an older bounds table).
const unknown = getTimeoutBounds("http" as unknown as HookType, false)
assert(unknown.max >= 60_000, "T10 unknown handler type returns permissive bound (max ≥ 60s)")
assertEqual(unknown.min, 1_000, "T11 unknown handler type keeps 1s floor")

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
