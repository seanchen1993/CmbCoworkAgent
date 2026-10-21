import { useCallback, useEffect, useRef } from "react"

export const SIDEBAR_WIDTH_PROPERTY = "--app-sidebar-width"
export const SIDEBAR_RESIZE_DURATION_PROPERTY = "--app-sidebar-resize-duration"

// Preview layout directly; committing React state on every frame rerenders the
// entire App, including its chat and panel surfaces, while the pointer moves.
export function useSidebarResizePreview(
  width: number,
  commit: (width: number) => void,
  minimum: number,
  maximum: number
) {
  const start = useRef<number | null>(null)
  const preview = useCallback(
    (delta: number) => {
      start.current ??= width
      const next = Math.min(maximum, Math.max(minimum, start.current + delta))
      const style = document.documentElement.style
      style.setProperty(SIDEBAR_RESIZE_DURATION_PROPERTY, "0ms")
      style.setProperty(SIDEBAR_WIDTH_PROPERTY, `${next}px`)
      return next
    },
    [width, minimum, maximum]
  )
  const finish = useCallback(
    (delta: number) => {
      if (start.current === null) return
      const next = preview(delta)
      start.current = null
      document.documentElement.style.removeProperty(SIDEBAR_RESIZE_DURATION_PROPERTY)
      commit(next)
    },
    [preview, commit]
  )
  const cancel = useCallback(() => {
    if (start.current === null) return
    start.current = null
    document.documentElement.style.removeProperty(SIDEBAR_RESIZE_DURATION_PROPERTY)
    document.documentElement.style.setProperty(SIDEBAR_WIDTH_PROPERTY, `${width}px`)
  }, [width])
  useEffect(
    () => () => {
      start.current = null
      document.documentElement.style.removeProperty(SIDEBAR_WIDTH_PROPERTY)
      document.documentElement.style.removeProperty(SIDEBAR_RESIZE_DURATION_PROPERTY)
    },
    []
  )
  return { preview, finish, cancel }
}
