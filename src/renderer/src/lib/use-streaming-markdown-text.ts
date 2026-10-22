import { startTransition, useEffect, useRef, useState } from "react"
import { getStreamingMarkdownDelayMs } from "./streaming-markdown-schedule"

/** One trailing throttle per live text producer; completion is never delayed. */
export function useStreamingMarkdownText(text: string, isStreaming: boolean): string {
  const [snapshot, setSnapshot] = useState(text)
  const latest = useRef(text)
  const flushed = useRef(text)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    latest.current = text
    if (!isStreaming) {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      return
    }
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      if (flushed.current !== latest.current) {
        flushed.current = latest.current
        startTransition(() => setSnapshot(latest.current))
      }
    }, getStreamingMarkdownDelayMs(text.length))
  }, [text, isStreaming])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  return isStreaming ? snapshot : text
}
