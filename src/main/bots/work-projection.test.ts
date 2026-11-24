import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"

const databases: NativeSqliteAdapter[] = []
afterEach(() => databases.splice(0).forEach((database) => database.close()))

function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  let time = 1000
  const store = new BotStore(db, () => ++time)
  const profile = { instructions: "", color: "#123456", modelRef: null }
  const owner = store.create({ ...profile, name: "Owner" })
  const other = store.create({ ...profile, name: "Other" })
  const works = Array.from({ length: 45 }, (_, index) => {
    const created = store.createWork({
      botId: owner.id,
      operationId: `work-${index}`,
      title: `Work ${index}`,
      goal: "Verify current work"
    })
    store.transition(created.task.id, "running")
    store.settle(created.task.id, "completed", null, "Initial result")
    return created
  })
  const peers = (["queued", "running", "waiting_user"] as const).map((state, index) => {
    const peer = store.create({ ...profile, name: `Peer ${index}` })
    const source = store.enqueue({
      botId: owner.id,
      workId: works[index].work.id,
      requestId: `follow-up-${index}`,
      message: "Get this work's peer result"
    })
    store.transition(source.id, "running")
    const child = store.delegate(source.id, peer.id, "Verify", `peer-${index}`)
    if (state !== "queued") store.transition(child.id, "running")
    if (state === "waiting_user") store.transition(child.id, "waiting_user")
    store.settle(source.id, "completed", null, "Waiting for peer")
    return child
  })
  return { db, store, owner, other, works, peers }
}

function addPrivateHistory(f: ReturnType<typeof fixture>, count: number) {
  for (let index = 0; index < count; index++) {
    const task = f.store.enqueue({
      botId: f.other.id,
      requestId: `unrelated-private-${index}`,
      message: "Unrelated private task"
    })
    f.store.transition(task.id, "running")
    f.store.settle(task.id, "completed", null, "Unrelated result")
  }
}

describe("work activity projection query boundaries", () => {
  it("seeks the existing family index for list, detail and summaries despite unrelated private history", () => {
    const f = fixture()
    addPrivateHistory(f, 2000)
    const queries: Array<Parameters<NativeSqliteAdapter["prepare"]>> = []
    const prepare = f.db.prepare.bind(f.db)
    const capture = vi.spyOn(f.db, "prepare").mockImplementation((sql, bindings) => {
      if (sql.includes("AS pending_peers")) queries.push([sql, bindings])
      return prepare(sql, bindings)
    })
    try {
      const first = f.store.listWorks(f.owner.id)
      expect(first.items).toHaveLength(40)
      expect(first.items.every(item => item.lastExecution?.state === "completed")).toBe(true)
      expect(first.nextCursor).not.toBeNull()
      expect(f.store.listWorks(f.owner.id, first.nextCursor!).items).toHaveLength(5)
      expect(f.store.getWork(f.owner.id, f.works[0].work.id).pendingPeers).toBe(1)
      const summaries = f.store.workSummaries(
        f.owner.id,
        f.works.slice(0, 3).map((entry) => entry.work.id)
      )
      const byId = new Map(summaries.map((item) => [item.id, item]))
      expect(f.works.slice(0, 3).map((entry) => byId.get(entry.work.id))).toMatchObject([
        { id: f.works[0].work.id, executionState: "queued", pendingPeers: 1 },
        { id: f.works[1].work.id, executionState: "running", pendingPeers: 1 },
        { id: f.works[2].work.id, executionState: "waiting_user", pendingPeers: 1 }
      ])
    } finally {
      capture.mockRestore()
    }
    expect(queries).toHaveLength(6)
    for (const [sql, bindings] of queries) {
      const plan = f.db
        .exec(`EXPLAIN QUERY PLAN ${sql}`, bindings)[0]
        .values.map((row) => String(row[3]))
      // Both correlated branches must seek one family/state, not scan work_id=NULL history.
      for (const alias of ["t", "p"]) {
        expect(
          plan.some(
            (detail) =>
              detail.startsWith(`SEARCH ${alias} USING INDEX bot_tasks_work_family`) &&
              detail.includes("<expr>=? AND state=?")
          )
        ).toBe(true)
      }
      expect(
        plan.some((detail) => detail.startsWith("SEARCH p USING INDEX bot_tasks_work_history"))
      ).toBe(false)
      // Workflow ownership also seeks exact source IDs; it must not scan unrelated task history.
      expect(plan.some(detail => detail.startsWith("SCAN wf_owner"))).toBe(false)
      expect(plan.some(detail => detail.includes("bot_workflow_refs_live"))).toBe(true)
      expect(plan.some(detail => detail.startsWith("SEARCH t USING INDEX bot_tasks_work_order") && detail.includes("work_id=?"))).toBe(true)
      expect(plan.some(detail => detail.startsWith("SCAN t"))).toBe(false)
      expect(plan.some(detail => detail.startsWith("SCAN x"))).toBe(false)
      expect(plan.some(detail => detail.startsWith("SEARCH t USING INDEX bot_tasks_injected"))).toBe(false)
      // Compare every projected field against the prior SQL, not only peer counts.
      const priorProjection = `(SELECT version FROM bot_activity a WHERE a.kind='work' AND a.id=w.id) AS activity_version,
      (SELECT attention_version FROM bot_activity a WHERE a.kind='work' AND a.id=w.id) AS attention_version,
      (SELECT seen_version FROM bot_activity a WHERE a.kind='work' AND a.id=w.id) AS seen_version,
      (SELECT updated_at FROM bot_activity a WHERE a.kind='work' AND a.id=w.id) AS activity_at,
      (SELECT preview FROM bot_activity a WHERE a.kind='work' AND a.id=w.id) AS activity_preview,
      (SELECT t.state FROM bot_tasks t WHERE t.work_id=w.id OR
        (json_extract(t.origin_json,'$.rootWorkId')=+w.id AND t.state IN ('queued','running','waiting_user'))
      ORDER BY CASE t.state WHEN 'waiting_user' THEN 0 WHEN 'running' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,
      t.created_at DESC,t.rowid DESC LIMIT 1) AS execution_state,
      (SELECT json_object('taskId',t.id,'state',t.state,'updatedAt',t.updated_at,'error',substr(t.error,1,1000))
        FROM bot_tasks t INDEXED BY bot_tasks_work_history WHERE t.work_id=w.id AND t.injected_into IS NULL
        ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1) AS last_execution,
      (SELECT COUNT(*) FROM bot_tasks p WHERE json_extract(p.origin_json,'$.rootWorkId')=+w.id
        AND p.work_id IS NULL AND p.state IN ('queued','running','waiting_user')) AS pending_peers,
      (EXISTS(SELECT 1 FROM bot_commands c LEFT JOIN bot_tasks p ON p.id=c.source_task_id
        WHERE (c.state='accepted' OR (c.pending_notification IS NOT NULL AND c.suppressed=0)) AND (c.thread_id=w.thread_id OR json_extract(p.origin_json,'$.rootWorkId')=w.id))
       OR EXISTS(SELECT 1 FROM bot_workflow_refs r WHERE r.retired_at IS NULL AND r.source_task_id IN (
         SELECT wf_owner.id FROM bot_tasks wf_owner WHERE wf_owner.work_id=w.id OR json_extract(wf_owner.origin_json,'$.rootWorkId')=+w.id
       ))) AS background_busy`
      const priorSql = sql.replace((f.store as any).workActivityProjection(), priorProjection)
      expect(priorSql).not.toBe(sql)
      const before = f.db.exec(priorSql, bindings)[0]
      const after = f.db.exec(sql, bindings)[0]
      const indices = before.columns.map(column => after.columns.indexOf(column))
      expect(indices).not.toContain(-1)
      expect(after.values.map(row => indices.map(index => row[index]))).toEqual(before.values)
    }
    expect(
      f.db.exec("SELECT typeof(+id),+id,id FROM bot_work_items WHERE id=?", [f.works[0].work.id])[0]
        .values[0]
    ).toEqual(["text", f.works[0].work.id, f.works[0].work.id])
  })

  it("keeps direct and peer command work in priority without admitting unrelated private commands", () => {
    const f = fixture()
    const direct = f.store.enqueue({ botId: f.owner.id, workId: f.works[4].work.id, requestId: "direct", message: "Run" })
    const unrelated = f.store.enqueue({ botId: f.other.id, requestId: "private", message: "Run privately" })
    for (const task of [direct, unrelated, f.peers[1]]) {
      if (task.state === "queued") f.store.transition(task.id, "running")
      f.store.acceptCommand(task.id, { id: `command-${task.id}`, threadId: task.threadId,
        command: "fixture", cwd: "/fixture", startedAt: 1 })
      f.store.settle(task.id, "completed", null, "Command running")
    }
    // Retire the other two peers so only background commands make these works active.
    for (const task of [f.peers[0], f.peers[2]]) {
      if (task.state === "queued") f.store.transition(task.id, "running")
      f.store.settle(task.id, "completed", null, "Done")
    }
    for (const work of f.works) f.db.run("UPDATE bot_activity SET seen_version=attention_version WHERE kind='work' AND id=?", [work.work.id])
    const page = f.store.listWorks(f.owner.id, undefined, "", "desktop")
    expect(new Set(page.priority.map(work => work.id))).toEqual(new Set([f.works[1].work.id, f.works[4].work.id]))
    expect(page.priority.every(work => work.backgroundBusy)).toBe(true)
    expect(f.store.listWorks(f.owner.id, undefined, "", "another-audience").priority).toEqual([])
    expect(f.store.listWorks(f.other.id).priority).toEqual([])
    // A completed command with an undelivered notification must still attract attention.
    f.db.run("UPDATE bot_commands SET state='completed',pending_notification='pending' WHERE id=?", [`command-${f.peers[1].id}`])
    expect(f.store.listWorks(f.owner.id).priority.map(work => work.id)).toContain(f.works[1].work.id)
    f.db.run("UPDATE bot_commands SET suppressed=1 WHERE id=?", [`command-${f.peers[1].id}`])
    expect(f.store.listWorks(f.owner.id).priority.map(work => work.id)).not.toContain(f.works[1].work.id)
  })

  it("preserves family state, owner and audience isolation as peers finish", () => {
    const f = fixture()
    const ids = f.works.slice(0, 3).map((entry) => entry.work.id)
    const all = f.store.listWorks(f.owner.id)
    expect(all.priority.filter((item) => ids.includes(item.id))).toHaveLength(3)
    const desktop = f.store.listWorks(f.owner.id, undefined, "", "desktop")
    expect(desktop.items).toEqual(all.items)
    expect(desktop.priority).toEqual(all.priority)
    expect(f.store.listWorks(f.owner.id, undefined, "", "another-audience").items).toEqual([])
    expect(f.store.listWorks(f.other.id).items).toEqual([])
    expect(() => f.store.getWork(f.other.id, ids[0])).toThrow("工作不属于")
    expect(() => f.store.workSummaries(f.other.id, ids)).toThrow("工作摘要不属于")
    expect(
      f.store.listWorks(f.owner.id, undefined, "Work 44").items.map((item) => item.id)
    ).toEqual([f.works[44].work.id])
    for (const peer of f.peers) {
      if (peer.state === "queued") f.store.transition(peer.id, "running")
      f.store.settle(peer.id, "completed", null, "Verified result")
    }
    expect(f.store.workSummaries(f.owner.id, ids).map((item) => item.pendingPeers)).toEqual([
      0, 0, 0
    ])
    expect(f.store.getWork(f.owner.id, f.works[44].work.id)).toMatchObject({
      state: "active",
      executionState: "completed",
      pendingPeers: 0
    })
  })

  it("paginates smaller prompt snapshots without omissions or extra database requests", () => {
    const f = fixture()
    const ids: string[] = []
    let cursor: string | undefined
    do {
      const page = f.store.listWorks(f.owner.id, cursor, "", "desktop", 8)
      expect(page.items.length).toBeLessThanOrEqual(8)
      ids.push(...page.items.map(item => item.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(ids).toHaveLength(45)
    expect(new Set(ids).size).toBe(45)
  })

  it("retains the newest primary outcome for same-millisecond turns without reading result bodies", () => {
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    databases.push(db)
    const store = new BotStore(db, () => 1000)
    const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
    const first = store.createWork({ botId: bot.id, operationId: "first", title: "Work", goal: "Start" })
    store.transition(first.task.id, "running")
    store.settle(first.task.id, "completed", null, "Old successful output")
    const next = store.enqueue({ botId: bot.id, workId: first.work.id, requestId: "next", message: "Continue" })
    store.transition(next.id, "running")
    store.settle(next.id, "failed", "Error ".repeat(400), "Large output ".repeat(10000))
    const current = store.getWork(bot.id, first.work.id)
    expect(current.lastExecution).toMatchObject({ taskId: next.id, state: "failed", updatedAt: 1000 })
    expect(current.lastExecution?.error).toHaveLength(1000)
    expect(JSON.stringify(current.lastExecution)).not.toContain("Large output")
  })
})
