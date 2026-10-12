import { afterEach, expect, it, vi } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { BotStore } from "./store"
import { BotWorkflowStore } from "./workflow-store"
import { readBotComputerHelp, writeBotComputerHelp } from "../../shared/bot-computer-help"
import { readBotSecretCard } from "../../shared/bot-secrets"
import { botTrackedWorkKey, type BotWorkPageRequest } from "../../shared/bot-work-pages"

const cleanup: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) close()
})
function fixture(path = ":memory:") {
  let now = 100_000
  const store = new BotStore(path, () => now)
  cleanup.push(() => store.close())
  const owner = store.createBot({ nonce: "owner", name: "Owner" }),
    other = store.createBot({ nonce: "other", name: "Other" })
  store.updateBot({
    id: other.bot.id,
    revision: other.bot.revision,
    hidden: true
  })
  const root = store.send({
    nonce: "root",
    conversationId: owner.conversationId,
    text: "Root"
  })
  store.cancel(root.runIds[0])
  const sent = store.send({
    nonce: "active",
    conversationId: owner.conversationId,
    text: "Active"
  })
  const parent = store.claim("host", 300_000)!
  const workflow = BotWorkflowStore.open(store, parent.lease, "workflow", {
    script:
      'export const meta={name:"Tests",description:"Bounded page contract"}; return "SECRET_SCRIPT";',
    maxConcurrency: 16,
    defaultModelId: "PRIVATE_MODEL",
    agentProfiles: [],
    authority: { private: "PRIVATE_AUTHORITY" }
  })
  const input = (index: number) => ({
    prompt: "PRIVATE_CHILD_PROMPT",
    agentIndex: index,
    toolStreamKey: `${"a".repeat(64)}_c${index}`,
    durableCallKey: `${"a".repeat(64)}_n${index}`,
    label: `Child ${index}`,
    phase: "check",
    shellAccess: "read_only" as const
  })
  const child = (index: number) =>
    store.workflowChildren.reserve(workflow, parent.lease, input(index))
  const claimChild = (index: number) =>
    store.workflowChildren.claim(workflow, parent.lease, input(index))
  const page = (
    scope: BotWorkPageRequest["scope"] = { kind: "workspace" },
    extra: Partial<BotWorkPageRequest> = {}
  ) =>
    store.workPages.openRuns(
      { hostId: "host-test", dataEpoch: "initial", scope, ...extra },
      "host-test"
    )
  return {
    store,
    owner,
    other,
    root,
    sent,
    parent,
    workflow,
    child,
    claimChild,
    page,
    clock: (value: number) => {
      now = value
    }
  }
}

it("server-pages every ordinary queued root and workflow child with exact counts and no raw bodies", () => {
  const f = fixture(),
    expected = new Set([f.parent.run.id])
  for (let index = 0; index < 47; index++)
    expected.add(
      f.store.send({
        nonce: `queue-${index}`,
        conversationId: f.owner.conversationId,
        text: `PRIVATE_ROOT ${index}`
      }).runIds[0]
    )
  for (let index = 0; index < 49; index++) expected.add(f.child(index).id)
  let before: BotWorkPageRequest["before"]
  const seen = new Set<string>()
  let requests = 0
  do {
    const page = f.page({ kind: "workspace" }, { before, limit: 7 })
    requests++
    expect(page.counts.total).toBe(expected.size)
    expect(page.items.length).toBeLessThanOrEqual(7)
    for (const run of page.items) {
      expect(seen.has(run.id)).toBe(false)
      seen.add(run.id)
      expect(run.projection).toBe("summary")
      expect(run.output).toBeUndefined()
      expect(run.result).toBeNull()
      expect(run.checkpoint).toBeNull()
    }
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|SECRET_/)
    before = page.next ?? undefined
  } while (before)
  expect(seen).toEqual(expected)
  expect(requests).toBe(Math.ceil(expected.size / 7))
  const modern = f.store.snapshot(
    {
      runProjection: "summary",
      workProjection: "paged",
      hostId: "host-test",
      dataEpoch: "initial",
      view: { conversationId: f.owner.conversationId }
    },
    "host-test"
  )
  expect(modern.bots.map((bot) => bot.id)).toContain(f.other.bot.id)
  expect(modern.runs.length).toBeLessThanOrEqual(4)
  expect(modern.interactions).toEqual([])
  expect(modern.work?.counts.total).toBe(expected.size)
  expect(modern.work?.selected?.counts.total).toBe(expected.size)
  expect(f.store.snapshot().runs).toHaveLength(expected.size)
  expect(f.store.snapshot({ runProjection: "summary" }).runs).toHaveLength(expected.size)
})

it("covers all five unfinished statuses, including cancelling and interrupted children", () => {
  const f = fixture()
  const states = ["queued", "running", "waiting_input", "cancelling", "needs_review"] as const
  const children = states.map((status, index) => {
    const run = f.child(index)
    f.store.db.run("UPDATE bot_runs SET status=? WHERE id=?", [status, run.id])
    return run.id
  })
  const page = f.page()
  for (let index = 0; index < states.length; index++)
    expect(page.items.find((run) => run.id === children[index])?.status).toBe(states[index])
  expect(page.counts).toMatchObject({
    total: 6,
    queued: 1,
    running: 2,
    waitingInput: 1,
    cancelling: 1,
    needsReview: 1
  })
})

it("keeps same-time and finished-anchor cursors in the exact Bot/main/branch scope", () => {
  const f = fixture()
  for (let index = 0; index < 8; index++)
    f.store.send({
      nonce: `tie-${index}`,
      conversationId: f.owner.conversationId,
      text: "tie"
    })
  const branch = f.store.send({
    nonce: "branch",
    conversationId: f.owner.conversationId,
    threadRootId: f.root.messageId,
    text: "PRIVATE_BRANCH"
  })
  const first = f.page(
    { kind: "conversation", conversationId: f.owner.conversationId },
    { limit: 2 }
  )
  expect(first.counts.total).toBe(9)
  expect(first.next).not.toBeNull()
  f.store.cancel(first.items.at(-1)!.id)
  const second = f.page(first.scope, { before: first.next!, limit: 2 })
  expect(second.items.every((run) => !first.items.some((old) => old.id === run.id))).toBe(true)
  const branchPage = f.page({
    kind: "conversation",
    conversationId: f.owner.conversationId,
    threadRootId: f.root.messageId
  })
  expect(branchPage.items.map((run) => run.id)).toEqual(branch.runIds)
  expect(branchPage.items[0].threadRootId).toBe(f.root.messageId)
  expect(() => f.page({ kind: "bot", botId: f.other.bot.id }, { before: first.next! })).toThrow()
  expect(() => f.page(branchPage.scope, { before: first.next! })).toThrow()
  expect(() =>
    f.page({
      kind: "conversation",
      conversationId: f.other.conversationId,
      threadRootId: f.root.messageId
    })
  ).toThrow()
  expect(() => f.page({ kind: "workspace" }, { hostId: "stale-host" })).toThrow()
})

it("pending pages are independent of run page membership and retain exact secret/approval/Help cards", () => {
  const f = fixture()
  for (let index = 0; index < 45; index++)
    f.store.send({
      nonce: `queue-${index}`,
      conversationId: f.owner.conversationId,
      text: "queued"
    })
  const cards = [
    {
      kind: "approval" as const,
      prompt: JSON.stringify({
        secretRequest: {
          version: 1,
          label: "Password",
          description: "PRIVATE_DESTINATION",
          botId: f.owner.bot.id,
          token: randomUUID(),
          origin: "https://example.test",
          path: "/",
          field: "password"
        }
      }),
      action: { kind: "secret", destination: "private" }
    },
    {
      kind: "approval" as const,
      prompt: "PRIVATE_EXACT_APPROVAL " + "a".repeat(20_000),
      action: { write: "exact-target" }
    },
    {
      kind: "question" as const,
      prompt: JSON.stringify({
        botComputerHelp: {
          version: 1,
          backend: "browser",
          instruction: "Sign in",
          reason: "auth",
          hostId: "host-test",
          dataEpoch: "initial",
          botId: f.owner.bot.id,
          runId: "placeholder",
          conversationId: f.owner.conversationId,
          generation: randomUUID(),
          runFence: 1,
          controlEpoch: 0
        }
      })
    }
  ]
  // The pending children must be outside the first page, including UUID ties.
  f.clock(100_001)
  const entries = cards.map((card, index) => {
    const child = f.claimChild(index)
    const actual =
      index === 2
        ? {
            ...card,
            prompt: writeBotComputerHelp({
              version: 1,
              backend: "browser",
              instruction: "Sign in",
              reason: "auth",
              hostId: "host-test",
              dataEpoch: "initial",
              botId: f.owner.bot.id,
              runId: child.run.id,
              conversationId: f.owner.conversationId,
              taskRunId: child.run.id,
              generation: randomUUID(),
              runFence: child.run.fence,
              controlEpoch: 0
            })
          }
        : card
    const item = f.store.requestInteraction(child.lease!, actual)
    return { run: child.run, item }
  })
  expect(readBotSecretCard(entries[0].item.prompt)).not.toBeNull()
  expect(readBotComputerHelp(entries[2].item.prompt)?.runId).toBe(entries[2].run.id)
  const firstRuns = f.page({ kind: "bot", botId: f.owner.bot.id }, { limit: 1 })
  expect(entries.every((entry) => !firstRuns.items.some((run) => run.id === entry.run.id))).toBe(
    true
  )
  const pending = f.store.workPages.pendingInteractions(
    {
      hostId: "host-test",
      dataEpoch: "initial",
      scope: { kind: "bot", botId: f.owner.bot.id },
      limit: 2
    },
    "host-test"
  )
  expect(pending.counts.pending).toBe(3)
  expect(pending.items).toHaveLength(2)
  expect(JSON.stringify(pending)).not.toMatch(/PRIVATE_|token|actionHash|prompt/)
  const second = f.store.workPages.pendingInteractions(
    {
      hostId: "host-test",
      dataEpoch: "initial",
      scope: pending.scope,
      before: pending.next!,
      limit: 2
    },
    "host-test"
  )
  const all = [...pending.items, ...second.items]
  expect(new Set(all.map((item) => item.id)).size).toBe(3)
  for (const entry of entries) {
    const detail = f.store.workPages.pendingCard(
      {
        hostId: "host-test",
        dataEpoch: "initial",
        conversationId: f.owner.conversationId,
        runId: entry.run.id,
        interactionId: entry.item.id,
        revision: entry.item.revision
      },
      "host-test"
    )
    expect(detail.interaction.prompt).toBe(entry.item.prompt)
    expect(detail.interaction.actionHash).toBe(entry.item.actionHash)
    const target = {
      kind: "interaction" as const,
      conversationId: f.owner.conversationId,
      runId: entry.run.id,
      interactionId: entry.item.id
    }
    const states = f.store.workPages.trackedWork(
      { hostId: "host-test", dataEpoch: "initial", targets: [target] },
      "host-test"
    )
    expect(states.items[0]).toMatchObject({
      key: botTrackedWorkKey(target),
      run: { id: entry.run.id },
      interaction: { id: entry.item.id, status: "pending" }
    })
  }
  expect(() =>
    f.store.workPages.pendingCard(
      {
        hostId: "host-test",
        dataEpoch: "initial",
        conversationId: f.other.conversationId,
        runId: entries[0].run.id,
        interactionId: entries[0].item.id,
        revision: 1
      },
      "host-test"
    )
  ).toThrow()
  f.store.answerInteraction({
    id: entries[1].item.id,
    revision: 1,
    answer: "reject"
  })
  expect(() =>
    f.store.workPages.pendingCard(
      {
        hostId: "host-test",
        dataEpoch: "initial",
        conversationId: f.owner.conversationId,
        runId: entries[1].run.id,
        interactionId: entries[1].item.id,
        revision: 1
      },
      "host-test"
    )
  ).toThrow()
})

it("rejects restored generations and expired cards without clearing unrelated tracked work", () => {
  const f = fixture()
  const child = f.claimChild(1)
  const item = f.store.requestInteraction(child.lease!, {
    kind: "question",
    prompt: "Exact question",
    expiresInMs: 1000
  })
  f.clock(101_001)
  const pending = f.store.workPages.pendingInteractions(
    { hostId: "host-test", dataEpoch: "initial", scope: { kind: "workspace" } },
    "host-test"
  )
  expect(pending.items[0].status).toBe("expired")
  expect(pending.counts).toMatchObject({ pending: 1, actionablePending: 0 })
  expect(() =>
    f.store.workPages.pendingCard(
      {
        hostId: "host-test",
        dataEpoch: "initial",
        conversationId: f.owner.conversationId,
        runId: child.run.id,
        interactionId: item.id,
        revision: 1
      },
      "host-test"
    )
  ).toThrow()
  f.store.db.run(
    "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','new-epoch','{}',?)",
    [101_001]
  )
  expect(() => f.page()).toThrow()
  expect(() =>
    f.store.workPages.trackedWork(
      {
        hostId: "host-test",
        dataEpoch: "initial",
        targets: [{ kind: "run", botId: f.owner.bot.id, runId: child.run.id }]
      },
      "host-test"
    )
  ).toThrow()
  expect(() =>
    f.store.snapshot(
      {
        runProjection: "summary",
        workProjection: "paged",
        hostId: "host-test",
        dataEpoch: "initial"
      },
      "host-test"
    )
  ).toThrow()
})

it("uses a pure SQLite read frame without reserving the writer lock or mixing counts", () => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-work-read-lock-"))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, "bots.sqlite"),
    f = fixture(path),
    writer = new DatabaseSync(path)
  cleanup.push(() => writer.close())
  writer.exec("PRAGMA busy_timeout=100")
  const before = f.page()
  f.store.readTransaction(() => {
    const pinned = f.page()
    expect(pinned.counts.total).toBe(before.counts.total)
    writer.exec("BEGIN IMMEDIATE")
    writer.prepare("UPDATE bot_runs SET status='cancelled' WHERE id=?").run(f.parent.run.id)
    writer.exec("COMMIT")
    expect(f.page().counts.total).toBe(before.counts.total)
  })
  expect(f.page().counts.total).toBe(before.counts.total - 1)
  expect(() => f.store.readTransaction(() => Promise.resolve())).toThrow("must be synchronous")
  expect(f.store.transaction(() => f.store.readTransaction(() => 123))).toBe(123)
})

it("uses the existing global partial keyset indexes rather than sorting full raw history", () => {
  const f = fixture()
  const runs = f.store.db.exec(
    "EXPLAIN QUERY PLAN SELECT id,created_at FROM bot_runs WHERE status NOT IN ('succeeded','failed','cancelled') AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT 21",
    [0, 0, ""]
  )[0]
  const gates = f.store.db.exec(
    "EXPLAIN QUERY PLAN SELECT id,created_at FROM bot_interactions WHERE status='pending' AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT 21",
    [0, 0, ""]
  )[0]
  expect(JSON.stringify(runs)).toContain("bot_run_open_projection")
  expect(JSON.stringify(gates)).toContain("bot_interaction_pending_projection")
})

it("seeks the actual workspace, Bot and conversation page queries through scoped indexes", () => {
  const f = fixture()
  for (let index = 0; index < 8; index++) f.child(index)
  for (const [scope, index] of [
    [{ kind: "workspace" } as const, "bot_run_open_projection"],
    [{ kind: "bot", botId: f.owner.bot.id } as const, "bot_primary_active_signal"],
    [
      { kind: "conversation", conversationId: f.owner.conversationId } as const,
      "bot_work_conversation_open"
    ]
  ] as const) {
    const first = f.page(scope, { limit: 2 })
    const statements = vi.spyOn(f.store.db, "prepare")
    f.page(scope, { before: first.next!, limit: 2 })
    const query = statements.mock.calls.find(
      ([sql]) => sql.startsWith("SELECT r.id,r.bot_id") && sql.includes("(r.created_at,r.id)>(?,?)")
    )!
    statements.mockRestore()
    expect(query).toBeDefined()
    const plan = f.store.db
      .exec(`EXPLAIN QUERY PLAN ${query[0]}`, query[1])[0]
      .values.map((row) => String(row[3]))
    expect(
      plan.some((step) => step.includes(`SEARCH r USING INDEX ${index}`)),
      JSON.stringify({ scope, index, plan })
    ).toBe(true)
    expect(plan.some((step) => step.includes("TEMP B-TREE"))).toBe(false)
  }
})

it("retains inactive card descriptors for inspection without exposing an actionable full card", () => {
  const f = fixture(),
    child = f.claimChild(0)
  const item = f.store.requestInteraction(child.lease!, {
    kind: "question",
    prompt: "Original",
    expiresInMs: 600_000
  })
  f.clock(400_001)
  const request = {
    hostId: "host-test",
    dataEpoch: "initial",
    scope: { kind: "workspace" as const }
  }
  const page = f.store.workPages.pendingInteractions(request, "host-test")
  expect(page.items.find((row) => row.id === item.id)?.status).toBe("expired")
  expect(page.counts).toMatchObject({ pending: 1, actionablePending: 0 })
  expect(() =>
    f.store.workPages.pendingCard(
      {
        hostId: "host-test",
        dataEpoch: "initial",
        conversationId: f.owner.conversationId,
        runId: child.run.id,
        interactionId: item.id,
        revision: item.revision
      },
      "host-test"
    )
  ).toThrow("此请求已结束")
})

it("tracks page-outside routine work and terminal exact tasks without inferring closure from absence", () => {
  const f = fixture(),
    routine = f.store.saveRoutine({
      botId: f.owner.bot.id,
      name: "Check",
      prompt: "Exact goal",
      timezone: "UTC",
      enabled: false,
      schedule: { kind: "event", topic: "changed" }
    })
  const target = { kind: "routine" as const, botId: f.owner.bot.id, routineId: routine.id }
  const exact = { kind: "run" as const, botId: f.owner.bot.id, runId: f.sent.runIds[0] }
  const read = () =>
    f.store.workPages.trackedWork(
      { hostId: "host-test", dataEpoch: "initial", targets: [target, exact] },
      "host-test"
    )
  expect(read().items[0].run).toBeNull()
  const run = f.store.runRoutine({ id: routine.id, nonce: "manual", revision: routine.revision })
  expect(read().items[0].run?.id).toBe(run.id)
  f.store.cancel(run.id)
  expect(read().items[0].run).toBeNull()
  f.store.cancel(f.sent.runIds[0])
  expect(read().items[1].run?.status).toBe("cancelling")
  f.store.finish(f.parent.lease, "cancelled", "")
  expect(read().items[1].run?.status).toBe("cancelled")
  expect(() =>
    f.store.workPages.trackedWork(
      { hostId: "host-test", dataEpoch: "initial", targets: [{ ...exact, botId: f.other.bot.id }] },
      "host-test"
    )
  ).toThrow("任务不属于当前 Bot")
  expect(() =>
    f.store.workPages.trackedWork(
      { hostId: "host-test", dataEpoch: "initial", targets: Array(65).fill(exact) },
      "host-test"
    )
  ).toThrow("任务状态地址无效")
})

it("selects one deterministic narrow persona per conversation with a single ranked SQL read", () => {
  const f = fixture(),
    statuses = ["queued", "running", "waiting_input", "cancelling", "needs_review"]
  const children = statuses.map((status, index) => {
    const child = f.child(index)
    f.store.db.run("UPDATE bot_runs SET status=? WHERE id=?", [status, child.id])
    f.store.db.run(
      "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('run.activity',?,?,?)",
      [child.id, JSON.stringify({ kind: "tool", description: `Representative ${status}` }), 100_000]
    )
    return child
  })
  const second = f.child(5)
  f.store.db.run("UPDATE bot_runs SET status='needs_review' WHERE id=?", [second.id])
  f.store.db.run(
    "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('run.activity',?,?,?)",
    [second.id, JSON.stringify({ kind: "tool", description: "Other tied representative" }), 100_000]
  )
  const expected = [children[4], second].sort((a, b) => a.id.localeCompare(b.id))[0]
  f.store.db.run(
    "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('run.output',?,'{\"characters\":9}',?)",
    [expected.id, 100_000]
  )
  for (let index = 0; index < 5; index++) {
    const created = f.store.createBot({ nonce: `other-${index}`, name: "Other active" })
    f.store.send({
      nonce: `other-task-${index}`,
      conversationId: created.conversationId,
      text: "PRIVATE_OMITTED"
    })
  }
  const queries = vi.spyOn(f.store.db, "prepare")
  const snapshot = f.store.snapshot(
    {
      runProjection: "summary",
      workProjection: "paged",
      hostId: "host-test",
      dataEpoch: "initial"
    },
    "host-test"
  )
  const persona = snapshot.work!.personas[f.owner.conversationId]
  expect(persona.status).toBe("needs_review")
  expect(persona.hasOutput).toBe(true)
  expect(persona.activity?.description).toBe(
    expected.id === children[4].id ? "Representative needs_review" : "Other tied representative"
  )
  expect(Object.keys(snapshot.work!.personas)).toHaveLength(6)
  const reads = queries.mock.calls.filter(([sql]) =>
    sql.includes("FROM ranked picked JOIN bot_runs")
  )
  expect(reads).toHaveLength(1)
  expect(reads[0][0]).not.toMatch(/r\.checkpoint|r\.result|bot_run_outputs/)
  expect(snapshot.runs).toEqual([])
  expect(JSON.stringify(snapshot.work)).not.toMatch(/PRIVATE_|SECRET_/)
})

it("advertises the complete host-bound projection through the production API while old reads stay exact", async () => {
  const f = fixture()
  for (let index = 0; index < 25; index++) f.child(index)
  const { BotHost } = await import("./host"),
    { createBotAPI } = await import("./rpc")
  const { readBotWorkspaceFrame } = await import("../../shared/bot-workspace-frame")
  const api = createBotAPI(new BotHost(f.store)),
    status = await api.status()
  expect(status.capabilities).toContain("work-pages-v1")
  const frame = await readBotWorkspaceFrame(api, { conversationId: f.owner.conversationId })
  expect(frame.snapshot.work?.projection).toBe("paged")
  expect(frame.snapshot.runs.length).toBeLessThanOrEqual(4)
  expect(frame.snapshot.interactions).toEqual([])
  const request = {
    hostId: status.hostId,
    dataEpoch: status.dataEpoch!,
    scope: { kind: "workspace" as const },
    limit: 7
  }
  expect((await api.openRuns(request)).items).toHaveLength(7)
  expect((await api.pendingInteractions(request)).items).toEqual([])
  expect(
    (await api.trackedWork({ hostId: status.hostId, dataEpoch: status.dataEpoch!, targets: [] }))
      .items
  ).toEqual([])
  expect((await api.snapshot()).runs).toHaveLength(26)
  expect((await api.snapshot({ runProjection: "summary" })).runs).toHaveLength(26)
  expect(
    (
      await api.notificationEvents({
        hostId: status.hostId,
        dataEpoch: status.dataEpoch!,
        after: frame.snapshot.cursor,
        through: frame.snapshot.cursor
      })
    ).events
  ).toEqual([])
})
