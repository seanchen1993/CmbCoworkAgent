export const MODAL_DIALOG_CHANGE_EVENT = "cmb:modal-dialog-change"

const MODAL_DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]'

/**
 * Native WebContentsView instances sit above renderer DOM. Keep them hidden
 * whenever a dialog is mounted in the renderer. Radix Dialog marks open
 * content with data-state rather than aria-modal.
 */
export function hasOpenModalDialog(): boolean {
  if (typeof document === "undefined") return false

  return Array.from(document.querySelectorAll<HTMLElement>(MODAL_DIALOG_SELECTOR)).some(
    (dialog) =>
      dialog.getAttribute("aria-hidden") !== "true" &&
      dialog.getAttribute("data-state") !== "closed"
  )
}
