import { describe, expect, it } from "vitest"
import { workspacePathsOverlap } from "./workspace-path"

describe("workspace resource overlap", () => {
  it("includes equality and parents while excluding sibling prefixes and empty paths", () => {
    expect(workspacePathsOverlap("/repo/project/", "/repo/project")).toBe(true)
    expect(workspacePathsOverlap("/repo/project", "/repo/project/src")).toBe(true)
    expect(workspacePathsOverlap("/repo/project/src", "/repo/project")).toBe(true)
    expect(workspacePathsOverlap("/repo/project", "/repo/project-2")).toBe(false)
    expect(workspacePathsOverlap("", "/repo/project")).toBe(false)
    expect(workspacePathsOverlap("/", "/repo/project")).toBe(true)
    expect(workspacePathsOverlap("C:\\repo\\project", "C:/repo/project/src")).toBe(true)
  })
})
