// Explicit dev lifecycle verification; leaves the single healthy dev stack.
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { lstat } from "node:fs/promises"
import { hostState, docker, colima, privateFile } from "../../../deploy/dev/docker/host.mjs"
import { prepareProject, resources, validateContainer, stop } from "../../../deploy/dev/docker/lifecycle.mjs"
import { run, isolatedEnv, privateTemp, removePrivateTemp } from "../../../deploy/dev/process.mjs"

const [java, javac, jdbc] = process.argv.slice(2)
const state = await hostState(), entry = await prepareProject(state, { existing: true }), dir = await privateTemp()
const controller = new AbortController(), cancel = () => controller.abort(), timer = setTimeout(cancel, 360000)
process.once("SIGTERM", cancel); process.once("SIGINT", cancel)
const cli = fileURLToPath(new URL("../../../deploy/dev/docker/cli.mjs", import.meta.url))
const invoke = async command => JSON.parse(await run(process.execPath, [cli, command, ...(command === "start" ? ["--java", java, "--javac", javac, "--jdbc", jdbc] : [])], { cwd: dir, env: isolatedEnv(dir), stdoutOnly: true, timeoutMs: 210000, signal: controller.signal }))
const identity = current => ({ containers: Object.fromEntries(Object.entries(current.containers).map(([s, c]) => [s, c.Id])), volumes: Object.values(current.volumes).map(v => v.Name).sort(), network: current.network.Id })
try {
  const before = identity(await resources(state, entry)), hashes = await privateFile(join(entry.dir, "secret-hashes.json"))
  const repeated = await invoke("start"), healthy = await invoke("status")
  assert.equal(repeated.status, "healthy"); assert.equal(healthy.status, "healthy")
  assert.deepEqual(identity(await resources(state, entry)), before)
  console.log(JSON.stringify({ stage: "idempotent", project: entry.project, status: healthy.status, identity: before }))
  await invoke("stop")
  const stopped = await invoke("status"), current = await resources(state, entry)
  assert.equal(stopped.status, "stopped_or_incomplete")
  assert.equal(Object.keys(current.containers).length, 3)
  assert.equal(Object.values(current.containers).some(c => c.State.Running), false)
  assert.deepEqual(identity(current), before)
  assert.equal(await privateFile(join(entry.dir, "secret-hashes.json")), hashes)
  console.log(JSON.stringify({ stage: "stopped", data: "all_three_volumes_retained", credentials: "unchanged" }))
  const started = await invoke("start"), final = await invoke("status")
  assert.equal(started.status, "healthy"); assert.equal(final.status, "healthy")
  assert.deepEqual(identity(await resources(state, entry)), before)
  const mysql = (await resources(state, entry)).containers.mysql
  validateContainer(mysql, entry, "mysql")
  const version = await docker(state, ["exec", mysql.Id, "mysqld", "--version"], { stdoutOnly: true })
  assert.match(version, /Ver 5\.7\.44/); assert.match(version, /x86_64/)
  const rosetta = await colima(state, ["ssh", "--", "cat", "/proc/sys/fs/binfmt_misc/rosetta"], { stdoutOnly: true })
  assert.match(rosetta, /^enabled/m); assert.match(rosetta, /interpreter \/.*rosetta/); assert.match(rosetta, /flags:.*OCF/)
  for (const name of ["app-password", "root-password", "es-password", "s3-config.json", "s3-client.json"]) await privateFile(join(entry.dir, name))
  assert.equal((await lstat(entry.dir)).mode & 0o777, 0o700)
  console.log(JSON.stringify({ status: "verified", project: entry.project, identity: before, endpoints: started.endpoints, application: started.application, services: started.services, mysqlExecution: "linux/x86_64_5.7.44", rosetta: "enabled_OCF", privateCredentials: "0700_0600", finalStatus: final.status }))
} catch (error) {
  let stopFailed = false
  try { await stop(state, entry) } catch { stopFailed = true }
  console.log(JSON.stringify({ status: "failed", reason: /^B00_[A-Z0-9_]+$/.test(error.message) ? error.message : error.failureCode ?? "assertion", stopFailed }))
  process.exitCode = 1
} finally { clearTimeout(timer); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel); await removePrivateTemp(dir) }
