import { afterEach, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BotTeachStore } from "./teach-store"
import { BotTeachService } from "./teach-service"
import { LocalBotComputerProvider } from "./computer-provider"

const stores: BotStore[] = []
const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-teach-scope-"))
  const path = join(directory, "bots.sqlite")
  const store = new BotStore(path)
  stores.push(store)
  const a = store.createBot({ nonce: "a", name: "学习成员" })
  const b = store.createBot({ nonce: "b", name: "其他成员" })
  const group = store.createGroup({ nonce: "group", name: "协作", members: [a.bot.id, b.bot.id] })
  const root = store.send({ nonce: "discussion", conversationId: group.id, text: "原讨论" })
  const target = {
    botId: a.bot.id,
    generation: "original-generation",
    controlEpoch: 1,
    control: "bot" as const,
    viewId: "original-view"
  }
  const input = {
    expectedDataEpoch: store.dataEpoch(),
    botId: a.bot.id,
    conversationId: group.id,
    conversationRevision: group.revision,
    threadRootId: root.messageId,
    nonce: "start",
    target
  }
  return { directory, path, store, a, b, group, root, input, teach: new BotTeachStore(store) }
}
function rows(store: BotStore, sql: string) {
  const result = store.db.exec(sql)[0]
  return (
    result?.values.map((values) =>
      Object.fromEntries(result.columns.map((key, index) => [key, values[index]]))
    ) ?? []
  )
}
function queued(f: ReturnType<typeof fixture>) {
  let session = f.teach.create(f.input)
  f.teach.addFrame(session.id, {
    at: 1,
    sha256: "a".repeat(64),
    size: 10,
    url: "https://example.test",
    title: "Store scope fixture (not browser evidence)"
  })
  session = f.teach.update(session.id, session.revision, "finalizing")
  return f.teach.update(session.id, session.revision, "queued", {
    video: { size: 20, sha256: "b".repeat(64), mime: "video/webm" }
  })
}

it("binds the full normalized original Start, accepting reordered fields and refusing altered target or branch", () => {
  const f = fixture()
  const input = {
    ...f.input,
    conversationId: f.a.conversationId,
    threadRootId: undefined,
    conversationRevision: f.store.getConversation(f.a.conversationId).revision
  }
  const session = f.teach.create(input)
  expect(
    f.teach.create({
      ...input,
      target: {
        viewId: input.target.viewId,
        control: input.target.control,
        controlEpoch: input.target.controlEpoch,
        generation: input.target.generation,
        botId: input.target.botId
      }
    }).id
  ).toBe(session.id)
  expect(() =>
    f.teach.create({ ...input, target: { ...input.target, viewId: "different-view" } })
  ).toThrow(expect.objectContaining({ code: "nonce_conflict" }))
  expect(rows(f.store, "SELECT start_request FROM bot_teach_sessions")[0].start_request).toContain(
    "original-view"
  )
})

it("queues one user-priority learning run in the original group branch without replacing a discussion", () => {
  const f = fixture(),
    session = queued(f)
  const before = rows(f.store, "SELECT * FROM bot_group_cycles")
  const learning = f.teach.queue(session.id)
  expect(rows(f.store, "SELECT * FROM bot_group_cycles")).toEqual(before)
  const run = f.store.getRun(learning.learningRunId!)
  expect(run).toMatchObject({
    botId: f.a.bot.id,
    conversationId: f.group.id,
    threadRootId: f.root.messageId,
    lane: "user",
    source: "teach-learning"
  })
  expect(rows(f.store, "SELECT * FROM bot_group_runs").some((row) => row.run_id === run.id)).toBe(
    false
  )
  const claimed = f.store.claim("learning-owner")!
  expect(claimed.run.id).toBe(run.id)
  f.store.finish(claimed.lease, "succeeded", "Store publication fixture")
  expect(
    f.store
      .messages(f.group.id, undefined, 100, undefined, f.root.messageId)
      .filter((message) => message.runId === run.id)
      .map((message) => message.text)
  ).toEqual(["Store publication fixture"])
  expect(rows(f.store, "SELECT * FROM bot_group_cycles")).toEqual(before)
})

it("durably reopens the learning enqueue gap with the same message, run and original branch", () => {
  const f = fixture(),
    session = queued(f),
    learning = f.teach.queue(session.id)
  f.store.db.run("UPDATE bot_teach_sessions SET phase='queued',learning_run_id=NULL WHERE id=?", [
    session.id
  ])
  f.store.close()
  stores.splice(stores.indexOf(f.store), 1)
  const store = new BotStore(f.path)
  stores.push(store)
  const teach = new BotTeachStore(store)
  expect(teach.get(session.id).threadRootId).toBe(f.root.messageId)
  expect(teach.queue(session.id).learningRunId).toBe(learning.learningRunId)
  expect(store.messages(f.group.id, undefined, 100, undefined, f.root.messageId)).toHaveLength(1)
})

it("rejects stale workspace, stale group membership and cross-conversation branch before admission", () => {
  const f = fixture()
  expect(() => f.teach.create({ ...f.input, expectedDataEpoch: "wrong-workspace" })).toThrow(
    expect.objectContaining({ code: "data_epoch" })
  )
  const foreign = f.store.send({
    nonce: "foreign",
    conversationId: f.b.conversationId,
    text: "private root"
  })
  expect(() =>
    f.teach.create({ ...f.input, nonce: "foreign-root", threadRootId: foreign.messageId })
  ).toThrow(expect.objectContaining({ code: "thread_unavailable" }))
  f.store.updateGroup({
    ...f.group,
    description: "",
    nonce: "remove",
    members: [f.b.bot.id],
    expectedDataEpoch: f.store.dataEpoch()
  })
  expect(() => f.teach.create(f.input)).toThrow()
  expect(rows(f.store, "SELECT * FROM bot_teach_sessions")).toHaveLength(0)
})

it("withdraws new learning admission after a selected member is removed", () => {
  const f = fixture(),
    session = queued(f)
  f.store.updateGroup({
    ...f.group,
    description: "",
    nonce: "remove",
    members: [f.b.bot.id],
    expectedDataEpoch: f.store.dataEpoch()
  })
  const runs = rows(f.store, "SELECT id FROM bot_runs")
  expect(() => f.teach.queue(session.id)).toThrow()
  expect(rows(f.store, "SELECT id FROM bot_runs")).toEqual(runs)
  expect(f.teach.get(session.id).learningRunId).toBeNull()
})

it("uses a fresh human epoch and exact retry receipt without rewriting accepted Start authority", () => {
  const f = fixture(),
    session = queued(f)
  const failed = f.teach.update(session.id, session.revision, "failed")
  const original = rows(f.store, "SELECT start_request FROM bot_teach_sessions")[0].start_request
  f.store.db.run(
    "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','replacement','{}',?)",
    [f.store.now()]
  )
  const retry = {
    expectedDataEpoch: "replacement",
    id: session.id,
    revision: failed.revision,
    conversationRevision: f.group.revision,
    nonce: "retry"
  }
  expect(() => f.teach.retry({ ...retry, expectedDataEpoch: "initial" })).toThrow(
    expect.objectContaining({ code: "data_epoch" })
  )
  const learned = f.teach.retry(retry)
  expect(f.teach.retry(retry).learningRunId).toBe(learned.learningRunId)
  expect(() => f.teach.retry({ ...retry, conversationRevision: f.group.revision + 1 })).toThrow(
    expect.objectContaining({ code: "nonce_conflict" })
  )
  expect(rows(f.store, "SELECT start_request FROM bot_teach_sessions")[0].start_request).toBe(
    original
  )
  expect(rows(f.store, "SELECT learning_epoch FROM bot_teach_sessions")[0].learning_epoch).toBe(
    "replacement"
  )
})

it("requires current learning authorization at the original recording read boundary after a workspace epoch changes", () => {
  const f = fixture(),
    saved = queued(f),
    learning = f.teach.queue(saved.id)
  const claim = f.store.claim("learning-owner")!
  expect(claim.run.id).toBe(learning.learningRunId)
  expect(f.teach.authorizeRead(saved.id, claim.lease).id).toBe(saved.id)
  f.store.db.run(
    "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','replacement','{}',?)",
    [f.store.now()]
  )
  expect(() => f.teach.authorizeRead(saved.id, claim.lease)).toThrow(
    expect.objectContaining({ code: "data_epoch" })
  )
})

function legacyQueued(f: ReturnType<typeof fixture>) {
  let session = f.teach.create({
    nonce: "legacy-start",
    botId: f.a.bot.id,
    conversationId: f.a.conversationId
  })
  f.teach.addFrame(session.id, {
    at: 1,
    sha256: "a".repeat(64),
    size: 10,
    url: "https://example.test",
    title: "Legacy Store scope metadata, not physical browser proof"
  })
  session = f.teach.update(session.id, session.revision, "finalizing")
  return f.teach.update(session.id, session.revision, "queued", {
    video: { size: 20, sha256: "b".repeat(64), mime: "video/webm" }
  })
}
function restoredEpoch(f: ReturnType<typeof fixture>) {
  f.store.db.run(
    "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','replacement','{}',?)",
    [f.store.now()]
  )
}
it("refuses an old nullable queued recording after restore before creating any message or run", () => {
  const f = fixture(),
    session = legacyQueued(f),
    messages = rows(f.store, "SELECT * FROM bot_messages"),
    runs = rows(f.store, "SELECT * FROM bot_runs")
  restoredEpoch(f)
  expect(() => f.teach.queue(session.id)).toThrow(expect.objectContaining({ code: "data_epoch" }))
  expect(rows(f.store, "SELECT * FROM bot_messages")).toEqual(messages)
  expect(rows(f.store, "SELECT * FROM bot_runs")).toEqual(runs)
})
it("recovers a legacy queued recording only in its original initial epoch, and refuses restored automatic admission", () => {
  for (const restored of [false, true]) {
    const f = fixture(),
      session = legacyQueued(f),
      messages = rows(f.store, "SELECT * FROM bot_messages"),
      runs = rows(f.store, "SELECT * FROM bot_runs")
    if (restored) restoredEpoch(f)
    const computer = new LocalBotComputerProvider(join(f.directory, "unopened-browser")),
      service = new BotTeachService(join(f.directory, "teach"), f.store, computer)
    closes.push(
      () => computer.shutdown(),
      () => service.close()
    )
    service.recover()
    expect(service.repository.get(session.id).phase).toBe(restored ? "failed" : "learning")
    expect(rows(f.store, "SELECT * FROM bot_messages").length).toBe(
      messages.length + (restored ? 0 : 1)
    )
    expect(rows(f.store, "SELECT * FROM bot_runs").length).toBe(runs.length + (restored ? 0 : 1))
    expect(computer.status().state).toBe("stopped")
  }
})
it("does not infer an epoch for a modern Start whose durable learning authorization is missing", () => {
  const f = fixture(),
    session = queued(f)
  f.store.db.run("UPDATE bot_teach_sessions SET learning_epoch=NULL WHERE id=?", [session.id])
  expect(() => f.teach.assertLearningScope(f.teach.get(session.id))).toThrow(
    expect.objectContaining({ code: "teach_scope" })
  )
  expect(() => f.teach.queue(session.id)).toThrow(expect.objectContaining({ code: "teach_scope" }))
})
it("rechecks group membership and branch origin at the original learning read boundary", () => {
  for (const revoke of ["member", "branch"]) {
    const f = fixture(),
      session = queued(f),
      learning = f.teach.queue(session.id),
      claim = f.store.claim("learner")!
    expect(claim.run.id).toBe(learning.learningRunId)
    expect(f.teach.authorizeRead(session.id, claim.lease).id).toBe(session.id)
    if (revoke === "member")
      f.store.updateGroup({
        ...f.group,
        description: "",
        nonce: "remove-after-queue",
        expectedDataEpoch: f.store.dataEpoch(),
        members: [f.b.bot.id]
      })
    else
      f.store.db.run("UPDATE bot_messages SET conversation_id=? WHERE id=?", [
        f.b.conversationId,
        f.root.messageId
      ])
    expect(() => f.teach.authorizeRead(session.id, claim.lease)).toThrow(
      expect.objectContaining({ code: revoke === "member" ? "teach_scope" : "thread_unavailable" })
    )
  }
})
