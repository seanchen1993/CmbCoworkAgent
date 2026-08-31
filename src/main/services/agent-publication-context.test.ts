import { describe, expect, it } from "vitest"
import { matchesAgentPublicationContext } from "./agent-publication-context"

describe("agent run publication context", () => {
  it("rejects a stale invoke at the publication barrier without installing an active run", () => {
    const initialThread = {
      created_at: 1,
      metadata: JSON.stringify({ cmb_thread_incarnation: "incarnation-a" })
    }
    const parsedContext = {
      workspacePath: "C:\\repo",
      mode: "normal" as const,
      normalSubagentsEnabled: true,
      threadIncarnation: { token: "incarnation-a", legacyCreatedAt: 1 }
    }
    const activeRuns = new Map<string, AbortController>()

    // Renderer patch wins after invoke parsed its mode but before invoke gets the run lock.
    const metadataAfterPatch = { workspacePath: "C:/repo", agentMode: "workflow" }
    if (matchesAgentPublicationContext(initialThread, metadataAfterPatch, parsedContext)) {
      activeRuns.set("thread", new AbortController())
    }

    expect(activeRuns.size).toBe(0)
  })

  it("uses the new mode when the patch completed before the first invoke snapshot", () => {
    const metadataAfterPatch = { workspacePath: "C:\\repo", agentMode: "workflow" }
    const latestThread = {
      created_at: 1,
      metadata: JSON.stringify({ cmb_thread_incarnation: "incarnation-a" })
    }
    const expected = {
      workspacePath: "C:\\repo",
      mode: "workflow" as const,
      normalSubagentsEnabled: true,
      threadIncarnation: { token: "incarnation-a", legacyCreatedAt: 1 }
    }
    expect(
      matchesAgentPublicationContext(
        latestThread,
        { workspacePath: "c:/repo/", agentMode: "workflow" },
        expected
      )
    ).toBe(true)
    expect(metadataAfterPatch.agentMode).toBe(expected.mode)
  })

  it("rejects delete and same-value recreate before publication", () => {
    const expected = {
      workspacePath: "C:/repo",
      mode: "normal" as const,
      normalSubagentsEnabled: true,
      threadIncarnation: { token: "incarnation-a", legacyCreatedAt: 100 }
    }
    const recreatedAtTheSameMillisecond = {
      created_at: 100,
      metadata: JSON.stringify({ cmb_thread_incarnation: "incarnation-b" })
    }

    expect(
      matchesAgentPublicationContext(
        recreatedAtTheSameMillisecond,
        { workspacePath: "C:/repo", agentMode: "normal" },
        expected
      )
    ).toBe(false)
  })

  it("rejects a Solo/Multi toggle that wins before normal-mode publication", () => {
    const latestThread = {
      created_at: 1,
      metadata: JSON.stringify({ cmb_thread_incarnation: "incarnation-a" })
    }
    const expected = {
      workspacePath: "C:/repo",
      mode: "normal" as const,
      normalSubagentsEnabled: false,
      threadIncarnation: { token: "incarnation-a", legacyCreatedAt: 1 }
    }

    expect(
      matchesAgentPublicationContext(
        latestThread,
        { workspacePath: "C:/repo", agentMode: "normal", subagentsEnabled: true },
        expected
      )
    ).toBe(false)
  })
})
