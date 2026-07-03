/**
 * Regression tests for the right-panel Skills tree path builder.
 *
 * Run:
 *   npx tsx tests/right-panel-skill-tree-path.spec.ts
 */

import {
  getRightPanelSkillPath,
  getRightPanelSkillPathSegments
} from "../src/renderer/src/components/panels/skill-tree-path.ts"
import type { SkillMetadata } from "../src/renderer/src/types.ts"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function skill(partial: Partial<SkillMetadata> & Pick<SkillMetadata, "name">): SkillMetadata {
  return {
    description: "",
    path: `C:/skills/${partial.name}/SKILL.md`,
    source: "user",
    ...partial
  }
}

function testNonPluginPath(): void {
  const localPath = getRightPanelSkillPath(
    skill({ name: "review", relativePath: "category/review" })
  )
  assert(
    localPath === "category/review",
    `local skill should use relativePath verbatim; got ${JSON.stringify(localPath)}`
  )

  const idFallback = getRightPanelSkillPath(skill({ name: "review", id: "review" }))
  assert(idFallback === "review", `id fallback failed; got ${JSON.stringify(idFallback)}`)

  const nameFallback = getRightPanelSkillPath(skill({ name: "naked" }))
  assert(
    nameFallback.endsWith("naked"),
    `name fallback should produce path containing skill name; got ${JSON.stringify(nameFallback)}`
  )

  console.log("PASS getRightPanelSkillPath passes through non-plugin skills")
}

function testPluginPathNamespacedById(): void {
  const a = getRightPanelSkillPath(
    skill({
      name: "review",
      pluginId: "plugin-a",
      pluginName: "Plugin A",
      relativePath: "review",
      id: "plugin:plugin-a/review"
    })
  )
  const b = getRightPanelSkillPath(
    skill({
      name: "review",
      pluginId: "plugin-b",
      pluginName: "Plugin B",
      relativePath: "review",
      id: "plugin:plugin-b/review"
    })
  )
  assert(a === "plugin-a/review", `pluginA path mismatch: ${JSON.stringify(a)}`)
  assert(b === "plugin-b/review", `pluginB path mismatch: ${JSON.stringify(b)}`)
  assert(a !== b, "same-named skills across plugins MUST produce distinct paths")
  console.log("PASS plugin skills are namespaced by pluginId to avoid tree collisions")
}

function testPluginIdPreferredOverName(): void {
  // pluginName is a display string and can carry slashes/spaces. pluginId is
  // the stable scope — make sure we never let an unsanitized name leak through
  // when an id is available.
  const path = getRightPanelSkillPath(
    skill({
      name: "review",
      pluginId: "stable-id",
      pluginName: "Trojan/Name/Display",
      relativePath: "review"
    })
  )
  assert(
    path === "stable-id/review",
    `pluginId should win over pluginName; got ${JSON.stringify(path)}`
  )
  console.log("PASS pluginId preferred over pluginName for scope")
}

function testPluginDisplayStaysFlat(): void {
  const segments = getRightPanelSkillPathSegments(
    skill({
      name: "review",
      pluginId: "ee736d3f-opaque-id",
      pluginName: "Friendly Review Plugin",
      relativePath: "review"
    })
  )
  assert(segments.length === 1, `plugin source should not add a tree folder, got ${segments.length}`)
  assert(
    segments[0].key === "review::plugin:ee736d3f-opaque-id",
    `plugin skill key should keep stable plugin identity, got ${JSON.stringify(segments[0])}`
  )
  assert(
    segments[0].label === "review",
    `plugin skill label should stay as the skill name, got ${JSON.stringify(segments[0])}`
  )
  assert(
    segments[0].title?.includes("Friendly Review Plugin"),
    `plugin source should be available as metadata, got ${JSON.stringify(segments[0])}`
  )
  console.log("PASS plugin skill tree segment stays flat and carries source metadata")
}

function testPluginNestedSkillStillFolds(): void {
  const segments = getRightPanelSkillPathSegments(
    skill({
      name: "review",
      pluginId: "plugin-a",
      pluginName: "Plugin A",
      relativePath: "category/review"
    })
  )
  assert(segments.length === 2, `nested plugin skill should keep nested path, got ${segments.length}`)
  assert(segments[0].key === "category", `parent segment mismatch: ${JSON.stringify(segments[0])}`)
  assert(segments[0].label === "category", `parent label mismatch: ${JSON.stringify(segments[0])}`)
  assert(
    segments[1].key === "review::plugin:plugin-a",
    `leaf should carry plugin identity without adding a plugin folder: ${JSON.stringify(segments[1])}`
  )
  assert(segments[1].label === "review", `leaf label mismatch: ${JSON.stringify(segments[1])}`)
  console.log("PASS nested plugin skill keeps its own folder hierarchy only")
}

function testPluginNameFallbackSanitised(): void {
  // Only when pluginId is missing do we fall back to pluginName — and even
  // then any internal slashes must be neutralised so the tree builder doesn't
  // see phantom sub-folders.
  const path = getRightPanelSkillPath(
    skill({
      name: "review",
      pluginName: "Friendly/Name",
      relativePath: "review"
    })
  )
  assert(
    path === "Friendly-Name/review",
    `pluginName fallback should sanitise slashes; got ${JSON.stringify(path)}`
  )

  const backslashPath = getRightPanelSkillPath(
    skill({
      name: "review",
      pluginName: "Win\\Name",
      relativePath: "review"
    })
  )
  assert(
    backslashPath === "Win-Name/review",
    `pluginName fallback should sanitise backslashes; got ${JSON.stringify(backslashPath)}`
  )
  console.log("PASS pluginName fallback sanitised against slashes")
}

function testPluginWithoutRelativePath(): void {
  // No relativePath / id — falls back to skill.name as the local segment,
  // still nested under the plugin scope so cross-plugin collisions cannot occur.
  const path = getRightPanelSkillPath(
    skill({
      name: "alpha",
      pluginId: "plugin-a",
      path: "",
      relativePath: undefined,
      id: undefined
    })
  )
  assert(
    path === "plugin-a/alpha",
    `name fallback fills local segment under plugin scope; got ${JSON.stringify(path)}`
  )
  console.log("PASS plugin scope keeps name fallback nested below it")
}

testNonPluginPath()
testPluginPathNamespacedById()
testPluginIdPreferredOverName()
testPluginDisplayStaysFlat()
testPluginNestedSkillStillFolds()
testPluginNameFallbackSanitised()
testPluginWithoutRelativePath()
