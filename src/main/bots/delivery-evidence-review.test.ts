import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { botDeliverFileTool } from "./deliver-file-tool"
import { writeBotModelSnapshot, readBotModelSnapshot } from "./model-config"
import {
  botDeliveryEvidenceReviewer,
  BOT_DELIVERY_EVIDENCE_PROMPT
} from "./delivery-evidence-review"
import type { BotRuntimeRequest } from "./host"
import type { EvidenceBinding } from "./delivery-evidence-store"
const model = vi.hoisted(() => ({
  bodies: [] as unknown[],
  bindings: [] as unknown[],
  response: "",
  content: "",
  calls: 0,
  finish: "stop"
}))
vi.mock("../models/model-factory", () => ({
  createConfiguredCmbModel: () => {
    const fixture = {
      bindTools(tools: unknown[], options: unknown) {
        model.bindings.push({ tools, options })
        return fixture
      },
      async *stream(messages: unknown[]) {
        model.calls++
        model.bodies.push(messages)
        if (model.content) yield { content: model.content }
        yield {
          content: "",
          // Production adapters expose the normalized fragments together with
          // their raw OpenAI-compatible envelope. Keep the fixture honest so
          // this suite exercises the same boundary validation as a real
          // provider response.
          additional_kwargs: {
            tool_calls: [
              {
                id: "fixture-verdict",
                index: 0,
                type: "function",
                function: {
                  name: "delivery_evidence_verdict",
                  arguments: model.response
                }
              }
            ]
          },
          tool_call_chunks: [
            {
              id: "fixture-verdict",
              name: "delivery_evidence_verdict",
              index: 0,
              args: model.response
            }
          ],
          response_metadata: { finish_reason: model.finish }
        }
      }
    }
    return fixture
  }
}))
const clean: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn()
  model.finish = "stop"
  model.calls = 0
  model.bodies = []
  model.bindings = []
  model.content = ""
  model.response = ""
})
async function fixture(
  task = "根据 records.csv 及 rule.txt 核算并交付 result.csv",
  original = "id,version,amount\nQ,1,9\nQ,2,3\n",
  originalName = "records.csv"
) {
  const directory = await mkdtemp(join(tmpdir(), "delivery-evidence-"))
  clean.push(() => rm(directory, { recursive: true, force: true }))
  const store = new BotStore(join(directory, "bots.sqlite"))
  clean.push(() => store.close())
  const files = new BotArtifacts(join(directory, "objects"), store)
  clean.push(() => files.close())
  await files.recover()
  const { bot, conversationId } = store.createBot({
    nonce: "bot",
    name: "Evidence"
  })
  const source = await files.publish(
    {
      id: "source",
      conversationId,
      runId: null,
      name: originalName,
      mime: "text/plain"
    },
    Buffer.from(original)
  )
  const rule = await files.publish(
    {
      id: "rule",
      conversationId,
      runId: null,
      name: "rule.txt",
      mime: "text/plain"
    },
    Buffer.from("每个 id 选择数值 version 最大的记录；金额保留原符号。")
  )
  const sent = store.send({
    nonce: "send",
    conversationId,
    text: task,
    attachments: [source.id, rule.id]
  })
  const claimed = store.claim("worker", 300000)!
  const request: BotRuntimeRequest = {
    ...claimed,
    bot,
    store,
    messages: store.messagesForRun(sent.runIds[0]),
    signal: new AbortController().signal
  }
  const modelFile = join(directory, "models.private")
  await writeBotModelSnapshot(modelFile, {
    version: 1,
    defaultRef: "test",
    models: [
      {
        id: "test",
        ref: "test",
        name: "Test",
        model: "test",
        apiKey: "test-only",
        baseUrl: "http://127.0.0.1:1/v1"
      }
    ]
  })
  const snapshot = await readBotModelSnapshot(modelFile)
  const review = botDeliveryEvidenceReviewer({
    request,
    files,
    modelFile,
    snapshot,
    config: snapshot.models[0],
    check: () => store.assertDispatch(claimed.lease)
  })
  const tool = botDeliverFileTool(request, files, () => store.assertDispatch(claimed.lease), review)
  const invoke = async (id: string, args: Record<string, unknown>) =>
    JSON.parse(
      String(
        (
          await tool.invoke({
            type: "tool_call",
            name: "deliver_file",
            id,
            args
          })
        ).content
      )
    )
  return {
    store,
    files,
    source,
    rule,
    request,
    invoke,
    ...claimed,
    conversationId,
    modelFile
  }
}
const pass = () =>
  (model.response = JSON.stringify({
    decision: "pass",
    finding: "原件记录和选择规则一致。"
  }))
const revise = () =>
  (model.response = JSON.stringify({
    decision: "revise",
    finding: "rule.txt 要求按 version 选取，候选取了 amount 最大值。"
  }))
it("checks original materials independently, caches identical bytes, and excludes hidden reasoning", async () => {
  const f = await fixture()
  revise()
  model.content = "<think>PRIVATE_REVIEW_REASONING</think>"
  const args = { name: "result.csv", content: "id,amount\nQ,9\n" }
  const result = await f.invoke("bad1", args)
  expect(result.status).toBe("not_generated")
  expect(f.store.artifacts(f.conversationId)).toHaveLength(2)
  expect(JSON.stringify(model.bodies)).toContain("每个 id 选择数值 version 最大")
  expect(JSON.stringify(model.bodies)).not.toContain("PRIVATE_REVIEW_REASONING")
  expect(JSON.stringify(result)).not.toContain("PRIVATE_REVIEW_REASONING")
  expect(await f.invoke("bad2", args)).toEqual(result)
  expect(model.calls).toBe(1)
  pass()
  const result2 = await f.invoke("fixed", {
    ...args,
    content: "id,amount\nQ,3\n"
  })
  expect((await f.files.read(result2.id)).bytes.toString()).toBe("id,amount\nQ,3\n")
  expect(f.store.finish(f.lease, "succeeded", "Delivered").status).toBe("succeeded")
})
it("supplies literal named fields beside complete original sources, without changing versions or amounts", async () => {
  const original = "id,version,amount\n001,10,-2.50\n001,2,9.00\n"
  const f = await fixture(undefined, original)
  pass()
  await f.invoke("named-fields", { name: "result.csv", content: "id,amount\n001,-2.50\n" })
  const messages = model.bodies[0] as { content: string }[]
  const payload = JSON.parse(messages[1].content)
  expect(
    payload.sources.find((source: { name: string }) => source.name === "records.csv")
  ).toMatchObject({
    text: original,
    table: {
      fields: ["id", "version", "amount"],
      records: [
        { record: 1, values: { id: "001", version: "10", amount: "-2.50" } },
        { record: 2, values: { id: "001", version: "2", amount: "9.00" } }
      ]
    }
  })
  expect(payload.candidate.table.records[0].values).toEqual({ id: "001", amount: "-2.50" })
  expect(
    payload.sources.find((source: { name: string }) => source.name === "rule.txt").table
  ).toBeUndefined()
  expect((await f.files.read(f.source.id)).bytes.toString()).toBe(original)
})
it("preserves original-file, ordinary code and non-data zero-review paths", async () => {
  const f = await fixture()
  pass()
  const result = await f.invoke("original", { file_id: f.source.id })
  expect(result.id).toBe(f.source.id)
  await f.invoke("code", {
    name: "program.ts",
    content: "export const value = 3"
  })
  expect(model.calls).toBe(0)
  const g = await fixture("写 README", "export const a=1", "source.ts")
  await g.invoke("readme", { name: "README.md", content: "Example" })
  expect(model.calls).toBe(0)
})
it("returns third failed ToolMessage before pause and preserves ledger on human resume", async () => {
  const f = await fixture()
  revise()
  for (const id of ["one", "two", "three"])
    expect((await f.invoke(id, { name: "result.csv", content: "id,amount\nQ,9\n" })).status).toBe(
      "not_generated"
    )
  expect(() => f.store.deliveryEvidence.assertCanContinue(f.lease)).toThrow("连续失败")
  expect(() => f.store.deliveryEvidence.repairableCompletionIssue(f.lease)).toThrow("连续失败")
  const stopped = f.store.finish(f.lease, "failed", "Review stopped")
  expect(stopped.status).toBe("needs_review")
  f.store.recover({
    id: stopped.id,
    revision: stopped.revision,
    decision: "resume",
    note: "按原件版本字段修正",
    effects: []
  })
  expect(f.store.steering.hasPending(f.run.id)).toBe(true)
  const human = f.store.messages(f.conversationId).filter((message) => message.sender === "user")
  expect(human.at(-1)?.text).toBe("按原件版本字段修正")
  expect(model.calls).toBe(1)
  expect(
    f.store.db.exec(
      "SELECT count(*) FROM bot_receipts WHERE nonce LIKE '%delivery-evidence:attempt:%'"
    )[0].values[0][0]
  ).toBe(3)
})
it("does not replay an interrupted review and explicitly marks large input not_reviewed", async () => {
  const f = await fixture()
  pass()
  const task = f.store.deliveryEvidence.task(f.run.id)!
  const binding: EvidenceBinding = {
    reviewProtocol: "test",
    epoch: f.store.dataEpoch(),
    task: task.key,
    model: "x",
    sources: [{ id: f.source.id, sha256: f.source.sha256 }],
    name: "result.csv",
    sha256: "a".repeat(64)
  }
  expect(f.store.deliveryEvidence.begin(f.lease, binding)).toBe(true)
  expect(f.store.deliveryEvidence.begin(f.lease, binding)).toBe(false)
  const big = await fixture("核算", "id,amount\n" + "A,1\n".repeat(9000))
  const result = await big.invoke("large", { name: "result.csv", content: "id,amount\nA,1" })
  expect(result.verification).toMatchObject({ status: "not_reviewed", coverage: "text_limit" })
  expect(model.calls).toBe(0)
  expect(() => big.store.deliveryEvidence.assertCanContinue(big.lease)).not.toThrow()
  expect(() => big.store.deliveryEvidence.assertComplete(big.lease)).not.toThrow()
  expect(
    big.store
      .messages(big.conversationId)
      .some((message) => message.text.includes("尚未自动核验内容"))
  ).toBe(true)
  await big.invoke("large", { name: "result.csv", content: "id,amount\nA,1" })
  expect(
    big.store
      .messages(big.conversationId)
      .filter((message) => message.text.includes("尚未自动核验内容"))
  ).toHaveLength(1)
})

it("does not reuse a cached verdict after the review protocol changes", async () => {
  const f = await fixture()
  const task = f.store.deliveryEvidence.task(f.run.id)!
  const base: EvidenceBinding = {
    reviewProtocol: "tool-v1",
    epoch: f.store.dataEpoch(),
    task: task.key,
    model: "x",
    sources: [{ id: f.source.id, sha256: f.source.sha256 }],
    name: "result.csv",
    sha256: "b".repeat(64)
  }
  f.store.deliveryEvidence.saveVerdict(f.lease, base, {
    decision: "uncertain",
    findings: ["旧协议未完成。"]
  })
  expect(f.store.deliveryEvidence.cached(f.lease, base)?.decision).toBe("uncertain")
  const upgraded = { ...base, reviewProtocol: "tool-v2-minimax-reasoning-split" }
  expect(f.store.deliveryEvidence.cached(f.lease, upgraded)).toBeUndefined()
  expect(f.store.deliveryEvidence.begin(f.lease, upgraded)).toBe(true)
})

it("opens bounded review windows only on formal recovery, preserving old starts and the lifetime ceiling", async () => {
  const f = await fixture()
  let lease = f.lease
  const binding = (index: number): EvidenceBinding => ({
    reviewProtocol: "window-test",
    epoch: f.store.dataEpoch(),
    task: f.store.deliveryEvidence.task(f.run.id)!.key,
    model: "fixture",
    sources: [{ id: f.source.id, sha256: f.source.sha256 }],
    name: "result.csv",
    sha256: index.toString(16).padStart(64, "0")
  })
  for (let window = 0; window < 4; window++) {
    const first = window * 12
    for (let index = first; index < first + 12; index++) {
      expect(f.store.deliveryEvidence.begin(lease, binding(index))).toBe(true)
      // Even within a new approved window, a started request cannot be replayed.
      expect(f.store.deliveryEvidence.begin(lease, binding(index))).toBe(false)
    }
    expect(f.store.deliveryEvidence.begin(lease, binding(first + 12))).toBe(false)
    f.store.deliveryEvidence.record(
      lease,
      `window-${window}`,
      `candidate-${window}`,
      binding(first),
      {
        decision: "uncertain",
        findings: ["Interrupted review remains uncertain."]
      }
    )
    const stopped = f.store.finish(lease, "failed", "Review window stopped")
    expect(stopped.status).toBe("needs_review")
    const recovery = {
      id: stopped.id,
      revision: stopped.revision,
      decision: "resume" as const,
      note: "人工核对后继续同一任务",
      effects: []
    }
    if (window < 3) {
      f.store.recover(recovery)
      lease = f.store.claim(`recovered-${window}`)!.lease
      await f.store.steering.queue(lease).take({
        threadId: lease.runId,
        ownerRunToken: `${lease.owner}:${lease.fence}`,
        appliedIds: f.store.steering.acceptedMessageIds(lease.runId),
        phase: "beforeModel"
      })
    } else {
      expect(() => f.store.recover(recovery)).toThrow("次数已达上限")
      expect(f.store.getRun(stopped.id).status).toBe("needs_review")
    }
  }
  expect(
    f.store.db.exec(
      "SELECT count(*) FROM bot_receipts WHERE nonce LIKE '%delivery-evidence:started:%'"
    )[0].values[0][0]
  ).toBe(48)
  expect(model.calls).toBe(0)
})

it("fences exact bytes and deleted source in the original publication transaction", async () => {
  const f = await fixture()
  pass()
  const task = f.store.deliveryEvidence.task(f.run.id)!,
    bytes = Buffer.from("id,amount\nQ,3\n")
  const binding: EvidenceBinding = {
    reviewProtocol: "test",
    epoch: f.store.dataEpoch(),
    task: task.key,
    model: "x",
    sources: [{ id: f.source.id, sha256: f.source.sha256 }],
    name: "result.csv",
    sha256: createHash("sha256").update(bytes).digest("hex")
  }
  f.store.deliveryEvidence.saveVerdict(f.lease, binding, {
    decision: "pass",
    findings: ["verified"]
  })
  f.store.deliveryEvidence.record(f.lease, "record", "out", binding, {
    decision: "pass",
    findings: ["verified"]
  })
  await expect(
    f.files.publish(
      {
        id: "out",
        name: "result.csv",
        runId: f.run.id,
        conversationId: f.conversationId,
        mime: "text/csv"
      },
      Buffer.from("wrong"),
      f.lease
    )
  ).rejects.toThrow("未通过原件核验")
  // Simulate a monotonic deletion observed during restored publication. The live
  // delete API correctly disallows removal while this run is active.
  f.store.transaction(() =>
    f.store.db.run("UPDATE bot_artifact_lifecycle SET deleted_at=? WHERE artifact_id=?", [
      f.store.now(),
      f.source.id
    ])
  )
  await expect(
    f.files.publish(
      {
        id: "out",
        name: "result.csv",
        runId: f.run.id,
        conversationId: f.conversationId,
        mime: "text/csv"
      },
      bytes,
      f.lease
    )
  ).rejects.toThrow()
  expect(f.store.artifacts(f.conversationId).some((a) => a.id === "out")).toBe(false)
})
it("does not treat pass as publication or final success after a failed check", async () => {
  const f = await fixture()
  revise()
  await f.invoke("bad", { name: "result.csv", content: "id,amount\nQ,9\n" })
  expect(() => f.store.deliveryEvidence.assertComplete(f.lease)).toThrow("尚未通过")
  expect(f.store.deliveryEvidence.repairableCompletionIssue(f.lease)).toContain("尚未通过")
  expect(f.store.finish(f.lease, "succeeded", "Claims done").status).toBe("needs_review")
})
it("has generic opposite selection-rule instructions without frozen case IDs or amounts", () => {
  expect(BOT_DELIVERY_EVIDENCE_PROMPT).toContain("human-requested value-max rule")
  expect(BOT_DELIVERY_EVIDENCE_PROMPT).toContain("matching named source field")
  expect(BOT_DELIVERY_EVIDENCE_PROMPT).toContain("return uncertain and identify the ambiguity")
  expect(BOT_DELIVERY_EVIDENCE_PROMPT).toContain("original rule phrase")
  expect(BOT_DELIVERY_EVIDENCE_PROMPT).toContain("no other drafts")
  for (const constant of ["P101", "18.45", "20.00", "review-policy.txt"])
    expect(BOT_DELIVERY_EVIDENCE_PROMPT).not.toContain(constant)
})

it("binds accepted human amendments to a new verdict and fences old publication", async () => {
  const f = await fixture()
  pass()
  const args = { name: "result.csv", content: "id,amount\nQ,3\n" }
  await f.invoke("initial", args)
  const task = f.store.deliveryEvidence.task(f.run.id)!.key
  f.store.send({
    nonce: "amend",
    conversationId: f.conversationId,
    steerRunId: f.run.id,
    text: "改为只选择金额大于 2 的记录，再交付同一文件。"
  })
  await f.store.steering.queue(f.lease).take({
    threadId: f.run.id,
    ownerRunToken: `${f.lease.owner}:${f.lease.fence}`,
    appliedIds: [],
    phase: "beforeModel"
  })
  expect(f.store.deliveryEvidence.task(f.run.id)!.key).not.toBe(task)
  expect(() => f.store.deliveryEvidence.assertComplete(f.lease)).toThrow("早于当前要求")
  expect(f.store.deliveryEvidence.repairableCompletionIssue(f.lease)).toContain("早于当前要求")
  await f.invoke("updated", args)
  expect(model.calls).toBe(2)
  expect(() => f.store.deliveryEvidence.assertComplete(f.lease)).not.toThrow()
  expect(f.store.deliveryEvidence.repairableCompletionIssue(f.lease)).toBeUndefined()
})
it("retains historical delivery completion after a later monotonic deletion", async () => {
  const f = await fixture()
  pass()
  const artifact = await f.invoke("good", { name: "result.csv", content: "id,amount\nQ,3\n" })
  f.store.transaction(() =>
    f.store.db.run("UPDATE bot_artifact_lifecycle SET deleted_at=? WHERE artifact_id IN (?,?)", [
      f.store.now(),
      f.source.id,
      artifact.id
    ])
  )
  expect(() => f.store.deliveryEvidence.assertComplete(f.lease)).toThrow("原件")
  expect(() => f.store.deliveryEvidence.repairableCompletionIssue(f.lease)).toThrow("原件")
  expect(() => f.store.deliveryEvidence.assertComplete(f.lease, true)).not.toThrow()
  expect(f.store.artifacts(f.conversationId).some((a) => a.id === artifact.id)).toBe(false)
})
it("rechecks a previously published original without rewriting its ID, bytes or legacy publication receipt", async () => {
  const f = await fixture()
  pass()
  const original = await f.invoke("original", { name: "result.csv", content: "id,amount\nQ,3\n" })
  const qualified = f.store.db.exec(
    "SELECT nonce,request_hash,response,created_at FROM bot_receipts WHERE nonce LIKE ?",
    [`tool:${f.run.id}:delivery-evidence:published:%`]
  )[0].values[0]
  const legacyKey = `tool:${f.run.id}:delivery-evidence:published:${createHash("sha256").update(JSON.stringify(original.id)).digest("hex")}`
  // Exact pre-fix schema69 shape; the new path must read it without a migration.
  f.store.transaction(() => {
    f.store.db.run("INSERT INTO bot_receipts VALUES(?,?,?,?)", [legacyKey, ...qualified.slice(1)])
    f.store.db.run("DELETE FROM bot_receipts WHERE nonce=?", [qualified[0]])
  })
  expect(() => f.store.deliveryEvidence.assertComplete(f.lease)).not.toThrow()
  f.store.send({
    nonce: "amend",
    conversationId: f.conversationId,
    steerRunId: f.run.id,
    text: "再次核对全部文件，保持金额原符号。"
  })
  await f.store.steering.queue(f.lease).take({
    threadId: f.run.id,
    ownerRunToken: `${f.lease.owner}:${f.lease.fence}`,
    appliedIds: [],
    phase: "beforeModel"
  })
  expect(f.store.deliveryEvidence.repairableCompletionIssue(f.lease)).toContain("早于当前要求")
  const delivered = await f.invoke("current-original", { file_id: original.id })
  expect(delivered).toEqual(original)
  expect((await f.files.read(delivered.id)).bytes.toString()).toBe("id,amount\nQ,3\n")
  expect(model.calls).toBe(2)
  expect(f.store.artifacts(f.conversationId).filter((a) => a.name === "result.csv")).toHaveLength(1)
  expect(
    f.store.db.exec("SELECT response FROM bot_receipts WHERE nonce=?", [legacyKey])[0].values[0][0]
  ).toBe(qualified[2])
  expect(() => f.store.deliveryEvidence.assertComplete(f.lease)).not.toThrow()
  // Same call replay does not create another review or attachment.
  expect(await f.invoke("current-original", { file_id: original.id })).toEqual(delivered)
  expect(model.calls).toBe(2)
})
it("cannot relabel a failed review as out of scope by enlarging or renaming the draft", async () => {
  const f = await fixture()
  revise()
  await f.invoke("bad", { name: "result.csv", content: "id,amount\nQ,9\n" })
  const enlarged = await f.invoke("large-bypass", {
    name: "alternative.csv",
    content: "id,amount\n" + "Q,9\n".repeat(9000)
  })
  expect(enlarged.status).toBe("not_generated")
  expect(enlarged.verification).toBeUndefined()
  expect(f.store.artifacts(f.conversationId).some((a) => a.name === "alternative.csv")).toBe(false)
  expect(model.calls).toBe(1)
})
it.each(["length", "stop"])(
  "rejects a non-complete or model-forged coverage verdict (%s)",
  async (finish) => {
    const f = await fixture()
    model.finish = finish
    model.response = JSON.stringify({
      decision: finish === "stop" ? "not_reviewed" : "pass",
      findings: ["Unverified"],
      ...(finish === "stop" ? { coverage: "text_limit" } : {})
    })
    const result = await f.invoke("untrusted-verdict", {
      name: "result.csv",
      content: "id,amount\nQ,9\n"
    })
    expect(result.status).toBe("not_generated")
    expect(f.store.artifacts(f.conversationId).some((a) => a.name === "result.csv")).toBe(false)
    expect(() => f.store.deliveryEvidence.assertCanContinue(f.lease)).toThrow("未能完成")
  }
)
it.each(["选择 version 最大的记录", "以 amount 最大的记录为准，替代 rule.txt 的 version 选择规则"])(
  "preserves the real human rule without substituting a fixed version policy: %s",
  async (rule) => {
    const f = await fixture(`依据 records.csv 核算：${rule}。交付 result.csv。`)
    pass()
    await f.invoke("review-rule", {
      name: "result.csv",
      content: `id,amount\nQ,${rule.startsWith("选择 version") ? 3 : 9}\n`
    })
    const payload = model.bodies.at(-1) as { content: string }[]
    expect(JSON.parse(payload[1].content).task[0].text).toContain(rule)
    expect(model.calls).toBe(1)
  }
)
it.each(["txt", "html"])(
  "does not publish an unresolved rejected CSV under an unchecked extension: %s",
  async (extension) => {
    const f = await fixture()
    revise()
    await f.invoke("bad", { name: "result.csv", content: "id,amount\nQ,9\n" })
    const result = await f.invoke("rename-bypass", {
      name: `result.${extension}`,
      content: "id,amount\nQ,9\n"
    })
    expect(result.status).toBe("not_generated")
    expect(f.store.artifacts(f.conversationId).some((a) => a.name === `result.${extension}`)).toBe(
      false
    )
    expect(model.calls).toBe(1)
  }
)
