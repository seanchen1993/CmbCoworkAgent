const dismissCurrentGuideEvent = "ui-guide:dismiss-current-entry"

/** Explicit navigation may close this entry's guide without acknowledging future entries. */
export function dismissCurrentPageEntryGuide(guideId: string): void {
  window.dispatchEvent(new CustomEvent(dismissCurrentGuideEvent, { detail: { guideId } }))
}

export function subscribeCurrentPageEntryGuideDismiss(guideId: string, onDismiss: () => void) {
  const dismiss = (event: Event) => {
    if ((event as CustomEvent<{ guideId: string }>).detail?.guideId === guideId) onDismiss()
  }
  window.addEventListener(dismissCurrentGuideEvent, dismiss)
  return () => window.removeEventListener(dismissCurrentGuideEvent, dismiss)
}
