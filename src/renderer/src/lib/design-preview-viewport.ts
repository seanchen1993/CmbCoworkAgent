/** The document scrolls inside a fixed viewport. Growing the iframe to the
 * document's scrollHeight changes vh units, sticky headers and fixed dialogs. */
export function getDesignPreviewViewport(width: number, height: number, zoom: number) {
  const scale = Math.max(0.25, zoom / 100)
  return {
    width: Math.max(1, width) / scale,
    height: Math.max(1, height) / scale
  }
}

/** Percentage dimensions follow the mounted canvas immediately, including during split dragging. */
export function getDesignPreviewViewportStyle(zoom: number) {
  const viewport = getDesignPreviewViewport(100, 100, zoom)
  return { width: `${viewport.width}%`, height: `${viewport.height}%` }
}
