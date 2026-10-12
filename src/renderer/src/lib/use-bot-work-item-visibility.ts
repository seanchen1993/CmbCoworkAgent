import { useCallback, useLayoutEffect, useState } from "react"

let observer: IntersectionObserver | undefined
const subscribers = new Map<Element, (visible: boolean) => void>()
/** One passive observer for mounted task controls; hidden rows do not occupy
 * the bounded tracked-work registry. Disconnect it when the final row leaves. */
export function observeBotWorkItem(element: Element, publish: (visible: boolean) => void) {
  publish(false)
  // Old/limited renderers cannot safely turn every hidden row into a tracked
  // target. Leave it unknown until the user updates/reopens a supported window.
  if (typeof IntersectionObserver === "undefined") return () => {}
  if (!observer)
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) subscribers.get(entry.target)?.(entry.isIntersecting)
    })
  subscribers.set(element, publish)
  observer.observe(element)
  let released = false
  return () => {
    if (released) return
    released = true
    if (subscribers.get(element) !== publish) return
    subscribers.delete(element)
    observer?.unobserve(element)
    if (!subscribers.size) {
      observer?.disconnect()
      observer = undefined
    }
  }
}
export function useBotWorkItemVisibility() {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [visible, setVisible] = useState(false)
  const ref = useCallback((node: HTMLElement | null) => setElement(node), [])
  useLayoutEffect(() => (element ? observeBotWorkItem(element, setVisible) : undefined), [element])
  return { ref, visible }
}
