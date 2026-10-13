import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { withPartnerHttpFixture } from "./partner-http.mjs"

const check = value => { if (!value) throw Error("GROUP_MEMORY_CHECK") }
let phase = "start"
export async function groupMemoryHttpCheck(signal) {
  const results = []
  for (const upgradeV5 of [true, false]) results.push(await withPartnerHttpFixture(async ({ node, control, publicCall, probe, reopen, upgrade }) => {
    let denials = 0
    const safeCode = value => /^[A-Z_]+$/.test(value?.code) ? value.code : "UNEXPECTED"
    const denied = async (status, code, promise) => { const value = await promise; if (value.status !== status || !isDeepStrictEqual(value.value, { code })) throw Error(`GROUP_MEMORY_EXPECTED_${status}_${code}_ACTUAL_${value.status}_${safeCode(value.value)}`); denials++ }
    const get = async promise => { const value = await promise; if (value.status !== 200) throw Error(`GROUP_MEMORY_EXPECTED_OK_ACTUAL_${value.status}_${safeCode(value.value)}`); return value.value }
    const memory = (operation, fields, options) => control({ operation, ...fields }, options)
    const manual = { kind: "manual" }
    const makeMemory = (groupId, commandId, text, source = manual) => memory("createGroupMemory", { groupId, commandId, text, source })
    const list = groupId => get(memory("listGroupMemories", { groupId }))
    const ticket = run => ({ runId: run.id, attemptId: run.attemptId, leaseId: run.leaseId, fence: run.fence })
    const inspect = run => get(control({ operation: "inspect", runId: run.id }, { principal: "business" }))
    const snapshot = run => get(memory("inspectMemorySnapshot", { runId: run.id }, { principal: "business" }))
    const settle = (run, text) => node({ operation: "settle", ...ticket(run), outcome: "succeeded", text })
    phase = "observe"; await get(node({ operation: "observe" }))
    if (upgradeV5) {
      phase = "v5-running-historical-null"
      await get(makeMemory(upgrade.running.groupId, "legacy-new-memory", "MUST_NOT_ENTER_V5_GRAPH"))
      await get(node({ operation: "renew", ...ticket(upgrade.running) }))
      const historical = await get(node({ operation: "start", ...ticket(upgrade.running) }))
      check(historical.input.botVersion.config.memoryPolicy === "explicit_only" && historical.input.memorySnapshot === null)
      check((await snapshot(upgrade.running)).memorySnapshot === null)
      await get(settle(upgrade.running, "V5_RUNNING_FINISHED"))
      check((await get(settle(upgrade.terminal, "V5_PERSISTED_RESULT"))).result.text === "V5_PERSISTED_RESULT")
      await denied(404, "NOT_FOUND", memory("inspectMemorySnapshot", { runId: upgrade.terminal.id }))
    }
    phase = "seed-public"
    const bot = await publicCall("createBot", "POST", "/api/bot/v1/bots", { commandId: "memory-bot", name: "Memory expert", maintainerIds: ["owner", "other"], config: { description: "Explicit team memory", instructions: "Task only", knowledgeRefs: [], repositoryRefs: [], skillAllowlist: [], capabilityCeiling: ["requirements.analyze"], memoryPolicy: "explicit_only" } }); check(bot.status === 201)
    const groups = {}
    const createGroup = async (name, version = bot.value.botVersion.id) => {
      const value = await publicCall("createGroup", "POST", "/api/bot/v1/groups", { commandId: `memory-group-${name}`, name, members: [{ principalId: "owner", role: "admin" }, { principalId: "business", role: "participant" }, { principalId: "other", role: "participant" }], bots: [{ botId: bot.value.bot.id, botVersionId: version, role: "specialist" }], limits: { maxRuns: 1, maxHandoffs: 1, maxTokens: 1000 } }); check(value.status === 201); groups[name] = value.value.group; return value.value.group
    }
    await createGroup("A"); await createGroup("B"); await createGroup("empty"); await createGroup("budget"); await createGroup("bounds"); await createGroup("faults")
    const disabledVersion = await publicCall("createBotVersion", "POST", `/api/bot/v1/bots/${bot.value.bot.id}/versions`, { commandId: "memory-disabled-version", expectedVersion: 1, config: { ...bot.value.botVersion.config, memoryPolicy: "disabled" } }); check(disabledVersion.status === 201)
    await createGroup("disabled", disabledVersion.value.botVersion.id)
    const tasks = {}
    for (const name of ["A", "B", "empty", "disabled"]) {
      const value = await publicCall("createTask", "POST", "/api/bot/v1/tasks", { commandId: `memory-task-${name}`, groupId: groups[name].id, title: `Task ${name}`, goal: "Bounded requirement", inputArtifactVersions: [] }, { principal: "business" }); check(value.status === 201); tasks[name] = value.value.task
      await get(control({ operation: "authorize", groupId: groups[name].id, nodeId: "node", workspaceRef: "view", expectedVersion: 0, expiresAt: new Date(Date.now() + 600000).toISOString() }))
    }
    let sequence = 0
    const queue = name => control({ operation: "enqueue", commandId: `memory-run-${++sequence}`, taskId: tasks[name].id, botId: bot.value.bot.id, expectedTaskVersion: tasks[name].version, deadline: new Date(Date.now() + 600000).toISOString() }, { principal: "business" })
    const queued = name => get(queue(name))
    const claimed = async name => (await get(node({ operation: "claim", runId: (await queued(name)).runId }))).run
    const start = async name => { const run = await claimed(name); return { run, started: await get(node({ operation: "start", ...ticket(run) })) } }
    phase = "permissions-and-closure"
    const empty = await list(groups.A.id); check(empty.revision === 0 && empty.memories.length === 0 && empty.canManage && empty.botPolicies[0].botVersionId === bot.value.botVersion.id && empty.botPolicies[0].memoryPolicy === "explicit_only")
    const member = await get(memory("listGroupMemories", { groupId: groups.A.id }, { principal: "business" })); check(!member.canManage)
    await denied(403, "FORBIDDEN", memory("listGroupMemories", { groupId: groups.A.id }, { principal: "outsider" }))
    for (const principal of ["business", "other"]) await denied(403, "FORBIDDEN", memory("createGroupMemory", { groupId: groups.A.id, commandId: `forbidden-${principal}`, text: "no", source: manual }, { principal }))
    await denied(400, "INVALID_PAYLOAD", node({ operation: "listGroupMemories", groupId: groups.A.id }))
    await denied(403, "FORBIDDEN", memory("listGroupMemories", { groupId: groups.A.id }, { headers: { "X-DevClaw-Space": "B" } }))
    const beforeDenied = (await probe("facts")).factsSha256
    for (const source of [{ kind: "manual", createdBy: "other" }, { kind: "url", url: "https://invalid.test" }, { kind: "task", taskId: tasks.A.id, taskVersion: 1, author: "other" }, { kind: "result", runId: "missing", spaceId: "B" }]) await denied(400, "INVALID_PAYLOAD", makeMemory(groups.A.id, "closed-source", "safe", source))
    for (const text of ["", "\u00a0\ufeff", "x\0y", "\ud800", "\udc00", "🚀".repeat(257)]) await denied(400, "INVALID_PAYLOAD", makeMemory(groups.A.id, "invalid-text", text))
    await denied(400, "INVALID_PAYLOAD", memory("createGroupMemory", { groupId: groups.A.id, commandId: "forged-author", text: "safe", source: manual, createdBy: "business" }))
    await denied(403, "FORBIDDEN", makeMemory(groups.A.id, "other-group-source", "no", { kind: "task", taskId: tasks.B.id, taskVersion: 1 }))
    await denied(409, "INPUT_CHANGED", makeMemory(groups.A.id, "stale-task-source", "no", { kind: "task", taskId: tasks.A.id, taskVersion: 2 }))
    await denied(404, "NOT_FOUND", makeMemory(groups.A.id, "missing-source", "no", { kind: "task", taskId: "space-b-only-task", taskVersion: 1 }))
    check(beforeDenied === (await probe("facts")).factsSha256)
    phase = "command-cas"
    const originalBody = { groupId: groups.A.id, commandId: "memory-original", text: "TEAM_A_SENTINEL", source: manual }
    const original = await get(memory("createGroupMemory", originalBody)); check(original.revision === 1 && original.memory.version === 1 && original.memory.createdBy === "owner" && original.memory.updatedBy === "owner")
    const otherSpace = await probe("other-space", { groupId: groups.A.id, taskId: tasks.A.id, memoryId: original.memory.id }); check(otherSpace.sameGroupMemoryIdsScoped)
    await denied(404, "NOT_FOUND", makeMemory(groups.A.id, "actual-space-b-source", "no", { kind: "task", taskId: otherSpace.spaceBTaskId, taskVersion: 10 }))
    await denied(409, "INPUT_CHANGED", makeMemory(groups.A.id, "collided-space-b-source", "no", { kind: "task", taskId: tasks.A.id, taskVersion: 10 }))
    check((await list(groups.A.id)).memories.every(value => value.spaceId === "A" && !value.text.includes("SPACE_B")))
    check(isDeepStrictEqual(original, await get(memory("createGroupMemory", originalBody))))
    await denied(409, "COMMAND_CONFLICT", memory("createGroupMemory", { ...originalBody, text: "different" }))
    await denied(409, "COMMAND_CONFLICT", memory("createGroupMemory", { ...originalBody, groupId: groups.B.id }))
    await denied(409, "COMMAND_CONFLICT", memory("disableGroupMemory", { groupId: groups.A.id, memoryId: original.memory.id, commandId: originalBody.commandId, expectedVersion: 1 }))
    const repeated = await Promise.all([makeMemory(groups.A.id, "memory-concurrent", "TEAM_A_SECOND"), makeMemory(groups.A.id, "memory-concurrent", "TEAM_A_SECOND")]); check(repeated.every(value => value.status === 200) && isDeepStrictEqual(repeated[0].value, repeated[1].value) && (await list(groups.A.id)).revision === 2)
    const sourceBody = { groupId: groups.A.id, commandId: "task-source-memory", text: "TEAM_A_TASK_SOURCE", source: { kind: "task", taskId: tasks.A.id, taskVersion: 1 } }
    const taskMemory = await get(memory("createGroupMemory", sourceBody))
    const clarification = await publicCall("createTaskMessage", "POST", `/api/bot/v1/tasks/${tasks.A.id}/messages`, { commandId: "memory-clarification", expectedVersion: 1, text: "Current clarification", artifactVersions: [] }, { principal: "business" }); check(clarification.status === 201); tasks.A.version = 2
    check(isDeepStrictEqual(taskMemory, await get(memory("createGroupMemory", sourceBody))))
    const update = { groupId: groups.A.id, memoryId: original.memory.id, expectedVersion: 1, text: "TEAM_A_UPDATED", source: manual, status: "active" }
    const races = await Promise.all([memory("updateGroupMemory", { ...update, commandId: "cas-one" }), memory("updateGroupMemory", { ...update, commandId: "cas-two", text: "TEAM_A_OTHER" })]); check(races.filter(value => value.status === 200).length === 1 && races.filter(value => value.status === 409 && value.value.code === "VERSION_CONFLICT").length === 1)
    const winner = races.find(value => value.status === 200).value
    await denied(409, "INPUT_CHANGED", memory("updateGroupMemory", { ...update, expectedVersion: winner.memory.version, commandId: "stale-update-source", source: sourceBody.source }))
    const disable = { groupId: groups.A.id, memoryId: original.memory.id, commandId: "disable-original", expectedVersion: winner.memory.version }
    const disabled = await get(memory("disableGroupMemory", disable)); check(disabled.memory.status === "disabled" && isDeepStrictEqual(disabled, await get(memory("disableGroupMemory", disable))))
    await get(makeMemory(groups.B.id, "memory-b", "TEAM_B_SENTINEL"))
    check((await list(groups.A.id)).memories.every(value => !value.text.includes("TEAM_B")))
    check((await list(groups.B.id)).memories.every(value => !value.text.includes("TEAM_A")))
    phase = "empty-and-source-result"
    const pending = await queued("empty")
    await denied(404, "NOT_FOUND", memory("inspectMemorySnapshot", { runId: pending.runId }))
    await denied(400, "INVALID_PAYLOAD", makeMemory(groups.empty.id, "pending-result", "no", { kind: "result", runId: pending.runId }))
    await get(control({ operation: "cancelPending", runId: pending.runId, expectedVersion: 1 }, { principal: "business" }))
    const noMemories = await start("empty"); check(isDeepStrictEqual(noMemories.started.input.memorySnapshot, { revision: 0, memories: [] })); await get(settle(noMemories.run, "EMPTY_EXPLICIT_RESULT"))
    await denied(403, "FORBIDDEN", makeMemory(groups.A.id, "other-result", "no", { kind: "result", runId: noMemories.run.id }))
    await get(makeMemory(groups.empty.id, "settled-source", "RESULT_SOURCE_SENTINEL", { kind: "result", runId: noMemories.run.id }))
    phase = "start-frozen-renew-invalidates"
    const first = await start("A"), frozen = first.started.input.memorySnapshot
    phase = "frozen-scope"
    check(frozen !== null && frozen.memories.every(value => value.status === "active" && value.groupId === groups.A.id && value.spaceId === "A" && !value.text.includes("TEAM_B")))
    check(frozen.memories.map(value => value.id).join() === frozen.memories.map(value => value.id).sort().join())
    phase = "frozen-duplicate"; check(isDeepStrictEqual(first.started, await get(node({ operation: "start", ...ticket(first.run) }))))
    const changedMemory = repeated[0].value.memory
    phase = "memory-change"; const changed = await get(memory("updateGroupMemory", { groupId: groups.A.id, memoryId: changedMemory.id, commandId: "inflight-change", expectedVersion: 1, text: "A_NEW_MEMORY", source: manual, status: "active" }))
    phase = "frozen-after-change"; check(isDeepStrictEqual(frozen, (await get(node({ operation: "start", ...ticket(first.run) }))).input.memorySnapshot))
    phase = "memory-changed-renew"; await denied(409, "INPUT_CHANGED", node({ operation: "renew", ...ticket(first.run) }))
    phase = "memory-changed-inspect"; const invalidated = await inspect(first.run); check(invalidated.run.status === "failed" && invalidated.result.outcome === "failed" && invalidated.result.text === "MEMORY_CHANGED")
    check(isDeepStrictEqual(frozen, (await snapshot(first.run)).memorySnapshot))
    await denied(409, "COMMAND_CONFLICT", node({ operation: "start", ...ticket(first.run) }))
    const second = await start("A"); check(second.started.input.memorySnapshot.memories.some(value => value.text === "A_NEW_MEMORY"))
    await get(memory("disableGroupMemory", { groupId: groups.A.id, memoryId: changed.memory.id, commandId: "inflight-disable", expectedVersion: changed.memory.version }))
    await denied(409, "INPUT_CHANGED", settle(second.run, "MUST_NOT_PUBLISH")); check((await inspect(second.run)).result.text === "MEMORY_CHANGED")
    phase = "success-replay-history"
    const third = await start("A"), success = await get(settle(third.run, "MEMORY_SUCCESS")), oldSnapshot = (await snapshot(third.run)).memorySnapshot
    await get(makeMemory(groups.A.id, "post-success-memory", "AFTER_SUCCESS"))
    check(isDeepStrictEqual(success, await get(settle(third.run, "MEMORY_SUCCESS"))))
    await denied(403, "FORBIDDEN", memory("inspectMemorySnapshot", { runId: third.run.id }, { principal: "outsider" }))
    phase = "disabled-independent"
    const off = await start("disabled"); check(off.started.input.memorySnapshot === null)
    await get(makeMemory(groups.disabled.id, "disabled-store", "DO_NOT_CONSUME"))
    check((await get(node({ operation: "start", ...ticket(off.run) }))).input.memorySnapshot === null)
    await get(node({ operation: "renew", ...ticket(off.run) })); await get(settle(off.run, "DISABLED_SUCCESS")); check((await snapshot(off.run)).memorySnapshot === null)
    phase = "expired-unknown-first"
    const expiring = await start("B"); check(expiring.started.input.memorySnapshot.memories.some(value => value.text === "TEAM_B_SENTINEL"))
    await get(makeMemory(groups.B.id, "memory-before-expire", "REVISION_CHANGED")); await probe("expire", { runId: expiring.run.id })
    phase = "expired-unknown-renew"; await denied(409, "OUTCOME_UNKNOWN", node({ operation: "renew", ...ticket(expiring.run) }))
    phase = "expired-unknown-settle"
    await denied(409, "OUTCOME_UNKNOWN", settle(expiring.run, "MUST_NOT_PUBLISH"))
    const unknown = await inspect(expiring.run); check(unknown.run.status === "outcome_unknown" && unknown.result === null)
    phase = "expired-unknown-capacity"; await denied(429, "RATE_LIMITED", queue("B"))
    phase = "faults"
    const faultProof = await probe("faults", { groupId: groups.faults.id }); check(faultProof.allFactsRollback && faultProof.lostReceiptRecovered && faultProof.replayCurrentActorRequired)
    phase = "budget"
    for (let i = 0; i < 3; i++) await get(makeMemory(groups.budget.id, `encoded-${i}`, "<".repeat(512)))
    await denied(413, "PAYLOAD_TOO_LARGE", makeMemory(groups.budget.id, "encoded-overflow", "<".repeat(512))); check((await list(groups.budget.id)).revision === 3)
    phase = "stored-active-bounds"
    const bounded = []
    for (let i = 0; i < 10; i++) bounded.push((await get(makeMemory(groups.bounds.id, `bounded-${i}`, i === 0 ? "🚀".repeat(256) : `bounded ${i}`))).memory)
    await denied(413, "PAYLOAD_TOO_LARGE", makeMemory(groups.bounds.id, "active-overflow", "no"))
    for (let i = 10; i < 100; i++) { const previous = bounded[bounded.length - 1]; await get(memory("disableGroupMemory", { groupId: groups.bounds.id, memoryId: previous.id, commandId: `bounded-disable-${i}`, expectedVersion: 1 })); bounded.push((await get(makeMemory(groups.bounds.id, `bounded-${i}`, `bounded ${i}`))).memory) }
    const hundred = await list(groups.bounds.id); check(hundred.memories.length === 100 && hundred.memories.filter(value => value.status === "active").length === 10)
    await denied(413, "PAYLOAD_TOO_LARGE", makeMemory(groups.bounds.id, "stored-overflow", "no"))
    phase = "service-reopen"
    const before = await list(groups.A.id); await reopen(); await get(node({ operation: "observe" })); check(isDeepStrictEqual(before, await list(groups.A.id)))
    check(isDeepStrictEqual(oldSnapshot, (await snapshot(third.run)).memorySnapshot)); check(isDeepStrictEqual(success, await get(settle(third.run, "MEMORY_SUCCESS"))))
    phase = "withdraw-admin-replay"
    const removed = await publicCall("updateGroupMembers", "PUT", `/api/bot/v1/groups/${groups.A.id}/members`, { commandId: "remove-owner-memory", expectedVersion: 1, members: [{ principalId: "business", role: "admin" }], bots: groups.A.bots }); check(removed.status === 200)
    await denied(403, "FORBIDDEN", memory("createGroupMemory", originalBody)); await denied(403, "FORBIDDEN", memory("listGroupMemories", { groupId: groups.A.id })); await denied(403, "FORBIDDEN", memory("inspectMemorySnapshot", { runId: third.run.id }))
    check((await get(memory("listGroupMemories", { groupId: groups.A.id }, { principal: "business" }))).canManage)
    return { status: "verified", upgradeV5, denials, sourceTaskVersion: true, realCasAndReplay: true, allFactsRollback: true, lostReceiptRecovered: true, sameBotGroupsIsolated: true, frozenSnapshot: true, memoryChangedTerminalCapacityReleased: true, disabledNullIndependent: true, expiredUnknownReserved: true, hundredStoredTenActive: true, encodedBudget: true, reopened: true }
  }, { signal, upgradeV5 }))
  return { status: "verified", sequentialDatabases: 2, proofs: results }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort(), timer = setTimeout(cancel, 1200000)
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel)
  try { if (process.argv.length !== 2) throw Error("GROUP_MEMORY_ARGUMENTS"); console.log(JSON.stringify(await groupMemoryHttpCheck(controller.signal))) }
  catch (error) { console.log(JSON.stringify({ status: "failed", phase, category: controller.signal.aborted ? "CANCELLED" : /^GROUP_MEMORY_[A-Z0-9_]+$/.test(error.message) ? error.message : "GROUP_MEMORY_CHECK" })); process.exitCode = 1 }
  finally { clearTimeout(timer); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel) }
}
