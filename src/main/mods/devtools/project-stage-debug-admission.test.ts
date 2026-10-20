import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  parseProjectRuntimeManifest,
  wrapProjectRuntimeManifest,
  REQUIRED_BUSINESS_CHECKS_PROTOCOL,
  CONTEXT_HANDOFF_PROTOCOL,
  type ProjectRuntimeManifest
} from "../../../shared/project-runtime"
import { createProjectTemplate } from "./project-template"
import { assertStageDebugPackageSupported } from "./project-stage-debug-admission"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stage-debug-admission-"))
  roots.push(root)
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value))
  }
  const source = createProjectTemplate({ packageId: "stage-debug-admission", name: "Admission" })
  for (const file of source.files) put(file.path, file.text)
  let manifest = parseProjectRuntimeManifest(
    JSON.parse(readFileSync(join(root, "devclaw.project-runtime.json"), "utf8"))
  )
  const metadata = { name: manifest.plugin.id, version: manifest.plugin.version }
  return {
    root,
    put,
    metadata,
    manifest: () => manifest,
    runtime: (edit: (manifest: ProjectRuntimeManifest) => void) => {
      const next = structuredClone(manifest)
      edit(next)
      manifest = parseProjectRuntimeManifest(next)
      put("devclaw.project-runtime.json", manifest)
    },
    check: () => assertStageDebugPackageSupported(root, manifest)
  }
}

describe("confined stage debug package admission", () => {
  it("admits the actual project-lite template with static knowledge and an ordinary board-named resource", () => {
    const f = fixture()
    f.put("knowledge/policy.md", "A complete immutable package knowledge body.\n")
    f.put("board_core/board_config.json", {
      description: "Ordinary resource, no runtime ownership"
    })
    expect(f.check).not.toThrow()
  })
  it.each(
    [[], {}, { hooks: {} }, { hooks: { PreToolUse: [], PostSkillUse: [] } }].map((hooks) => ({
      hooks
    }))
  )("retains a truly empty original Hook declaration: %j", ({ hooks }) => {
    const f = fixture()
    f.put("hooks/hooks.json", hooks)
    expect(f.check).not.toThrow()
    expect(JSON.parse(readFileSync(join(f.root, "hooks/hooks.json"), "utf8"))).toEqual(hooks)
  })
  it("uses the original selected manifest and its custom Hook declaration rather than a conventional empty file", () => {
    const f = fixture()
    f.put("hooks/hooks.json", [])
    f.put(".codex-plugin/plugin.json", { ...f.metadata, hooks: "custom/lifecycle.json" })
    f.put("custom/lifecycle.json", {
      hooks: {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "arbitrary-host-side-effect" }] }
        ]
      }
    })
    expect(f.check).toThrow("PROJECT_STAGE_DEBUG_HOOKS_UNSUPPORTED")
  })
  it("accepts an empty custom Hook file without changing its original metadata", () => {
    const f = fixture()
    f.put("plugin.json", { ...f.metadata, hooks: "custom/empty.json" })
    f.put("custom/empty.json", [])
    expect(f.check).not.toThrow()
  })
  it("does not reinterpret an ignored lower-priority manifest as the actual selected package", () => {
    const f = fixture()
    f.put(".codex-plugin/plugin.json", f.metadata)
    f.put("plugin.json", { ...f.metadata, hooks: "ignored.json" })
    f.put("ignored.json", [{ event: "Stop", type: "http", url: "https://example.invalid" }])
    expect(f.check).not.toThrow()
  })
  it.each(
    [
      [{ event: "PreToolUse", enabled: false, type: "command", command: "do-not-skip-disabled" }],
      {
        hooks: {
          Stop: [
            { matcher: "never-match", hooks: [{ type: "prompt", prompt: "Original behavior" }] }
          ]
        }
      }
    ].map((hooks) => ({ hooks }))
  )("blocks all nonempty original Hooks instead of silently filtering them: %j", ({ hooks }) => {
    const f = fixture()
    f.put("hooks/hooks.json", hooks)
    expect(f.check).toThrow("PROJECT_STAGE_DEBUG_HOOKS_UNSUPPORTED")
  })
  it("rejects declared missing, malformed and unknown Hook protocols with fixed diagnostic codes", () => {
    const f = fixture()
    f.put("plugin.json", { ...f.metadata, hooks: "custom/missing.json" })
    expect(f.check).toThrow("PROJECT_STAGE_DEBUG_RESOURCE_MISSING")
    f.put("custom/missing.json", '{"password":"PRIVATE_VALUE",')
    expect(f.check).toThrow("PROJECT_STAGE_DEBUG_PACKAGE_INVALID")
    f.put("custom/missing.json", { UnrecognizedEvent: [] })
    expect(f.check).toThrow("PROJECT_STAGE_DEBUG_HOOK_DECLARATION_INVALID")
  })
  it.each(["hooks.json", "hooks/hooks.json"])("checks original Skill Hook sidecar %s", (path) => {
    const f = fixture()
    f.put(`skills/draft/${path}`, [
      { event: "PostSkillUse", type: "http", url: "https://example.invalid" }
    ])
    expect(f.check).toThrow("PROJECT_STAGE_DEBUG_HOOKS_UNSUPPORTED")
  })
  it("rejects real YAML Skill frontmatter Hooks and does not ignore invalid YAML", () => {
    const f = fixture()
    f.put("skills/draft/SKILL.md", "---\nname: draft\nhooks:\n  Stop: []\n---\nOriginal skill\n")
    expect(f.check).toThrow("PROJECT_STAGE_DEBUG_SKILL_HOOKS_UNSUPPORTED")
    f.put("skills/draft/SKILL.md", "---\nname: draft\nhooks: [invalid\n---\nOriginal skill\n")
    expect(f.check).toThrow("PROJECT_STAGE_DEBUG_SKILL_DECLARATION_INVALID")
  })
  it("checks custom declared Skill roots and convention-discovered Skills before original lifecycle loading", () => {
    const f = fixture()
    f.put("plugin.json", { ...f.metadata, skills: ["custom-skills"] })
    f.put("custom-skills/extra/SKILL.md", "---\nname: extra\nhooks: {}\n---\nPreserve me\n")
    expect(f.check).toThrow("PROJECT_STAGE_DEBUG_SKILL_HOOKS_UNSUPPORTED")
  })
  it.each(["userConfig", "userConfigSchema"])(
    "blocks %s instead of losing source configuration",
    (key) => {
      const f = fixture()
      f.put("plugin.json", {
        ...f.metadata,
        [key]:
          key === "userConfig"
            ? {
                ordinary: { type: "string", title: "Original value", default: "Must not disappear" }
              }
            : { version: 1, migrations: [] }
      })
      expect(f.check).toThrow("PROJECT_STAGE_DEBUG_CONFIGURATION_UNSUPPORTED")
    }
  )
  it("also blocks an explicit empty configuration declaration until mapping is implemented", () => {
    const f = fixture()
    f.put("plugin.json", { ...f.metadata, userConfig: {} })
    expect(f.check).toThrow("PROJECT_STAGE_DEBUG_CONFIGURATION_UNSUPPORTED")
  })
  it("rejects extension context providers while retaining ordinary package knowledge support", () => {
    const f = fixture()
    f.put("scripts/context.py", "Never execute this provider in debug")
    f.put(
      "devclaw.project-runtime.json",
      wrapProjectRuntimeManifest(f.manifest(), {
        apiVersion: "devclaw.extension-contract/v1",
        requires: [REQUIRED_BUSINESS_CHECKS_PROTOCOL, CONTEXT_HANDOFF_PROTOCOL],
        context: {
          sourceAccess: "read-only",
          mutableData: "host",
          configuration: "host-resolved",
          knowledge: { required: true },
          provider: { entry: "scripts/context.py", operations: ["session-context"] }
        }
      })
    )
    expect(f.check).toThrow("PROJECT_STAGE_DEBUG_CONTEXT_UNSUPPORTED")
  })
  it("admits the ordinary required-business-checks envelope without inventing context behavior", () => {
    const f = fixture()
    f.put(
      "devclaw.project-runtime.json",
      wrapProjectRuntimeManifest(f.manifest(), {
        apiVersion: "devclaw.extension-contract/v1",
        requires: [REQUIRED_BUSINESS_CHECKS_PROTOCOL]
      })
    )
    expect(f.check).not.toThrow()
  })
  it("blocks declared and convention-loaded MCP rather than removing its tools", () => {
    const f = fixture()
    f.put("plugin.json", { ...f.metadata, mcpServers: ".mcp.json" })
    f.put(".mcp.json", { mcpServers: {} })
    expect(f.check).toThrow("PROJECT_STAGE_DEBUG_MCP_UNSUPPORTED")
    f.put("plugin.json", f.metadata)
    f.put(".mcp.json", { mcpServers: { remote: { url: "https://example.invalid" } } })
    expect(f.check).toThrow("PROJECT_STAGE_DEBUG_MCP_UNSUPPORTED")
  })
  it.each(["native", "custom", "legacy-modules"])(
    "rejects original shared Mods entrance %s",
    (kind) => {
      const f = fixture()
      if (kind === "native")
        f.put("mods/manifest.json", { apiVersion: "cmb.mods/v2", id: "native", entry: "main.ts" })
      if (kind === "custom") f.put("plugin.json", { ...f.metadata, mods: "custom/mods.json" })
      if (kind === "legacy-modules") f.put("hooks/hooks.json", { modules: ["./native.ts"] })
      expect(f.check).toThrow("PROJECT_STAGE_DEBUG_SHARED_MODS_UNSUPPORTED")
    }
  )
  it("blocks original actions and external checks instead of weakening their contracts", () => {
    const f = fixture()
    f.runtime((manifest) =>
      manifest.actions.push({
        id: "original",
        ref: {
          pluginId: "native-owner",
          plugin: "original",
          digest: "1".repeat(64),
          actionId: "original"
        }
      })
    )
    expect(f.check).toThrow("PROJECT_STAGE_DEBUG_ACTIONS_UNSUPPORTED")
    f.runtime((manifest) => {
      manifest.checks[0] = {
        ...manifest.checks[0],
        kind: "action",
        actionId: "original",
        sideEffect: "external"
      }
    })
    expect(f.check).toThrow("PROJECT_STAGE_DEBUG_CHECK_EFFECT_UNSUPPORTED")
  })
  it("rejects manifest-exported callable capabilities without executing their registration", () => {
    const f = fixture()
    f.put("plugin.json", {
      ...f.metadata,
      claw: {
        actions: [
          {
            id: "publish",
            name: "Publish",
            inputSchema: { type: "object" },
            command: "publish-result"
          }
        ]
      }
    })
    expect(f.check).toThrow("PROJECT_STAGE_DEBUG_ACTIONS_UNSUPPORTED")
  })
  it("blocks capabilities requiring Hooks or MCP and secondary unreviewed flows", () => {
    const f = fixture()
    const capability = {
      id: "flow",
      title: "Original flow",
      kind: "flow",
      usage: "project",
      entry: "devclaw.project-runtime.json",
      requiredHooks: ["original-check"]
    }
    f.put("devclaw.capabilities.json", {
      apiVersion: "devclaw.capabilities/v1",
      capabilities: [capability]
    })
    expect(f.check).toThrow("PROJECT_STAGE_DEBUG_CAPABILITY_DEPENDENCY_UNSUPPORTED")
    f.put("devclaw.capabilities.json", {
      apiVersion: "devclaw.capabilities/v1",
      capabilities: [{ ...capability, requiredHooks: [], entry: "other-runtime.json" }]
    })
    expect(f.check).toThrow("PROJECT_STAGE_DEBUG_CAPABILITY_FLOW_UNSUPPORTED")
  })
})
