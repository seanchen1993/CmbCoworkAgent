#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * openwork CLI - Launches the Electron app
 */

const { spawn } = require("child_process")
const path = require("path")

// Set process title for Activity Monitor
process.title = "openwork"

const args = process.argv.slice(2)

// Handle --version flag
if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
  const { version } = require("../package.json")
  console.log(`openwork v${version}`)
  process.exit(0)
}

// Handle --help flag
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
openwork - A tactical agent interface for deepagentsjs

Usage:
  openwork              Launch the application
  openwork --version    Show version
  openwork --help       Show this help
  openwork plugin check <directory>    Validate a function-hooks plugin
  openwork plugin inspect <directory>  Inspect its profile, digest and registrations
  openwork plugin types <directory> [--out <new-file.d.ts>]  Export the supported authoring subset
  openwork plugin init <new-directory> --template project-lite|harness-lite|harness-fullstack|harness-data|command [--id package-id] [--name name]
  openwork plugin compile <source-directory> --out <new-directory>
  openwork plugin doctor <directory>  Diagnose a lightweight project package without executing it
  openwork plugin test <directory>    Check generated fixtures with production artifact validators
  openwork plugin pack <directory> --out <new-file.zip>  Package a checked project for normal import
  openwork plugin dev <directory> --out <new-directory>  Prepare an isolated snapshot and workspace
  Project dev prepares files only; it does not start a model, install a plugin or approve a stage.
  Add --types to check/inspect for isolated, strict TypeScript checks (no user tsconfig or plugins).
  Add --strict-compatibility to fail when registered events lack a verified host provider.
  This checks event availability only, not complete SDK compatibility or authorization.
`)
  process.exit(0)
}

// Get the path to electron
const electron = require("electron")

// Launch electron with our main process
const pluginCommand = args[0] === "plugin"
const mainPath = path.join(
  __dirname,
  "..",
  "out",
  "main",
  pluginCommand ? "mods-cli.js" : "index.js"
)

const child = spawn(electron, [mainPath, ...(pluginCommand ? args.slice(1) : args)], {
  windowsHide: true,
  stdio: "inherit"
})

// Forward signals to child process
function forwardSignal(signal) {
  if (child.pid) {
    process.kill(child.pid, signal)
  }
}

process.on("SIGINT", () => forwardSignal("SIGINT"))
process.on("SIGTERM", () => forwardSignal("SIGTERM"))

// Exit with the same code as the child
child.on("close", (code) => {
  process.exit(code ?? 0)
})

child.on("error", (err) => {
  console.error("Failed to start openwork:", err.message)
  process.exit(1)
})
