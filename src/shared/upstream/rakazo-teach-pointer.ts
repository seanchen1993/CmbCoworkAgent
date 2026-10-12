// Extracted from Rakazo, Apache-2.0. See src/main/bots/upstream/RAKAZO-LICENSE and PROVENANCE.json.
function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max)
}

/**
 * The embedded viewer scales the remote framebuffer to fit while preserving its aspect ratio
 * and centres it, so the visible screen is letterboxed inside the container. Map through that
 * letterbox instead of stretching across the whole container rect.
 */
export function mapTeachPointer(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  screen: { width: number; height: number }
): { x: number; y: number } {
  const width = rect.width || 1
  const height = rect.height || 1
  const scale = Math.min(width / screen.width, height / screen.height) || 1
  const offsetX = (width - screen.width * scale) / 2
  const offsetY = (height - screen.height * scale) / 2
  return {
    x: clamp(Math.round((clientX - rect.left - offsetX) / scale), screen.width - 1),
    y: clamp(Math.round((clientY - rect.top - offsetY) / scale), screen.height - 1)
  }
}
