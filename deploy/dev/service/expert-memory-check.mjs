import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { withPartnerHttpFixture } from "./partner-http.mjs"

let phase = "start"
export async function expertMemoryCheck(signal) {
  return withPartnerHttpFixture(async ({ publicCall, control, node, upgrade, reopen }) => {
    let denials = 0, sequence = 0
    const ok = async promise => { const value = await promise; assert.equal(value.status, 200, `phase:${phase}`); return value.value }
    const denied = async (code, promise) => { const value = await promise; assert.notEqual(value.status, 200); assert.deepEqual(value.value, { code }); denials++ }
    const memory = (operation, fields, options) => control({ operation, ...fields }, options)
    const ticket = run => ({ runId: run.id, attemptId: run.attemptId, leaseId: run.leaseId, fence: run.fence })
    const config = { description: "Expert", instructions: "Analyze explicit input only", knowledgeRefs: [], repositoryRefs: [], skillAllowlist: [], capabilityCeiling: ["requirements.analyze"], memoryPolicy: "explicit_only" }
    phase = "create"
    const bot = await publicCall("createBot", "POST", "/api/bot/v1/bots", { commandId: "expert-bot", name: "Expert", maintainerIds: ["owner"], config }); assert.equal(bot.status, 201)
    const second = await publicCall("createBot", "POST", "/api/bot/v1/bots", { commandId: "second-bot", name: "Other", maintainerIds: ["owner"], config }); assert.equal(second.status, 201)
    const botId = bot.value.bot.id, versionId = bot.value.botVersion.id, groups = {}, tasks = {}
    for (const name of ["A", "B"]) {
      const group = await publicCall("createGroup", "POST", "/api/bot/v1/groups", { commandId: `expert-group-${name}`, name, members: [{ principalId: "owner", role: "admin" }, { principalId: "business", role: "participant" }, { principalId: "other", role: "admin" }], bots: [{ botId, botVersionId: versionId, role: "specialist" }], limits: { maxRuns: 4, maxHandoffs: 1, maxTokens: 1000 } }); assert.equal(group.status, 201); groups[name] = group.value.group
      const task = await publicCall("createTask", "POST", "/api/bot/v1/tasks", { commandId: `expert-task-${name}`, groupId: groups[name].id, title: `Task ${name}`, goal: "Clarify", inputArtifactVersions: [] }, { principal: "business" }); assert.equal(task.status, 201); tasks[name] = task.value.task
    }
    await ok(node({ operation: "observe" }))
    for (const group of Object.values(groups)) await ok(control({ operation: "authorize", groupId: group.id, nodeId: "node", workspaceRef: "view", expectedVersion: 0, expiresAt: new Date(Date.now() + 600000).toISOString() }))
    const queue = async name => ok(control({ operation: "enqueue", commandId: `expert-run-${++sequence}`, taskId: tasks[name].id, botId, expectedTaskVersion: 1, deadline: new Date(Date.now() + 600000).toISOString() }, { principal: "business" }))
    const start = async id => { const run = (await ok(node({ operation: "claim", runId: id }))).run; return ok(node({ operation: "start", ...ticket(run) })) }
    const legacy = await ok(memory("createGroupMemory", { groupId: groups.A.id, commandId: "private-group", text: "PRIVATE_GROUP_ONLY", source: { kind: "manual" } }))
    const oldQueued = await queue("A")
    phase = "permission-and-adoption"
    await denied("FORBIDDEN", memory("createExpertMemory", { botId, commandId: "admin-not-maintainer", text: "no" }, { principal: "other" }))
    await denied("FORBIDDEN", memory("listExpertMemories", { botId }, { principal: "business" }))
    await denied("FORBIDDEN", memory("listExpertMemories", { botId }, { headers: { "X-DevClaw-Space": "B" } }))
    await denied("INVALID_PAYLOAD", memory("createExpertMemory", { botId, commandId: "source-forgery", text: "no", source: { kind: "task", taskId: tasks.A.id, taskVersion: 1 } }))
    const adopt = group => ({ groupId: group.id, botId, botVersionId: versionId, expectedGroupVersion: group.version })
    await denied("FORBIDDEN", memory("activateExpertMemory", adopt(groups.A), { principal: "other" }))
    await denied("INPUT_CHANGED", memory("activateExpertMemory", { ...adopt(groups.A), expectedGroupVersion: 2 }))
    await denied("INPUT_CHANGED", memory("activateExpertMemory", { ...adopt(groups.A), botVersionId: second.value.botVersion.id }))
    for (const group of Object.values(groups)) { assert.equal((await ok(memory("activateExpertMemory", adopt(group)))).adopted, true); assert.equal((await ok(memory("activateExpertMemory", adopt(group)))).adopted, true) }
    assert.equal((await ok(memory("expertMemoryAdoption", { groupId: groups.A.id, botId }, { principal: "other" }))).adopted, true)
    assert.deepEqual((await ok(memory("listExpertMemories", { botId }))).memories, [])
    assert.equal((await ok(memory("listGroupMemories", { groupId: groups.A.id }))).memories[0].text, "PRIVATE_GROUP_ONLY")
    phase = "commands-and-cas"
    const create = { botId, commandId: "manual-expert", text: "SHARED_EXPERT_KNOWLEDGE" }
    const repeated = await Promise.all([ok(memory("createExpertMemory", create)), ok(memory("createExpertMemory", create))]); assert.deepEqual(repeated[0], repeated[1])
    const first = repeated[0]; assert.equal(first.revision, 1); assert.equal(first.memory.botId, botId); assert(!("groupId" in first.memory)); assert.equal(first.memory.createdBy, "owner")
    await denied("COMMAND_CONFLICT", memory("createExpertMemory", { ...create, text: "different" }))
    assert.deepEqual((await ok(memory("listExpertMemories", { botId: second.value.bot.id }))).memories, [])
    phase = "fixed-run-scopes"
    phase = "legacy-start"
    const old = await start(oldQueued.runId); assert.equal(old.run.memoryScope, "group"); assert.equal(old.input.memorySnapshot.memories[0].text, "PRIVATE_GROUP_ONLY")
    phase = "expert-start"
    const a = await start((await queue("A")).runId), b = await start((await queue("B")).runId)
    phase = "expert-snapshot-assertions"
    for (const run of [a, b]) { assert.equal(run.run.memoryScope, "bot"); assert.equal(run.input.memorySnapshot.scope, "bot"); assert.equal(run.input.memorySnapshot.botId, botId); assert.deepEqual(run.input.memorySnapshot.memories, [first.memory]) }
    const frozen = a.input.memorySnapshot
    phase = "expert-concurrent-cas"
    const changes = await Promise.all(["one", "two"].map(suffix => memory("updateExpertMemory", { botId, memoryId: first.memory.id, commandId: `cas-${suffix}`, expectedVersion: 1, text: `UPDATED_${suffix}`, status: "active" })))
    assert.equal(changes.filter(v => v.status === 200).length, 1); assert.equal(changes.filter(v => v.value.code === "VERSION_CONFLICT").length, 1)
    const changed = changes.find(v => v.status === 200).value
    phase = "expert-repeat-frozen-start"
    assert.deepEqual((await ok(node({ operation: "start", ...ticket(a.run) }))).input.memorySnapshot, frozen)
    phase = "legacy-unaffected-renew"
    await ok(node({ operation: "renew", ...ticket(old.run) }))
    for (const run of [a, b]) {
      phase = "expert-inflight-invalidation"
      await denied("INPUT_CHANGED", node({ operation: "renew", ...ticket(run.run) }))
      const result = await ok(control({ operation: "inspect", runId: run.run.id }, { principal: "business" })); assert.equal(result.run.status, "failed"); assert.equal(result.result.text, "MEMORY_CHANGED")
    }
    phase = "legacy-inflight-invalidation"
    await ok(memory("updateGroupMemory", { groupId: groups.A.id, memoryId: legacy.memory.id, commandId: "change-legacy", expectedVersion: 1, text: "NEW_PRIVATE_GROUP", source: { kind: "manual" }, status: "active" }))
    await denied("INPUT_CHANGED", node({ operation: "renew", ...ticket(old.run) }))
    phase = "disable-and-restart"
    const current = await start((await queue("B")).runId)
    assert.equal(current.input.memorySnapshot.memories[0].text, changed.memory.text)
    const result = await ok(node({ operation: "settle", ...ticket(current.run), outcome: "succeeded", text: "EXPERT_SUCCESS" }))
    await ok(memory("disableExpertMemory", { botId, memoryId: first.memory.id, commandId: "disable-expert", expectedVersion: changed.memory.version }))
    const empty = await start((await queue("B")).runId); assert.deepEqual(empty.input.memorySnapshot.memories, []); assert.equal(empty.input.memorySnapshot.revision, 3)
    await ok(node({ operation: "settle", ...ticket(empty.run), outcome: "succeeded", text: "EMPTY_SUCCESS" }))
    await reopen(); await ok(node({ operation: "observe" }))
    assert.deepEqual((await ok(memory("inspectMemorySnapshot", { runId: a.run.id }, { principal: "business" }))).memorySnapshot, frozen)
    assert.deepEqual(await ok(node({ operation: "settle", ...ticket(current.run), outcome: "succeeded", text: "EXPERT_SUCCESS" })), result)
    assert.equal((await ok(memory("listExpertMemories", { botId }))).memories[0].status, "disabled")
    phase = "legacy-upgrade"
    assert.equal((await ok(control({ operation: "inspect", runId: upgrade.running.id }, { principal: "business" }))).run.memoryScope, "group")
    assert.deepEqual((await ok(memory("inspectMemorySnapshot", { runId: upgrade.running.id }, { principal: "business" }))).memorySnapshot, JSON.parse(upgrade.snapshot))
    return { status: "verified", realJavaMysql57: true, expertSharedAcrossAdoptedGroups: true, legacyScopePreserved: true, noPrivatePromotion: true, fixedSnapshots: true, independentInvalidation: true, casAndIdempotency: true, restartAndHistoricalReplay: true, denials }
  }, { signal, upgradeV6: true })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort(), timer = setTimeout(cancel, 600000)
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel)
  try { console.log(JSON.stringify(await expertMemoryCheck(controller.signal))) }
  catch (error) { console.log(JSON.stringify({ status: "failed", phase, category: /^[A-Z0-9_]+$/.test(error?.message) ? error.message : "EXPERT_CHECK" })); process.exitCode = 1 }
  finally { clearTimeout(timer); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel) }
}
