#!/usr/bin/env node
/**
 * Electron 22 拒绝识别 entry script 之前的 --remote-debugging-port，但
 * playwright `_electron.launch()` 总是把它前置。这个壳把传入的所有
 * `--remote-debugging-port` / `--inspect` 之类的 chromium-only 开关挪到
 * entry script 之后，然后用同样的 stdio 接力 electron.exe，让 Playwright
 * 正常匹配它要等的 "Debugger listening on …" / "DevTools listening on …" 行。
 */

const { spawn } = require("child_process")
const path = require("path")

const ELECTRON_BIN = path.join(
  __dirname,
  "..",
  "..",
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron"
)

const argv = process.argv.slice(2)

// First positional that ends with .js / .cjs / .mjs / .asar is the entry.
const entryIdx = argv.findIndex((arg) => /\.(c|m)?js$|\.asar$/i.test(arg))
if (entryIdx === -1) {
  console.error("[electron-launcher] no entry script found in args:", argv)
  process.exit(1)
}

const before = argv.slice(0, entryIdx)
const entry = argv[entryIdx]
const after = argv.slice(entryIdx + 1)

const CHROMIUM_FLAG_RE = /^--(remote-debugging-port|remote-debugging-pipe|enable-logging|disable-gpu|no-sandbox)(=|$)/

const electronFlagsBefore = []
const chromiumFlags = []
for (const arg of before) {
  if (CHROMIUM_FLAG_RE.test(arg)) chromiumFlags.push(arg)
  else electronFlagsBefore.push(arg)
}

const finalArgs = [...electronFlagsBefore, entry, ...chromiumFlags, ...after]

const child = spawn(ELECTRON_BIN, finalArgs, {
  stdio: "inherit",
  env: process.env,
  windowsHide: false
})

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig)
  })
}
