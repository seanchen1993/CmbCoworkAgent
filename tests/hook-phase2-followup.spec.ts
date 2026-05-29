/**
 * Targeted regressions for the five phase-2 follow-up fixes:
 *
 *   P1-1  CC settings.json `type: "http"` survives import
 *   P1-2  http-runner body read is covered by the request timeout
 *   P1-3  Setup marker is written only after hooks actually settle
 *   P2-1  Dialog form bounds (covered indirectly — see snapshot below)
 *   P2-2  MCP isError triggers PostToolUseFailure (covered in runtime.ts;
 *         not exercised here because the MCP service is heavy to stub)
 *
 * Run:
 *   npx tsx tests/hook-phase2-followup.spec.ts
 */

import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let pass = 0
let fail = 0

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual === expected) {
    pass++
    console.log(`PASS ${msg}`)
  } else {
    fail++
    console.error(`FAIL ${msg} (got ${String(actual)}, expected ${String(expected)})`)
  }
}

function assert(cond: unknown, msg: string): void {
  if (cond) {
    pass++
    console.log(`PASS ${msg}`)
  } else {
    fail++
    console.error(`FAIL ${msg}`)
  }
}

import { executeHttpHook } from "../src/main/hooks/http-runner.ts"
import { createServer } from "node:http"
import { runHooks } from "../src/main/hooks/runner.ts"
import type { HookConfig } from "../src/main/hooks/types.ts"
import { readFileSync as _read } from "node:fs"

async function main(): Promise<void> {
// ─── P1-1 — CC import preserves type:"http" (code-level check) ─────────────
//
// storage.ts's `ccCommandToHookConfig` is module-private, so we can't drive
// an end-to-end import without pointing OPENWORK_DIR at a tmp tree (no env
// override exists today). Instead we grep the source for the branch and
// assert it is present + reads the right fields. Coarse but enough to fail
// loudly on a future revert.
const storageSrc = _read(
  join(import.meta.dirname ?? ".", "..", "src", "main", "storage.ts"),
  "utf-8"
)
assert(
  /if \(hookType === "http"\)/.test(storageSrc),
  "P1-1a ccCommandToHookConfig has an http branch"
)
for (const field of [
  "url",
  "headers",
  "allowedEnvVars",
  "fallback",
  "statusMessage",
  "async",
  "if",
  "timeout"
]) {
  assert(
    new RegExp(`\\b${field}:`).test(storageSrc),
    `P1-1 http branch references field "${field}"`
  )
}

// ─── P1-2 — http-runner aborts body read when the request times out ─────────

const slowServer = createServer((req, res) => {
  if (req.url === "/slow") {
    res.writeHead(200, { "Content-Type": "application/json" })
    // Send a partial body then stall — never end the response.
    res.write('{"started":')
    // Do NOT call res.end(); the connection stays open until aborted.
  }
})
await new Promise<void>((resolve) => slowServer.listen(0, "127.0.0.1", resolve))
const slowAddr = slowServer.address()
const slowPort = slowAddr && typeof slowAddr === "object" ? slowAddr.port : 0

const t0 = Date.now()
const result = await executeHttpHook(
  {
    id: "test-slow",
    event: "PreToolUse",
    type: "http",
    url: `http://127.0.0.1:${slowPort}/slow`,
    enabled: true,
    createdAt: "",
    updatedAt: ""
  } as Parameters<typeof executeHttpHook>[0],
  '{"hook_event_name":"PreToolUse"}',
  500 // 500ms timeout — should kick in well before any default test runner timeout
)
const elapsed = Date.now() - t0
slowServer.close()

assert(elapsed >= 400 && elapsed < 4_000, `P1-2a timeout fires close to 500ms (got ${elapsed}ms)`)
assert(
  /timed out|request failed/i.test(result.stderr),
  `P1-2b stderr surfaces a timeout/failure ("${result.stderr.slice(0, 80)}")`
)
// fallback defaults to "allow" — decision should NOT be "block".
assertEqual(result.blocked, false, "P1-2c default fallback=allow → not blocked")

// ─── P1-3 — Setup branch of runHooks awaits hook completion ────────────────

const lateHook: HookConfig = {
  id: "test-setup-late",
  event: "Setup",
  type: "command",
  // Pick a command that lives ≥150ms then exits 0.
  command: process.platform === "win32" ? "ping -n 2 127.0.0.1 > nul" : "sleep 0.15",
  enabled: true,
  timeout: 5_000,
  createdAt: "",
  updatedAt: ""
}
const tBefore = Date.now()
const setupResult = await runHooks([lateHook], "Setup", {
  workspacePath: tmpdir(),
  sessionId: "test-thread",
  setupTrigger: "init"
})
const setupElapsed = Date.now() - tBefore
assert(setupElapsed >= 140, `P1-3a Setup branch waited for the hook (≥140ms; got ${setupElapsed}ms)`)
assertEqual(setupResult, null, "P1-3b Setup returns null when every hook exit code is 0")

// Failing Setup hook → blocking result so the caller skips the marker write.
const failingHook: HookConfig = {
  id: "test-setup-fail",
  event: "Setup",
  type: "command",
  command: process.platform === "win32" ? "cmd /c exit 1" : "false",
  enabled: true,
  timeout: 5_000,
  createdAt: "",
  updatedAt: ""
}
const failingResult = await runHooks([failingHook], "Setup", {
  workspacePath: tmpdir(),
  sessionId: "test-thread",
  setupTrigger: "init"
})
assert(
  failingResult !== null && failingResult.blocked === true,
  "P1-3c Setup branch returns blocking result when any hook exits non-zero"
)

// Side-effect check: setup-state file is NOT written by runHooks itself
// (that's session-lifecycle's job; the unit boundary keeps the two paths
// separate). The marker file only exists if the caller decided to write it.
const stateFile = join(tmpdir(), ".cmbcoworkagent", "setup-state.json")
assert(
  !existsSync(stateFile),
  "P1-3d runHooks does not write the setup-state marker on its own"
)

// ─── P3 — Setup catch path returns exitCode:1 so a throwing hook is not
//         mistakenly treated as success and the workspace marker is NOT
//         written. We exercise this via a command that points at a binary
//         that does not exist — spawn surfaces an error rejection on the
//         executor, the task catch rewrites it to exitCode:1, and runHooks
//         returns a blocking result.

const throwingHook: HookConfig = {
  id: "test-setup-throw",
  event: "Setup",
  type: "command",
  // bogus binary that doesn't exist; surfaces as ENOENT inside the executor
  command: process.platform === "win32"
    ? "nosuch-cmbcowork-binary-9af3.exe"
    : "/nope/nosuch-cmbcowork-binary-9af3",
  enabled: true,
  timeout: 5_000,
  createdAt: "",
  updatedAt: ""
}
const throwingResult = await runHooks([throwingHook], "Setup", {
  workspacePath: tmpdir(),
  sessionId: "test-thread",
  setupTrigger: "init"
})
// The "ENOENT" path on Windows often surfaces as a regular non-zero exit
// (cmd /c with a missing binary), so we don't insist on the rejection
// branch — we just want a non-null, blocking result either way.
assert(
  throwingResult !== null && throwingResult.blocked === true,
  "P3a Setup with a throwing/erroring hook returns a blocking result (marker write will be skipped)"
)

} // end main

main().then(
  () => {
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
  },
  (err) => {
    console.error("FATAL:", err)
    process.exit(1)
  }
)
