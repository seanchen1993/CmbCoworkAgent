import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { currentGitReadSignal } from "../services/git-read-context"
import { GitReadRequestCoordinator } from "./git-read-request-coordinator"

class FakeSender extends EventEmitter {
  constructor(readonly id: number) {
    super()
  }
}

function pendingUntilCancelled(label: string): Promise<string> {
  const signal = currentGitReadSignal()
  if (!signal) throw new Error("missing Git read signal")
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(label), 5_000)
    timer.unref?.()
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}

describe("GitReadRequestCoordinator", () => {
  it("gives concurrent changed-summary metadata reads a task-specific scope", () => {
    const source = readFileSync(new URL("./models.ts", import.meta.url), "utf8")
    const start = source.indexOf('"workspace:getGitChangedFilesSummary"')
    const end = source.indexOf('"workspace:getGitPanelState"', start)
    const handler = source.slice(start, end)

    expect(start).toBeGreaterThan(0)
    expect(handler).toContain('requestScope: `git-changed-summary:${threadId}`')
    expect(handler).not.toContain('requestScope: "git-changed-summary"')
  })

  it("isolates the mount-time workspace probe and keeps it free of metadata rewrites", () => {
    const source = readFileSync(new URL("./models.ts", import.meta.url), "utf8")
    const start = source.indexOf('"workspace:isGit"')
    const end = source.indexOf('"workspace:listWorktrees"', start)
    const handler = source.slice(start, end)

    expect(start).toBeGreaterThan(0)
    expect(handler).toContain('"workspace-probe"')
    expect(handler).toContain("gitReadRequestCoordinator.run(")
    expect(handler).not.toContain("getThreadCore")
    expect(handler).not.toContain("updateThread")
    expect(handler).not.toContain("JSON.parse")
  })

  it("reuses the bounded task-directory metadata in the workspace picker", () => {
    const source = readFileSync(
      new URL("../../renderer/src/components/chat/WorkspacePicker.tsx", import.meta.url),
      "utf8"
    )

    expect(source).toContain("useAppStore.getState().threads.find")
    expect(source).not.toContain("window.api.threads.get(threadId)")
    expect(source).toContain('cancelGitPanelReads("workspace-probe")')
  })

  it("cancels a stale workspace probe without cancelling Git panel reads", async () => {
    const coordinator = new GitReadRequestCoordinator()
    const sender = new FakeSender(12)
    const panel = coordinator.run(sender, "panel", "meta", "thread-a", async () => "panel")
    const staleProbe = coordinator.run(
      sender,
      "workspace-probe",
      "probe",
      "thread-a",
      () => pendingUntilCancelled("old-probe")
    )
    const latestProbe = coordinator.run(
      sender,
      "workspace-probe",
      "probe",
      "thread-b",
      async () => "new-probe"
    )

    await expect(staleProbe).rejects.toMatchObject({ name: "AbortError" })
    await expect(Promise.all([panel, latestProbe])).resolves.toEqual(["panel", "new-probe"])
  })

  it("cancels task A when task B wins the same panel family", async () => {
    const coordinator = new GitReadRequestCoordinator()
    const sender = new FakeSender(7)
    const first = coordinator.run(sender, "panel", "meta", "thread-a", () =>
      pendingUntilCancelled("a")
    )
    const second = coordinator.run(sender, "panel", "meta", "thread-b", async () => "b")

    await expect(first).rejects.toMatchObject({ name: "AbortError" })
    await expect(second).resolves.toBe("b")
    expect(coordinator.activeRequestCount()).toBe(0)
  })

  it("allows meta and diff reads for one task to overlap", async () => {
    const coordinator = new GitReadRequestCoordinator()
    const sender = new FakeSender(8)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = coordinator.run(sender, "panel", "meta", "thread-a", async () => {
      await gate
      return "meta"
    })
    const second = coordinator.run(sender, "panel", "diffs", "thread-a", async () => {
      await gate
      return "diff"
    })
    expect(coordinator.activeRequestCount()).toBe(2)
    release()
    await expect(Promise.all([first, second])).resolves.toEqual(["meta", "diff"])
  })

  it("keeps only the newest request in one task and lane", async () => {
    const coordinator = new GitReadRequestCoordinator()
    const sender = new FakeSender(10)
    const first = coordinator.run(sender, "panel", "file-diff", "thread-a", () =>
      pendingUntilCancelled("old-file")
    )
    const second = coordinator.run(
      sender,
      "panel",
      "file-diff",
      "thread-a",
      async () => "new-file"
    )

    await expect(first).rejects.toMatchObject({ name: "AbortError" })
    await expect(second).resolves.toBe("new-file")
  })

  it("still rejects a superseded read when an inner fallback catches the abort", async () => {
    const coordinator = new GitReadRequestCoordinator()
    const sender = new FakeSender(11)
    const first = coordinator.run(sender, "panel", "meta", "thread-a", async () => {
      try {
        await pendingUntilCancelled("old-meta")
      } catch {
        return "empty-fallback"
      }
      return "unreachable"
    })
    const second = coordinator.run(sender, "panel", "meta", "thread-b", async () => "new-meta")

    await expect(first).rejects.toMatchObject({ name: "AbortError" })
    await expect(second).resolves.toBe("new-meta")
  })

  it("keeps summary families isolated and aborts every read on sender teardown", async () => {
    const coordinator = new GitReadRequestCoordinator()
    const sender = new FakeSender(9)
    const panel = coordinator.run(sender, "panel", "meta", "thread-a", () =>
      pendingUntilCancelled("panel")
    )
    const summary = coordinator.run(sender, "summary", "summary", "thread-b", () =>
      pendingUntilCancelled("summary")
    )
    expect(coordinator.activeRequestCount()).toBe(2)
    sender.emit("destroyed")
    await expect(panel).rejects.toMatchObject({ name: "AbortError" })
    await expect(summary).rejects.toMatchObject({ name: "AbortError" })
    expect(coordinator.activeRequestCount()).toBe(0)
  })
})
