/** Real packaged/unpacked helper bootstrap, without accessing the user's Keychain.
 * Only malformed requests or an abandoned, incomplete request are sent. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createRequire } from "node:module"
import { BOT_MAC_SECRET_HELPER_FLAG } from "../src/main/bots/mac-secret-protocol"
import { botShellEnvironment } from "../src/main/bots/shell-contract"

async function main() {
  if (process.platform !== "darwin") {
    console.log("SKIP macOS credential helper bootstrap on non-macOS")
    return
  }
  const root = await mkdtemp(join(tmpdir(), "cmb-mac-secret-bootstrap-"))
  try {
    const executable = process.env.CMB_BOT_APP_BINARY
      ? resolve(process.env.CMB_BOT_APP_BINARY)
      : (createRequire(import.meta.url)("electron") as string)
    for (const mode of ["malformed", "abandoned"] as const) {
      const appRoot = process.env.CMB_BOT_APP_BINARY
        ? join(dirname(executable), "../Resources/app.asar")
        : process.cwd()
      const child = spawn(executable, [appRoot, BOT_MAC_SECRET_HELPER_FLAG], {
        env: {
          ...botShellEnvironment(process.env),
          CMB_COWORK_AGENT_HOME: root,
          CMB_COWORK_TRACE_STORAGE_MODE: "off"
        },
        stdio: ["pipe", "pipe", "pipe", "pipe"]
      })
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
      let stdout = "",
        stderr = ""
      child.stdout!.on("data", (bytes) => {
        stdout += bytes.toString()
        if (stdout.length > 10_000) child.kill("SIGKILL")
      })
      child.stderr!.on("data", (bytes) => {
        stderr += bytes.toString()
        if (stderr.length > 100_000) child.kill("SIGKILL")
      })
      child.stdin!.on("error", () => {})
      child.stdio[3]!.on("error", () => {})
      const closed = new Promise<{ code: number | null; signal: string | null }>((done, reject) => {
        child.once("error", reject)
        child.once("close", (code, signal) => done({ code, signal }))
      })
      if (mode === "malformed") child.stdin!.end("PRIVATE_INVALID_HELPER_INPUT")
      else {
        // No stdin EOF: a valid request cannot reach safeStorage before abandonment.
        child.stdin!.write('{"version":1,"operation":"protect","data":"dmFsdWU="}')
        child.stdio[3]!.destroy()
      }
      try {
        assert.deepEqual(
          await closed,
          mode === "malformed" ? { code: 1, signal: null } : { code: null, signal: "SIGKILL" },
          `${mode}: helper must exit promptly`
        )
        assert.equal(stdout, "", "helper must not load desktop logging or publish partial output")
        assert.ok(
          !stderr.includes("PRIVATE_INVALID_HELPER_INPUT"),
          "native input must not enter stderr"
        )
        assert.deepEqual(
          await readdir(root),
          [],
          "helper must not initialize desktop settings or a Bot database"
        )
        console.log(
          `PASS macOS credential helper ${mode} request exits without desktop initialization`
        )
      } finally {
        clearTimeout(timer)
        child.kill("SIGKILL")
        for (const stream of child.stdio) stream?.destroy()
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
