export const MODAL_DIALOG_CHANGE_EVENT = "cmb:modal-dialog-change"

const MODAL_DIALOG_SELECTOR = '[data-cmb-modal-dialog="true"]'

/**
 * Native WebContentsView instances sit above renderer DOM. Keep them hidden
 * whenever an app Dialog is mounted in the renderer. The shared DialogContent
 * marker intentionally excludes Popover and other ARIA overlays.
 */
export function hasOpenModalDialog(): boolean {
  if (typeof document === "undefined") return false

  return Array.from(document.querySelectorAll<HTMLElement>(MODAL_DIALOG_SELECTOR)).some(
    (dialog) =>
      dialog.getAttribute("aria-hidden") !== "true" &&
      dialog.getAttribute("data-state") !== "closed"
  )
}
