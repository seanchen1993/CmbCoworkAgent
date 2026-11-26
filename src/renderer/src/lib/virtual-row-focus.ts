// Return keyboard scrolling to the list when virtualization removes the focused row.
export function retainListFocus(row: HTMLButtonElement | null): (() => void) | undefined {
  if (!row) return
  return () => {
    if (row === document.activeElement) {
      row.closest<HTMLElement>('[role="region"]')?.focus({ preventScroll: true })
    }
  }
}
