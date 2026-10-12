import { afterEach, expect, it } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { randomUUID } from "node:crypto"
import { executeBotBackup } from "./backups"
import { BOT_SESSION_END_KEY } from "./skill-hook-state"
import { botDeliverFileTool } from "./deliver-file-tool"
import { BotWorkflowStore } from "./workflow-store"
import type { BotRuntimeRequest } from "./host"
const close: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const fn of close.splice(0).reverse()) await fn()
})
async function fixture(text = "交付 result.csv（project_id、amount万元，每个项目一行）") {
  const dir = await mkdtemp(join(tmpdir(), "bot-output-contract-"))
  close.push(() => rm(dir, { recursive: true, force: true }))
  const store = new BotStore(join(dir, "bots.sqlite"))
  close.push(() => store.close())
  const files = new BotArtifacts(join(dir, "objects"), store)
  close.push(() => files.close())
  await files.recover()
  const { bot, conversationId } = store.createBot({ nonce: "owner", name: "Owner" })
  const sent = store.send({ nonce: "task", conversationId, text })
  const claimed = store.claim("host", 300000)!
  const request: BotRuntimeRequest = {
    ...claimed,
    bot,
    store,
    signal: new AbortController().signal,
    messages: store.messagesForRun(claimed.run.id)
  }
  const tool = botDeliverFileTool(request, files, () => store.assertDispatch(claimed.lease))
  const invoke = async (id: string, args: Record<string, unknown>) => {
    const result = await tool.invoke({ type: "tool_call", name: "deliver_file", id, args })
    return JSON.parse(String(result.content))
  }
  return { dir, store, files, bot, conversationId, sent, ...claimed, invoke }
}
const wrong = { name: "result.csv", content: "project_id,amount_wan\nA,18.45\n" }
const right = { name: "result.csv", content: "project_id,amount万元\nA,18.45\n" }
function inspectionChild(f: Awaited<ReturnType<typeof fixture>>) {
  const workflow = BotWorkflowStore.open(f.store, f.lease, "inspect-originals", {
    script:
      'export const meta={name:"Inspect originals",description:"Read original attachments"}; return await agent("Inspect originals");',
    maxConcurrency: 1,
    defaultModelId: "configured",
    agentProfiles: [],
    authority: { project: "test" }
  })
  const child = f.store.workflowChildren.claim(workflow, f.lease, {
    prompt: "Read the original attachments and return their contents. Do not create files.",
    agentIndex: 1,
    toolStreamKey: `${"a".repeat(64)}_c0`,
    durableCallKey: `${"a".repeat(64)}_n0`,
    label: "Inspect originals",
    phase: null,
    shellAccess: "read_only"
  })
  return { workflow, child }
}
it("lets an actual read-only child finish its evidence while the parent still owes final files", async () => {
  const f = await fixture(),
    { child } = inspectionChild(f)
  expect(f.store.outputContracts.instructions(child.lease!)).toContain(
    "not additional work assigned to this child"
  )
  expect(() => f.store.outputContracts.assertComplete(child.lease!)).not.toThrow()
  expect(
    f.store.workflowChildren.settle(child.lease!, "succeeded", {
      text: "Originals inspected",
      structured: { inspected: true },
      outputTokens: 5
    }).status
  ).toBe("succeeded")
  expect(f.store.finish(f.lease, "succeeded", "No files yet")).toMatchObject({
    status: "needs_review",
    error: expect.stringContaining("result.csv")
  })
})
it("still validates a child's own file against the human columns and stops repeated invalid delivery", async () => {
  const f = await fixture(),
    { child } = inspectionChild(f)
  for (const id of ["child-a", "child-b", "child-c"])
    expect(
      f.store.outputContracts.authorize(
        child.lease!,
        id,
        wrong.name,
        Buffer.from(wrong.content),
        id
      )
    ).toMatchObject({ status: "not_generated" })
  expect(() => f.store.outputContracts.assertComplete(child.lease!)).toThrow("多次")
  expect(f.store.artifacts(f.conversationId)).toEqual([])
})
it("keeps an upgraded child pause recoverable without assigning its parent's final files", async () => {
  const f = await fixture(),
    { child } = inspectionChild(f)
  f.store.outputContracts.instructions(child.lease!)
  // A prior Host saved this pause when it mistook the shared user message for
  // the child's own assignment. Recovery must retain that record and scope.
  f.store.db.run("UPDATE bot_output_contracts SET stop_reason=? WHERE run_id=?", [
    "尚未交付符合当前格式的文件：result.csv",
    child.run.id
  ])
  const failed = f.store.workflowChildren.settle(child.lease!, "failed", "Format pause")
  expect(failed.status).toBe("needs_review")
  f.store.recover({
    id: failed.id,
    revision: failed.revision,
    decision: "resume",
    note: "Continue the existing read-only inspection",
    effects: []
  })
  const messages = f.store.messages(f.conversationId)
  expect(messages.at(-1)?.text).toContain("父任务负责最终文件交付")
  expect(f.store.steering.hasPending(child.run.id)).toBe(true)
  expect(f.store.outputContracts.completionIssue(child.run.id, true)).toBeUndefined()
  expect(f.store.outputContracts.completionIssue(f.run.id, true)).toContain("result.csv")
})
it("rejects before publication, saves one failure per call, then commits original bytes and fulfillment together", async () => {
  const f = await fixture()
  const feedback = await f.invoke("wrong", wrong)
  expect(feedback).toMatchObject({ status: "not_generated" })
  expect(await f.invoke("wrong", wrong)).toEqual(feedback)
  expect(f.store.artifacts(f.conversationId)).toEqual([])
  expect(f.store.db.exec("SELECT count(*) FROM bot_output_attempts")[0].values[0][0]).toBe(1)
  const delivered = await f.invoke("right", right)
  expect((await readFile(join(f.dir, "objects", delivered.sha256))).toString()).toBe(right.content)
  expect(f.store.finish(f.lease, "succeeded", "Ready").status).toBe("succeeded")
})
it("keeps the third bad tool response resumable, stops only at model boundary and preserves attempts", async () => {
  const f = await fixture()
  for (const id of ["a", "b", "c"])
    expect(
      await f.invoke(id, { ...wrong, content: `project_id,amount_wan\n${id},18.45\n` })
    ).toMatchObject({ status: "not_generated" })
  expect(() => f.store.outputContracts.assertCanContinue(f.lease)).toThrow("多次")
  const failed = f.store.finish(f.lease, "failed", "validator paused")
  expect(failed.status).toBe("needs_review")
  const recovered = f.store.recover({
    id: failed.id,
    revision: failed.revision,
    decision: "resume",
    note: "Use the exact requested Chinese unit",
    effects: []
  })
  expect(recovered.status).toBe("queued")
  expect(f.store.steering.hasPending(f.run.id)).toBe(true)
  expect(f.store.db.exec("SELECT count(*) FROM bot_output_attempts")[0].values[0][0]).toBe(3)
})
it("does not relabel ordinary model failures, and cancellation wins over format incompleteness", async () => {
  const f = await fixture()
  expect(f.store.finish(f.lease, "failed", "provider offline")).toMatchObject({
    status: "failed",
    error: "provider offline"
  })
  const other = await fixture()
  other.store.cancel(other.run.id)
  expect(other.store.finish(other.lease, "cancelled", "Stopped").status).toBe("cancelled")
})
it("refuses success until all files satisfy the current authoritative declaration", async () => {
  const f = await fixture()
  const run = f.store.finish(f.lease, "succeeded", "Claimed done")
  expect(run).toMatchObject({
    status: "needs_review",
    error: expect.stringContaining("result.csv")
  })
})
it("uses human typed JSON requirements and fingerprints them in the send receipt", async () => {
  const f = await fixture("No structured file requested")
  f.store.finish(f.lease, "succeeded", "Done")
  const input = {
    nonce: "typed",
    conversationId: f.conversationId,
    text: "Deliver JSON",
    outputContract: {
      files: [
        {
          name: "result.json",
          kind: "json" as const,
          schema: { type: "object", required: ["ok"], properties: { ok: { const: true } } }
        }
      ]
    }
  }
  const receipt = f.store.send(input)
  expect(f.store.send(input)).toEqual(receipt)
  expect(() =>
    f.store.send({
      ...input,
      outputContract: { files: [{ name: "other.csv", kind: "csv", columns: ["x"] }] }
    })
  ).toThrow("标识")
  const active = f.store.claim("host", 300000)!
  expect(f.store.outputContracts.instructions(active.lease)).toContain('"ok"')
  expect(
    f.store.outputContracts.authorize(
      active.lease,
      "bad",
      "result.json",
      Buffer.from('{"ok":false}'),
      "bad-artifact"
    ).status
  ).toBe("not_generated")
})
it("returns a validated original with BOM and CRLF unchanged", async () => {
  const f = await fixture()
  const originalBytes = Buffer.from("\ufeffproject_id,amount万元\r\nA,18.45\r\n")
  const artifact = await f.files.publish(
    {
      id: "original",
      conversationId: f.conversationId,
      runId: f.run.id,
      name: "result.csv",
      mime: "text/csv",
      origin: "browser"
    },
    originalBytes,
    f.lease
  )
  const delivered = await f.invoke("existing", { file_id: artifact.id })
  expect(delivered.id).toBe(artifact.id)
  expect((await f.files.read(delivered.id)).bytes).toEqual(originalBytes)
  expect(f.store.finish(f.lease, "succeeded", "Original").status).toBe("succeeded")
})
it("does not infer requirements from ordinary file requests or selection quotes", async () => {
  const f = await fixture("交付 presentation.pptx 和九个源码文件")
  expect(f.store.outputContracts.instructions(f.lease)).toBeUndefined()
  expect(f.store.finish(f.lease, "succeeded", "Ordinary delivery path").status).toBe("succeeded")
})
it("does not count an old artifact after accepted human format steering", async () => {
  const f = await fixture()
  await f.invoke("original", right)
  const update = f.store.send({
    nonce: "steer",
    conversationId: f.conversationId,
    steerRunId: f.run.id,
    text: "交付 result.csv（project_id、amount元）"
  })
  expect(update.runIds).toEqual([f.run.id])
  f.store.db.run("UPDATE bot_steering SET accepted_at=? WHERE message_id=?", [
    Date.now(),
    update.messageId
  ])
  expect(f.store.outputContracts.instructions(f.lease)).toContain("amount元")
  expect(f.store.finish(f.lease, "succeeded", "Using old file").status).toBe("needs_review")
})
it("excludes explicitly selected quotation text from the authoritative declaration", async () => {
  const f = await fixture("请解释以下引用")
  const quote = "交付 result.csv（project_id、amount万元）"
  const id = f.sent.messageId
  f.store.transaction(() =>
    f.store.outputContracts.saveMessage(id, quote, undefined, [{ from: 0, to: quote.length }])
  )
  expect(
    f.store.db.exec("SELECT count(*) FROM bot_output_messages WHERE message_id=?", [id])[0]
      .values[0][0]
  ).toBe(0)
})
it("does not trust peer-authored messages even if a stale contract row exists", async () => {
  const f = await fixture("Unstructured task")
  f.store.db.run("INSERT INTO bot_output_messages VALUES(?,?,?)", [
    f.sent.messageId,
    "controlled-test",
    JSON.stringify({ files: [{ name: "result.csv", kind: "csv", columns: ["forged"] }] })
  ])
  f.store.db.run("UPDATE bot_messages SET sender='bot',bot_id=? WHERE id=?", [
    f.bot.id,
    f.sent.messageId
  ])
  expect(f.store.outputContracts.instructions(f.lease)).toBeUndefined()
})
it("refuses an older lease and a changed format between validation and publication", async () => {
  const f = await fixture()
  const bytes = Buffer.from(right.content)
  expect(
    f.store.outputContracts.authorize(f.lease, "pending", "result.csv", bytes, "pending").status
  ).toBe("validated")
  const update = f.store.send({
    nonce: "new-format",
    conversationId: f.conversationId,
    steerRunId: f.run.id,
    text: "交付 result.csv（project_id、amount元）"
  })
  f.store.db.run("UPDATE bot_steering SET accepted_at=? WHERE message_id=?", [
    Date.now(),
    update.messageId
  ])
  await expect(
    f.files.publish(
      {
        id: "pending",
        conversationId: f.conversationId,
        runId: f.run.id,
        name: "result.csv",
        mime: "text/csv"
      },
      bytes,
      f.lease
    )
  ).rejects.toMatchObject({ code: "output_contract_changed" })
  expect(f.store.artifacts(f.conversationId)).toEqual([])
  f.store.fenceOwner("host", "controlled restart")
  expect(() =>
    f.store.outputContracts.authorize(f.lease, "stale", "result.csv", bytes, "stale")
  ).toThrow()
})
it("clears a format pause when the same tool batch subsequently delivers all required files", async () => {
  const f = await fixture()
  for (const id of ["bad-a", "bad-b", "bad-c"]) await f.invoke(id, wrong)
  await f.invoke("fixed", right)
  expect(() => f.store.outputContracts.assertCanContinue(f.lease)).not.toThrow()
  expect(f.store.finish(f.lease, "succeeded", "Fixed before next model call").status).toBe(
    "succeeded"
  )
})
it("preserves a recorded validation across a real Store reopen", async () => {
  const f = await fixture()
  await f.invoke("before-restart", right)
  await f.files.close()
  f.store.close()
  const restored = new BotStore(join(f.dir, "bots.sqlite"))
  close.push(() => restored.close())
  expect(restored.finish(f.lease, "succeeded", "Already delivered").status).toBe("succeeded")
})

it("restoring an older pending completion preserves later deletion and cannot requeue the cancelled run", async () => {
  const f = await fixture()
  const artifact = await f.invoke("delivered", right)
  expect(() => f.store.outputContracts.assertComplete(f.lease)).not.toThrow()
  f.store.toolOnce(f.lease, BOT_SESSION_END_KEY, { event: "SessionEnd" }, () => ({
    content: "Already delivered"
  }))
  await f.files.close()
  f.store.close()
  const backup = (await executeBotBackup(f.dir, { action: "create", nonce: randomUUID() })).backup!
  const live = new BotStore(join(f.dir, "bots.sqlite"))
  try {
    expect(live.finish(f.lease, "succeeded", "Already delivered").status).toBe("succeeded")
    live.deleteArtifact({
      nonce: "delete-completed-original",
      conversationId: f.conversationId,
      id: artifact.id,
      sha256: artifact.sha256
    })
  } finally {
    live.close()
  }
  await executeBotBackup(f.dir, {
    action: "restore",
    nonce: randomUUID(),
    backup: { id: backup.id, sha256: backup.sha256 }
  })
  const restored = new BotStore(join(f.dir, "bots.sqlite"))
  close.push(() => restored.close())
  const run = restored.getRun(f.run.id)
  expect(run.status).toBe("cancelled")
  expect(() => restored.getArtifact(artifact.id)).toThrow("已删除")
  expect(restored.claim("replacement-host")).toBeNull()
  expect(() =>
    restored.recover({
      id: run.id,
      revision: run.revision,
      decision: "resume",
      note: "Do not replay a pre-restore turn",
      effects: []
    })
  ).toThrow("任务状态已变化")
})
