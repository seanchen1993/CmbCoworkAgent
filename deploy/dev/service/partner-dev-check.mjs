import http from "node:http"
import { fileURLToPath } from "node:url"
import { resolve, join } from "node:path"
import { lstat } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { partnerEntry, partnerResources, partnerPrivateFile, partnerTestProject, cleanupPartnerTest } from "./partner-dev-resources.mjs"
import { partnerDevStart, partnerDevStatus, partnerDevStop } from "./partner-dev.mjs"
import { httpDevProof, httpCapacity } from "./http-proof.mjs"

const check = value => { if (!value) throw Error("PARTNER_DEV_CHECK") }
let phase = "start"
async function call(descriptor, path, body, node = false, method = "POST", expected = 200) {
  const url = new URL(descriptor.url), bytes = body == null ? undefined : Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: Number(url.port), path, method, agent: false, headers: { Authorization: `Bearer ${node ? descriptor.nodeToken : descriptor.ownerToken}`, ...(!node ? { "X-DevClaw-Space": "A" } : {}), ...(bytes ? { "Content-Type": "application/json", "Content-Length": bytes.length } : {}) } }, response => {
      let size = 0; const chunks = []
      response.on("data", chunk => { size += chunk.length; if (size > 1048576) request.destroy(); else chunks.push(chunk) })
      response.on("end", () => { try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); check(response.statusCode === expected); resolve(value) } catch { reject(Error("PARTNER_DEV_RESPONSE")) } })
    })
    request.setTimeout(10000, () => request.destroy()); request.on("error", () => reject(Error("PARTNER_DEV_REQUEST"))); request.end(bytes)
  })
}
export async function partnerDevCheck(signal) {
  const original = await httpDevProof(); let entry
  try {
    console.log(JSON.stringify(await httpCapacity(signal))); entry = await partnerEntry({ create: true, test: true, project: partnerTestProject() })
    console.log(JSON.stringify({ stage: "partner-dev-registered", project: entry.project }))
    phase = "first-start"; const first = await partnerDevStart(entry, signal)
    console.log(JSON.stringify({ stage: "partner-dev-first", project: entry.project, pid: first.pid, port: first.port }))
    const resources = await partnerResources(entry), container = resources.containers[0].Id, volume = resources.volume.Name, marker = await partnerPrivateFile(join(entry.dir, "owner.json")), credentials = await partnerPrivateFile(join(entry.dir, "partner.json"))
    const descriptor = JSON.parse(await partnerPrivateFile(first.connectionFile)); check(!JSON.stringify(descriptor).includes("password"))
    check((await call(descriptor, "/api/bot/local/v1/control", { operation: "identity" })).principalId === descriptor.ownerPrincipalId)
    check((await call(descriptor, "/api/bot/local/v1/node", { operation: "identity" }, true)).nodeId === descriptor.nodeId)
    const persisted = await call(descriptor, "/api/bot/v1/bots", { commandId: "persistent-bot", name: "Persistent partner fixture", maintainerIds: ["owner"], config: { description: "Persistent control DB proof", instructions: "Analyze only", knowledgeRefs: [], repositoryRefs: [], skillAllowlist: [], capabilityCeiling: ["requirements.analyze"], memoryPolicy: "disabled" } }, false, "POST", 201)
    const group = await call(descriptor, "/api/bot/v1/groups", { commandId: "persistent-memory-group", name: "Persistent memory team", members: [{ principalId: "owner", role: "admin" }, { principalId: "business", role: "participant" }], bots: [{ botId: persisted.bot.id, botVersionId: persisted.botVersion.id, role: "specialist" }], limits: { maxRuns: 1, maxHandoffs: 1, maxTokens: 1000 } }, false, "POST", 201)
    await call(descriptor, "/api/bot/local/v1/control", { operation: "createGroupMemory", groupId: group.group.id, commandId: "persistent-memory", text: "MYSQL_RESTART_MEMORY_SENTINEL", source: { kind: "manual" } })
    const memories = await call(descriptor, "/api/bot/local/v1/control", { operation: "listGroupMemories", groupId: group.group.id })
    phase = "idempotent-start"; const duplicate = await partnerDevStart(entry, signal), status = await partnerDevStatus(entry)
    check(duplicate.pid === first.pid && duplicate.port === first.port && status.status === "running")
    phase = "stop-owned-process"; const stopped = await partnerDevStop(entry)
    phase = "stop-preserve"; const after = await partnerResources(entry)
    const facts = { stopped: stopped.status === "stopped", sameContainer: after.containers[0].Id === container, databaseStopped: !after.containers[0].State.Running, sameVolume: after.volume.Name === volume, sameCredentials: await partnerPrivateFile(join(entry.dir, "partner.json")) === credentials, sameOwner: await partnerPrivateFile(join(entry.dir, "owner.json")) === marker }
    console.log(JSON.stringify({ stage: "partner-dev-stop-preserve", ...facts })); check(Object.values(facts).every(Boolean))
    phase = "restart"; const restarted = await partnerDevStart(entry, signal), restartedResources = await partnerResources(entry)
    check(restarted.pid !== first.pid && restartedResources.containers[0].Id === container && restartedResources.volume.Name === volume)
    const restored = JSON.parse(await partnerPrivateFile(restarted.connectionFile)); check(restored.nodeToken === descriptor.nodeToken && restored.ownerToken === descriptor.ownerToken && (await call(restored, "/api/bot/local/v1/node", { operation: "identity" }, true)).ownerPrincipalId === "owner")
    check(isDeepStrictEqual(persisted, await call(restored, `/api/bot/v1/bots/${persisted.bot.id}`, null, false, "GET")))
    check(isDeepStrictEqual(memories, await call(restored, "/api/bot/local/v1/control", { operation: "listGroupMemories", groupId: group.group.id })))
    await partnerDevStop(entry)
    for (const name of ["partner.json", "connection.json", "process.json", "server.log", "server-error.log"]) { const stat = await lstat(join(entry.dir, name)); check(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600) }
    return { status: "verified", explicitStartStop: true, realPartnerMain: true, separatePersistentControlDatabase: true, identicalDatabaseAndVolumeAcrossRestart: true, credentialsPreserved: true, privateConnectionWithoutDatabaseSecret: true, groupMemoryAcrossRestart: true }
  } finally {
    if (entry) { try { await partnerDevStop(entry) } finally { await cleanupPartnerTest(entry); console.log(JSON.stringify({ stage: "partner-dev-cleanup", project: entry.project, status: "removed", resources: "exact-test-only" })) } }
    check(isDeepStrictEqual(original, await httpDevProof())); console.log(JSON.stringify({ stage: "partner-dev-original", sameIdentityHealthy: true, credentialsRead: false }))
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort(), timer = setTimeout(cancel, 600000)
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel)
  try { if (process.argv.length !== 2) throw Error("PARTNER_DEV_ARGUMENTS"); console.log(JSON.stringify(await partnerDevCheck(controller.signal))) }
  catch { console.log(JSON.stringify({ status: "failed", phase, category: controller.signal.aborted ? "CANCELLED" : "PARTNER_DEV_CHECK" })); process.exitCode = 1 }
  finally { clearTimeout(timer); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel) }
}
