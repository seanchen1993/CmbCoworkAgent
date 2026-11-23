// Layouts without floating controls retain their original scroll coordinates.
export function chatScrollInsets(viewport: HTMLElement | null): { top: number; bottom: number } {
  const style = viewport && viewport.ownerDocument?.defaultView?.getComputedStyle(viewport)
  return {
    top: style ? parseFloat(style.scrollPaddingTop) || 0 : 0,
    bottom: style ? parseFloat(style.scrollPaddingBottom) || 0 : 0
  }
}
