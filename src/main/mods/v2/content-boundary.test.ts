import { expect, it } from "vitest"
import { isFunctionContentBoundary } from "./content-boundary"

it("keeps UI, timer and metadata queries separate from actual external execution/data boundaries", () => {
  for (const method of [
    "ui.render",
    "ui.resolve",
    "ui.status",
    "platform.poll",
    "platform.list",
    "prompt.chunk",
    "prompt.section",
    "session.id",
    "tool.list",
    "config.describe",
    "clock.after",
    "turn.abort",
    "platform.cancel"
  ])
    expect(isFunctionContentBoundary(method), method).toBe(false)
  for (const method of [
    "fs.read",
    "fs.write",
    "process.run",
    "process.spawn",
    "http.fetch",
    "model.complete",
    "model.fork",
    "mcp.call",
    "tool.call",
    "platform.act",
    "command.run"
  ])
    expect(isFunctionContentBoundary(method), method).toBe(true)
})
