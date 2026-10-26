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
      // Compare every projected field against the prior SQL, not only peer counts.
      const priorSql = sql.replaceAll("=+w.id", "=w.id")
      expect(f.db.exec(sql, bindings)).toEqual(f.db.exec(priorSql, bindings))
    }
    expect(
      f.db.exec("SELECT typeof(+id),+id,id FROM bot_work_items WHERE id=?", [f.works[0].work.id])[0]
        .values[0]
    ).toEqual(["text", f.works[0].work.id, f.works[0].work.id])
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
})
