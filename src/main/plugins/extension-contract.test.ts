import { afterEach, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  assertPackageExtensionCompatibility,
  readPackageExtensionContract
} from "./extension-contract"
import { HostPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import {
  CONTEXT_HANDOFF_PROTOCOL,
  EXTENSION_CONTRACT_API_VERSION,
  REQUIRED_BUSINESS_CHECKS_PROTOCOL,
  VERIFIED_ARTIFACTS_PROTOCOL,
  parseProjectRuntimeManifestV1,
  wrapProjectRuntimeManifest
} from "../../shared/project-runtime"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "extension-compat-"))
  roots.push(root)
  const put = (value: unknown) =>
    writeFileSync(join(root, "devclaw.project-runtime.json"), JSON.stringify(value))
  const runtime = parseProjectRuntimeManifestV1({
    apiVersion: "devclaw.project-runtime/v1",
    plugin: { id: "business", version: "1.0.0" },
    mode: "legacy",
    stateOwner: "plugin",
    stages: [],
    actions: [],
    artifacts: [],
    checks: [],
    environment: [],
    capabilities: {
      execution: true,
      conditionalTransition: false,
      idempotency: false,
      reconciliation: false,
      cancellation: true
    }
  })
  const contract = {
    apiVersion: EXTENSION_CONTRACT_API_VERSION,
    requires: [REQUIRED_BUSINESS_CHECKS_PROTOCOL]
  }
  return { root, put, runtime, contract }
}

it("checks actual package protocol bytes and source changes rather than persisted UI claims", () => {
  const f = fixture()
  expect(readPackageExtensionContract(f.root)).toBeUndefined()
  f.put(f.runtime)
  expect(readPackageExtensionContract(f.root)).toBeUndefined()
  f.put(wrapProjectRuntimeManifest(f.runtime, f.contract))
  expect(readPackageExtensionContract(f.root)).toEqual(f.contract)
  f.put({
    apiVersion: "devclaw.project-runtime/v2",
    runtime: f.runtime,
    extensionContract: { ...f.contract, requires: ["unknown.protocol/v1"] }
  })
  expect(() => readPackageExtensionContract(f.root)).toThrow("PROTOCOL_UNSUPPORTED")
  f.put({ ...f.runtime, apiVersion: "devclaw.project-runtime/v99" })
  expect(() => readPackageExtensionContract(f.root)).toThrow("PROTOCOL_UNSUPPORTED")
})

it("rejects checked export declarations on unsupported producers at the actual package gate", () => {
  const f = fixture()
  const declaration = { ...f.contract, requires: [VERIFIED_ARTIFACTS_PROTOCOL],
    verifiedArtifacts: { artifactIds: ["quality"] } }
  f.put(wrapProjectRuntimeManifest(f.runtime, declaration))
  expect(() => assertPackageExtensionCompatibility(f.root)).toThrow("ADAPTER_UNSUPPORTED")
  writeFileSync(join(f.root, "devclaw.stage-checks.json"), JSON.stringify({
    apiVersion: "devclaw.stage-check-adapter/v1", adapter: "autobiz-v1"
  }))
  f.runtime.artifacts.push({ id: "verified-context", path: ".devclaw/handoffs/verified-context.json", required: true })
  f.put(wrapProjectRuntimeManifest(f.runtime, declaration))
  // A copied adapter name is not a reviewed producer or executable protocol admission.
  expect(readPackageExtensionContract(f.root)?.verifiedArtifacts?.artifactIds).toEqual(["quality"])
  expect(() => assertPackageExtensionCompatibility(f.root)).toThrow("ADAPTER_UNSUPPORTED")
})

it("requires provider implementation inside the package and binds the full v2 contract into snapshots", () => {
  const f = fixture()
  const envelope = wrapProjectRuntimeManifest(f.runtime, {
    ...f.contract,
    requires: [REQUIRED_BUSINESS_CHECKS_PROTOCOL, CONTEXT_HANDOFF_PROTOCOL],
    context: {
      sourceAccess: "read-only",
      mutableData: "host",
      configuration: "host-resolved",
      knowledge: { required: true, binding: "knowledge" },
      provider: { entry: "provider.py", operations: ["session-context"] }
    }
  })
  f.put(envelope)
  expect(() => readPackageExtensionContract(f.root)).toThrow("PROVIDER_MISSING")
  writeFileSync(join(f.root, "provider.py"), "# plugin-owned knowledge provider\n")
  expect(readPackageExtensionContract(f.root)?.context?.knowledge.required).toBe(true)
  const store = join(f.root, "../", `${f.root.split(/[\\/]/).pop()}-snapshots`)
  mkdirSync(store)
  roots.push(store)
  const snapshots = new HostPackageSnapshots(store)
  const before = snapshots.capture(f.root)
  envelope.extensionContract.context!.knowledge.binding = "otherKnowledge"
  f.put(envelope)
  const after = snapshots.capture(f.root)
  expect(before.digest).not.toBe(after.digest)
  expect(readPackageExtensionContract(before.root)?.context?.knowledge.binding).toBe("knowledge")
  expect(readPackageExtensionContract(after.root)?.context?.knowledge.binding).toBe(
    "otherKnowledge"
  )
})

it("rejects an unsupported secondary flow instead of checking only the default entry", () => {
  const f = fixture()
  f.put(f.runtime)
  writeFileSync(
    join(f.root, "custom-runtime.json"),
    JSON.stringify({
      apiVersion: "devclaw.project-runtime/v2",
      runtime: f.runtime,
      extensionContract: { ...f.contract, requires: ["unknown.protocol/v1"] }
    })
  )
  writeFileSync(
    join(f.root, "devclaw.capabilities.json"),
    JSON.stringify({
      apiVersion: "devclaw.capabilities/v1",
      capabilities: [
        {
          id: "custom",
          title: "Custom",
          kind: "flow",
          usage: "project",
          entry: "custom-runtime.json"
        }
      ]
    })
  )
  expect(readPackageExtensionContract(f.root)).toBeUndefined()
  expect(() => assertPackageExtensionCompatibility(f.root)).toThrow("PROTOCOL_UNSUPPORTED")
})
