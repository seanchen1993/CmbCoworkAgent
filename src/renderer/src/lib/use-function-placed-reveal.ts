import { useEffect, useRef, type RefObject } from "react"
import type { VirtuosoHandle } from "react-virtuoso"
import type { FunctionPlacedEntry, FunctionPlacedRevealAck } from "../../../shared/mods/v2/placed"
import { useFunctionDesktopOwner } from "./function-desktop-owner"
import { useModsChatCurrent } from "./mods-chat-scope"

/** Reveals only a host-listed row in the already resident window; never loads history. */
export function useFunctionPlacedReveal(options: {
  threadId: string
  rows: readonly FunctionPlacedEntry[]
  placements: { start: FunctionPlacedEntry[]; after: Map<number, FunctionPlacedEntry[]> }
  visibleIndexes: readonly number[]
  firstItemIndex: number
  root: RefObject<HTMLDivElement | null>
  viewport: HTMLDivElement | null
  virtuoso: RefObject<VirtuosoHandle | null>
}) {
  const binding = useFunctionDesktopOwner(options.threadId)
  const current = useModsChatCurrent(options.threadId)
  const latest = useRef(options)
  latest.current = options
  const fingerprint = JSON.stringify(
    options.rows.filter((row) => row.reveal).map((row) => [row.requestId, row.reveal?.id])
  )
  useEffect(() => {
    if (!binding || !window.api.mods.placedRevealAck || !current()) return
    let live = true
    const frames = new Set<number>()
    for (const row of latest.current.rows) {
      if (!row.reveal) continue
      const reveal = row.reveal
      let attempts = 0,
        positioned = false,
        finished = false
      const valid = () =>
        live &&
        current() &&
        latest.current.rows.some(
          (candidate) =>
            candidate.requestId === row.requestId &&
            candidate.reveal?.id === reveal.id &&
            JSON.stringify(candidate.anchor) === JSON.stringify(row.anchor)
        )
      const answer = (ack: Omit<FunctionPlacedRevealAck, "requestId" | "receipt">) => {
        if (finished || !valid()) return
        finished = true
        void window.api.mods
          .placedRevealAck(options.threadId, binding.owner, {
            requestId: row.requestId,
            receipt: reveal.id,
            ...ack
          })
          .catch(() => {})
      }
      const tick = () => {
        if (!valid() || finished) return
        const now = latest.current,
          viewport = now.viewport,
          root = now.root.current
        if (!root || !viewport || !root.isConnected || root.closest("[inert]")) {
          answer({ allowed: false })
          return
        }
        if (!positioned) {
          let index: number | undefined
          if (now.placements.start.some((candidate) => candidate.requestId === row.requestId))
            index = 0
          for (const [messageIndex, rows] of now.placements.after) {
            if (rows.some((candidate) => candidate.requestId === row.requestId))
              index = now.visibleIndexes.indexOf(messageIndex)
          }
          if (index === undefined || index < 0) {
            answer({ allowed: false })
            return
          }
          now.virtuoso.current?.scrollToIndex({
            index,
            align: reveal.block === "nearest" ? "center" : reveal.block,
            behavior: "auto"
          })
          positioned = true
        }
        const node = [...root.querySelectorAll<HTMLElement>("[data-function-placed]")].find(
          (element) => element.dataset.functionPlaced === row.requestId
        )
        if (
          node?.dataset.functionPlacedLease &&
          node.dataset.functionPlacedGeneration &&
          node.getClientRects().length &&
          !node.closest("[inert]")
        ) {
          node.scrollIntoView({ block: reveal.block, behavior: "instant" })
          const rect = node.getBoundingClientRect(),
            visible = viewport.getBoundingClientRect()
          if (
            rect.bottom > visible.top &&
            rect.top < visible.bottom &&
            rect.right > visible.left &&
            rect.left < visible.right &&
            document.visibilityState !== "hidden"
          ) {
            answer({
              allowed: true,
              lease: node.dataset.functionPlacedLease,
              generation: node.dataset.functionPlacedGeneration
            })
            return
          }
        }
        if (++attempts >= 120) {
          answer({ allowed: false })
          return
        }
        const frame = requestAnimationFrame(() => {
          frames.delete(frame)
          tick()
        })
        frames.add(frame)
      }
      tick()
    }
    return () => {
      live = false
      for (const frame of frames) cancelAnimationFrame(frame)
    }
  }, [options.threadId, binding, current, fingerprint])
}
