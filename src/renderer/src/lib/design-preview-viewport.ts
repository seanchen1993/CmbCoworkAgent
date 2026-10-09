/** The document scrolls inside a fixed viewport. Growing the iframe to the
 * document's scrollHeight changes vh units, sticky headers and fixed dialogs. */
export function getDesignPreviewViewport(width: number, height: number, zoom: number) {
  const scale = Math.max(0.25, zoom / 100)
  return {
    width: Math.max(1, width) / scale,
    height: Math.max(1, height) / scale
  }
}
