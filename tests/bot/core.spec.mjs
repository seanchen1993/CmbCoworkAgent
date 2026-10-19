import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { generate } from "../../scripts/generate-bot-contract-types.mjs"
import { schemas, states, validator } from "./schema-support.mjs"

test("closed core schema and single state table compile offline", () => {
  for (const name of Object.keys(schemas.$defs))
    assert.equal(typeof validator(name), "function", name)
  assert.deepEqual(
    Object.keys(states["x-state-transitions"]).sort(),
    Object.keys(states.$defs).sort()
  )
  assert.deepEqual(
    Object.keys(states["x-mode-capabilities"]).sort(),
    [...schemas.$defs.ModeRef.properties.id.enum].sort()
  )
  for (const caps of Object.values(states["x-mode-capabilities"])) {
    assert.equal(new Set(caps).size, caps.length)
    for (const cap of caps) assert.ok(schemas.$defs.Capability.enum.includes(cap))
  }
  for (const [name, status] of Object.entries(states.$defs)) {
    const table = states["x-state-transitions"][name]
    assert.deepEqual(Object.keys(table).sort(), [...status.enum].sort(), name)
    for (const next of Object.values(table))
      for (const value of next) assert.ok(status.enum.includes(value))
    for (const [from, next] of Object.entries(states["x-reconciliation"][name] ?? {})) {
      assert.equal(from, "outcome_unknown")
      assert.deepEqual(table[from], [])
      for (const value of next) assert.ok(status.enum.includes(value))
    }
  }
  assert.equal(validator("Version")(0), false)
  assert.equal(
    validator("CredentialBinding")({
      credentialRef: "cred-1",
      purpose: "repository_read",
      token: "synthetic-secret"
    }),
    false
  )
  assert.equal(validator("ModeRef")({ id: "requirement", version: 1 }), true)
})

test("deterministic generator rejects unsupported keyword, remote refs and open maps", () => {
  const docs = { "schemas.json": schemas, "state-transitions.json": states }
  assert.equal(generate(docs), generate(docs))
  for (const mutation of [
    (s) => {
      s.$defs.Id.not = {}
    },
    (s) => {
      s.$defs.Id = { $ref: "https://invalid.example/x#/$defs/Id" }
    },
    (s) => {
      s.$defs.Bot.additionalProperties = true
    },
    (s) => {
      s.$defs.Id.properties = { unsupported: { type: "string" } }
    },
    (s) => {
      s.$defs.RuntimeErrorBody.if.not = {}
    }
  ]) {
    const changed = structuredClone(docs)
    mutation(changed["schemas.json"])
    assert.throws(() => generate(changed))
  }
})

test("actual generator CLI --check detects drift and never overwrites it", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bot-contract-drift-"))
  try {
    mkdirSync(join(scratch, "scripts"), { recursive: true })
    mkdirSync(join(scratch, "contracts/bot/v1"), { recursive: true })
    mkdirSync(join(scratch, "src/shared/bot"), { recursive: true })
    copyFileSync(
      new URL("../../scripts/generate-bot-contract-types.mjs", import.meta.url),
      join(scratch, "scripts/generate-bot-contract-types.mjs")
    )
    for (const name of ["schemas.json", "state-transitions.json"])
      copyFileSync(
        new URL(`../../contracts/bot/v1/${name}`, import.meta.url),
        join(scratch, `contracts/bot/v1/${name}`)
      )
    const args = [join(scratch, "scripts/generate-bot-contract-types.mjs")]
    assert.equal(spawnSync(process.execPath, args, { encoding: "utf8" }).status, 0)
    assert.equal(spawnSync(process.execPath, [...args, "--check"], { encoding: "utf8" }).status, 0)
    const output = join(scratch, "src/shared/bot/contracts.generated.ts")
    writeFileSync(output, "// synthetic drift\n")
    const failed = spawnSync(process.execPath, [...args, "--check"], { encoding: "utf8" })
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr, /have drifted/)
    assert.equal(readFileSync(output, "utf8"), "// synthetic drift\n")
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

 test("text task review can complete directly without a fictional handoff", () => {
  const table = states["x-state-transitions"].TaskStatus
  assert.ok(table.awaiting_business.includes("completed"))
  assert.ok(table.awaiting_business.includes("active"))
  assert.deepEqual(table.completed, [])
  assert.equal(table.active.includes("completed"), false)
})


test("expert task lifecycle is guarded separately from ordinary terminal transitions", () => {
  const lifecycle = states["x-internal-lifecycles"].expert_task
  assert.equal(lifecycle.ordinaryEnqueueMayReopen, false)
  assert.equal(lifecycle.publicStageTerminalTransitionsUnchanged, true)
  for (const guard of ["explicit_complete_or_reopen", "current_group_bot_membership", "conversation_owner", "expected_task_version", "no_pending_or_unknown_run", "local_pending_coordination_gate"])
    assert.ok(lifecycle.guards.includes(guard))
  assert.deepEqual(lifecycle.reopen.firstStage, ["completed", "active"])
  assert.deepEqual(lifecycle.reopen.otherStages, ["cancelled", "pending"])
  assert.equal(states["x-state-transitions"].TaskStatus.active.includes("completed"), false)
  assert.deepEqual(states["x-state-transitions"].TaskStatus.completed, [])
  assert.deepEqual(states["x-state-transitions"].StageStatus.completed, [])
  assert.deepEqual(states["x-state-transitions"].StageStatus.cancelled, [])
})
