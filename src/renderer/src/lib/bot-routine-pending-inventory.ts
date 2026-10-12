export interface PendingRoutineOperation {
  kind: "save" | "run"
  id: string
}

/** Reuse the skill-save inventory: bounded identities only, no second persistent index. */
export function pendingRoutineOperations(botId: string): PendingRoutineOperation[] {
  if (localStorage.length > 4096) throw new Error("本机操作记录过多，请检查应用存储后重新打开。")
  const prefixes = [
    ["save", `bot-routine-pending:${botId}:`],
    ["run", `bot-routine-run-pending:${botId}:`]
  ] as const
  const operations: PendingRoutineOperation[] = []
  for (let index = 0; index < localStorage.length; index++) {
    const name = localStorage.key(index)
    if (!name) continue
    for (const [kind, prefix] of prefixes) {
      if (!name.startsWith(prefix)) continue
      const id = name.slice(prefix.length)
      if (kind === "save" && id === "new") continue
      if (!id || id.length > 160 || !/^[\w:.-]+$/.test(id))
        throw new Error("本机例程操作记录索引无法读取，请保留原记录并检查应用存储。")
      operations.push({ kind, id })
      if (operations.length > 64) throw new Error("待核对例程操作过多，请先处理现有记录。")
    }
  }
  return operations
}
