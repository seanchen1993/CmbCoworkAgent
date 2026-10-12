import { BOT_SCHEMA_VERSION } from "./schema"
import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BotLocalToolGate } from "./local-tool-gate"
import { BotSharedWorkspace } from "./shared-workspace"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { BotHostLock } from "./host-lock"
import { createBotLocalToolAuthority } from "./local-tool-authority"
import { fenceBotCheckpointDatabase } from "./checkpoint-data"
import { BotDeletionLedger } from "./deletion-ledger"
import type { BotLocalToolAction } from "../../shared/bot-local-tool-permission"
const close: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of close.splice(0).reverse()) await fn()
})
const action: BotLocalToolAction = {
  kind: "run-command",
  workspace: "C:/projects/demo",
  target: "npm test",
  description: "运行项目测试",
  fingerprint: "b".repeat(64)
}
function fixture(path = ":memory:", ceiling: "always" | "ask" | "never" = "always") {
  let now = 1_800_000_000_000
  const store = new BotStore(path, () => now)
  close.push(() => store.close())
  store.localTools.bind(
    {
      target: { id: "a".repeat(64), label: "本机测试电脑", platform: "win32" },
      assertCurrent() {
        /* Fixture owns this target for its entire lifetime. */
      }
    },
    ceiling
  )
  const created = store.createBot({ nonce: "bot", name: "项目助手" })
  store.send({ nonce: "task", conversationId: created.conversationId, text: "运行测试" })
  const { lease, run } = store.claim("host")!
  const set = (choice: "always" | "ask" | "never", nonce = `policy:${Math.random()}`) => {
    const current = store.localTools.read()
    return store.localTools.change({
      targetId: current.target.id,
      dataEpoch: current.dataEpoch,
      revision: current.revision,
      choice,
      nonce
    })
  }
  const request = (id = "one", value = action) => store.localTools.request(lease, id, value)
  const submitted = new Map<string, unknown>()
  const answer = (
    id: string,
    resolution: "always" | "never" | "allow-once" | "deny",
    nonce = `answer:${id}`
  ) => {
    const item = store.getInteraction(id),
      current = store.localTools.read()
    const payload = submitted.get(nonce) ?? {
      id,
      revision: item.revision,
      targetId: current.target.id,
      dataEpoch: current.dataEpoch,
      resolution,
      nonce
    }
    submitted.set(nonce, payload)
    return store.localTools.resolve(payload)
  }
  return {
    store,
    lease,
    run,
    ...created,
    set,
    request,
    answer,
    advance(ms: number) {
      while (ms > 0) {
        const step = Math.min(ms, 5000)
        now += step
        ms -= step
        store.renew(lease)
      }
    }
  }
}
it("defaults ask, stamps ten minutes and ignores exact-command/independent automatic approval", () => {
  const f = fixture()
  const permit = f.request()
  expect(permit.decision).toBe("ask")
  const item = f.store.getInteraction(permit.interactionId!)
  expect(item.expiresAt - item.createdAt).toBe(600_000)
  expect(item.localProjectAccess).toMatchObject({
    target: { id: "a".repeat(64) },
    action: { kind: "run-command", target: "npm test" }
  })
  expect(item.review).toBeUndefined()
  expect(item.autoReview).toBeUndefined()
  expect(() => f.store.localTools.assertGranted(f.lease, permit.id)).toThrow(/拒绝|过期|撤销/)
  expect(() =>
    f.store.answerInteraction({ id: item.id, revision: item.revision, answer: "approve" })
  ).toThrow("明确选项")
})
it("allow once is exact to operation/run; repeating the same resolution nonce has no new writes", () => {
  const f = fixture(),
    p = f.request(),
    before = f.store.snapshot().cursor
  const answered = f.answer(p.interactionId!, "allow-once")
  expect(f.answer(p.interactionId!, "allow-once")).toEqual(answered)
  expect(f.store.snapshot().cursor).toBeGreaterThan(before)
  expect(f.store.localTools.read().choice).toBe("ask")
  f.store.localTools.assertGranted(f.lease, p.id, action)
  expect(() =>
    f.store.localTools.assertGranted(f.lease, p.id, { ...action, target: "npm run publish" })
  ).toThrow("操作")
  expect(f.request("two", { ...action, target: "npm run publish" }).decision).toBe("ask")
})
it.each(["ask", "never"] as const)(
  "revoking to %s invalidates answered not-yet-dispatched permits",
  (choice) => {
    const f = fixture(),
      p = f.request()
    f.answer(p.interactionId!, "allow-once")
    f.set(choice)
    expect(() => f.store.localTools.assertGranted(f.lease, p.id)).toThrow(/撤销|失效/)
    expect(f.store.getInteraction(p.interactionId!).status).toBe("answered")
  }
)
it("Never retires queued cards; changing to Always cannot resurrect a previously rejected action", () => {
  const f = fixture(),
    p = f.request()
  f.answer(p.interactionId!, "deny")
  f.set("always")
  expect(f.request().decision).toBe("deny")
  expect(() => f.store.localTools.assertGranted(f.lease, p.id)).toThrow()
  expect(f.request("fresh").decision).toBe("allow")
})
it("Always only admits local access: the existing shell action still asks", () => {
  const f = fixture()
  f.set("always")
  const permit = f.request()
  f.store.localTools.assertGranted(f.lease, permit.id)
  const exact = {
    shell: { command: "npm test", cwd: action.workspace, timeoutSeconds: 60, sandbox: "unelevated" }
  }
  expect(
    f.store.requestInteraction(f.lease, {
      kind: "approval",
      prompt: JSON.stringify(exact),
      action: exact
    }).status
  ).toBe("pending")
})
it.each(["ask", "never"] as const)("respects a stricter administrator ceiling %s", (ceiling) => {
  const f = fixture(":memory:", ceiling)
  f.set("always")
  expect(f.store.localTools.read()).toMatchObject({ choice: "always", effective: ceiling })
  expect(f.request().decision).toBe(ceiling === "never" ? "deny" : "ask")
})
it("expired unstarted permits require a fresh card and preserve the original card history", () => {
  const f = fixture(),
    p = f.request()
  f.answer(p.interactionId!, "allow-once")
  f.advance(600_001)
  expect(() => f.store.localTools.assertGranted(f.lease, p.id)).toThrow(/过期/)
  const next = f.request()
  expect(next.decision).toBe("ask")
  expect(next.interactionId).not.toBe(p.interactionId)
  expect(f.store.getInteraction(p.interactionId!).localProjectAccess).toBeDefined()
})
it("refuses wrong target/epoch/revision and different payload reused under one nonce", () => {
  const f = fixture(),
    policy = f.store.localTools.read()
  const input = {
    targetId: policy.target.id,
    dataEpoch: policy.dataEpoch,
    revision: policy.revision,
    nonce: "policy",
    choice: "always" as const
  }
  expect(() => f.store.localTools.change({ ...input, targetId: "c".repeat(64) })).toThrow("电脑")
  expect(() => f.store.localTools.change({ ...input, dataEpoch: "retired" })).toThrow("恢复")
  f.store.localTools.change(input)
  expect(() => f.store.localTools.change({ ...input, choice: "never" })).toThrow(/nonce|相同|标识/)
})
it("preserves a known completed effect receipt when permission is subsequently revoked", () => {
  const f = fixture()
  f.set("always")
  const effectAction = { browser: { op: "click", ref: "x" } }
  const a = f.store.requestInteraction(f.lease, {
    kind: "approval",
    prompt: "click",
    action: effectAction
  })
  f.store.answerInteraction({ id: a.id, revision: a.revision, answer: "approve" })
  f.store.beginEffect(f.lease, { id: "done", action: effectAction, approvalId: a.id })
  f.store.settleEffect(f.lease, "done", "succeeded", "done-once")
  f.set("never")
  expect(f.store.effectResult(f.lease, "done")).toMatchObject({
    status: "succeeded",
    result: "done-once"
  })
})
it("uses the existing physical installation identity across Host restart; root replacement changes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-local-authority-"))
  close.push(() => rmSync(root, { recursive: true, force: true }))
  const lock = BotHostLock.acquire(root)!,
    a = createBotLocalToolAuthority(root, lock)
  lock.release()
  const restarted = BotHostLock.acquire(root)!,
    b = createBotLocalToolAuthority(root, restarted)
  expect(a.target.id).toBe(b.target.id)
  restarted.release()
  await rename(root, `${root}.retained`)
  close.push(() => rmSync(`${root}.retained`, { recursive: true, force: true }))
  await mkdir(root)
  const replaced = BotHostLock.acquire(root)!,
    c = createBotLocalToolAuthority(root, replaced)
  expect(c.target.id).not.toBe(a.target.id)
  replaced.release()
})
it("backup restore resets prior Always while retaining safe readonly history", () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-local-restore-"))
  close.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "bots.sqlite"),
    f = fixture(path)
  f.set("always")
  f.store.close()
  close.pop()
  fenceBotCheckpointDatabase(path, "replacement", new BotDeletionLedger(join(root, "deletions")))
  const store = new BotStore(path)
  close.push(() => store.close())
  store.localTools.bind({
    target: { id: "a".repeat(64), label: "本机", platform: "win32" },
    assertCurrent() {
      /* Fixture owns this target for its entire lifetime. */
    }
  })
  expect(store.localTools.read().effective).toBe("ask")
})
it("an unbound physical authority fails closed", () => {
  const store = new BotStore(":memory:")
  close.push(() => store.close())
  expect(() => store.localTools.read()).toThrow("未配置")
})
it("only exempts the exact pinned managed directory; external and swapped project roots remain gated", async () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-local-gate-"))
  close.push(() => rmSync(root, { recursive: true, force: true }))
  await mkdir(join(root, "host"))
  const managed = await BotSharedWorkspace.open(join(root, "host"))
  const f = fixture()
  const request = {
    messages: [],
    store: f.store,
    lease: f.lease,
    run: f.run,
    bot: { ...f.bot, workspacePath: managed.path },
    signal: new AbortController().signal
  }
  expect(BotLocalToolGate.open(request, managed)).toBeUndefined()
  await mkdir(join(root, "external"))
  await writeFile(join(root, "external", "one.txt"), "private")
  const gate = BotLocalToolGate.open(
    { ...request, bot: { ...f.bot, workspacePath: join(root, "external") } },
    managed
  )!
  f.set("always")
  await gate.read()
  await rename(join(root, "external"), join(root, "external-retained"))
  await mkdir(join(root, "external"))
  expect(() => gate.assert()).toThrow("替换")
})

it("a queued native guard refuses a revoked permit before any physical write; completed receipts remain readonly", () => {
  const f = fixture()
  f.set("always")
  const read = f.request("read", { ...action, kind: "read-file", target: "project" }),
    command = f.request()
  const exact = {
    shell: {
      command: action.target,
      cwd: action.workspace,
      timeoutSeconds: 60,
      sandbox: "unelevated"
    }
  }
  const approval = f.store.requestInteraction(f.lease, {
    kind: "approval",
    prompt: "command",
    action: exact,
    expiresInMs: 3_600_000
  })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  f.store.localTools.bindEffect(f.lease, approval.id, read.id, command.id)
  f.store.beginEffect(f.lease, { id: "queued", action: exact, approvalId: approval.id })
  f.set("never")
  let physicalWrites = 0
  expect(() => {
    f.store.localTools.assertStartedEffect(f.lease, "queued")
    ++physicalWrites
  }).toThrow(/撤销|失效/)
  expect(physicalWrites).toBe(0)
  f.store.settleEffect(f.lease, "queued", "unknown", "not-dispatched")
  f.set("always")
  expect(f.request().decision).toBe("ask")
  expect(() => f.store.localTools.assertStartedEffect(f.lease, "queued")).toThrow()
})
it("only renews an exact original action binding before effect reservation", () => {
  const f = fixture(),
    readAction = { ...action, kind: "read-file" as const, target: "project" }
  const read = f.request("read", readAction)
  f.answer(read.interactionId!, "allow-once")
  const command = f.request()
  f.answer(command.interactionId!, "allow-once")
  const exact = {
    shell: {
      command: action.target,
      cwd: action.workspace,
      timeoutSeconds: 60,
      sandbox: "unelevated"
    }
  }
  const a = f.store.requestInteraction(f.lease, {
    kind: "approval",
    prompt: "command",
    action: exact,
    expiresInMs: 3_600_000
  })
  f.store.answerInteraction({ id: a.id, revision: a.revision, answer: "approve" })
  f.store.localTools.bindEffect(f.lease, a.id, read.id, command.id)
  f.advance(600_001)
  const read2 = f.request("read", readAction)
  f.answer(read2.interactionId!, "allow-once")
  const command2 = f.request()
  f.answer(command2.interactionId!, "allow-once")
  f.store.localTools.bindEffect(f.lease, a.id, read2.id, command2.id)
  f.store.beginEffect(f.lease, { id: "started", action: exact, approvalId: a.id })
  f.store.localTools.assertStartedEffect(f.lease, "started")
  f.advance(600_001)
  const read3 = f.request("read", readAction)
  f.answer(read3.interactionId!, "allow-once")
  const command3 = f.request()
  f.answer(command3.interactionId!, "allow-once")
  expect(() => f.store.localTools.bindEffect(f.lease, a.id, read3.id, command3.id)).toThrow(
    "开始执行"
  )
})

it("upgrades v51 without granting external project access or altering existing task history", () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-local-migration-"))
  close.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "bots.sqlite"),
    f = fixture(path),
    text = f.store.messages(f.conversationId).map((m) => m.text)
  f.store.db.run(
    "DROP TABLE bot_local_tool_effect_permits; DROP TABLE bot_local_tool_requests; DROP TABLE bot_local_tool_policy; UPDATE bot_schema SET version=51"
  )
  f.store.close()
  close.pop()
  const store = new BotStore(path)
  close.push(() => store.close())
  store.localTools.bind({
    target: { id: "a".repeat(64), label: "本机", platform: "win32" },
    assertCurrent() {
      /* Fixture owns this target for its entire lifetime. */
    }
  })
  expect(store.localTools.read().effective).toBe("ask")
  expect(store.messages(f.conversationId).map((m) => m.text)).toEqual(text)
  expect(Number(store.db.exec("SELECT version FROM bot_schema")[0].values[0][0])).toBe(
    BOT_SCHEMA_VERSION
  )
})

it("public authenticated RPC rejects old physical target ACK while Store receipt is readonly", async () => {
  const { randomBytes } = await import("node:crypto"),
    { BotHost } = await import("./host"),
    { BotRpcServer } = await import("./rpc"),
    { BotTransportClient } = await import("./transport-client")
  const root = mkdtempSync(join(tmpdir(), "cmb-local-rpc-"))
  close.push(() => rmSync(root, { recursive: true, force: true }))
  const f = fixture(),
    policy = f.store.localTools.read(),
    input = {
      nonce: "accepted-policy",
      targetId: policy.target.id,
      dataEpoch: policy.dataEpoch,
      revision: policy.revision,
      choice: "always" as const
    }
  const original = f.store.localTools.change(input),
    cursor = f.store.snapshot().cursor
  const host = new BotHost(f.store),
    token = randomBytes(32).toString("hex"),
    server = new BotRpcServer(host, token)
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cmb-local-${token.slice(0, 16)}`
      : join(root, "rpc.sock")
  await server.listen(socketPath)
  close.push(() => server.close())
  const client = new BotTransportClient({
    version: 1,
    hostId: host.id,
    pid: process.pid,
    socketPath,
    token
  })
  close.push(() => client.close())
  expect(await client.call("localToolPermission")).toMatchObject({ effective: "always" })
  // This mutable fixture alone emulates a physical authority replacement; the real
  // Host provider is frozen and replacement closes/reopens the Host (identity test above).
  policy.target.id = "c".repeat(64)
  await expect(client.call("changeLocalToolPermission", input)).rejects.toMatchObject({
    code: "local_computer_changed"
  })
  expect(f.store.localTools.change(input)).toMatchObject({
    choice: "always",
    target: { id: "a".repeat(64) }
  })
  expect(f.store.snapshot().cursor).toBe(cursor)
  expect(f.store.localTools.read().effective).toBe("ask")
  expect(original.choice).toBe("always")
})

it("revokes only live-run grants with indexed SQL while keeping thousands of completed allowed records", () => {
  const f = fixture()
  f.set("always")
  const read = f.request("historic-read", { ...action, kind: "read-file" }),
    grant = f.request("historic-command")
  const effectAction = { shell: { command: "npm test" } }
  const approval = f.store.requestInteraction(f.lease, {
    kind: "approval",
    prompt: "npm test",
    action: effectAction
  })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  f.store.localTools.bindEffect(f.lease, approval.id, read.id, grant.id)
  f.store.beginEffect(f.lease, {
    id: "historic-effect",
    action: effectAction,
    approvalId: approval.id
  })
  f.store.settleEffect(f.lease, "historic-effect", "succeeded", "original completed output")
  const historical = String(
    f.store.db.exec("SELECT record FROM bot_local_tool_requests WHERE id=?", [grant.id])[0]
      .values[0][0]
  )
  f.store.finish(f.lease, "succeeded", "done")
  f.set("ask")
  // Bulk evidence is based on a real completed run/allowed permit. Keep allowed
  // history too: indexing only retired/denied would miss the common case.
  f.store.db.run("UPDATE bot_local_tool_requests SET record=? WHERE id=?", [historical, grant.id])
  f.store.db.run(
    `WITH RECURSIVE seq(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<3000)
    INSERT INTO bot_local_tool_requests SELECT 'historical:'||x,?,'historical:'||x,NULL,
      CASE WHEN x<=2000 THEN ? ELSE json_set(?,'$.status',CASE WHEN x<=2500 THEN 'retired' ELSE 'denied' END) END,0 FROM seq`,
    [f.run.id, historical, historical]
  )
  f.store.send({
    nonce: "live-task",
    conversationId: f.conversationId,
    text: "continue current work"
  })
  const active = f.store.claim("host-live")!
  const liveAllowed = f.store.localTools.request(active.lease, "live-allowed", action)
  f.answer(liveAllowed.interactionId!, "allow-once")
  const livePending = f.store.localTools.request(active.lease, "live-pending", {
    ...action,
    target: "npm run check",
    fingerprint: "e".repeat(64)
  })
  const observed = vi.spyOn(f.store.db, "run")
  try {
    f.set("never")
    const statements = observed.mock.calls.filter(
      ([sql]) => sql.startsWith("UPDATE") && sql.includes("bot_local_tool_requests")
    )
    expect(statements).toHaveLength(2)
    const plans = statements.map(([sql, args]) =>
      f.store.db.exec(`EXPLAIN QUERY PLAN ${sql}`, args)[0].values.map((row) => String(row[3]))
    )
    const untouched = f.store.db.exec(
      "SELECT COUNT(*) FROM bot_local_tool_requests WHERE invocation LIKE 'historical:%' AND json_extract(record,'$.status')=CASE WHEN CAST(substr(invocation,12) AS INTEGER)<=2000 THEN 'allowed' WHEN CAST(substr(invocation,12) AS INTEGER)<=2500 THEN 'retired' ELSE 'denied' END"
    )[0].values[0][0]
    console.info(
      "[LocalPermission revoke plans]",
      JSON.stringify({ plans, historyRecords: 3000, historyUntouched: untouched })
    )
    for (const plan of plans) {
      expect(plan.join("\n")).toContain("bot_run_queue")
      expect(plan.join("\n")).toContain("bot_local_tool_active_requests")
      expect(plan.some((detail) => detail === "SCAN bot_local_tool_requests")).toBe(false)
    }
    expect(untouched).toBe(3000)
    expect(
      String(
        f.store.db.exec("SELECT record FROM bot_local_tool_requests WHERE id=?", [grant.id])[0]
          .values[0][0]
      )
    ).toBe(historical)
    expect(f.store.effects(f.run.id)).toMatchObject([
      { status: "succeeded", result: "original completed output" }
    ])
    expect(f.store.getInteraction(livePending.interactionId!).status).toBe("expired")
    expect(f.store.getInteraction(liveAllowed.interactionId!).status).toBe("answered")
    expect(() => f.store.localTools.assertGranted(active.lease, liveAllowed.id)).toThrow(
      /撤销|失效/
    )
  } finally {
    observed.mockRestore()
  }
})

it("renews only an unchanged explicit standing Always after its first permit expires", () => {
  const f = fixture(),
    original = f.request()
  f.answer(original.interactionId!, "always")
  const revision = f.store.localTools.read().revision
  f.advance(600_001)
  expect(() => f.store.localTools.assertGranted(f.lease, original.id)).toThrow(/过期/)
  const next = f.request()
  expect(next).toMatchObject({ decision: "allow", interactionId: null })
  expect(next.id).not.toBe(original.id)
  expect(f.store.localTools.read().revision).toBe(revision)
  f.store.localTools.assertGranted(f.lease, next.id, action)
  expect(f.store.getInteraction(original.interactionId!).answer).toBe("approve")
  expect(f.store.snapshot().interactions.filter((item) => item.status === "pending")).toEqual([])
  // A one-shot answer remains one-shot even when its current standing policy is
  // Always: a retired invocation must first be answered again explicitly.
  f.set("ask")
  f.set("always")
  const retired = f.request()
  expect(retired.decision).toBe("ask")
  f.answer(retired.interactionId!, "allow-once")
  f.advance(600_001)
  const onceExpired = f.request()
  expect(onceExpired.decision).toBe("ask")
  f.answer(onceExpired.interactionId!, "deny")
  f.set("always")
  expect(f.request().decision).toBe("deny")
})

it("upgrades v65 without inventing standing provenance and preserves the original record in its backup", () => {
  // Synthetic previous-record contract; this does not claim a frozen historic DB.
  const directory = mkdtempSync(join(tmpdir(), "cmb-local-standing-v65-")),
    path = join(directory, "bots.sqlite")
  close.push(() => rmSync(directory, { recursive: true, force: true }))
  const f = fixture(path),
    permit = f.request()
  f.answer(permit.interactionId!, "always")
  const current = JSON.parse(
    String(
      f.store.db.exec("SELECT record FROM bot_local_tool_requests WHERE id=?", [permit.id])[0]
        .values[0][0]
    )
  )
  delete current.standing
  delete current.standingUpgradeFromRevision
  current.expiresAt = 1_800_000_000_000 - 1
  const original = JSON.stringify(current),
    policy = f.store.localTools.read(),
    messages = f.store.messages(f.conversationId)
  f.store.db.run("UPDATE bot_local_tool_requests SET record=? WHERE id=?", [original, permit.id])
  f.store.db.run("UPDATE bot_schema SET version=65")
  f.store.close()
  close.pop()
  const reopened = new BotStore(path, () => 1_800_000_000_000)
  close.push(() => reopened.close())
  reopened.localTools.bind({
    target: { id: "a".repeat(64), label: "本机测试电脑", platform: "win32" },
    assertCurrent() {
      /* Synthetic fixture retains the same physical authority. */
    }
  })
  const readRecord = () =>
    String(
      reopened.db.exec("SELECT record FROM bot_local_tool_requests WHERE id=?", [permit.id])[0]
        .values[0][0]
    )
  expect(Number(reopened.db.exec("SELECT version FROM bot_schema")[0].values[0][0])).toBe(
    BOT_SCHEMA_VERSION
  )
  expect(BOT_SCHEMA_VERSION).toBeGreaterThan(65)
  expect(readRecord()).toBe(original)
  expect(reopened.messages(f.conversationId)).toEqual(messages)
  expect(reopened.localTools.read()).toEqual(policy)
  const backups = readdirSync(join(directory, "backups")).filter(
    (name) => name.startsWith("bots-v65-") && name.endsWith(".sqlite")
  )
  expect(backups).toHaveLength(1)
  const backup = new DatabaseSync(join(directory, "backups", backups[0]), { readOnly: true })
  try {
    expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(65)
    expect(
      backup.prepare("SELECT record FROM bot_local_tool_requests WHERE id=?").get(permit.id)?.record
    ).toBe(original)
  } finally {
    backup.close()
  }
  // The old record cannot prove whether approve meant Always or allow-once;
  // re-confirm even though the separate standing policy currently says Always.
  expect(reopened.localTools.request(f.lease, "one", action).decision).toBe("ask")
  expect(reopened.getInteraction(permit.interactionId!).answer).toBe("approve")
})

it("does not derive a read upgrade from settings Always or a prior retired read", () => {
  for (const cause of ["settings", "prior-retirement"] as const) {
    const f = fixture(),
      readAction = { ...action, kind: "read-file" as const, target: "project" },
      writeAction = {
        ...action,
        kind: "write-file" as const,
        target: "one.txt",
        fingerprint: "c".repeat(64)
      },
      read = f.request("read", readAction)
    f.answer(read.interactionId!, "allow-once")
    if (cause === "settings") f.set("always")
    else f.set("ask") // Retirement predates this mutation card's own upgrade.
    const mutation = f.request("write", writeAction)
    if (cause === "prior-retirement") f.answer(mutation.interactionId!, "always")
    f.store.localTools.assertGranted(f.lease, mutation.id, writeAction)
    expect(f.store.localTools.readUpgradeInvocation(f.lease, read.id, mutation.id)).toBeUndefined()
    expect(() => f.store.localTools.assertGranted(f.lease, read.id)).toThrow(/撤销|失效/)
    expect(f.store.getInteraction(read.interactionId!).answer).toBe("approve")
    expect(
      f.store.db.exec("SELECT COUNT(*) FROM bot_local_tool_effect_permits")[0].values[0][0]
    ).toBe(0)
  }
})
