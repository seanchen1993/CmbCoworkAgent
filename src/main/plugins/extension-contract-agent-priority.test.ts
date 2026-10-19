import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { afterEach, expect, it, vi } from "vitest"
import {
  REQUIRED_BUSINESS_CHECKS_PROTOCOL,
  VERIFIED_ARTIFACTS_PROTOCOL,
  wrapProjectRuntimeManifest
} from "../../shared/project-runtime"
import { hostProjectFixture } from "../harness-board/project-runtime/host-fixtures.test-helper"
import * as reviewed from "./autobiz-composition-protocol"
import {
  assertPackageExtensionCompatibility,
  assertPackageExtensionCompatibilityAsync
} from "./extension-contract"

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    expect(dirname(root)).toBe(tmpdir())
    expect(root.split(/[\\/]/).at(-1)).toMatch(/^extension-agent-priority-/)
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "extension-agent-priority-"))
  roots.push(root)
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value))
  }
  const host = hostProjectFixture(root).manifest
  const legacy = { ...host, mode: "legacy" as const, stateOwner: "plugin" as const }
  legacy.artifacts.push({
    id: "verified-context",
    path: ".devclaw/handoffs/verified-context.json",
    required: true
  })
  put("devclaw.project-runtime.json", wrapProjectRuntimeManifest(legacy, {
    apiVersion: "devclaw.extension-contract/v1",
    requires: [REQUIRED_BUSINESS_CHECKS_PROTOCOL, VERIFIED_ARTIFACTS_PROTOCOL],
    verifiedArtifacts: { artifactIds: ["quality"] }
  }))
  put("devclaw.stage-checks.json", {
    apiVersion: "devclaw.stage-check-adapter/v1",
    adapter: "autobiz-v1"
  })
  put("board_core/board_config.json", {
    apiVersion: 2,
    workflow: {
      nodes: [{
        runtimePolicy: {
          subagentConfig: { customSubagentFiles: ["agents/required.md"] }
        }
      }]
    }
  })
  return { root, put, legacy }
}

async function rejects(root: string, error: string) {
  expect(() => assertPackageExtensionCompatibility(root)).toThrow(error)
  await expect(assertPackageExtensionCompatibilityAsync(root)).rejects.toThrow(error)
}

it("reports missing mandatory agents before inventory rejection and still refuses unreviewed complete resources", async () => {
  const f = fixture()
  // Call through to the actual inventory checker; this fixture is deliberately not a reviewed package.
  const inventory = vi.spyOn(reviewed, "isReviewedAutobizProtocol")
  await rejects(f.root, "PROJECT_AGENT_RESOURCE_MISSING")
  expect(inventory).not.toHaveBeenCalled()
  f.put("agents/required.md", "---\nname: required\n---\nActual packaged agent instructions")
  await rejects(f.root, "EXTENSION_CONTRACT_VERIFIED_ARTIFACTS_ADAPTER_UNSUPPORTED")
  expect(inventory).toHaveBeenCalledTimes(2)
})

it("checks unsupported secondary protocols before any missing-agent diagnostic", async () => {
  const f = fixture()
  f.put("secondary.json", {
    apiVersion: "devclaw.project-runtime/v2",
    runtime: f.legacy,
    extensionContract: {
      apiVersion: "devclaw.extension-contract/v1",
      requires: ["unknown.protocol/v99"]
    }
  })
  f.put("devclaw.capabilities.json", {
    apiVersion: "devclaw.capabilities/v1",
    capabilities: [{
      id: "secondary",
      title: "Secondary",
      kind: "flow",
      usage: "project",
      entry: "secondary.json"
    }]
  })
  await rejects(f.root, "PROTOCOL_UNSUPPORTED")
})

it("does not disguise malformed runtime metadata as a missing-agent failure", async () => {
  const f = fixture()
  f.put("devclaw.project-runtime.json", {
    apiVersion: "devclaw.project-runtime/v1",
    mode: "legacy"
  })
  await rejects(f.root, "PROJECT_RUNTIME_MANIFEST_INVALID")
})

it("retains the strict verified-producer declaration gate before resource diagnostics", async () => {
  const f = fixture()
  f.put("devclaw.stage-checks.json", {
    apiVersion: "devclaw.stage-check-adapter/v1",
    adapter: "unsupported-adapter"
  })
  const inventory = vi.spyOn(reviewed, "isReviewedAutobizProtocol")
  await rejects(f.root, "EXTENSION_CONTRACT_VERIFIED_ARTIFACTS_ADAPTER_UNSUPPORTED")
  expect(inventory).not.toHaveBeenCalled()
})
