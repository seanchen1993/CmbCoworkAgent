import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"

function rows(db: NativeSqliteAdapter, sql: string): Record<string, unknown>[] {
  const q = db.prepare(sql),
    result: Record<string, unknown>[] = []
  try {
    while (q.step()) result.push(q.getAsObject())
    return result
  } finally {
    q.free()
  }
}

/** Called inside the existing BotStore transaction; no new database or future-mode tables. */
export function upgradeWorkConversationSchema(db: NativeSqliteAdapter): void {
  let columns = rows(db, "PRAGMA table_info(bot_work_items)")
  if (!columns.some((v) => v.name === "conversation_json"))
    db.run("ALTER TABLE bot_work_items ADD COLUMN conversation_json TEXT")
  if (!columns.some((v) => v.name === "detached"))
    db.run("ALTER TABLE bot_work_items ADD COLUMN detached INTEGER NOT NULL DEFAULT 0")
  const original = String(
    rows(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name='bot_work_items'")[0]
      ?.sql ?? ""
  )
  const oldConstraint = /\bthread_id\s+TEXT\s+UNIQUE\s+NOT\s+NULL/i
  if (oldConstraint.test(original)) {
    // Copy every persisted column, including source and any additive known-to-the-database fields.
    // Keep all explicit indexes verbatim. A refusal rolls this entire migration back.
    columns = rows(db, "PRAGMA table_info(bot_work_items)")
    const names = columns.map((v) => String(v.name))
    if (names.some((name) => !/^\w+$/.test(name))) throw new Error("任务会话表字段无效，已停止升级")
    if (rows(db, "PRAGMA table_xinfo(bot_work_items)").some((v) => Number(v.hidden) !== 0))
      throw new Error("任务会话表含未知生成字段，已停止升级以保留数据")
    // DROP/RENAME can rewrite or cascade foreign references. Refuse an unknown extension
    // rather than silently dropping its constraints; the caller rolls back every ALTER.
    const tables = rows(db, "SELECT name FROM sqlite_master WHERE type='table'")
    for (const table of tables) {
      const name = String(table.name).replaceAll('"', '""')
      const foreign = rows(db, `PRAGMA foreign_key_list("${name}")`)
      if (foreign.some((v) => table.name === "bot_work_items" || v.table === "bot_work_items"))
        throw new Error("任务会话表含未知外键，已停止升级以保留约束")
    }
    const highWater = Number(
      rows(db, "SELECT seq FROM sqlite_sequence WHERE name='bot_work_items'")[0]?.seq ?? 0
    )
    if (!Number.isSafeInteger(highWater) || highWater < 0)
      throw new Error("任务会话序号无效，已停止升级")
    const triggers = rows(
      db,
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='bot_work_items'"
    ).map((v) => String(v.sql))
    const indexes = rows(
      db,
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='bot_work_items' AND sql IS NOT NULL"
    ).map((v) => String(v.sql))
    const schema = original
      .replace(
        /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"bot_work_items"|bot_work_items)/i,
        "CREATE TABLE bot_work_items_link_upgrade"
      )
      .replace(oldConstraint, "thread_id TEXT NOT NULL")
    if (schema === original || !schema.startsWith("CREATE TABLE bot_work_items_link_upgrade"))
      throw new Error("任务会话表结构无法安全升级")
    db.run(schema)
    const projection = names.map((name) => `"${name}"`).join(",")
    db.run(
      `INSERT INTO bot_work_items_link_upgrade (${projection}) SELECT ${projection} FROM bot_work_items`
    )
    db.run("DROP TABLE bot_work_items")
    db.run("ALTER TABLE bot_work_items_link_upgrade RENAME TO bot_work_items")
    // INSERT SELECT restores only the highest *remaining* ordinal. Preserve deleted
    // ordinals too: directory cursors must never observe a reused historical ordinal.
    db.run("DELETE FROM sqlite_sequence WHERE name='bot_work_items'")
    db.run("INSERT INTO sqlite_sequence(name,seq) VALUES('bot_work_items',?)", [highWater])
    for (const sql of indexes) db.run(sql)
    for (const sql of triggers) db.run(sql)
  }
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS bot_work_live_thread ON bot_work_items(thread_id) WHERE detached=0"
  )
}
