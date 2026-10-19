import { expertConversationProbe, stopExpertConversationChildren } from "./expert-conversation-java.mjs"
import { textDeliveryProbe, stopTextDeliveryChildren } from "./text-delivery-java.mjs"
import http from "node:http"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { lstat, writeFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { ownedProcess, run, privateTemp, removePrivateTemp } from "../process.mjs"
import { active, appPassword, createTestDatabase, startTestDatabase, cleanupTestDatabase } from "./test-database.mjs"
import { packagedDatabaseRuntime, closeDatabaseRuntime, javaDatabase } from "./database-java.mjs"
import { createHttpFixture, readHttpIdentity, checkHttpFixture, closeHttpFixture } from "./http-fixture.mjs"
import { currentHttpDatabase } from "./http-java.mjs"
import { validateHttpResponse } from "./http-client.mjs"
import { httpDevProof, httpCapacity, httpAbsent } from "./http-proof.mjs"
import { groupMemoryProbe, stopGroupMemoryChildren } from "./group-memory-java.mjs"
import { partnerWrite } from "./partner-dev-resources.mjs"

const children = new Set(), check = value => { if (!value) throw Error("PARTNER_ASSERTION") }
const scope = { spaceId: "A", member: true, canCreateBot: true, canCreateGroup: true, knowledgeRefs: [], repositoryRefs: [], skillAllowlist: [], capabilityCeiling: ["requirements.analyze"] }
export function partnerPrincipals() {
  return ["owner", "business", "other", "outsider"].map(principalId => ({ principalId, active: true, spaces: [{ ...scope }] }))
}
export async function stopPartnerChildren() {
  const stopped = await Promise.allSettled([...children].map(handle => handle.stop()))
  if (stopped.some(result => result.status !== "fulfilled")) throw Error("PARTNER_CLEANUP")
}
async function pidAbsent(pid) { try { process.kill(pid, 0); throw Error("PARTNER_PID_RESIDUE") } catch (error) { if (error.code !== "ESRCH") throw error } }
async function listenerAbsent(port) {
  const child = ownedProcess("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"], { env: { PATH: "/usr/bin:/bin", LANG: "C", TZ: "UTC" }, maxOutput: 4096 })
  child.child.stdin.end()
  const timer = setTimeout(() => { void child.stop() }, 5000)
  try { const value = await child.done; check(value.code === 1 && !value.stdout && !value.stderr && !value.overflow && !value.spawnError) }
  finally { clearTimeout(timer); await child.stop() }
}
async function ownedListenerPorts(pid) {
  const child = ownedProcess("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fpn"], { env: { PATH: "/usr/bin:/bin", LANG: "C", TZ: "UTC" }, maxOutput: 4096 })
  child.child.stdin.end(); const timer = setTimeout(() => { void child.stop() }, 5000)
  try {
    const value = await child.done
    if (value.code === 1 && !value.stdout && !value.stderr && !value.overflow && !value.spawnError) return []
    check(value.code === 0 && !value.stderr && !value.overflow && !value.spawnError)
    const lines = value.stdout.trim().split("\n")
    check(lines.filter(line => line.startsWith("p")).join() === `p${pid}`)
    return lines.filter(line => line.startsWith("n")).map(line => { const port = Number(line.slice(line.lastIndexOf(":") + 1)); check(Number.isInteger(port) && port > 0 && port <= 65535); return port })
  } finally { clearTimeout(timer); await child.stop() }
}
export async function startPartnerJava(runtime, entry, fixture, signal) {
  active(signal); await currentHttpDatabase(entry, signal); await checkHttpFixture(fixture, signal)
  const password = await appPassword(entry, signal), identity = await readHttpIdentity(fixture, signal)
  const credential = `dcn1_${randomBytes(32).toString("hex")}`, otherCredential = `dcn1_${randomBytes(32).toString("hex")}`
  const expiresAt = new Date(Date.now() + 3600000).toISOString()
  const nodes = [
    { spaceId: "A", nodeId: "node", ownerPrincipalId: "owner", credential, expiresAt },
    { spaceId: "A", nodeId: "other-node", ownerPrincipalId: "other", credential: otherCredential, expiresAt }
  ]
  const access = ["owner", "business", "other"].map(principalId => ({ spaceId: "A", principalId, capabilities: ["requirements.analyze"], workspaceRefs: ["view"] }))
  const input = JSON.stringify({ legacy: { mode: "local-dev", http: { host: "127.0.0.1", port: 0 }, db: { mode: "local-dev", host: "127.0.0.1", port: entry.port, schema: "devclaw", user: "devclaw_app", password }, identity }, nodes, access })
  check(Buffer.byteLength(input) <= 65536)
  active(signal)
  const child = ownedProcess(runtime.java, ["-Xmx256m", "-Duser.timezone=UTC", "-cp", runtime.classpath, "com.devclaw.botcontrol.http.PartnerHttpMain"], { cwd: runtime.dir, env: runtime.env, maxOutput: 65536 })
  const secrets = [password, credential, otherCredential, ...identity.bearers.map(value => value.token)]
  const handle = { pid: child.child.pid, port: null }, abort = () => { void child.stop() }
  let closing
  const timer = setTimeout(abort, 600000)
  signal?.addEventListener("abort", abort, { once: true })
  child.child.stdin.on("error", () => {})
  function noSecret(bytes) { check(!secrets.some(secret => bytes.includes(secret)) && !/jdbc:mysql:|SQLSyntaxErrorException|at com\.devclaw\./.test(bytes)) }
  handle.stop = () => {
    if (!closing) closing = (async () => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort)
      let ports = [], proofFailed = false
      try { ports = await ownedListenerPorts(handle.pid) } catch { proofFailed = true }
      await child.stop(); const value = await child.done
      await pidAbsent(child.child.pid)
      for (const port of new Set([...ports, ...(handle.port ? [handle.port] : [])])) await listenerAbsent(port)
      noSecret(value.stdout); noSecret(value.stderr); check(!value.stderr && !value.overflow && !value.spawnError)
      check(!proofFailed)
      children.delete(handle)
    })()
    return closing
  }
  children.add(handle)
  try {
    active(signal); child.child.stdin.end(input)
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      active(signal)
      if (child.output.includes("\n")) {
        const records = child.output.trim().split("\n"); check(records.length === 1)
        const value = JSON.parse(records[0]); check(value.stage === "partner-ready" && Number.isInteger(value.port) && value.port > 1024 && value.port <= 65535)
        handle.port = value.port; break
      }
      check(!child.exited); await new Promise(resolve => setTimeout(resolve, 10))
    }
    check(handle.port)
    const proof = (await run("/usr/sbin/lsof", ["-nP", "-a", "-p", String(handle.pid), "-iTCP", "-sTCP:LISTEN", "-Fpn"], { timeoutMs: 5000, signal })).split("\n")
    check(proof.filter(value => value.startsWith("p")).join() === `p${handle.pid}` && proof.filter(value => value.startsWith("n")).join() === `n127.0.0.1:${handle.port}`)
    const bearer = principal => { const value = identity.bearers.find(value => value.principalId === principal); check(value); return value.token }
    handle.descriptor = { version: 1, url: `http://127.0.0.1:${handle.port}`, spaceId: "A", nodeId: "node", ownerPrincipalId: "owner", businessPrincipalId: "business", workspaceRef: "view", ownerToken: bearer("owner"), businessToken: bearer("business"), nodeToken: credential }
    handle.nodeToken = principal => principal === "other" ? otherCredential : credential
    handle.userToken = bearer
    handle.noSecret = noSecret
    handle.assertAlive = () => { check(!closing && !child.exited); process.kill(handle.pid, 0) }
    return handle
  } catch (error) { await handle.stop(); throw error }
}
export async function partnerRequest(handle, path, body, { principal = "owner", node = false, headers = {}, signal, method = "POST" } = {}) {
  active(signal)
  handle.assertAlive()
  check(["/api/bot/local/v1/node", "/api/bot/local/v1/control"].includes(path) || /^\/api\/bot\/v1\//.test(path))
  const token = node ? handle.nodeToken(principal) : handle.userToken(principal)
  const bytes = body == null ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    let settled = false, timer
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(value) }
    const request = http.request({ host: "127.0.0.1", port: handle.port, path, method, agent: false, headers: { Authorization: `Bearer ${token}`, ...(!node ? { "X-DevClaw-Space": "A" } : {}), ...(bytes ? { "Content-Type": "application/json", "Content-Length": bytes.length } : {}), ...headers } }, response => {
      let size = 0; const chunks = []
      response.on("data", chunk => { size += chunk.length; if (size > 1048576) request.destroy(Error("PARTNER_RESPONSE_BOUND")); else chunks.push(chunk) })
      response.on("end", () => { try { const body = Buffer.concat(chunks); handle.noSecret(body.toString("utf8")); const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); check(response.headers["cache-control"] === "no-store" && response.headers["x-content-type-options"] === "nosniff" && Number(response.headers["content-length"]) === body.length && !response.headers["set-cookie"] && !response.headers["access-control-allow-origin"]); finish(null, { status: response.statusCode, body, value, headers: response.headers }) } catch { finish(Error("PARTNER_RESPONSE")) } })
      response.on("aborted", () => finish(Error("PARTNER_RESPONSE"))); response.on("error", () => finish(Error("PARTNER_RESPONSE")))
    })
    const abort = () => request.destroy(Error("PARTNER_CANCELLED"))
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort()
    timer = setTimeout(() => request.destroy(Error("PARTNER_TIMEOUT")), 10000)
    request.on("error", () => finish(Error("PARTNER_REQUEST"))); request.end(bytes)
  })
}
export async function withPartnerHttpFixture(callback, { signal, upgradeV5 = false, upgradeV6 = false, upgradeV7 = false, upgradeV8 = false } = {}) {
  if (typeof callback !== "function") throw Error("PARTNER_CALLBACK")
  if (typeof upgradeV5 !== "boolean" || typeof upgradeV6 !== "boolean" || typeof upgradeV7 !== "boolean" || typeof upgradeV8 !== "boolean" || [upgradeV5, upgradeV6, upgradeV7, upgradeV8].filter(Boolean).length > 1) throw Error("PARTNER_SELECTION")
  active(signal)
  const original = await httpDevProof(), runtime = await packagedDatabaseRuntime()
  let entry, fixture, server, descriptorDirectory
  try {
    console.log(JSON.stringify(await httpCapacity(signal))); entry = await createTestDatabase()
    console.log(JSON.stringify({ stage: "partner-registered", project: entry.project }))
    console.log(JSON.stringify({ stage: "partner-database-ready", ...(await startTestDatabase(entry, signal)) }))
    const upgrade = upgradeV8 ? await expertConversationProbe(runtime, entry, "seed-v8", {}, signal) : upgradeV7 ? await textDeliveryProbe(runtime, entry, "seed-v7", {}, signal) : upgradeV5 || upgradeV6 ? await groupMemoryProbe(runtime, entry, upgradeV5 ? "seed-v5" : "seed-v6", {}, signal) : null
    const migrated = await javaDatabase(runtime, entry, "migrate", { signal }); check(migrated.exitCode === 0 && migrated.proof.migrations === (upgradeV8 ? 1 : upgradeV7 ? 2 : upgradeV5 ? 4 : upgradeV6 ? 3 : 9))
    const noop = await javaDatabase(runtime, entry, "migrate", { signal }); check(noop.exitCode === 0 && noop.proof.migrations === 0)
    if (upgradeV8) { const proof = await expertConversationProbe(runtime, entry, "verify-v8", upgrade, signal); check(proof.oldResultsPreserved && proof.oldCompletedAndAwaitingPreserved && proof.noAutomaticAdoption) }
    if (upgradeV7) { const proof = await textDeliveryProbe(runtime, entry, "verify-v7", upgrade, signal); check(proof.oldFactsUnchanged && proof.oldResultReadable && proof.noAutomaticPublication) }
    if (upgradeV5) { const proof = await groupMemoryProbe(runtime, entry, "verify-v5", { v5Facts: upgrade.v5Facts, runId: upgrade.running.id, terminalId: upgrade.terminal.id }, signal); check(proof.v5FactsPreserved && proof.historicalRunningNull && proof.oldResultPreserved) }
    if (upgradeV6) { const proof = await groupMemoryProbe(runtime, entry, "verify-v6", upgrade, signal); check(proof.v6ScopeAndDataPreserved && proof.noExpertPromotion) }
    fixture = await createHttpFixture(partnerPrincipals(), signal); server = await startPartnerJava(runtime, entry, fixture, signal)
    console.log(JSON.stringify({ stage: "partner-listener", pid: server.pid, port: server.port, project: entry.project, realPartnerMain: true }))
    descriptorDirectory = await privateTemp(); const connectionFile = join(descriptorDirectory, "connection.json")
    await writeFile(connectionFile, JSON.stringify(server.descriptor) + "\n", { mode: 0o600, flag: "wx" })
    const stat = await lstat(connectionFile); check(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600)
    return await callback({ descriptor: { ...server.descriptor }, connectionFile, upgrade,
      expertProbe: (action, fixture = {}) => expertConversationProbe(runtime, entry, action, fixture, signal),
      deliveryProbe: (action, fixture = {}) => textDeliveryProbe(runtime, entry, action, fixture, signal),
      probe: (action, fixture = {}) => groupMemoryProbe(runtime, entry, action, fixture, signal),
      reopen: async () => { await server.stop(); server = await startPartnerJava(runtime, entry, fixture, signal); await partnerWrite(connectionFile, JSON.stringify(server.descriptor) + "\n"); console.log(JSON.stringify({ stage: "partner-reopened", pid: server.pid, port: server.port, project: entry.project })); return { ...server.descriptor } },
      node: (body, options = {}) => partnerRequest(server, "/api/bot/local/v1/node", body, { ...options, node: true, signal }),
      control: (body, options = {}) => partnerRequest(server, "/api/bot/local/v1/control", body, { ...options, node: false, signal }),
      publicCall: async (operation, method, path, body, options = {}) => { const result = await partnerRequest(server, path, body, { ...options, method, node: false, signal }); validateHttpResponse(operation, result.status, result.body); return result },
      request: (path, body, options = {}) => partnerRequest(server, path, body, { ...options, signal }) })
  } finally {
    let failed = false
    for (const finish of [stopPartnerChildren, stopGroupMemoryChildren, stopTextDeliveryChildren, stopExpertConversationChildren, ...(descriptorDirectory ? [() => removePrivateTemp(descriptorDirectory)] : []), ...(fixture ? [() => closeHttpFixture(fixture)] : []), ...(entry ? [async () => { console.log(JSON.stringify({ stage: "partner-cleanup", ...(await cleanupTestDatabase(entry)) })) }, () => httpAbsent(entry.project)] : []), () => closeDatabaseRuntime(runtime), async () => { check(isDeepStrictEqual(original, await httpDevProof())); console.log(JSON.stringify({ stage: "partner-original-dev", sameIdentityHealthy: true, credentialsRead: false })) }]) {
      try { await finish() } catch { failed = true }
    }
    if (failed) throw Error("PARTNER_CLEANUP")
  }
}
