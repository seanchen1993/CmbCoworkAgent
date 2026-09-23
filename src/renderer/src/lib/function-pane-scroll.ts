import { FunctionScrollFollow } from "./function-scroll-follow"
import { useEffect, useRef, useState, type RefObject } from "react"
import type { FunctionPaneSnapshot } from "../../../shared/mods/v2/ui"
import {
  functionScrollGeometry,
  type FunctionScrollGeometry,
  type FunctionScrollRequest
} from "../../../shared/mods/v2/ui-scroll"
import { paneFocusElement } from "./function-pane-focus"

function measure(
  section: HTMLElement,
  request: FunctionScrollRequest
):
  | {
      body: HTMLElement
      geometry: FunctionScrollGeometry
    }
  | undefined {
  if (
    !section.isConnected ||
    !section.getClientRects().length ||
    document.visibilityState !== "visible" ||
    !document.hasFocus() ||
    document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]')
  )
    return undefined
  const body = section.querySelector<HTMLElement>("[data-function-pane-body]")
  if (!body?.isConnected || !body.getClientRects().length) return undefined
  const target =
    typeof request.args.to === "object" && "key" in request.args.to
      ? paneFocusElement(section, { plugin: request.plugin, element: request.args.to.key })
      : undefined
  if (
    typeof request.args.to === "object" &&
    (!target || !body.contains(target) || !target.getClientRects().length)
  )
    return undefined
  const rect = body.getBoundingClientRect()
  const targetRect = target?.getBoundingClientRect()
  try {
    return {
      body,
      geometry: functionScrollGeometry({
        height: body.clientHeight,
        content: body.scrollHeight,
        top: body.scrollTop,
        width: body.clientWidth,
        row: parseFloat(getComputedStyle(body).lineHeight),
        ...(targetRect
          ? {
              target: {
                top: targetRect.top - rect.top - body.clientTop + body.scrollTop,
                height: targetRect.height
              }
            }
          : {})
      })
    }
  } catch {
    return undefined
  }
}

/** Renderer acknowledgement has its own IPC route, outside the callback currently awaiting it. */
export function useFunctionPaneScroll(input: {
  threadId: string
  panes: FunctionPaneSnapshot[]
  current: RefObject<FunctionPaneSnapshot[]>
  sections: RefObject<Map<string, HTMLElement>>
  loadedThread: RefObject<string | undefined>
  refresh: RefObject<() => void>
}): void {
  const { threadId, panes, current, sections, loadedThread, refresh } = input
  const epoch = useRef(0)
  const probes = useRef(new Map<string, { epoch: number; accepted: Promise<boolean> }>())
  const steps = useRef(new Set<string>())
  const [followers] = useState(() => new FunctionScrollFollow())
  const active = panes.length > 0
  useEffect(() => {
    const pending = probes.current
    const processed = steps.current
    const following = followers
    const invalidate = (): void => {
      epoch.current++
    }
    const changed = (event: Event): void => {
      invalidate()
      following.observe(event)
    }
    const events = [
      "pointerdown",
      "keydown",
      "wheel",
      "scroll",
      "blur",
      "resize",
      "mods:configuration-changed"
    ]
    if (active) for (const event of events) window.addEventListener(event, changed, true)
    return () => {
      invalidate()
      following.close()
      pending.clear()
      processed.clear()
      for (const event of events) window.removeEventListener(event, changed, true)
    }
  }, [threadId, active, followers])
  useEffect(() => {
    if (loadedThread.current !== threadId) return
    followers.sync(panes, sections.current)
    const ids = new Set(
      panes.flatMap((pane) => (pane.imperativeScroll ? [pane.imperativeScroll.id] : []))
    )
    for (const id of probes.current.keys()) if (!ids.has(id)) probes.current.delete(id)
    for (const step of steps.current) if (!ids.has(step.split(":")[0])) steps.current.delete(step)
    for (const pane of panes) {
      const request = pane.imperativeScroll
      if (!request || request.pane !== pane.key || request.generation !== pane.generation) continue
      const step = `${request.id}:${request.phase}`
      if (steps.current.has(step)) continue
      steps.current.add(step)
      const ready = () => {
        if (loadedThread.current !== threadId) return undefined
        const row = current.current.find((row) => row.key === pane.key)
        if (
          row?.generation !== request.generation ||
          row.imperativeScroll?.id !== request.id ||
          row.imperativeScroll.phase !== request.phase
        )
          return undefined
        const section = sections.current.get(pane.key)
        return section ? measure(section, request) : undefined
      }
      const ack = {
        pane: request.pane,
        generation: request.generation,
        id: request.id,
        phase: request.phase
      }
      if (request.phase === "probe") {
        const measured = ready()
        const accepted = window.api.mods
          .scrollAck(threadId, {
            ...ack,
            allowed: Boolean(measured),
            ...(measured ? { geometry: measured.geometry } : {})
          })
          .then(
            () => Boolean(measured),
            () => false
          )
        if (measured) probes.current.set(request.id, { epoch: epoch.current, accepted })
        void accepted.finally(() => refresh.current())
      } else {
        const probe = probes.current.get(request.id)
        void (async () => {
          const accepted = probe && (await probe.accepted)
          const measured = ready()
          let allowed = Boolean(
            accepted &&
            measured &&
            probe?.epoch === epoch.current &&
            JSON.stringify(measured.geometry) === JSON.stringify(request.geometry) &&
            typeof request.offset === "number" &&
            Number.isFinite(request.offset)
          )
          probes.current.delete(request.id)
          if (allowed && measured) {
            const requestedTop = request.offset! * measured.geometry.row
            measured.body.scrollTop = requestedTop
            allowed = Math.abs(measured.body.scrollTop - requestedTop) <= 1
          }
          const acknowledge = () => window.api.mods.scrollAck(threadId, { ...ack, allowed })
          if (allowed && measured) {
            await followers.acknowledge(
              pane.key,
              request.id,
              measured.body,
              request.args.to === "end" &&
                Math.abs(
                  measured.body.scrollTop -
                    (measured.body.scrollHeight - measured.body.clientHeight)
                ) <= 1,
              acknowledge
            )
          } else await acknowledge()
        })()
          .catch(() => {})
          .finally(() => refresh.current())
      }
    }
  }, [threadId, panes, current, sections, loadedThread, refresh, followers])
}
