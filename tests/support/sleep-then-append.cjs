#!/usr/bin/env node
/**
 * Cross-platform sleep + append helper.
 * Usage: node sleep-then-append.cjs <file> <line> <ms>
 * Appends "<line>\n" to <file> after <ms> milliseconds, then exits 0.
 */
const fs = require("node:fs")
const [, , file, line, msStr] = process.argv
const ms = parseInt(msStr ?? "1000", 10)
setTimeout(() => {
  fs.appendFileSync(file, `${line}\n`)
  process.exit(0)
}, ms)
