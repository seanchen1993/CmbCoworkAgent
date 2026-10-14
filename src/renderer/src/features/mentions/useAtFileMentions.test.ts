import { createElement, useState } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { FileInfo } from "@/types"
import { useAtFileMentions } from "./useAtFileMentions"

type Frame = Parameters<typeof useAtFileMentions>[0] & { dismiss?: boolean }

const files: FileInfo[] = [{ path: "/normal.txt", is_dir: false }]

function frame(input = "Review @normal.txt", extra: Partial<Frame> = {}): Frame {
  return { input, cursorOffset: input.length, workspaceFiles: files, ...extra }
}

// The real React renderer flushes render-phase state updates on the same component.
// SSR does not run search effects; Electron separately verifies candidates and sending.
function renderFrames(frames: Frame[]): string {
  function Probe() {
    const [index, setIndex] = useState(0)
    const current = frames[index]
    const mentions = useAtFileMentions(current)
    if (current.dismiss) mentions.dismiss()
    if (index < frames.length - 1) setIndex(index + 1)
    const mode = mentions.mode
    return createElement("span", {
      "data-kind": mode.kind,
      "data-query": mode.kind === "at-file" ? mode.query : undefined,
      "data-start": mode.kind === "at-file" ? mode.startPos : undefined,
      "data-end": mode.kind === "at-file" ? mode.endPos : undefined,
      "data-quoted": mode.kind === "at-file" ? String(mode.quoted) : undefined
    })
  }
  return renderToStaticMarkup(createElement(Probe))
}

describe("workspace mention dismissal on the actual React hook", () => {
  it("keeps the original active query and replacement boundaries", () => {
    const html = renderFrames([frame()])
    expect(html).toContain('data-kind="at-file"')
    expect(html).toContain('data-query="normal.txt"')
    expect(html).toContain('data-start="7"')
    expect(html).toContain('data-end="18"')
    expect(html).toContain('data-quoted="false"')
  })

  it("stays closed after dismissal and ordinary rerenders of the same token", () => {
    const html = renderFrames([frame(undefined, { dismiss: true }), frame(), frame()])
    expect(html).toContain('data-kind="closed"')
    expect(html).not.toContain("data-query")
  })

  it("stays closed when the workspace publishes a fresh file array for the same token", () => {
    const html = renderFrames([
      frame(undefined, { dismiss: true }),
      frame(undefined, { workspaceFiles: [...files] }),
      frame(undefined, { workspaceFiles: [...files, { path: "/new.txt", is_dir: false }] })
    ])
    expect(html).toContain('data-kind="closed"')
  })

  it("opens the new query after the user changes the dismissed token", () => {
    const html = renderFrames([frame(undefined, { dismiss: true }), frame("Review @new.txt")])
    expect(html).toContain('data-kind="at-file"')
    expect(html).toContain('data-query="new.txt"')
  })

  it("opens again after leaving the token and returning to it", () => {
    const html = renderFrames([frame(undefined, { dismiss: true }), frame("Review "), frame()])
    expect(html).toContain('data-kind="at-file"')
    expect(html).toContain('data-query="normal.txt"')
  })

  it("keeps a dismissed quoted path closed across rerenders", () => {
    const input = 'Review @"folder with spaces/normal.txt"'
    const html = renderFrames([frame(input, { dismiss: true }), frame(input), frame(input)])
    expect(html).toContain('data-kind="closed"')
  })

  it("resets the dismissed token when mentions are disabled and enabled again", () => {
    const html = renderFrames([
      frame(undefined, { dismiss: true }),
      frame(undefined, { disabled: true }),
      frame()
    ])
    expect(html).toContain('data-kind="at-file"')
  })

  it("does not reopen when the cursor moves inside the same full token", () => {
    const html = renderFrames([
      frame(undefined, { dismiss: true }),
      frame(undefined, { cursorOffset: 12 }),
      frame()
    ])
    expect(html).toContain('data-kind="closed"')
  })
})
