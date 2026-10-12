import { useMemo, useState } from "react"
import { pendingRoutineOperations } from "@/lib/bot-routine-pending-inventory"
import { BotRoutineForm } from "./BotRoutineForm"
import { BotRoutineRunButton } from "./BotRoutineRunButton"

/** One opened original operation at a time; pending identities remain in their original storage. */
export function BotRoutinePendingRecovery({
  botId,
  dataEpoch,
  activeRoutineIds
}: {
  botId: string
  dataEpoch: string
  activeRoutineIds: string[]
}) {
  const identity = activeRoutineIds.join("\0")
  const [revision, setRevision] = useState(0)
  const [selection, setSelection] = useState("")
  const refresh = () => setRevision((value) => value + 1)
  const inventory = useMemo(() => {
    const active = new Set(identity ? identity.split("\0") : [])
    try {
      return {
        items: pendingRoutineOperations(botId).filter((item) => !active.has(item.id)),
        error: null
      }
    } catch (error) {
      return {
        items: [],
        error: error instanceof Error ? error.message : "无法读取原例程操作记录，请重新打开。"
      }
    }
    // localStorage is external to React; exact ACK/archive invalidates this bounded inventory.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, identity, revision])
  const selected =
    inventory.items.find((item) => `${item.kind}:${item.id}` === selection) ?? inventory.items[0]
  if (!selected && !inventory.error) return null
  return (
    <section
      aria-label="原例程的待核对操作"
      className="mb-4 space-y-3 rounded-xl border border-border/70 bg-muted/20 p-3"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium">
          待核对的原例程操作{inventory.items.length ? ` · ${inventory.items.length}` : ""}
        </h3>
        <p className="text-xs leading-5 text-muted-foreground">
          原例程已不在当前列表中。核对只使用原请求，不会创建替代例程或新任务。
        </p>
      </div>
      {inventory.error && (
        <p role="alert" className="text-xs text-destructive">
          {inventory.error}
        </p>
      )}
      {selected && (
        <>
          <label className="block space-y-1.5 text-xs text-muted-foreground">
            选择原例程操作
            <select
              aria-label="选择原例程操作"
              value={`${selected.kind}:${selected.id}`}
              onChange={(event) => {
                setSelection(event.target.value)
                refresh()
              }}
              className="w-full rounded-lg border bg-background px-3 py-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {inventory.items.map((item) => (
                <option key={`${item.kind}:${item.id}`} value={`${item.kind}:${item.id}`}>
                  {item.kind === "save" ? "保存记录" : "运行记录"} · {item.id}
                </option>
              ))}
            </select>
          </label>
          {selected.kind === "save" ? (
            <BotRoutineForm
              key={`save:${selected.id}:${dataEpoch}`}
              botId={botId}
              recoveryId={selected.id}
              idempotent
              onPendingCleared={refresh}
              onSaved={refresh}
            />
          ) : (
            <BotRoutineRunButton
              key={`run:${selected.id}:${dataEpoch}`}
              pendingTarget={{ botId, id: selected.id }}
              dataEpoch={dataEpoch}
              disabled={false}
              onPendingCleared={refresh}
            />
          )}
        </>
      )}
    </section>
  )
}
