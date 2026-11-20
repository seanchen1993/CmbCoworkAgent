export const MEMORY_RENDER_WINDOW_SIZE = 128

export function boundMemoryRenderWindow<T>(items: readonly T[]): T[] {
  return items.slice(0, MEMORY_RENDER_WINDOW_SIZE)
}
