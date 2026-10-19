import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("../storage", () => ({ getOpenworkDir: () => "unused" }))
import {
  parseProjectCapabilitySources,
  ProjectCapabilitySelectionStore
} from "./project-capability-selection"
const roots: string[] = []
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})
describe("project capability selection", () => {
  it("persists exact sources, isolates projects and requires current revision to replace or clear", () => {
    const root = mkdtempSync(join(tmpdir(), "project-capability-selection-"))
    roots.push(root)
    const first = new ProjectCapabilitySelectionStore(join(root, "selection.sqlite"))
    const second = new ProjectCapabilitySelectionStore(join(root, "selection.sqlite"))
    try {
      const source = {
        pluginId: "installed",
        capabilityId: "review",
        packageDigest: "a".repeat(64)
      }
      expect(first.get("project", root).sources).toEqual([])
      const saved = first.save("project", root, "0", [source])
      expect(second.get("project", root)).toEqual(saved)
      expect(second.get("another", root).sources).toEqual([])
      // Creating settings for one project must not add filesystem validation to unrelated old chats.
      expect(second.get("unconfigured", join(root, "not-created-yet")).sources).toEqual([])
      expect(() => second.save("project", root, "0", [])).toThrow("CHANGED")
      expect(second.save("project", root, saved.revision, []).sources).toEqual([])
    } finally {
      first.close()
      second.close()
    }
  })
  it("rejects untrusted paths, duplicates and oversized capability sets", () => {
    const source = { pluginId: "installed", capabilityId: "review", packageDigest: "a".repeat(64) }
    for (const value of [
      [{ ...source, path: "C:/other" }],
      [source, source],
      Array(17).fill(source),
      [{ ...source, packageDigest: "forged" }]
    ])
      expect(() => parseProjectCapabilitySources(value)).toThrow()
  })
})
