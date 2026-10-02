import net from "node:net"
import { mkdir, readFile, stat } from "node:fs/promises"
import { join, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import { randomBytes } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { validateConfig, requireNode22 } from "./config.mjs"
import { compileProbe } from "./java-probe.mjs"
import { probeFailure } from "./probe-error.mjs"
import { privateTemp, removePrivateTemp, isolatedEnv, ownedProcess, run } from "./process.mjs"

async function availablePort() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const server = net.createServer()
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
    const port = server.address().port
    await new Promise((resolve) => server.close(resolve))
    if (port !== 3306 && port > 1024) return port
  }
  throw new Error("No exclusive nondefault port available")
}

async function ready(owned, log, pidFile, socket, probe, signal) {
  const deadline = Date.now() + 20000
  let pidMatches = false, logReady = false
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Cancelled")
    if (owned.exited) {
      const result = await owned.done
      throw Object.assign(new Error("Owned MySQL exited before readiness"), { failureCode: "exit", exitCode: result.code })
    }
    try {
      const [pid, content] = await Promise.all([readFile(pidFile, "utf8"), readFile(log, "utf8")])
      pidMatches = Number(pid.trim()) === owned.child.pid
      logReady = content.includes("ready for connections")
      if (pidMatches && (await stat(socket)).isSocket()) {
        try { await probe(); if (!owned.exited) return } catch { if (signal?.aborted) throw new Error("Cancelled") }
      }
    } catch (error) { if (error.code !== "ENOENT") throw error }
    await delay(100, undefined, { signal })
  }
  const error = new Error(`Owned MySQL readiness timeout (ownedPidMatch=${pidMatches}, readyLog=${logReady})`)
  error.readiness = { ownedPidMatch: pidMatches, readyLog: logReady }
  throw error
}

export async function realProbe(config, tools, { signal, fault, onResource = () => {} } = {}) {
  validateConfig(config); requireNode22()
  if (![undefined, "after-initialize", "after-bootstrap", "after-listen", "bootstrap-startup-failure"].includes(fault)) throw new Error("Unknown dev failure fixture")
  const dir = await privateTemp()
  let database
  let phase = "compile", injected = false
  try {
    onResource({ directory: dir })
    const driver = await compileProbe(dir, tools, signal)
    const data = join(dir, "data"), socket = join(dir, "mysql.sock"), pidFile = join(dir, "mysql.pid")
    await mkdir(data, { mode: 0o700 })
    const env = isolatedEnv(dir, tools.java)
    if (tools["mysql-messages"] && !isAbsolute(tools["mysql-messages"])) throw new Error("Explicit absolute MySQL messages directory required")
    const common = ["--no-defaults", `--datadir=${data}`, `--socket=${socket}`, `--pid-file=${pidFile}`, `--tmpdir=${dir}`, ...(tools["mysql-messages"] ? [`--lc-messages-dir=${tools["mysql-messages"]}`, "--lc-messages=en_US"] : []), "--skip-name-resolve", "--skip-log-bin", "--general-log=0", "--slow-query-log=0", "--character-set-server=utf8mb4", "--collation-server=utf8mb4_unicode_ci", "--default-time-zone=+00:00"]
    phase = "initialize"
    await run(tools.mysqld, [...common, "--initialize-insecure", "--skip-networking", `--log-error=${join(dir, "initialize.log")}`], { cwd: dir, env, timeoutMs: 30000, signal })
    if (fault === "after-initialize") { injected = true; throw new Error("Injected dev failure") }
    const bootstrapLog = join(dir, "bootstrap.log")
    phase = "socket-startup"
    database = ownedProcess(tools.mysqld, [...common, "--skip-networking", `--log-error=${bootstrapLog}`, ...(fault === "bootstrap-startup-failure" ? ["--f05-invalid-option"] : [])], { cwd: dir, env })
    database.child.stdin.end()
    onResource({ pid: database.child.pid, phase: "network-disabled" })
    const socketArgs = ["--no-defaults", "--protocol=SOCKET", `--socket=${socket}`, "--user=root", "--batch", "--connect-timeout=2"]
    phase = "socket-readiness"
    await ready(database, bootstrapLog, pidFile, socket, async () => {
      const result = await run(tools.mysql, [...socketArgs, "--skip-column-names"], { cwd: dir, env, input: "SELECT 1;\n", signal, timeoutMs: 3000, stdoutOnly: true })
      if (result !== "1") throw new Error("Socket SELECT1 not ready")
    }, signal)
    const password = randomBytes(32).toString("hex"), rootPassword = randomBytes(32).toString("hex")
    // Only fresh socket root/no password. Secrets travel over stdin, not argv/env/logs.
    phase = "credential-bootstrap"
    await run(tools.mysql, socketArgs, {
      cwd: dir, env, signal,
      input: `CREATE DATABASE f05_compat CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\nCREATE USER 'f05_probe'@'127.0.0.1' IDENTIFIED BY '${password}';\nGRANT SELECT,INSERT,UPDATE,DELETE,CREATE,DROP ON f05_compat.* TO 'f05_probe'@'127.0.0.1';\nALTER USER 'root'@'localhost' IDENTIFIED BY '${rootPassword}';\n`
    })
    await database.stop()
    const bootstrapPid = database.child.pid
    database = undefined
    onResource({ pid: bootstrapPid, stopped: true })
    if (fault === "after-bootstrap") { injected = true; throw new Error("Injected dev failure") }
    const port = await availablePort(), log = join(dir, "jdbc-server.log")
    phase = "loopback-startup"
    database = ownedProcess(tools.mysqld, [...common, "--skip-networking=OFF", "--bind-address=127.0.0.1", `--port=${port}`, `--log-error=${log}`], { cwd: dir, env })
    database.child.stdin.end()
    onResource({ pid: database.child.pid, port, phase: "credentialed-loopback" })
    const javaArgs = ["-cp", `${dir}:${tools.jdbc}`, "JdbcProbe"]
    const credentials = `port=${port}\nuser=f05_probe\npassword=${password}\n`
    phase = "jdbc-readiness"
    await ready(database, log, pidFile, socket, async () => {
      const result = await run(tools.java, [...javaArgs, "ping"], { cwd: dir, env, input: credentials, signal, timeoutMs: 5000, stdoutOnly: true })
      if (JSON.parse(result).sqlReady !== true) throw new Error("JDBC SQL not ready")
    }, signal)
    if (fault === "after-listen") { injected = true; throw new Error("Injected dev failure") }
    phase = "jdbc-probe"
    const output = await run(tools.java, ["-cp", `${dir}:${tools.jdbc}`, "JdbcProbe", fileURLToPath(new URL("probe.sql", import.meta.url))], {
      cwd: dir, env, signal, timeoutMs: 15000, stdoutOnly: true,
      input: credentials
    })
    const jdbc = JSON.parse(output)
    if (jdbc.status !== "verified" || !jdbc.mysql.startsWith("5.7.")) throw new Error("JDBC verification incomplete")
    return { classification: "real", java: driver, database: jdbc, cleanup: "owned processes stopped and private directory removed in finally" }
  } catch (error) {
    throw probeFailure(error, phase, { cancelled: signal?.aborted === true, injected })
  } finally {
    // Never remove a data directory while the owned server is still alive.
    let stoppedPid
    if (database) { await database.stop(); stoppedPid = database.child.pid }
    await removePrivateTemp(dir)
    if (stoppedPid) onResource({ pid: stoppedPid, stopped: true })
    onResource({ directory: dir, cleaned: true })
  }
}
