import { describe, expect, it } from "vitest"
import {
  CONTEXT_HANDOFF_PROTOCOL,
  CONTEXT_MATERIALS_PROTOCOL,
  EXECUTION_RESOURCES_PROTOCOL,
  EXTENSION_CONTRACT_API_VERSION,
  REQUIRED_BUSINESS_CHECKS_PROTOCOL,
  VERIFIED_ARTIFACTS_PROTOCOL,
  parseExtensionContract,
  projectRuntimeExtensionContract
} from "./extension-contract"
import {
  parseProjectRuntimeManifest,
  parseProjectRuntimeManifestV1,
  preserveProjectRuntimeEnvelope,
  wrapProjectRuntimeManifest
} from "./manifest"
import type { ProjectRuntimeManifest } from "./types"

const runtime = (mode: "host" | "legacy" = "host"): ProjectRuntimeManifest => ({
  apiVersion: "devclaw.project-runtime/v1",
  plugin: { id: "docs", version: "1.0.0" },
  mode,
  stateOwner: mode === "host" ? "host" : "plugin",
  stages: [
    {
      id: "review",
      title: "Review",
      actionIds: [],
      artifactIds: [],
      checkIds: [],
      approval: "none"
    }
  ],
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
const required = {
  apiVersion: EXTENSION_CONTRACT_API_VERSION,
  requires: [REQUIRED_BUSINESS_CHECKS_PROTOCOL]
}
const context = {
  sourceAccess: "read-only",
  mutableData: "host",
  configuration: "host-resolved",
  knowledge: { required: true, binding: "knowledgeDirectory" },
  provider: { entry: "mods/context-provider.py", operations: ["session-context", "sync-knowledge"] }
}

describe("negotiated extension contracts", () => {
  it("negotiates execution profiles and config-backed workspace names without accepting arbitrary roots", () => {
    const executionResources = { profiles: ["agents/reviewer.md"],
      workspaces: [{ id: "backend", binding: "repository" }] }
    const value = { ...required, requires: [EXECUTION_RESOURCES_PROTOCOL], executionResources }
    expect(parseExtensionContract(value).executionResources).toEqual(executionResources)
    for (const resources of [
      { ...executionResources, profiles: ["../reviewer.md"] },
      { ...executionResources, profiles: ["reviewer.js"] },
      { ...executionResources, profiles: ["agents/reviewer.md", "agents/Reviewer.md"] },
      { ...executionResources, workspaces: [{ id: "backend", path: "C:/source" }] },
      { ...executionResources, workspaces: [executionResources.workspaces[0], executionResources.workspaces[0]] },
      { profiles: [], workspaces: [] }
    ]) expect(() => parseExtensionContract({ ...value, executionResources: resources })).toThrow()
    expect(() => parseExtensionContract({ ...value, requires: [REQUIRED_BUSINESS_CHECKS_PROTOCOL] })).toThrow()
    expect(() => parseExtensionContract({ ...value, executionResources: undefined })).toThrow()
  })
  it("negotiates bounded named materials only for an action provider with explicit knowledge binding", () => {
    const materials = { roots: [
      { id: "methods", source: "package", path: "knowledge" },
      { id: "business", source: "knowledge" }
    ], configuration: ["selectedDeployUnits"] }
    const provider = { actionId: "select-context", operations: ["session-context"], materials }
    const value = { ...required, requires: [CONTEXT_HANDOFF_PROTOCOL, CONTEXT_MATERIALS_PROTOCOL],
      context: { ...context, provider } }
    expect(parseExtensionContract(value).context?.provider?.materials).toEqual(materials)
    expect(() => parseExtensionContract({ ...value, requires: [CONTEXT_HANDOFF_PROTOCOL] })).toThrow()
    expect(() => parseExtensionContract({ ...value,
      context: { ...value.context, knowledge: { required: false } } })).toThrow()
    for (const invalid of [
      { ...materials, roots: [...materials.roots, materials.roots[0]] },
      { ...materials, roots: [{ id: "x", source: "package", path: "../outside" }] },
      { ...materials, configuration: ["key", "key"] },
      { ...materials, configuration: ["secret", 3] },
      { roots: [], configuration: [] }
    ]) expect(() => parseExtensionContract({ ...value,
      context: { ...value.context, provider: { ...provider, materials: invalid } } })).toThrow()
    expect(() => parseExtensionContract({ ...value,
      context: { ...value.context, provider: { entry: "context.py",
        operations: ["session-context"], materials } } })).toThrow()
  })
  it("requires explicit version negotiation and bounded unique checked artifact IDs", () => {
    const value = { ...required, requires: [VERIFIED_ARTIFACTS_PROTOCOL],
      verifiedArtifacts: { artifactIds: ["sql_results", "quality"] } }
    expect(parseExtensionContract(value).verifiedArtifacts).toEqual(value.verifiedArtifacts)
    expect(() => parseExtensionContract(value, [REQUIRED_BUSINESS_CHECKS_PROTOCOL])).toThrow("PROTOCOL_UNSUPPORTED")
    expect(() => parseExtensionContract({ ...value, requires: required.requires })).toThrow("PROTOCOL_REQUIRED")
    expect(() => parseExtensionContract({ ...value, verifiedArtifacts: undefined })).toThrow("REQUIRED")
    for (const artifactIds of [[], ["quality", "quality"], ["../escape"], Array.from({ length: 65 }, (_, i) => `a${i}`)])
      expect(() => parseExtensionContract({ ...value, verifiedArtifacts: { artifactIds } })).toThrow("INVALID")
    expect(() => parseExtensionContract({ ...value, verifiedArtifacts: { artifactIds: ["ok"], path: "invented" } })).toThrow()
  })
  it("accepts an existing locked action as a context provider without a script runtime", () => {
    const value = { ...required, requires: [CONTEXT_HANDOFF_PROTOCOL], context: {
      ...context, provider: { actionId: "resolve-knowledge", operations: ["session-context"] }
    } }
    expect(parseExtensionContract(value).context?.provider).toEqual(value.context.provider)
    for (const provider of [
      { ...value.context.provider, entry: "provider.py" },
      { actionId: "resolve-knowledge", operations: ["sync-knowledge"] },
      { actionId: "../escape", operations: ["session-context"] },
      { operations: ["session-context"] }
    ]) expect(() => parseExtensionContract({ ...value, context: { ...value.context, provider } })).toThrow()
  })
  it.each(["host", "legacy"] as const)(
    "reuses %s execution and really rejects the v2 entry in the old v1 parser",
    (mode) => {
      const original = runtime(mode)
      const envelope = wrapProjectRuntimeManifest(original, required)
      expect(parseProjectRuntimeManifest(envelope)).toEqual(original)
      expect(() => parseProjectRuntimeManifestV1(envelope)).toThrow(
        "PROJECT_RUNTIME_MANIFEST_INVALID"
      )
      expect(parseProjectRuntimeManifest(original)).toEqual(original)
      expect(projectRuntimeExtensionContract(original)).toBeUndefined()
    }
  )

  it("does not treat an ignored sidecar as an execution-version gate", () => {
    expect(() =>
      parseProjectRuntimeManifest({ ...runtime(), extensionContract: required })
    ).toThrow()
    expect(projectRuntimeExtensionContract(required)).toBeUndefined()
  })

  it("negotiates provider data and configuration declarations without accepting local paths or credentials", () => {
    const contract = {
      ...required,
      requires: [...required.requires, CONTEXT_HANDOFF_PROTOCOL],
      context
    }
    expect(parseExtensionContract(contract).context).toEqual(context)
    for (const path of [
      "../outside.py",
      "C:/machine.py",
      "\\server\\source.py",
      "/absolute.py",
      "mods/../escape.py"
    ])
      expect(() =>
        parseExtensionContract({
          ...contract,
          context: { ...context, provider: { ...context.provider, entry: path } }
        })
      ).toThrow("EXTENSION_CONTRACT_INVALID")
    expect(() =>
      parseExtensionContract({ ...contract, context: { ...context, secret: "token" } })
    ).toThrow()
    expect(() =>
      parseExtensionContract({ ...contract, context: { ...context, sourceAccess: "write" } })
    ).toThrow()
  })

  it("rejects unknown mandatory protocols, malformed and unnegotiated context", () => {
    expect(() => parseExtensionContract({ ...required, requires: ["future.protocol/v9"] })).toThrow(
      "PROTOCOL_UNSUPPORTED"
    )
    expect(() => parseExtensionContract(required, [])).toThrow("PROTOCOL_UNSUPPORTED")
    expect(() => parseExtensionContract({ ...required, context })).toThrow(
      "CONTEXT_PROTOCOL_REQUIRED"
    )
    expect(() =>
      parseExtensionContract({ ...required, requires: [CONTEXT_HANDOFF_PROTOCOL] })
    ).toThrow("CONTEXT_REQUIRED")
    expect(() => parseExtensionContract({ ...required, requires: Array(1) })).toThrow()
    expect(() =>
      parseExtensionContract({
        ...required,
        requires: [...required.requires, ...required.requires]
      })
    ).toThrow()
  })

  it("keeps the v2 guarantee envelope through authoring transforms", () => {
    const envelope = wrapProjectRuntimeManifest(runtime(), required)
    const changed = { ...runtime(), plugin: { id: "derived-docs", version: "2.0.0" } }
    expect(
      projectRuntimeExtensionContract(preserveProjectRuntimeEnvelope(envelope, changed))
    ).toEqual(required)
    expect(
      parseProjectRuntimeManifest(preserveProjectRuntimeEnvelope(envelope, changed)).plugin
    ).toEqual(changed.plugin)
    expect(preserveProjectRuntimeEnvelope(runtime(), changed)).toEqual(changed)
  })
})
