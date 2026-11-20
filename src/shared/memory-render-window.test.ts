import { describe, expect, it } from "vitest"
import { boundMemoryRenderWindow, MEMORY_RENDER_WINDOW_SIZE } from "./memory-render-window"

describe("memory render window", () => {
  it("never exposes more than 128 rows to the MemoryPanel DOM", () => {
    const rows = Array.from({ length: 20_000 }, (_, index) => ({ index }))
    const visible = boundMemoryRenderWindow(rows)
    expect(visible).toHaveLength(MEMORY_RENDER_WINDOW_SIZE)
    expect(visible[0]?.index).toBe(0)
    expect(visible.at(-1)?.index).toBe(MEMORY_RENDER_WINDOW_SIZE - 1)
  })
})
