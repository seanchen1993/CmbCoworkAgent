import { pathToFileURL } from "node:url"
import { hostState, vmStart, vmStop, daemon } from "./host.mjs"
import { prepareProject, start, stop, resources, validateContainer, verifyListeners, finishFailedStart } from "./lifecycle.mjs"
import { verifyDev } from "./probe.mjs"
import { servicesHealth, localEndpoint } from "./services-probe.mjs"
import { mysqlReal } from "../../../tests/bot/docker/mysql-real.mjs"

export function argumentsFor(argv) {
  const [command, ...args] = argv
  if (!["vm-start", "vm-stop", "vm-status", "start", "status", "stop", "test"].includes(command)) throw new Error("B00_COMMAND")
  const tools = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = { "--java": "java", "--javac": "javac", "--jdbc": "jdbc" }[args[i]]
    if (!key || tools[key] || !args[i + 1] || !["start", "test"].includes(command)) throw new Error("B00_ARGUMENTS")
    tools[key] = args[i + 1]
  }
  if (["start", "test"].includes(command) && Object.keys(tools).length !== 3) throw new Error("B00_JDK_ARGUMENTS")
  return { command, tools }
}

export async function main(argv, signal) {
  const { command, tools } = argumentsFor(argv)
  const state = await hostState({ create: command === "vm-start" })
  if (command === "vm-start") return vmStart(state)
  if (command === "vm-stop") return vmStop(state)
  if (command === "vm-status") return daemon(state)
  if (command === "test") return { status: "verified", proof: await mysqlReal(tools, signal) }
  const entry = await prepareProject(state, { existing: command !== "start" })
  if (command === "stop") return stop(state, entry)
  if (command === "start") {
    const started = await start(state, entry, { signal })
    try {
      return { ...started, endpoints: Object.fromEntries(Object.entries(started.ports).map(([name, port]) => [name, name === "mysql" ? `127.0.0.1:${port}` : localEndpoint(port)])), application: await verifyDev(state, entry, tools, signal), services: await servicesHealth(entry, started.ports, signal), credentialDirectory: entry.dir }
    } catch (error) { return finishFailedStart(error, async () => [], () => stop(state, entry)) }
  }
  await daemon(state)
  const current = await resources(state, entry), services = {}, ports = {}
  for (const [service, c] of Object.entries(current.containers)) {
    const running = c.State.Running && c.State.Health?.Status === "healthy"
    services[service] = { status: c.State.Status, health: c.State.Health?.Status ?? "none", version: { mysql: "5.7.44", es: "8.19.22", s3: "4.48" }[service] }
    if (running) { ports[service] = validateContainer(c, entry, service); await verifyListeners(ports[service]); services[service].endpoint = service === "mysql" ? `127.0.0.1:${ports[service]}` : localEndpoint(ports[service]) }
  }
  if (Object.keys(ports).length === 3) await servicesHealth(entry, ports, signal)
  return { project: entry.project, status: Object.keys(ports).length === 3 ? "healthy" : "stopped_or_incomplete", services, volumes: Object.keys(current.volumes).map(suffix => `${entry.project}-${suffix}`), credentialDirectory: entry.dir }
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController(), cancel = () => controller.abort()
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel)
  const timer = setTimeout(cancel, 600000)
  try { console.log(JSON.stringify(await main(process.argv.slice(2), controller.signal))) }
  catch (error) {
    console.error(JSON.stringify({ status: "failed", reason: /^B00_[A-Z0-9_]+$/.test(error.message) ? error.message : error.failureCode || "compatibility_or_io", phase: error.phase, diagnostics: error.diagnostics, diagnosticsUnavailable: error.diagnosticsUnavailable === true, stopFailed: error.stopFailed === true, ...(Number.isInteger(error.exitCode) ? { exitCode: error.exitCode } : {}) }))
    process.exitCode = 1
  } finally { clearTimeout(timer); process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel) }
}
