import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import {
  CONTEXT_HANDOFF_PROTOCOL,
  REQUIRED_BUSINESS_CHECKS_PROTOCOL,
  VERIFIED_ARTIFACTS_PROTOCOL,
  wrapProjectRuntimeManifest
} from "../../shared/project-runtime"
import { hostProjectFixture } from "../harness-board/project-runtime/host-fixtures.test-helper"
import * as snapshots from "../harness-board/project-runtime/package-snapshots"
import * as reviewed from "./autobiz-composition-protocol"
import {
  assertPackageExtensionCompatibility,
  assertPackageExtensionCompatibilityAsync
} from "./extension-contract"

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "extension-board-boundary-"))
  roots.push(root)
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value))
  }
  const runtime = hostProjectFixture(root).manifest
  const contract = {
    apiVersion: "devclaw.extension-contract/v1" as const,
    requires: [REQUIRED_BUSINESS_CHECKS_PROTOCOL]
  }
  return { root, put, runtime, contract }
}
async function passes(root: string) {
  expect(() => assertPackageExtensionCompatibility(root)).not.toThrow()
  await expect(assertPackageExtensionCompatibilityAsync(root)).resolves.toBeUndefined()
}
async function rejects(root: string, error: string) {
  expect(() => assertPackageExtensionCompatibility(root)).toThrow(error)
  await expect(assertPackageExtensionCompatibilityAsync(root)).rejects.toThrow(error)
}

it.each(["v1", "v2"])(
  "does not attach board parsing, closure or board-version rules to ordinary Host %s",
  async (version) => {
    const f = fixture()
    f.put(
      "devclaw.project-runtime.json",
      version === "v1" ? f.runtime : wrapProjectRuntimeManifest(f.runtime, f.contract)
    )
    f.put("board_core/board_config.json", "opaque business resource".repeat(60_000))
    await passes(f.root)
    f.put("board_core/board_config.json", {
      apiVersion: 1,
      workflow: {
        nodes: [
          {
            runtimePolicy: {
              subagentConfig: { customSubagentFiles: ["agents/not-an-autobiz-agent.md"] }
            }
          }
        ]
      }
    })
    await passes(f.root)
  }
)

it("does not read an unrelated stage sidecar for a Host without a board", async () => {
  const f = fixture()
  f.put("devclaw.project-runtime.json", f.runtime)
  f.put("devclaw.stage-checks.json", "x".repeat(2048))
  await passes(f.root)
})

it("does not interpret an oversized optional stage resource as AutoBiz when a Host board resource exists", async () => {
  const f = fixture()
  f.put("devclaw.project-runtime.json", wrapProjectRuntimeManifest(f.runtime, f.contract))
  f.put("board_core/board_config.json", "opaque independent Host knowledge")
  f.put("devclaw.stage-checks.json", "x".repeat(2048))
  await passes(f.root)
})

it("still refuses oversized stage declarations for an explicit verified producer", async () => {
  const f = fixture()
  const legacy = { ...f.runtime, mode: "legacy" as const, stateOwner: "plugin" as const }
  legacy.artifacts.push({
    id: "verified-context",
    path: ".devclaw/handoffs/verified-context.json",
    required: true
  })
  f.put(
    "devclaw.project-runtime.json",
    wrapProjectRuntimeManifest(legacy, {
      ...f.contract,
      requires: [VERIFIED_ARTIFACTS_PROTOCOL],
      verifiedArtifacts: { artifactIds: ["quality"] }
    })
  )
  f.put("devclaw.stage-checks.json", "x".repeat(2048))
  await rejects(f.root, "PROJECT_HOST_FILE_LIMIT")
})

it("retains a valid Host catalog source before any executable runtime is assembled", async () => {
  const f = fixture()
  f.put("mods/business/manifest.json", {
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    kernel: {
      id: "independent",
      version: "1.0.0",
      resources: ["board_core/board_config.json"],
      runtime: { adapter: "host-linear-v1" }
    },
    modules: [
      {
        id: "draft",
        title: "Draft",
        node: { id: "draft", skill: "draft" },
        skill: { entry: "skills/draft/SKILL.md", resources: [] },
        resources: [],
        dependencies: { required: [], advisory: [] },
        checks: { validators: [], guards: [] }
      }
    ]
  })
  f.put("board_core/board_config.json", "opaque unassembled Host knowledge")
  await passes(f.root)
  f.put("devclaw.project-runtime.json", { apiVersion: "devclaw.project-runtime/v99" })
  await rejects(f.root, "PROTOCOL_UNSUPPORTED")
})

it("keeps legacy agent closure on a secondary flow even with an ordinary Host default", async () => {
  const f = fixture()
  f.put("devclaw.project-runtime.json", f.runtime)
  f.put("secondary.json", { ...f.runtime, mode: "legacy", stateOwner: "plugin" })
  f.put("devclaw.capabilities.json", {
    apiVersion: "devclaw.capabilities/v1",
    capabilities: [
      {
        id: "secondary",
        title: "Secondary",
        kind: "flow",
        usage: "project",
        entry: "secondary.json"
      }
    ]
  })
  f.put("board_core/board_config.json", {
    apiVersion: 1,
    workflow: {
      nodes: [
        {
          runtimePolicy: { subagentConfig: { customSubagentFiles: ["agents/required.md"] } }
        }
      ]
    }
  })
  await rejects(f.root, "PROJECT_AGENT_RESOURCE_MISSING")
  f.put("agents/required.md", "---\nname: required\n---\nPackaged instructions")
  await passes(f.root)
})

it("retains Host entry-provider board resources and original board API-version checks", async () => {
  const f = fixture()
  f.put(
    "devclaw.project-runtime.json",
    wrapProjectRuntimeManifest(f.runtime, {
      ...f.contract,
      requires: [REQUIRED_BUSINESS_CHECKS_PROTOCOL, CONTEXT_HANDOFF_PROTOCOL],
      context: {
        sourceAccess: "read-only",
        mutableData: "host",
        configuration: "host-resolved",
        knowledge: { required: true },
        provider: { entry: "provider.py", operations: ["session-context"] }
      }
    })
  )
  f.put("provider.py", "# Original Python context bridge")
  f.put("board_core/board_config.json", { apiVersion: 1 })
  await rejects(f.root, "EXTENSION_BOARD_VERSION_REQUIRED")
  f.put("board_core/board_config.json", {
    apiVersion: 2,
    workflow: {
      nodes: [
        {
          runtimePolicy: { subagentConfig: { customSubagentFiles: ["agents/required.md"] } }
        }
      ]
    }
  })
  await rejects(f.root, "PROJECT_AGENT_RESOURCE_MISSING")
  f.put("agents/required.md", "---\nname: required\n---\nPackaged instructions")
  await passes(f.root)
})

it("classifies the async protocol snapshot from observed bytes without a root fallback", async () => {
  const f = fixture()
  const legacy = { ...f.runtime, mode: "legacy" as const, stateOwner: "plugin" as const }
  legacy.artifacts.push({
    id: "verified-context",
    path: ".devclaw/handoffs/verified-context.json",
    required: true
  })
  f.put(
    "devclaw.project-runtime.json",
    wrapProjectRuntimeManifest(legacy, {
      ...f.contract,
      requires: [VERIFIED_ARTIFACTS_PROTOCOL],
      verifiedArtifacts: { artifactIds: ["quality"] }
    })
  )
  f.put("devclaw.stage-checks.json", {
    apiVersion: "devclaw.stage-check-adapter/v1",
    adapter: "autobiz-v1"
  })
  f.put("board_core/board_config.json", { apiVersion: 2 })
  // This test isolates the snapshot-reader boundary; actual reviewed inventory admission
  // remains covered by the existing original/warehouse compatibility integration suites.
  vi.spyOn(reviewed, "isReviewedAutobizProtocol").mockReturnValue(true)
  vi.spyOn(snapshots, "readPackageProtocolFilesAsync").mockResolvedValue([
    {
      path: "devclaw.project-runtime.json",
      bytes: Buffer.from(JSON.stringify(wrapProjectRuntimeManifest(f.runtime, f.contract)))
    },
    { path: "board_core/board_config.json", bytes: Buffer.from("opaque observed Host resource") }
  ])
  await expect(assertPackageExtensionCompatibilityAsync(f.root)).resolves.toBeUndefined()
})
