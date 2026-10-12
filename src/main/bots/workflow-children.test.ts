import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { BotWorkflowStore, type BotWorkflowDefinition } from "./workflow-store"
import type { BotWorkflowChildInput } from "./workflow-children"
import { botWorkflowChildRunner } from "./workflow-child-runner"
import { botWorkflowChildAllows } from "./workflow-child-policy"

const stores: BotStore[] = [],
  roots: string[] = []
let now = 1_800_000_000_000
function open(path: string) {
  const store = new BotStore(path, () => now)
  stores.push(store)
  return store
}
const definition: BotWorkflowDefinition = {
  script: 'export const meta={name:"Review",description:"Review"}; return await agent("task");',
  maxConcurrency: 2,
  defaultModelId: "configured",
  agentProfiles: [],
  authority: { project: "test" }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bot-child-"))
  roots.push(root)
  const path = join(root, "bots.sqlite"),
    store = open(path)
  const bot = store.createBot({ nonce: "bot", name: "Developer" })
  store.send({ nonce: "task", conversationId: bot.conversationId, text: "Review project" })
  const parent = store.claim("host")!
  const workflow = BotWorkflowStore.open(store, parent.lease, "workflow", definition)
  return { store, path, root, bot, parent, workflow }
}
const input = (n = 0): BotWorkflowChildInput => ({
  prompt: "Review the source",
  agentIndex: n + 1,
  toolStreamKey: `${"a".repeat(64)}_c${n}`,
  durableCallKey: `${"a".repeat(64)}_n${n}`,
  label: `Review ${n}`,
  phase: null,
  shellAccess: "read_only"
})
const result = { text: "Evidence", structured: { passed: true }, outputTokens: 10 }

it("inherits the root task timezone when desktop settings change before a child starts", () => {
  const f = fixture()
  expect(f.store.runTimezone(f.parent.lease, "Asia/Shanghai")).toBe("Asia/Shanghai")
  const child = f.store.workflowChildren.claim(f.workflow, f.parent.lease, input())
  expect(f.store.runTimezone(child.lease!, "America/New_York", f.parent.lease)).toBe(
    "Asia/Shanghai"
  )
  expect(f.store.runTimezone(child.lease!, "UTC", f.parent.lease)).toBe("Asia/Shanghai")
})

it("keeps document/image viewing inside the child's existing file-read permission", () => {
  expect(botWorkflowChildAllows(input(), "project_view")).toBe(true)
  for (const denied of ["project_view", "project_read", "read_file"])
    expect(botWorkflowChildAllows({ ...input(), disallowedTools: [denied] }, "project_view")).toBe(
      false
    )
})

it("keeps connector resources inside the delegated role's existing connector restrictions", () => {
  const role = { ...input(), shellAccess: "full" as const }
  expect(botWorkflowChildAllows(role, "read_connector_resource")).toBe(true)
  expect(botWorkflowChildAllows(input(), "list_connector_resources")).toBe(true)
  expect(botWorkflowChildAllows(input(), "read_connector_resource")).toBe(false)
  for (const denied of [
    "read_connector_resource",
    "read_mcp_resource",
    "call_connector_tool",
    "invoke_deferred_tool"
  ])
    expect(
      botWorkflowChildAllows({ ...role, disallowedTools: [denied] }, "read_connector_resource")
    ).toBe(false)
  expect(
    botWorkflowChildAllows(
      { ...role, disallowedTools: ["search_tool"] },
      "list_connector_resources"
    )
  ).toBe(false)
})
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  now = 1_800_000_000_000
})

it.each(["queued", "succeeded"])(
  "replays legacy %s children with their frozen role policy after a Host upgrade",
  (status) => {
    const f = fixture()
    const original = { ...input(), roleSystemPrompt: "Read only role instructions" }
    const old = f.store.workflowChildren.reserve(f.workflow, f.parent.lease, original)
    if (status === "succeeded") {
      const active = f.store.workflowChildren.claim(f.workflow, f.parent.lease, original)
      f.store.workflowChildren.settle(active.lease!, "succeeded", result)
    }
    const addedName = { ...original, agentType: "Reviewer" }
    const replay = f.store.workflowChildren.claim(f.workflow, f.parent.lease, addedName)
    expect(replay.run.id).toBe(old.id)
    expect(replay.result).toEqual(status === "succeeded" ? result : null)
    expect(f.store.workflowChildren.metadata(old.id)!.input).toEqual(original)
    for (const changed of [
      { ...addedName, prompt: "Another task" },
      { ...addedName, shellAccess: "full" as const },
      { ...addedName, roleSystemPrompt: "Changed role instructions" }
    ])
      expect(() => f.store.workflowChildren.reserve(f.workflow, f.parent.lease, changed)).toThrow(
        "输入或权限已变化"
      )
  }
)

it("keeps role names bound for newly recorded children", () => {
  const f = fixture()
  f.store.workflowChildren.reserve(f.workflow, f.parent.lease, {
    ...input(),
    agentType: "Reviewer"
  })
  for (const agentType of ["Developer", undefined])
    expect(() =>
      f.store.workflowChildren.reserve(f.workflow, f.parent.lease, { ...input(), agentType })
    ).toThrow("输入或权限已变化")
})

it("targets one child's durable inbox without steering siblings or creating new tasks", async () => {
  const f = fixture(),
    a = f.store.workflowChildren.claim(f.workflow, f.parent.lease, input()),
    b = f.store.workflowChildren.claim(f.workflow, f.parent.lease, input(1))
  const command = {
    conversationId: f.bot.conversationId,
    runId: a.run.id,
    nonce: "child-input",
    threadRootId: undefined,
    revision: a.run.revision,
    operation: "message" as const,
    text: "Check the edge case"
  }
  const receipt = f.store.controlWorkflowChild(command)
  expect(f.store.controlWorkflowChild(command)).toEqual(receipt)
  expect(f.store.steering.hasPending(a.run.id)).toBe(true)
  expect(f.store.steering.hasPending(b.run.id)).toBe(false)
  expect(f.store.steering.hasPending(f.parent.run.id)).toBe(false)
  const queue = f.store.steering.queue(a.lease!)
  const take = {
    threadId: a.run.id,
    ownerRunToken: `${a.lease!.owner}:${a.lease!.fence}`,
    appliedIds: [] as string[],
    phase: "beforeModel" as const
  }
  f.store.workflowChildren.saveStructured(a.lease!, { passed: false })
  expect((await queue.take(take))[0].content).toContain("Check the edge case")
  expect(f.store.workflowChildren.readStructured(a.run.id)).toBeUndefined()
  expect(await queue.take({ ...take, appliedIds: [receipt.messageId!] })).toEqual([])
  expect(f.store.workflowChildren.settle(a.lease!, "succeeded", result).status).toBe("succeeded")
  expect(() =>
    f.store.controlWorkflowChild({
      ...command,
      nonce: "late",
      revision: f.store.getRun(a.run.id).revision
    })
  ).toThrow("消息未发送")
  expect(f.store.messages(f.bot.conversationId)).toHaveLength(2)
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_runs")[0].values[0][0]).toBe(3)
})

it("keeps an unconsumed final-race instruction for review instead of starting a standalone follow-up", () => {
  const f = fixture(),
    a = f.store.workflowChildren.claim(f.workflow, f.parent.lease, input())
  f.store.controlWorkflowChild({
    conversationId: f.bot.conversationId,
    runId: a.run.id,
    nonce: "late",
    revision: a.run.revision,
    operation: "message",
    text: "One more constraint"
  })
  expect(f.store.workflowChildren.settle(a.lease!, "succeeded", result)).toMatchObject({
    status: "needs_review",
    error: expect.stringContaining("补充要求")
  })
  expect(f.store.workflowChildren.metadata(a.run.id)!.result).toBeNull()
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_runs")[0].values[0][0]).toBe(2)
  expect(f.store.steering.hasPending(a.run.id)).toBe(true)
})

it("rejects stale and cross-conversation controls and cancels only the selected child", () => {
  const f = fixture(),
    a = f.store.workflowChildren.claim(f.workflow, f.parent.lease, input()),
    b = f.store.workflowChildren.claim(f.workflow, f.parent.lease, input(1))
  const command = {
    conversationId: f.bot.conversationId,
    runId: a.run.id,
    nonce: "stop",
    revision: a.run.revision,
    operation: "cancel" as const
  }
  const other = f.store.createBot({ nonce: "other", name: "Other" })
  expect(() =>
    f.store.controlWorkflowChild({ ...command, conversationId: other.conversationId })
  ).toThrow("当前对话")
  expect(() =>
    f.store.controlWorkflowChild({ ...command, revision: command.revision + 1 })
  ).toThrow("状态已变化")
  expect(f.store.controlWorkflowChild(command).status).toBe("cancelling")
  expect(f.store.controlWorkflowChild(command).status).toBe("cancelling")
  expect(f.store.getRun(b.run.id).status).toBe("running")
  expect(f.store.getRun(f.parent.run.id).status).toBe("running")
})

it("runs same-Bot children concurrently with independent approvals, checkpoints and durable results", () => {
  const f = fixture(),
    a = f.store.workflowChildren.claim(f.workflow, f.parent.lease, input()),
    b = f.store.workflowChildren.claim(f.workflow, f.parent.lease, input(1))
  expect(a.run.id).not.toBe(b.run.id)
  const first = f.store.requestInteraction(a.lease!, {
    kind: "approval",
    prompt: "Change a",
    action: "a"
  })
  const second = f.store.requestInteraction(b.lease!, {
    kind: "approval",
    prompt: "Change b",
    action: "b"
  })
  expect(f.store.getRun(f.parent.run.id).status).toBe("running")
  for (const card of [first, second])
    f.store.answerInteraction({ id: card.id, revision: card.revision, answer: "approve" })
  f.store.saveCheckpoint(a.lease!, "checkpoint-a")
  f.store.saveCheckpoint(b.lease!, "checkpoint-b")
  expect(f.store.getRun(f.parent.run.id).checkpoint).toBeNull()
  f.store.workflowChildren.settle(a.lease!, "succeeded", result)
  f.store.workflowChildren.settle(b.lease!, "succeeded", result)
  expect(f.store.messages(f.bot.conversationId)).toHaveLength(1)
  f.store.close()
  const next = open(f.path),
    workflow = BotWorkflowStore.open(next, f.parent.lease, "workflow", definition)
  const replay = next.workflowChildren.claim(workflow, f.parent.lease, {
    ...input(),
    agentIndex: 55,
    toolStreamKey: `${"a".repeat(64)}_c55`,
    label: "Reordered"
  })
  expect(replay.run.id).toBe(a.run.id)
  expect(replay.result).toEqual(result)
  expect(replay.lease).toBeNull()
  expect(() =>
    next.workflowChildren.claim(workflow, f.parent.lease, { ...input(), prompt: "different" })
  ).toThrow("输入或权限")
  expect(next.finish(f.parent.lease, "succeeded", "Both tasks verified").status).toBe("succeeded")
  expect(next.messages(f.bot.conversationId).at(-1)?.text).toBe("Both tasks verified")
})

it("requires children to settle before the parent can succeed and never independently claims a child", () => {
  const f = fixture(),
    child = f.store.workflowChildren.claim(f.workflow, f.parent.lease, input())
  f.store.send({ nonce: "next", conversationId: f.bot.conversationId, text: "Next task" })
  expect(f.store.claim("other-host")).toBeNull()
  expect(() => f.store.finish(child.lease!, "succeeded", "no receipt")).toThrow("结果收据")
  const parent = f.store.finish(f.parent.lease, "succeeded", "premature")
  expect(parent.status).toBe("needs_review")
  expect(() => f.store.assertDispatch(child.lease!)).toThrow("执行权已失效")
  expect(() =>
    f.store.recover({
      id: parent.id,
      revision: parent.revision,
      decision: "resume",
      note: "review",
      effects: []
    })
  ).toThrow("先核对子任务")
})

it("cancels children before new actions but allows a started effect to record its final receipt", () => {
  const f = fixture(),
    a = f.store.workflowChildren.claim(f.workflow, f.parent.lease, input()),
    b = f.store.workflowChildren.claim(f.workflow, f.parent.lease, input(1))
  const approval = f.store.requestInteraction(a.lease!, {
    kind: "approval",
    prompt: "write",
    action: "write"
  })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  f.store.beginEffect(a.lease!, { id: "write", action: "write", approvalId: approval.id })
  const question = f.store.requestInteraction(b.lease!, { kind: "question", prompt: "which file?" })
  f.store.cancel(f.parent.run.id)
  expect(f.store.getRun(a.run.id).status).toBe("cancelling")
  expect(f.store.getInteraction(question.id).status).toBe("cancelled")
  expect(() => f.store.assertDispatch(a.lease!)).toThrow("执行权已失效")
  f.store.settleEffect(a.lease!, "write", "succeeded", "committed")
  f.store.workflowChildren.settle(a.lease!, "cancelled", "stopped")
  f.store.workflowChildren.settle(b.lease!, "cancelled", "stopped")
  expect(f.store.finish(f.parent.lease, "cancelled", "stopped").status).toBe("cancelled")
  expect(f.store.effects(a.run.id)[0].status).toBe("succeeded")
})

it("requires individual recovery after Host interruption and preserves the child's original checkpoint", () => {
  const f = fixture(),
    child = f.store.workflowChildren.claim(f.workflow, f.parent.lease, input())
  f.store.saveCheckpoint(child.lease!, "child-checkpoint")
  f.store.recoverAbandonedAtStartup()
  const parent = f.store.getRun(f.parent.run.id),
    current = f.store.getRun(child.run.id)
  expect(() =>
    f.store.recover({
      id: parent.id,
      revision: parent.revision,
      decision: "resume",
      note: "review",
      effects: []
    })
  ).toThrow("先核对子任务")
  f.store.recover({
    id: current.id,
    revision: current.revision,
    decision: "resume",
    note: "No external operation",
    effects: []
  })
  expect(f.store.claim("host-new")).toBeNull()
  f.store.recover({
    id: parent.id,
    revision: parent.revision,
    decision: "resume",
    note: "Children reviewed",
    effects: []
  })
  const claimed = f.store.claim("host-new")!
  expect(claimed.run.id).toBe(parent.id)
  const workflow = BotWorkflowStore.open(f.store, claimed.lease, "workflow", definition)
  const resumed = f.store.workflowChildren.claim(workflow, claimed.lease, input())
  expect(resumed.run.id).toBe(child.run.id)
  expect(resumed.run.checkpoint).toBe("child-checkpoint")
  expect(() => f.store.saveCheckpoint(child.lease!, "late old write")).toThrow("执行权已失效")
  f.store.workflowChildren.settle(resumed.lease!, "succeeded", result)
})

it("does not let an old executor cancel or settle the replacement child lease", async () => {
  const f = fixture(),
    controller = new AbortController()
  const runner = botWorkflowChildRunner(
    {
      ...f.parent,
      store: f.store,
      bot: f.bot.bot,
      messages: [],
      signal: controller.signal
    },
    f.workflow,
    async ({ signal }) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
  )
  const execution = runner({ ...input(), signal: controller.signal })
  // Attach the rejection handler before revoking the old owner.
  const rejected = expect(execution).rejects.toThrow("old executor stopped")
  const child = f.store.workflowChildren.outstanding(f.parent.run.id)[0]
  f.store.recoverAbandonedAtStartup()
  for (const id of [child.id, f.parent.run.id]) {
    const current = f.store.getRun(id)
    f.store.recover({
      id,
      revision: current.revision,
      decision: "resume",
      note: "No external operation",
      effects: []
    })
  }
  const parent = f.store.claim("new-host")!
  const workflow = BotWorkflowStore.open(f.store, parent.lease, "workflow", definition)
  const replacement = f.store.workflowChildren.claim(workflow, parent.lease, input())
  controller.abort(new Error("old executor stopped"))
  await rejected
  expect(f.store.getRun(child.id)).toMatchObject({
    status: "running",
    fence: replacement.lease!.fence,
    leaseOwner: "new-host"
  })
  f.store.assertDispatch(replacement.lease!)
  f.store.workflowChildren.settle(replacement.lease!, "succeeded", result)
})

it("bounds renewals by parent ownership and rejects an old workflow generation", () => {
  const f = fixture(),
    child = f.store.workflowChildren.claim(f.workflow, f.parent.lease, input())
  now += 10_000
  f.store.renew(f.parent.lease)
  f.store.workflowChildren.renew(child.lease!)
  expect(f.store.getRun(child.run.id).leaseUntil).toBe(f.store.getRun(f.parent.run.id).leaseUntil)
  BotWorkflowStore.open(f.store, f.parent.lease, "workflow", definition)
  expect(() => f.store.assertDispatch(child.lease!)).toThrow("已被接替")
  expect(() => f.store.workflowChildren.renew(child.lease!)).toThrow("已被接替")
  now += 31_000
  expect(() => f.store.workflowChildren.settle(child.lease!, "succeeded", result)).toThrow(
    "执行权已失效"
  )
})

it.each([false, true])(
  "supervises every child heartbeat without rewriting an unchanged parent expiry (waiting=%s)",
  (waiting) => {
    const f = fixture()
    const child = f.store.workflowChildren.claim(f.workflow, f.parent.lease, input())
    if (waiting) f.store.requestInteraction(child.lease!, { kind: "question", prompt: "请选择" })
    const changes = () => Number(f.store.db.exec("SELECT total_changes()")[0].values[0][0])
    const before = changes()
    for (let tick = 1; tick <= 240; tick++) {
      now += 250
      if (tick % 40 === 0) f.store.renew(f.parent.lease)
      f.store.workflowChildren.renew(child.lease!)
      expect(f.store.getRun(child.run.id).leaseUntil).toBe(
        f.store.getRun(f.parent.run.id).leaseUntil
      )
    }
    // Six parent renewals and six matching child writes over a minute. All 240
    // callbacks still validate authority, including a later revoked generation.
    expect(changes() - before).toBe(12)
    f.store.renew(f.parent.lease, 5000)
    f.store.workflowChildren.renew(child.lease!)
    expect(f.store.getRun(child.run.id).leaseUntil).toBe(now + 5000)
    const row = f.store.getRun(child.run.id)
    BotWorkflowStore.open(f.store, f.parent.lease, "workflow", definition)
    expect(() => f.store.workflowChildren.renew(child.lease!)).toThrow()
    expect(f.store.getRun(child.run.id).leaseUntil).toBe(row.leaseUntil)
  }
)

it("rolls the structured receipt back if settling the run fails", () => {
  const f = fixture(),
    child = f.store.workflowChildren.claim(f.workflow, f.parent.lease, input())
  f.store.db.run(
    "CREATE TRIGGER reject_child_finish BEFORE UPDATE OF status ON bot_runs WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'disk write failure'); END"
  )
  expect(() => f.store.workflowChildren.settle(child.lease!, "succeeded", result)).toThrow(
    "disk write failure"
  )
  expect(f.store.workflowChildren.metadata(child.run.id)?.result).toBeNull()
  expect(f.store.getRun(child.run.id).status).toBe("running")
})

it("upgrades the v19 active-run constraint with a backup while preserving the user's running task", () => {
  const f = fixture()
  f.store.close()
  const db = new DatabaseSync(f.path)
  db.exec(`DROP TABLE bot_workflow_children; DROP INDEX bot_one_active_run;
    CREATE UNIQUE INDEX bot_one_active_run ON bot_runs(bot_id) WHERE status IN ('running','waiting_input','cancelling','needs_review');
    UPDATE bot_schema SET version=19;`)
  db.close()
  const next = open(f.path),
    workflow = BotWorkflowStore.open(next, f.parent.lease, "workflow", definition)
  expect(next.workflowChildren.claim(workflow, f.parent.lease, input()).run.status).toBe("running")
  expect(next.workflowChildren.claim(workflow, f.parent.lease, input(1)).run.status).toBe("running")
  expect(next.getRun(f.parent.run.id).status).toBe("running")
  expect(readdirSync(join(f.root, "backups")).some((name) => name.startsWith("bots-v19-"))).toBe(
    true
  )
})

it("keeps started group-child receipts alive during supersession without granting another dispatch", () => {
  const f = fixture()
  f.store.finish(f.parent.lease, "succeeded", "initial")
  const second = f.store.createBot({ nonce: "other", name: "Reviewer" })
  const group = f.store.createGroup({
    nonce: "group",
    name: "Review room",
    members: [f.bot.bot.id, second.bot.id]
  })
  f.store.send({ nonce: "group-task", conversationId: group.id, text: "Review release" })
  const parent = f.store.claim("group-host")!
  const workflow = BotWorkflowStore.open(f.store, parent.lease, "group-wf", definition)
  const child = f.store.workflowChildren.claim(workflow, parent.lease, input())
  const approval = f.store.requestInteraction(child.lease!, {
    kind: "approval",
    action: "submit",
    prompt: "submit"
  })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  f.store.beginEffect(child.lease!, { id: "submitted", action: "submit", approvalId: approval.id })
  f.store.send({ nonce: "group-next", conversationId: group.id, text: "Updated requirement" })
  expect(f.store.getRun(parent.run.id).status).toBe("running")
  expect(f.store.workflowChildren.isCollectingReceipt(child.run.id)).toBe(true)
  expect(() => f.store.assertDispatch(child.lease!)).toThrow()
  f.store.workflowChildren.renew(child.lease!)
  f.store.settleEffect(child.lease!, "submitted", "succeeded", "confirmed")
  expect(f.store.workflowChildren.isCollectingReceipt(child.run.id)).toBe(false)
  expect(f.store.workflowChildren.settle(child.lease!, "cancelled", "superseded").status).toBe(
    "cancelled"
  )
  expect(f.store.finish(parent.lease, "cancelled", "superseded").status).toBe("cancelled")
})

it("persists parent-origin instructions with exact ownership, deduplication and unchanged child grants", async () => {
  const f = fixture()
  const a = f.store.workflowChildren.claim(f.workflow, f.parent.lease, input())
  const b = f.store.workflowChildren.claim(f.workflow, f.parent.lease, input(1))
  const receipt = f.store.steerWorkflowChild(
    f.parent.lease,
    a.run.id,
    "Focus on null inputs",
    "parent-steer"
  )
  expect(
    f.store.steerWorkflowChild(f.parent.lease, a.run.id, "Focus on null inputs", "parent-steer")
  ).toEqual(receipt)
  expect(() =>
    f.store.steerWorkflowChild(f.parent.lease, a.run.id, "Different instruction", "parent-steer")
  ).toThrow()
  const message = f.store.message({ conversationId: f.bot.conversationId, id: receipt.messageId })
  expect(message.sender).toBe("bot")
  expect(f.store.steering.hasPending(b.run.id)).toBe(false)
  expect(f.store.workflowChildren.metadata(a.run.id)?.input.shellAccess).toBe("read_only")
  const delivered = await f.store.steering.queue(a.lease!).take({
    threadId: a.run.id,
    ownerRunToken: `${a.lease!.owner}:${a.lease!.fence}`,
    appliedIds: [],
    phase: "beforeModel"
  })
  expect(String(delivered[0].content)).toContain("not human authorization")
  expect(f.store.snapshot().interactions).toEqual([])
  const foreign = f.store.createBot({ nonce: "foreign", name: "Foreign" })
  f.store.send({
    nonce: "foreign-task",
    conversationId: foreign.conversationId,
    text: "Separate work"
  })
  const other = f.store.claim("other")!
  expect(() =>
    f.store.steerWorkflowChild(other.lease, a.run.id, "Steal task", "foreign-steer")
  ).toThrow("直接派发")
  expect(f.store.messages(f.bot.conversationId)).toHaveLength(2)
})

it("allows already-dispatched background children to continue while foreground instructions arrive", () => {
  const f = fixture()
  f.store.db.run("INSERT INTO bot_background_workflows VALUES(?,?,NULL)", [
    f.workflow.id,
    JSON.stringify(definition)
  ])
  const a = f.store.workflowChildren.claim(f.workflow, f.parent.lease, input())
  f.store.send({
    nonce: "new-input",
    conversationId: f.bot.conversationId,
    text: "Also inspect tests",
    steerRunId: f.parent.run.id
  })
  expect(f.store.steering.hasPending(f.parent.run.id)).toBe(true)
  expect(() => f.store.workflowChildren.renew(a.lease!)).not.toThrow()
  expect(() => f.store.assertDispatch(a.lease!)).not.toThrow()
  f.store.cancel(f.parent.run.id)
  expect(() => f.store.assertDispatch(a.lease!)).toThrow()
})
