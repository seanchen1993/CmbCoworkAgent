#!/usr/bin/env node
/**
 * Seed the user's hooks.json with the 15 example hooks from
 * docs/hook-test-cases.md so they are always present (no need to recreate
 * via UI). Idempotent: replaces all id^="example-" entries on each run.
 *
 * Run:  node tests/support/seed-example-hooks.cjs
 */
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")

const HOOKS = path.join(os.homedir(), ".cmbcoworkagent", "hooks.json")
const HELPER = "C:\\ai\\CmbCoworkAgent\\tests\\support\\append-line.cjs"
const SLEEP_HELPER = "C:\\ai\\CmbCoworkAgent\\tests\\support\\sleep-then-append.cjs"
const TRACE = "C:\\tmp\\hook-trace.log"
const NOW = new Date().toISOString()

function cmd(tag) {
  return `node "${HELPER}" "${TRACE}" "${tag}"`
}
function sleepCmd(tag, ms) {
  return `node "${SLEEP_HELPER}" "${TRACE}" "${tag}" ${ms}`
}

const examples = [
  // ── Existing events ──────────────────────────────────────────────────────
  {
    id: "example-user-prompt",
    event: "UserPromptSubmit",
    matcher: "*",
    type: "command",
    command: cmd("USER-PROMPT"),
    timeout: 5000,
    enabled: true
  },
  {
    id: "example-session-start",
    event: "SessionStart",
    matcher: "*",
    type: "command",
    command: cmd("SESSION-START"),
    timeout: 5000,
    enabled: true
  },
  {
    id: "example-stop",
    event: "Stop",
    matcher: "*",
    type: "command",
    command: cmd("STOP"),
    timeout: 5000,
    enabled: true
  },
  {
    id: "example-pre-execute",
    event: "PreToolUse",
    matcher: "execute",
    type: "command",
    command: cmd("PRE-EXECUTE"),
    timeout: 5000,
    enabled: true
  },
  {
    id: "example-post-execute",
    event: "PostToolUse",
    matcher: "execute",
    type: "command",
    command: cmd("POST-EXECUTE"),
    timeout: 5000,
    enabled: true
  },
  {
    id: "example-session-end-clear",
    event: "SessionEnd",
    matcher: "clear",
    type: "command",
    command: cmd("END-CLEAR"),
    timeout: 5000,
    enabled: true
  },
  {
    id: "example-session-end-logout",
    event: "SessionEnd",
    matcher: "logout",
    type: "command",
    command: cmd("END-LOGOUT"),
    timeout: 5000,
    enabled: true
  },

  // ── Phase 2 new events ───────────────────────────────────────────────────
  {
    id: "example-setup-init",
    event: "Setup",
    matcher: "init",
    type: "command",
    command: cmd("SETUP-INIT"),
    timeout: 8000,
    enabled: true
  },
  {
    id: "example-setup-maintenance",
    event: "Setup",
    matcher: "maintenance",
    type: "command",
    command: cmd("SETUP-MAINTENANCE"),
    timeout: 8000,
    enabled: true
  },
  {
    id: "example-tool-failure",
    event: "PostToolUseFailure",
    matcher: "*",
    type: "command",
    command: cmd("TOOL-FAILURE"),
    timeout: 5000,
    enabled: true
  },
  {
    id: "example-subagent-start",
    event: "SubagentStart",
    matcher: "*",
    type: "command",
    command: cmd("SUB-START"),
    timeout: 5000,
    enabled: true
  },
  {
    id: "example-subagent-stop",
    event: "SubagentStop",
    matcher: "*",
    type: "command",
    command: cmd("SUB-STOP"),
    timeout: 5000,
    enabled: true
  },
  {
    id: "example-if-git",
    event: "PreToolUse",
    matcher: "execute",
    if: "execute(git *)",
    type: "command",
    command: cmd("IF-GIT-CMD"),
    timeout: 5000,
    enabled: true
  },

  // ── Disabled by default (require external setup or add noticeable latency)
  {
    id: "example-http-pre-execute",
    event: "PreToolUse",
    matcher: "execute",
    type: "http",
    url: "http://127.0.0.1:9999/pre-execute",
    headers: { "X-Source": "claude-code" },
    fallback: "allow",
    timeout: 8000,
    enabled: false
  },
  {
    id: "example-async-pre-execute",
    event: "PreToolUse",
    matcher: "execute",
    type: "command",
    command: sleepCmd("ASYNC-LATE", 1200),
    async: true,
    timeout: 8000,
    enabled: false
  }
]

const arr = JSON.parse(fs.readFileSync(HOOKS, "utf-8"))
const keep = arr.filter((h) => typeof h.id !== "string" || !h.id.startsWith("example-"))
const stamped = examples.map((e) => ({ ...e, createdAt: NOW, updatedAt: NOW }))
const next = [...keep, ...stamped]
fs.writeFileSync(HOOKS, JSON.stringify(next, null, 2))

console.log(`baseline kept: ${keep.length} hook(s)`)
console.log(`examples written: ${stamped.length}`)
console.log(`total: ${next.length}`)
console.log(`trace path: ${TRACE}`)
console.log("\nDefault-enabled (will fire on real interactions):")
for (const e of stamped.filter((h) => h.enabled)) {
  console.log(`  ${e.event.padEnd(20)} matcher=${(e.matcher ?? "").padEnd(14)} ${e.id}`)
}
console.log("\nDefault-disabled (toggle on when you want to test):")
for (const e of stamped.filter((h) => !h.enabled)) {
  console.log(`  ${e.event.padEnd(20)} matcher=${(e.matcher ?? "").padEnd(14)} ${e.id}`)
}
