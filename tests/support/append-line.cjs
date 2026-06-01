#!/usr/bin/env node
/**
 * Cross-platform helper for E2E hook commands.
 * Usage: node append-line.cjs <log-file> <line>
 * Appends "<line>\n" to <log-file>, creating the file if needed.
 * Exit code is always 0 so the hook is considered successful.
 */
const fs = require("node:fs")
const [, , file, line] = process.argv
if (!file || !line) {
  console.error("usage: append-line.cjs <file> <line>")
  process.exit(1)
}
fs.appendFileSync(file, `${line}\n`)
process.exit(0)
