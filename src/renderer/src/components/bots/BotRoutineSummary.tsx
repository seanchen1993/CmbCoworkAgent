import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { ChevronRight, Clock } from "lucide-react"
import { toast } from "sonner"
import { Switch } from "@/components/ui/switch"
import { botApi } from "@/lib/bot-api"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import { isDefinitiveRoutineSaveError } from "@/lib/bot-routine-pending"
import { toggleBotRoutine, type BotRoutineOpenIntent } from "@/lib/bot-routine-toggle"
import { routineStatusLabel, needsFutureOnceSchedule } from "@/lib/bot-routine-presentation"
import { BotRoutineActions } from "./BotRoutineActions"
import type { BotRoutine } from "../../../../shared/bot-types"

const refreshInterval = 2000

/** A visible details summary. The original resource owner handles full cards,
 * editing and uncertain saves; no second routine cache or polling loop. */
export function BotRoutineSummary({
  botId,
  dataEpoch,
  active,
  open,
  manage
}: {
  botId: string
  dataEpoch: string
  active: boolean
  open(intent: BotRoutineOpenIntent): void
  manage(): void
}) {
  const visible = useBotViewVisibility()
  const enabled = active && visible
  const cursor = useBotWorkspaceStore((state) => state.snapshot?.cursor)
  const currentDataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch)
  const editorSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("routine-editor") ?? false
  )
  const readinessSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("routine-readiness-state") ?? false
  )
  const historySupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("routine-history") ?? false
  )
  const mutationSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("mutation-data-epoch-v2") ?? false
  )
  const [routines, setRoutines] = useState<BotRoutine[]>([])
  const [loaded, setLoaded] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const owner = useRef({ mounted: false, active: enabled, mutation: false })
  const reads = useRef<{
    sequence: number
    inFlight: boolean
    dirty: boolean
    lastStarted: number
    cursor?: number
    timer?: ReturnType<typeof setTimeout>
    request?: (immediate?: boolean) => void
  }>({ sequence: 0, inFlight: false, dirty: false, lastStarted: -Infinity })
  useLayoutEffect(() => {
    const lifetime = owner.current
    const requests = reads.current
    lifetime.mounted = true
    return () => {
      lifetime.mounted = false
      requests.sequence++
      clearTimeout(requests.timer)
      requests.request = undefined
    }
  }, [])
  useLayoutEffect(() => {
    owner.current.active = enabled
    // Do not expose the old revision while a covered view is becoming active.
    if (enabled) setLoaded(false)
  }, [enabled])
  const currentEpoch = () => useBotWorkspaceStore.getState().snapshot?.dataEpoch === dataEpoch
  const readableEpoch = () => {
    const snapshot = useBotWorkspaceStore.getState().snapshot
    return Boolean(snapshot && (snapshot.dataEpoch ?? "initial") === dataEpoch)
  }
  const live = () => owner.current.mounted && owner.current.active && currentEpoch()

  useEffect(() => {
    if (!enabled) return
    const state = reads.current
    const current = () => {
      const snapshot = useBotWorkspaceStore.getState().snapshot
      return (
        owner.current.mounted &&
        owner.current.active &&
        Boolean(snapshot && (snapshot.dataEpoch ?? "initial") === dataEpoch)
      )
    }
    const read = async () => {
      state.timer = undefined
      if (!current()) return
      if (state.inFlight) {
        state.dirty = true
        return
      }
      state.inFlight = true
      state.dirty = false
      state.lastStarted = performance.now()
      const sequence = ++state.sequence
      try {
        const items = await botApi.routines(botId)
        if (current() && sequence === state.sequence) {
          setRoutines(items)
          setLoaded(true)
          setFailure(null)
        }
      } catch (error) {
        if (current() && sequence === state.sequence)
          setFailure(error instanceof Error ? error.message : "例程读取失败")
      } finally {
        state.inFlight = false
        if (state.dirty) state.request?.()
      }
    }
    state.request = (immediate = false) => {
      if (!current()) return
      state.dirty = true
      if (immediate) {
        state.lastStarted = -Infinity
        clearTimeout(state.timer)
        state.timer = undefined
      }
      if (state.inFlight || state.timer) return
      const delay = Math.max(0, refreshInterval - (performance.now() - state.lastStarted))
      if (delay) state.timer = setTimeout(() => void read(), delay)
      else void read()
    }
    state.cursor = useBotWorkspaceStore.getState().snapshot?.cursor
    state.request(true)
    return () => {
      state.sequence++
      state.request = undefined
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }, [botId, dataEpoch, enabled])
  useEffect(() => {
    const state = reads.current
    if (state.cursor === cursor) return
    state.cursor = cursor
    state.request?.()
  }, [cursor])

  const toggle = async (routine: BotRoutine) => {
    if (!live() || owner.current.mutation) return
    owner.current.mutation = true
    setBusy(true)
    try {
      const saved = await toggleBotRoutine({
        botId,
        routine,
        dataEpoch,
        editorSupport,
        mutationSupport,
        readinessSupport,
        setup: () => open({ id: routine.id, dataEpoch, mode: "view" }),
        reschedule: () => open({ id: routine.id, dataEpoch, mode: "reschedule" }),
        isLive: live,
        isCurrentEpoch: currentEpoch,
        save: async (request) => {
          const saved = await botApi.saveRoutine(request)
          if (live())
            setRoutines((items) => items.map((item) => (item.id === saved.id ? saved : item)))
          return saved
        },
        recover: () => open({ id: routine.id, dataEpoch, mode: "recover" })
      })
      if (saved && currentEpoch()) {
        reads.current.request?.(true)
        await useBotWorkspaceStore.getState().refresh()
      }
    } catch (error) {
      if (live()) {
        if (isDefinitiveRoutineSaveError(error)) reads.current.request?.(true)
        toast.error(error instanceof Error ? error.message : "例程操作失败")
      }
    } finally {
      owner.current.mutation = false
      if (owner.current.mounted) setBusy(false)
    }
  }
  return (
    <section aria-label="例程" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Clock size={14} aria-hidden="true" />
          例程
        </h4>
        <button
          type="button"
          className="rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={manage}
        >
          管理
        </button>
      </div>
      {failure ? (
        <p role="alert" className="px-1 text-xs text-destructive">
          {failure}
        </p>
      ) : !loaded ? (
        <p role="status" className="px-1 py-2 text-xs text-muted-foreground">
          正在读取例程…
        </p>
      ) : routines.length === 0 ? (
        <button
          type="button"
          onClick={manage}
          className="w-full rounded-xl bg-muted/30 px-3 py-3 text-left text-xs text-muted-foreground hover:bg-muted/50"
        >
          添加例程，让 Bot 按计划处理重复工作
        </button>
      ) : (
        routines.map((routine) => (
          <BotRoutineActions
            key={`${dataEpoch}:${routine.id}`}
            routine={routine}
            dataEpoch={dataEpoch}
            busy={busy}
            mutationDisabled={
              busy ||
              !enabled ||
              currentDataEpoch !== dataEpoch ||
              !editorSupport ||
              !mutationSupport
            }
            readinessSupport={readinessSupport}
            view={() => {
              if (owner.current.mounted && owner.current.active && readableEpoch())
                open({ id: routine.id, dataEpoch, mode: "view" })
            }}
            editInChat={
              editorSupport && mutationSupport
                ? () => {
                    if (live()) open({ id: routine.id, dataEpoch, mode: "edit" })
                  }
                : undefined
            }
            history={
              historySupport
                ? () => {
                    if (live()) open({ id: routine.id, dataEpoch, mode: "history" })
                  }
                : undefined
            }
            remove={
              editorSupport && mutationSupport
                ? () => {
                    if (live()) open({ id: routine.id, dataEpoch, mode: "delete" })
                  }
                : undefined
            }
            toggle={() => void toggle(routine)}
          >
            {(more) => (
              <div className="flex items-center gap-3 rounded-xl border border-border/60 px-3.5 transition-colors hover:bg-muted/40 motion-reduce:transition-none">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`查看例程 ${routine.name}`}
                  onClick={() => {
                    if (owner.current.mounted && owner.current.active && readableEpoch())
                      open({ id: routine.id, dataEpoch, mode: "view" })
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {routine.name}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {routineStatusLabel(routine, readinessSupport)}
                    </span>
                  </span>
                  <ChevronRight
                    size={13}
                    className="shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </button>
                {more}
                <Switch
                  aria-label={`${needsFutureOnceSchedule(routine) ? "重新安排" : "启用"}例程 ${routine.name}`}
                  checked={
                    routine.enabled &&
                    !(readinessSupport && routine.effectiveState === "needs_setup")
                  }
                  disabled={
                    busy ||
                    !enabled ||
                    currentDataEpoch !== dataEpoch ||
                    !editorSupport ||
                    !mutationSupport
                  }
                  title={
                    !editorSupport || !mutationSupport ? "请更新 Bot 后台后调整例程" : undefined
                  }
                  onCheckedChange={() => void toggle(routine)}
                />
              </div>
            )}
          </BotRoutineActions>
        ))
      )}
    </section>
  )
}
