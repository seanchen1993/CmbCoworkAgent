interface FrameNavigation {
  isMainFrame: boolean
  initiator?: object | null
}

/** Embedded documents may render and interact, but cannot navigate the app or load other pages. */
export function shouldBlockEmbeddedNavigation(event: FrameNavigation, mainFrame: object): boolean {
  if (event.initiator === mainFrame) return false
  // Null initiators cannot authorize subframe redirects or renderer-initiated navigations.
  return !event.isMainFrame || Boolean(event.initiator)
}
