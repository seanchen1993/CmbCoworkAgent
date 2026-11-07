import { useCallback, useEffect, useRef, type RefObject } from "react"
import type { ModObject } from "../../../shared/mods/types"
import type { FunctionPaneSnapshot } from "../../../shared/mods/v2/ui"

interface Observation {
  open: string | undefined
  plugin: string
  value?: ModObject
  running: boolean
  waitingForSnapshot?: FunctionPaneSnapshot[]
  frame?: number
}

export type FunctionPaneObservationResult = "applied" | "stale" | "failed"

const clamp = (value: number): number =>
  Number.isFinite(value) ? Math.max(-100000, Math.min(100000, value)) : 0

/** Wheel events observe native scrolling. Never replay them as control clicks on an old drawing. */
export function useFunctionPaneWheel(
  threadId: string,
  panes: FunctionPaneSnapshot[],
  current: RefObject<FunctionPaneSnapshot[]>,
  send: (pane: FunctionPaneSnapshot, value: ModObject) => Promise<FunctionPaneObservationResult>
): (pane: FunctionPaneSnapshot, value: ModObject) => void {
  const observations = useRef(new Map<string, Observation>())
  const sender = useRef(send)
  sender.current = send
  const schedule = useCallback(
    function schedule(key: string, observation: Observation) {
      if (observation.running || observation.frame !== undefined || !observation.value) return
      observation.frame = requestAnimationFrame(() => {
        observation.frame = undefined
        if (observations.current.get(key) !== observation || observation.running) return
        const pane = current.current.find((row) => row.key === key)
        if (
          !pane ||
          pane.openRequestId !== observation.open ||
          pane.plugin !== observation.plugin
        ) {
          observations.current.delete(key)
          return
        }
        // Wait for the refreshed snapshot after each observation. It may keep the same generation
        // when no scroll handler changed the drawing, so generation alone cannot acknowledge it.
        if (observation.waitingForSnapshot === current.current) return
        const value = observation.value
        if (!value) return
        observation.value = undefined
        observation.running = true
        const failed = () => {
          // No native redraw is promised after failure. Drop this burst without replaying it;
          // a new user wheel event can try again instead of waiting forever for a generation.
          observation.waitingForSnapshot = undefined
          observation.value = undefined
        }
        void sender
          .current(pane, value)
          .then((result) => {
            if (result === "failed") failed()
            else observation.waitingForSnapshot = current.current
          }, failed)
          .finally(() => {
            observation.running = false
            if (observations.current.get(key) === observation) schedule(key, observation)
          })
      })
    },
    [current]
  )
  useEffect(() => {
    const entries = observations.current
    return () => {
      for (const observation of entries.values())
        if (observation.frame !== undefined) cancelAnimationFrame(observation.frame)
      entries.clear()
    }
  }, [threadId])
  useEffect(() => {
    for (const [key, observation] of observations.current) {
      const pane = panes.find((row) => row.key === key)
      if (!pane || pane.openRequestId !== observation.open || pane.plugin !== observation.plugin) {
        if (observation.frame !== undefined) cancelAnimationFrame(observation.frame)
        observations.current.delete(key)
      } else schedule(key, observation)
    }
  }, [panes, schedule])
  return useCallback(
    (pane, value) => {
      let observation = observations.current.get(pane.key)
      if (
        !observation ||
        observation.open !== pane.openRequestId ||
        observation.plugin !== pane.plugin
      ) {
        if (observation?.frame !== undefined) cancelAnimationFrame(observation.frame)
        observation = { open: pane.openRequestId, plugin: pane.plugin, running: false }
        observations.current.set(pane.key, observation)
      }
      observation.value = {
        deltaX: clamp(Number(observation.value?.deltaX ?? 0) + Number(value.deltaX)),
        deltaY: clamp(Number(observation.value?.deltaY ?? 0) + Number(value.deltaY)),
        top: clamp(Number(value.top)),
        left: clamp(Number(value.left))
      }
      schedule(pane.key, observation)
    },
    [schedule]
  )
}
