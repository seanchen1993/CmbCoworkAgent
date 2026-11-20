import { describe, expect, it } from "vitest"
import { threadMetadataMatchesGroupSelector } from "./thread-group-selector"

describe("threadMetadataMatchesGroupSelector", () => {
  it("keeps chat workspace groups isolated from all typed harness rows", () => {
    expect(
      threadMetadataMatchesGroupSelector(
        { workspacePath: "C:/repo" },
        { type: "workspace", workspacePath: "C:/repo" }
      )
    ).toBe(true)
    expect(
      threadMetadataMatchesGroupSelector(
        { workspacePath: "C:/repo", harnessFeature: { projectId: "", slug: "" } },
        { type: "workspace", workspacePath: "C:/repo" }
      )
    ).toBe(false)
  })

  it("gives a valid project session precedence over compatibility feature metadata", () => {
    const metadata = {
      harnessProjectSession: { projectId: "project-a", kind: "chat" },
      harnessFeature: { projectId: "project-b", slug: "feature-b" }
    }

    expect(
      threadMetadataMatchesGroupSelector(metadata, {
        type: "harness-feature",
        projectId: "project-b",
        slug: "feature-b"
      })
    ).toBe(false)
    expect(
      threadMetadataMatchesGroupSelector(metadata, {
        type: "harness-project",
        projectId: "project-b"
      })
    ).toBe(false)
    expect(
      threadMetadataMatchesGroupSelector(metadata, {
        type: "harness-project",
        projectId: "project-a"
      })
    ).toBe(true)
  })

  it("falls back to valid feature metadata when project-session metadata is incomplete", () => {
    const metadata = {
      harnessProjectSession: { projectId: "project-a", kind: " " },
      harnessFeature: { projectId: "project-b", slug: "feature-b" }
    }

    expect(
      threadMetadataMatchesGroupSelector(metadata, {
        type: "harness-feature",
        projectId: "project-b",
        slug: "feature-b"
      })
    ).toBe(true)
    expect(
      threadMetadataMatchesGroupSelector(metadata, {
        type: "harness-project",
        projectId: "project-b"
      })
    ).toBe(true)
  })
})
