import type { DatabaseSync } from "node:sqlite"

export function ensureThreadMessageFragmentStorage(
  run: (sql: string) => unknown,
  hasColumn: (table: string, column: string) => boolean
): void {
  if (!hasColumn("thread_messages", "fragment_generation")) {
    run("ALTER TABLE thread_messages ADD COLUMN fragment_generation TEXT NOT NULL DEFAULT ''")
  }
  if (!hasColumn("thread_message_fragments", "generation")) {
    run("ALTER TABLE thread_message_fragments ADD COLUMN generation TEXT NOT NULL DEFAULT ''")
  }
  run(`CREATE INDEX IF NOT EXISTS idx_thread_message_fragment_generation
    ON thread_message_fragments(thread_id, message_id, generation, fragment_id)`)
}

/** Restrict a fragment read or update to the version published by its message row. */
export function publishedThreadMessageFragmentsSql(fragment: string, message?: string): string {
  const generation = message ? `${message}.fragment_generation` : `(SELECT fragment_owner.fragment_generation
    FROM thread_messages AS fragment_owner WHERE fragment_owner.thread_id = ${fragment}.thread_id
    AND fragment_owner.message_id = ${fragment}.message_id)`
  return `${fragment}.generation = ${generation}`
}

const connections = new WeakMap<DatabaseSync, boolean>()

/** Read-only recovery can open a database before the application upgrades it. */
export function hasThreadMessageFragmentGenerations(database: DatabaseSync): boolean {
  const known = connections.get(database)
  if (known !== undefined) return known
  const supported = database.prepare("PRAGMA table_info(thread_message_fragments)").all()
    .some((column) => column.name === "generation")
  if (supported) connections.set(database, true)
  return supported
}
