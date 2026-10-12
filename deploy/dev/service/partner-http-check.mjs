import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { withPartnerHttpFixture, stopPartnerChildren } from "./partner-http.mjs"

const check = value => { if (!value) throw Error("PARTNER_CHECK") }
let phase = "start"
const iso = value => typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
export async function partnerHttpCheck(signal) {
  return withPartnerHttpFixture(async ({ descriptor, node, control, publicCall, request }) => {
    phase = "identity"
    let denials = 0
    const denied = async (status, code, promise) => { const value = await promise; check(value.status === status && isDeepStrictEqual(value.value, { code })); denials++ }
    check(isDeepStrictEqual((await node({ operation: "identity" })).value, { spaceId: "A", nodeId: "node", ownerPrincipalId: "owner" }))
    check(isDeepStrictEqual((await control({ operation: "identity" })).value, { spaceId: "A", principalId: "owner" }))
    check((await control({ operation: "identity" }, { principal: "business" })).value.principalId === "business")
    await denied(401, "UNAUTHENTICATED", node({ operation: "identity" }, { headers: { Authorization: `Bearer ${descriptor.ownerToken}` } }))
    await denied(401, "UNAUTHENTICATED", request("/api/bot/local/v1/control", { operation: "identity" }, { node: true, headers: { "X-DevClaw-Space": "A" } }))
    phase = "transport"
    for (const headers of [{ "X-DevClaw-Space": "A" }, { Origin: "http://127.0.0.1" }, { Cookie: "private=sentinel" }, { Host: "localhost:1" }, { "Content-Encoding": "gzip" }, { "Content-Type": "text/plain" }]) await denied(400, "INVALID_PAYLOAD", node({ operation: "identity" }, { headers }))
    for (const body of [{ operation: "identity", spaceId: "A" }, { operation: "observe", nodeId: "forged" }, { operation: "poll", limit: 100 }, { operation: "unknown" }, Buffer.from('{"operation":"identity","operation":"poll"}'), Buffer.from('{} {}')]) await denied(400, "INVALID_PAYLOAD", node(body))
    await denied(413, "PAYLOAD_TOO_LARGE", node(Buffer.alloc(1048577, 32)))
    check((await node({ operation: "observe" })).value.observed === true)
    check((await node({ operation: "observe" }, { principal: "other" })).value.observed === true)
    phase = "public"
    const bot = await publicCall("createBot", "POST", "/api/bot/v1/bots", { commandId: "partner-bot", name: "Partner expert", maintainerIds: ["owner", "other"], config: { description: "Requirement expert", instructions: "Analyze only task text", knowledgeRefs: [], repositoryRefs: [], skillAllowlist: [], capabilityCeiling: ["requirements.analyze"], memoryPolicy: "disabled" } })
    check(bot.status === 201)
    const group = await publicCall("createGroup", "POST", "/api/bot/v1/groups", { commandId: "partner-group", name: "Partner team", members: [{ principalId: "owner", role: "admin" }, { principalId: "business", role: "participant" }, { principalId: "other", role: "admin" }], bots: [{ botId: bot.value.bot.id, botVersionId: bot.value.botVersion.id, role: "specialist" }], limits: { maxRuns: 16, maxHandoffs: 1, maxTokens: 1000 } })
    check(group.status === 201)
    const task = await publicCall("createTask", "POST", "/api/bot/v1/tasks", { commandId: "partner-task", groupId: group.value.group.id, title: "Local requirement", goal: "Clarify scope", inputArtifactVersions: [] }, { principal: "business" })
    check(task.status === 201)
    const clarification = await publicCall("createTaskMessage", "POST", `/api/bot/v1/tasks/${task.value.task.id}/messages`, { commandId: "partner-clarification", expectedVersion: 1, text: "CLARIFICATION_SENTINEL 只查本人可见账户，不代业务确认", artifactVersions: [] }, { principal: "business" })
    check(clarification.status === 201 && clarification.value.taskVersion === 2)
    phase = "grant"
    const authorize = { operation: "authorize", groupId: group.value.group.id, nodeId: "node", workspaceRef: descriptor.workspaceRef, expectedVersion: 0, expiresAt: new Date(Date.now() + 600000).toISOString() }
    check(isDeepStrictEqual((await control({ operation: "authorization", groupId: group.value.group.id })).value, { grant: null }))
    await denied(403, "FORBIDDEN", control(authorize, { principal: "business" }))
    await denied(403, "FORBIDDEN", control({ ...authorize, nodeId: "other-node" }))
    await denied(403, "FORBIDDEN", control({ ...authorize, workspaceRef: "unlisted" }))
    const grant = await control(authorize); check(grant.status === 200 && grant.value.grant.version === 1 && iso(grant.value.grant.expiresAt) && iso(grant.value.grant.createdAt))
    check(isDeepStrictEqual((await control({ operation: "authorization", groupId: group.value.group.id }, { principal: "business" })).value, grant.value))
    await denied(403, "FORBIDDEN", control({ operation: "authorization", groupId: group.value.group.id }, { principal: "outsider" }))
    check((await control({ operation: "lookupTaskNumber", groupId: group.value.group.id, taskNumber: task.value.task.taskNumber }, { principal: "business" })).value.task.id === task.value.task.id)
    await denied(400, "INVALID_PAYLOAD", control({ operation: "lookupTaskNumber", groupId: group.value.group.id, taskNumber: "TASK-0" }))
    await denied(403, "FORBIDDEN", control({ operation: "lookupTaskNumber", groupId: group.value.group.id, taskNumber: task.value.task.taskNumber }, { principal: "outsider" }))
    phase = "enqueue"
    const enqueue = { operation: "enqueue", commandId: "partner-enqueue", taskId: task.value.task.id, botId: bot.value.bot.id, expectedTaskVersion: 2, deadline: new Date(Date.now() + 600000).toISOString() }
    const queued = await control(enqueue, { principal: "business" }), duplicate = await control(enqueue, { principal: "business" })
    check(queued.status === 200 && isDeepStrictEqual(queued.value, duplicate.value) && iso(queued.value.createdAt))
    check((await node({ operation: "poll" }, { principal: "other" })).value.runs.length === 0)
    const polled = await node({ operation: "poll" }); check(polled.value.runs.length === 1 && polled.value.runs[0].id === queued.value.runId)
    await denied(403, "FORBIDDEN", node({ operation: "inspect", runId: queued.value.runId }, { principal: "other" }))
    const claimed = await node({ operation: "claim", runId: queued.value.runId }); check(claimed.status === 200 && claimed.value.run.status === "starting" && iso(claimed.value.run.leaseExpiresAt))
    const r = claimed.value.run, ticket = { runId: r.id, attemptId: r.attemptId, leaseId: r.leaseId, fence: r.fence }
    await denied(409, "COMMAND_CONFLICT", node({ operation: "start", ...ticket, fence: 2 }))
    phase = "execution"
    const starts = await Promise.all([node({ operation: "start", ...ticket }), node({ operation: "start", ...ticket })])
    check(starts.every(value => value.status === 200) && isDeepStrictEqual(starts[0].value, starts[1].value) && starts[0].value.run.status === "running" && starts[0].value.input.messages[0].message.text.includes("CLARIFICATION_SENTINEL"))
    check((await node({ operation: "renew", ...ticket })).value.run.status === "running")
    const settled = await Promise.all([node({ operation: "settle", ...ticket, outcome: "succeeded", text: "LOCAL_HTTP_RESULT" }), node({ operation: "settle", ...ticket, outcome: "succeeded", text: "LOCAL_HTTP_RESULT" })])
    check(settled.every(value => value.status === 200) && isDeepStrictEqual(settled[0].value, settled[1].value) && iso(settled[0].value.result.settledAt))
    await denied(409, "COMMAND_CONFLICT", node({ operation: "settle", ...ticket, outcome: "succeeded", text: "conflict" }))
    const inspected = await control({ operation: "inspect", runId: r.id }, { principal: "business" }); check(inspected.value.run.status === "succeeded" && inspected.value.result.text === "LOCAL_HTTP_RESULT")
    check(isDeepStrictEqual((await node({ operation: "inspect", runId: r.id })).value, inspected.value))
    phase = "poll-bound"
    for (let i = 0; i < 10; i++) check((await control({ ...enqueue, commandId: `poll-bound-${i}` }, { principal: "business" })).status === 200)
    const bounded = await node({ operation: "poll" }); check(bounded.value.runs.length === 8)
    const pending = bounded.value.runs[0]
    check((await control({ operation: "cancelPending", runId: pending.id, expectedVersion: pending.version }, { principal: "business" })).value.run.status === "cancelled")
    check((await control({ operation: "revoke", groupId: group.value.group.id, expectedVersion: 1 })).value.grant.enabled === false)
    await denied(403, "FORBIDDEN", node({ operation: "claim", runId: bounded.value.runs[1].id }))
    return { status: "verified", denials, realPartnerMain: true, oldPublicMethods: 4, independentIdentity: true, pollBound: 8, realHttpRunRoundTrip: true, clarificationProvided: true, resultPersisted: true }
  }, { signal })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, 600000)
  process.once("SIGTERM", abort); process.once("SIGINT", abort)
  try { if (process.argv.length !== 2) throw Error("PARTNER_ARGUMENTS"); console.log(JSON.stringify(await partnerHttpCheck(controller.signal))) }
  catch { console.log(JSON.stringify({ status: "failed", phase, category: controller.signal.aborted ? "CANCELLED" : "PARTNER_CHECK" })); process.exitCode = 1 }
  finally { clearTimeout(timer); await stopPartnerChildren(); process.removeListener("SIGTERM", abort); process.removeListener("SIGINT", abort) }
}
