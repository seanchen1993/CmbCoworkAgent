import { describe, expect, it } from "vitest"
import type { ClawActionDescriptor } from "../../shared/mods/claw-actions"
import {
  compileNativeComposition,
  nativeCompositionSchema,
  NativeCompositionDependencyError
} from "./native-composition"
import {
  evaluateNativeCompositionAction,
  nativeCompositionActionRequirements
} from "./native-composition-dependencies"

function composition(format: "json" | "text" | "artifact-reference-v1" = "json") {
  return nativeCompositionSchema.parse({
    apiVersion: "devclaw.native-composition/v1",
    plugin: { id: "supplier-review", version: "2.0.0", title: "Review", description: "Review" },
    resources: ["knowledge/rules.md", "hooks/review.json"],
    environment: [],
    modules: [
      {
        id: "review",
        version: "2.0.0",
        title: "Review",
        skill: "modules/review/SKILL.md",
        inputs: [],
        outputs: [{ id: "report", path: "REPORT.json", contract: "supplier.report/v2" }],
        checks: [
          {
            id: "report.shape",
            kind: "json-schema",
            artifactId: "report",
            schema: {
              type: "object",
              required: ["records"],
              additionalProperties: false,
              properties: { records: { type: "array" } }
            }
          },
          {
            id: "report.verified",
            kind: "action",
            artifactId: "report",
            format,
            ...(format === "artifact-reference-v1" ? { maxBytes: 28000 } : {}),
            provider: { plugin: "supplier-validator", actionId: "verify" }
          }
        ]
      }
    ]
  })
}
function action(
  overrides: Partial<Omit<ClawActionDescriptor, "command" | "platform">> = {}
): ClawActionDescriptor {
  return {
    pluginId: "actual-installation",
    plugin: "supplier-validator",
    actionId: "verify",
    digest: "a".repeat(64),
    name: "Verify supplier records",
    platform: { id: "supplier-validation", version: "2.0.0", action: "verify" },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    ...overrides
  }
}
const files = [
  {
    path: "modules/review/SKILL.md",
    bytes: Buffer.from("---\nname: review\ndescription: Review\n---\nReview real records.")
  },
  { path: "knowledge/rules.md", bytes: Buffer.from("Original knowledge") },
  { path: "hooks/review.json", bytes: Buffer.from('{"originalHook":true}') }
]

describe("native composition dependency discovery", () => {
  it("compiles selected public configuration keys without embedding native values in the lock", () => {
    const source = composition("artifact-reference-v1")
    source.configuration = { userConfig: {
      audience: { type: "string", title: "Audience", description: "UI selection", default: "product" },
      timeout: { type: "number", title: "Timeout", description: "UI timeout", default: 1000 }
    } }
    const check = source.modules[0].checks[1]
    if (check.kind !== "action") throw Error("expected action")
    check.configurationKeys = ["audience", "timeout"]
    const provider = action({ inputSchema: { type: "object", required: ["configuration"],
      properties: { configuration: { type: "object" } } } })
    const result = compileNativeComposition(source, { files, actionCatalog: [provider] })
    expect(result.actionLock.bindings[0].configurationKeys).toEqual(["audience", "timeout"])
    expect(result.actionLock.bindings[0].input).toEqual({})
    expect(result.actionLock.bindings[0].config).toEqual({})
    expect(JSON.stringify(result.actionLock)).not.toContain("product")
    delete check.configurationKeys
    expect(() => compileNativeComposition(source, { files, actionCatalog: [provider] }))
      .toThrow("NATIVE_COMPOSITION_PROVIDER_CONTRACT_MISMATCH")
  })

  it.each([
    { type: "string", sensitive: true }, { type: "file" }, { type: "directory" }, undefined
  ])("rejects private, path or unknown selected configuration at compilation: %j", (field) => {
    const source = composition("artifact-reference-v1")
    source.configuration = { userConfig: field ? { selected: {
      ...field, title: "Selected", description: "Native UI field"
    } } : {} }
    const check = source.modules[0].checks[1]
    if (check.kind !== "action") throw Error("expected action")
    check.configurationKeys = ["selected"]
    expect(() => compileNativeComposition(source, { files, actionCatalog: [action()] }))
      .toThrow("NATIVE_COMPOSITION_CHECK_CONFIGURATION_INVALID")
  })

  it("rejects configuration on non-reference checks and invalid selectors before provider resolution", () => {
    const source = composition()
    const check = source.modules[0].checks[1]
    if (check.kind !== "action") throw Error("expected action")
    check.configurationKeys = ["audience"]
    expect(() => compileNativeComposition(source, { files, actionCatalog: [] }))
      .toThrow("NATIVE_COMPOSITION_CHECK_CONFIGURATION_INVALID")
    for (const keys of [[], ["a", "a"], ["constructor"], Array.from({ length: 17 }, (_, i) => `k${i}`)]) {
      check.configurationKeys = keys
      expect(() => compileNativeComposition(source, { files, actionCatalog: [] }))
        .toThrow("PROJECT_CHECK_CONFIGURATION_KEYS_INVALID")
    }
  })

  it("reports exact unresolved contract and a consent preserving source-authoring route", () => {
    try {
      compileNativeComposition(composition(), { files, actionCatalog: [] })
      throw Error("expected failure")
    } catch (error) {
      expect(error).toBeInstanceOf(NativeCompositionDependencyError)
      const diagnostic = (error as NativeCompositionDependencyError).dependencies[0]
      expect(diagnostic).toMatchObject({
        plugin: "supplier-validator",
        actionId: "verify",
        usedBy: "report.verified",
        moduleId: "review",
        artifactId: "report",
        artifactContract: "supplier.report/v2",
        state: "missing-or-not-authorized",
        candidates: []
      })
      expect(diagnostic.next).toContain("save/check/request_reuse")
      expect(diagnostic.next).toContain("未安装和未授权")
      expect(diagnostic).not.toHaveProperty("pluginId")
    }
  })

  it("rejects an execution action as a reference check even when config supplies its missing input", () => {
    const source = composition("artifact-reference-v1")
    const check = source.modules[0].checks[1]
    if (check.kind !== "action") throw Error("expected action")
    check.config = { phase: "review", argv: ["node", "--test"] }
    const provider = action({
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["phase", "argv"],
        properties: { phase: { type: "string" }, argv: { type: "array" } }
      }
    })
    const result = evaluateNativeCompositionAction(
      nativeCompositionActionRequirements(source)[0],
      provider
    )
    expect(result.status).toBe("incompatible")
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "INPUT_REQUIRED_NOT_GUARANTEED", field: "phase" }),
        expect.objectContaining({ code: "INPUT_FIELD_REJECTED", field: "current" })
      ])
    )
    expect(() => compileNativeComposition(source, { files, actionCatalog: [provider] })).toThrow(
      "NATIVE_COMPOSITION_PROVIDER_CONTRACT_MISMATCH"
    )
  })

  it("rejects missing required JSON artifact fields and command reference providers", () => {
    const requirement = nativeCompositionActionRequirements(composition())[0]
    expect(
      evaluateNativeCompositionAction(
        requirement,
        action({
          inputSchema: {
            type: "object",
            required: ["command"],
            properties: { command: { type: "string" } }
          }
        })
      ).issues
    ).toContainEqual(expect.objectContaining({ field: "command" }))
    expect(
      evaluateNativeCompositionAction(
        nativeCompositionActionRequirements(composition("artifact-reference-v1"))[0],
        { ...action(), platform: undefined, command: "supplier-review" }
      ).issues
    ).toContainEqual(expect.objectContaining({ code: "ARTIFACT_REFERENCE_PLATFORM_REQUIRED" }))
  })

  it("accepts a real independent provider without claiming semantics and preserves original resources", () => {
    const provider = action({
      inputSchema: {
        type: "object",
        required: ["records"],
        properties: { records: { type: "array" } },
        additionalProperties: false
      }
    })
    const source = composition()
    expect(
      evaluateNativeCompositionAction(nativeCompositionActionRequirements(source)[0], provider)
    ).toMatchObject({ status: "no-static-blocker", businessSemanticsVerified: false, issues: [] })
    const result = compileNativeComposition(source, { files, actionCatalog: [provider] })
    expect(result.actionLock.bindings[0].ref).toEqual({
      pluginId: provider.pluginId,
      plugin: provider.plugin,
      digest: provider.digest,
      actionId: provider.actionId
    })
    for (const original of files.filter((file) => !file.path.endsWith("SKILL.md")))
      expect(result.files.find((file) => file.path === original.path)?.bytes).toEqual(
        original.bytes
      )
  })

  it("does not reject a valid union input or silently resolve duplicate installations", () => {
    const provider = action({
      inputSchema: {
        type: "object",
        anyOf: [
          { type: "object", required: ["command"] },
          { type: "object", required: ["current", "sources"] }
        ]
      }
    })
    const source = composition("artifact-reference-v1")
    expect(
      evaluateNativeCompositionAction(nativeCompositionActionRequirements(source)[0], provider)
        .issues
    ).toEqual([])
    expect(() =>
      compileNativeComposition(source, { files, actionCatalog: [provider, provider] })
    ).toThrow("NATIVE_COMPOSITION_PROVIDER_UNRESOLVED")
  })
})
