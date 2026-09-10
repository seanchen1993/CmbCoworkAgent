import type { Database as SqlJsDatabase } from "sql.js"

export type ImSqlValue = string | number | Uint8Array | null

export interface ImPersistenceDependencies {
  getDatabase(): SqlJsDatabase
  markDirty(): void
  flushStrict(): Promise<void>
  now(): number
}

export function readOne<T extends object>(
  database: SqlJsDatabase,
  sql: string,
  params: ImSqlValue[] = []
): T | null {
  const statement = database.prepare(sql)
  statement.bind(params)
  try {
    if (!statement.step()) return null
    return statement.getAsObject() as unknown as T
  } finally {
    statement.free()
  }
}

export function readAll<T extends object>(
  database: SqlJsDatabase,
  sql: string,
  params: ImSqlValue[] = []
): T[] {
  const statement = database.prepare(sql)
  statement.bind(params)
  const rows: T[] = []
  try {
    while (statement.step()) rows.push(statement.getAsObject() as unknown as T)
  } finally {
    statement.free()
  }
  return rows
}

export function withImTransaction<T>(database: SqlJsDatabase, operation: () => T): T {
  database.run("BEGIN")
  try {
    const result = operation()
    database.run("COMMIT")
    return result
  } catch (error) {
    try {
      database.run("ROLLBACK")
    } catch {
      // Keep the original error.
    }
    throw error
  }
}
