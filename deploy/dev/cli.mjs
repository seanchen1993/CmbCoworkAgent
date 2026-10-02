import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { requireNode22, parseArgs, configFromOptions } from "./config.mjs"
import { doctor } from "./doctor.mjs"
import { runRealChecks } from "../../tests/bot/dev/real-checks.mjs"
import { startMockServer } from "./mock-server.mjs"
import { privateTemp, removePrivateTemp, isolatedEnv, run } from "./process.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const controller = new AbortController()
const cancel = () => controller.abort()
process.once("SIGINT", cancel)
process.once("SIGTERM", cancel)

async function mockChecks(config) {
  const dir = await privateTemp()
  try {
    const output = await run(process.execPath, ["--test", "tests/bot/dev/config.spec.mjs", "tests/bot/dev/mock.spec.mjs", "tests/bot/dev/lifecycle.spec.mjs"], { cwd: root, env: isolatedEnv(dir), timeoutMs: 15000, signal: controller.signal })
    console.log(output)
    console.log(JSON.stringify({ classification: "mock", identity: "mock", zhaohu: "mock", model: "mock", s3: "disabled", es: "disabled", profile: config.profile, passed: true }))
  } finally { await removePrivateTemp(dir) }
}

async function serve(config, options) {
  const lifetime = options["lifetime-ms"] === undefined ? 60000 : Number(options["lifetime-ms"])
  if (!Number.isSafeInteger(lifetime) || lifetime < 100 || lifetime > 60000) throw new Error("Dev lifetime must be 100..60000 ms")
  const dir = await privateTemp()
  let server
  try {
    server = await startMockServer(config)
    const sessionFile = join(dir, "session.json")
    await writeFile(sessionFile, JSON.stringify({ url: server.url, credentials: server.credentials }), { mode: 0o600, flag: "wx" })
    // No credentials on stdout. The private file is consumed by a trusted dev harness.
    console.log(JSON.stringify({ classification: "mock", url: server.url, sessionFile, directory: dir, expiresInMs: lifetime }))
    try { await delay(lifetime, undefined, { signal: controller.signal }) }
    catch (error) { if (error.name !== "AbortError") throw error }
  } finally { if (server) await server.close(); await removePrivateTemp(dir) }
}

try {
  requireNode22()
  const { command, options } = parseArgs(process.argv.slice(2))
  const config = await configFromOptions(options)
  if (command === "serve") await serve(config, options)
  if (command === "mock" || command === "check") await mockChecks(config)
  if (["doctor", "real", "check"].includes(command)) {
    const report = await doctor(config, options)
    console.log(JSON.stringify({ classification: "doctor", ...report }, null, 2))
    if (!report.ok) throw new Error("Required real tooling unavailable or wrong version")
    if (command !== "doctor") {
      await runRealChecks(config, options, controller.signal, (report) => console.log(JSON.stringify(report, null, 2)))
      console.log(JSON.stringify({ classification: "real", failureCleanup: "verified", passed: true }))
    }
  }
} catch (error) {
  console.error(JSON.stringify({ classification: "unavailable", passed: false, reason: error.message, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) }))
  process.exitCode = 1
} finally {
  process.removeListener("SIGINT", cancel)
  process.removeListener("SIGTERM", cancel)
}
