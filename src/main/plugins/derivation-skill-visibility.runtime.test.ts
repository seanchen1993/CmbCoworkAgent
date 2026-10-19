import { describe, expect, it } from "vitest"
import { isSkillVisibleForProjectMode } from "./derivation-skill-visibility"
import { isSkillVisibleForProjectMode as ambientVisible } from "../../shared/skill-visibility"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource,
  type RuntimePluginSourceBinding
} from "./runtime-source-scope"

function binding(): RuntimePluginSourceBinding {
  return {
    mode: "capabilities",
    capabilitySources: [],
    threadId: "selected-skill-thread",
    incarnationKey: "original-incarnation",
    projectId: "original-project",
    operationId: "original-operation",
    workspace: "C:/workspace",
    packageDigest: "a".repeat(64),
    stageId: "draft",
    plugin: {
      id: "parent-plugin",
      name: "parent",
      version: "1.0.0",
      description: "",
      author: "",
      path: "C:/snapshots/selected-skill",
      enabled: true,
      skillCount: 1,
      mcpServerCount: 0,
      hookCount: 0,
      createdAt: "",
      updatedAt: ""
    }
  }
}

const scope = { projectMode: true, boundPluginId: "parent-plugin" }
const ordinary = (pluginId: string) => ({ pluginId, isProjectModePlugin: false })

describe("retained capability skill visibility", () => {
  it("denies ambient and parent skills when explicit selection omits parent preservation", () => {
    const parent = binding()
    // The ordinary fallback really admits both sources; the opaque selection must override it.
    expect(ambientVisible(ordinary("ambient-plugin"), scope)).toBe(true)
    expect(ambientVisible(ordinary(parent.plugin.id), scope)).toBe(true)
    withRuntimePluginSource(issueRuntimePluginSourceToken(parent), () => {
      expect(isSkillVisibleForProjectMode(ordinary("ambient-plugin"), scope)).toBe(false)
      expect(isSkillVisibleForProjectMode(ordinary(parent.plugin.id), scope)).toBe(false)
    })
  })

  it("admits only selected plugin skills and optionally the explicitly preserved parent", () => {
    const parent = binding()
    parent.capabilitySources = [
      {
        plugin: { ...parent.plugin, id: "selected-plugin", path: "C:/snapshots/selected-other" },
        packageDigest: "b".repeat(64),
        capability: {
          id: "selected",
          title: "Selected",
          kind: "skill",
          usage: "project",
          entry: "skills/selected/SKILL.md",
          dependsOn: []
        }
      }
    ]
    for (const preserveParentContext of [undefined, false, true]) {
      withRuntimePluginSource(
        issueRuntimePluginSourceToken({ ...parent, preserveParentContext }),
        () => {
          expect(isSkillVisibleForProjectMode(ordinary("selected-plugin"), scope)).toBe(true)
          expect(isSkillVisibleForProjectMode(ordinary(parent.plugin.id), scope)).toBe(
            preserveParentContext === true
          )
          expect(isSkillVisibleForProjectMode(ordinary("ambient-plugin"), scope)).toBe(false)
        }
      )
    }
  })

  it("keeps ordinary no-token fallback and checks live authority on every selected read", () => {
    withRuntimePluginSource(undefined, () => {
      expect(isSkillVisibleForProjectMode(ordinary("ambient-plugin"), scope)).toBe(true)
    })
    let enabled = true,
      reads = 0
    const token = issueRuntimePluginSourceToken(binding(), undefined, () => {
      reads++
      if (!enabled) throw Error("selected-source-disabled")
    })
    withRuntimePluginSource(token, () => {
      reads = 0
      expect(isSkillVisibleForProjectMode(ordinary("ambient-plugin"), scope)).toBe(false)
      expect(reads).toBe(1)
      enabled = false
      expect(() => isSkillVisibleForProjectMode(ordinary("ambient-plugin"), scope)).toThrow(
        "selected-source-disabled"
      )
      expect(reads).toBe(2)
    })
  })
})
