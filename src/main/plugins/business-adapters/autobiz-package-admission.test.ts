import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import {
  CONTEXT_HANDOFF_PROTOCOL,
  wrapProjectRuntimeManifest
} from "../../../shared/project-runtime"
import { hostProjectFixture } from "../../harness-board/project-runtime/host-fixtures.test-helper"
import { assertHostPackageSupported } from "../../harness-board/project-runtime/package-preflight"
import {
  assertAutobizPackageAgentResources,
  assertAutobizPackageAgentResourcesFromRoot,
  hasAutobizBoardContext,
  isAutobizLegacyProjectRoot,
  readAutobizPackageSemantics,
  readReviewedAutobizStageAdapter
} from "./autobiz-package-admission"

const boardPath = "board_core/board_config.json"
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const runtime = () => hostProjectFixture("unused").manifest
const missingAgent = {
  workflow: {
    nodes: [{ runtimePolicy: { subagentConfig: { customSubagentFiles: ["agents/missing.md"] } } }]
  }
}
function files(declaration?: unknown, board: unknown = missingAgent) {
  const result = new Map<string, Buffer>([
    ["plugin.json", Buffer.from(JSON.stringify({ name: "docs", version: "1.0.0" }))],
    [boardPath, Buffer.from(JSON.stringify(board))],
    ["skills/draft/SKILL.md", Buffer.from("Draft instructions")],
    ["skills/review/SKILL.md", Buffer.from("Review instructions")]
  ])
  if (declaration !== undefined)
    result.set("devclaw.project-runtime.json", Buffer.from(JSON.stringify(declaration)))
  return result
}
function materialize(source: ReadonlyMap<string, Buffer>) {
  const root = mkdtempSync(join(tmpdir(), "autobiz-admission-gating-"))
  roots.push(root)
  for (const [path, bytes] of source) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), bytes)
  }
  return root
}
function contextRuntime(provider: { entry: string } | { actionId: string }) {
  return wrapProjectRuntimeManifest(runtime(), {
    apiVersion: "devclaw.extension-contract/v1",
    requires: [CONTEXT_HANDOFF_PROTOCOL],
    context: {
      sourceAccess: "read-only",
      mutableData: "host",
      configuration: "host-resolved",
      knowledge: { required: true },
      provider: { ...provider, operations: ["session-context"] }
    }
  })
}

it("admits an explicit independent Host despite a same-named unrelated board resource", () => {
  const source = files(runtime(), { workflow: "an unrelated Host business document" })
  expect(() => assertAutobizPackageAgentResources(source)).not.toThrow()
  const root = materialize(source)
  expect(() => assertAutobizPackageAgentResourcesFromRoot(root)).not.toThrow()
  expect(() => assertHostPackageSupported(root, runtime())).not.toThrow()
  expect(hasAutobizBoardContext(root)).toBe(false)
  expect(isAutobizLegacyProjectRoot(root)).toBe(false)
})

it("does not interpret even invalid board JSON as an AutoBiz declaration for an explicit Host", () => {
  const source = files(runtime())
  source.set(boardPath, Buffer.from("this is an opaque business resource, not board JSON"))
  expect(() => assertAutobizPackageAgentResources(source)).not.toThrow()
  const root = materialize(source)
  expect(() => assertAutobizPackageAgentResourcesFromRoot(root)).not.toThrow()
  expect(hasAutobizBoardContext(root)).toBe(false)
})

it.each(["declared-legacy", "historical-no-runtime"])(
  "retains legacy resource closure and standalone-context protection: %s",
  (kind) => {
    const source = files(
      kind === "declared-legacy"
        ? { ...runtime(), mode: "legacy", stateOwner: "plugin" }
        : undefined
    )
    expect(() => assertAutobizPackageAgentResources(source)).toThrow(
      "PROJECT_AGENT_RESOURCE_MISSING"
    )
    const root = materialize(source)
    expect(() => assertAutobizPackageAgentResourcesFromRoot(root)).toThrow(
      "PROJECT_AGENT_RESOURCE_MISSING"
    )
    expect(hasAutobizBoardContext(root)).toBe(true)
    expect(isAutobizLegacyProjectRoot(root)).toBe(true)
    source.set("agents/missing.md", Buffer.from("Actual packaged agent instructions"))
    expect(() => assertAutobizPackageAgentResources(source)).not.toThrow()
  }
)

it("keeps the existing entry-based Host context bridge's board/agent resource checks", () => {
  const source = files(contextRuntime({ entry: "mods/context/provider.py" }))
  source.set("mods/context/provider.py", Buffer.from("# Never executed by admission"))
  expect(() => assertAutobizPackageAgentResources(source)).toThrow("PROJECT_AGENT_RESOURCE_MISSING")
  const root = materialize(source)
  expect(() => assertAutobizPackageAgentResourcesFromRoot(root)).toThrow(
    "PROJECT_AGENT_RESOURCE_MISSING"
  )
  expect(hasAutobizBoardContext(root)).toBe(true)
  expect(isAutobizLegacyProjectRoot(root)).toBe(false)
})

it("classifies Host entry context without shrinking the original 1 MiB board consumption limit", () => {
  const source = files(contextRuntime({ entry: "mods/context/provider.py" }), {
    ...missingAgent,
    description: "x".repeat(300 * 1024)
  })
  source.set("mods/context/provider.py", Buffer.from("# Packaged context provider"))
  source.set(
    "agents/missing.md",
    Buffer.from("---\nname: packaged-agent\n---\nRequired instructions")
  )
  const root = materialize(source)
  expect(hasAutobizBoardContext(root)).toBe(true)
  expect(isAutobizLegacyProjectRoot(root)).toBe(false)
  expect(() => assertAutobizPackageAgentResourcesFromRoot(root)).not.toThrow()
})

it("keeps unsafe board resources rejected during metadata-only context classification", () => {
  const root = materialize(files(contextRuntime({ entry: "mods/context/provider.py" })))
  linkSync(join(root, boardPath), join(root, "duplicate-board.json"))
  expect(() => hasAutobizBoardContext(root)).toThrow("PROJECT_HOST_FILE_UNSAFE")
})

it("does not turn a generic action-based Host context into the AutoBiz board protocol", () => {
  const source = files(contextRuntime({ actionId: "resolve-context" }), { workflow: "other" })
  expect(() => assertAutobizPackageAgentResources(source)).not.toThrow()
  const root = materialize(source)
  expect(() => assertAutobizPackageAgentResourcesFromRoot(root)).not.toThrow()
  expect(hasAutobizBoardContext(root)).toBe(false)
  // This classification does not approve the action. The original action lock/provider
  // admission still validates an actionId contract at its execution boundary.
})

it("keeps explicit AutoBiz stage safety checks without trusting a self-authored adapter label", () => {
  const source = files(runtime())
  source.set(
    "devclaw.stage-checks.json",
    Buffer.from(
      JSON.stringify({
        apiVersion: "devclaw.stage-check-adapter/v1",
        adapter: "autobiz-v1"
      })
    )
  )
  expect(() => assertAutobizPackageAgentResources(source)).toThrow("PROJECT_AGENT_RESOURCE_MISSING")
  const root = materialize(source)
  expect(() => assertAutobizPackageAgentResourcesFromRoot(root)).toThrow(
    "PROJECT_AGENT_RESOURCE_MISSING"
  )
  expect(hasAutobizBoardContext(root)).toBe(true)
  expect(readReviewedAutobizStageAdapter(source)).toBeUndefined()
})

it.each(["malformed-json", "malformed-host", "unsupported-context"])(
  "fails closed rather than trusting an invalid Host declaration: %s",
  (kind) => {
    const source = files(runtime())
    const declaration =
      kind === "malformed-json"
        ? "{"
        : JSON.stringify(
            kind === "malformed-host"
              ? { mode: "host", stateOwner: "host" }
              : {
                  apiVersion: "devclaw.project-runtime/v2",
                  runtime: runtime(),
                  extensionContract: {
                    apiVersion: "devclaw.extension-contract/v1",
                    requires: ["unknown/v9"]
                  }
                }
          )
    source.set("devclaw.project-runtime.json", Buffer.from(declaration))
    expect(() => assertAutobizPackageAgentResources(source)).toThrow()
    const root = materialize(source)
    expect(() => assertAutobizPackageAgentResourcesFromRoot(root)).toThrow()
    expect(() => hasAutobizBoardContext(root)).toThrow()
  }
)

function hostCatalog() {
  return {
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    kernel: {
      id: "independent",
      version: "1.0.0",
      resources: [],
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
  }
}

it("recognizes a valid unassembled Host catalog without inferring legacy from board resources", () => {
  const source = files(undefined)
  source.set("mods/business/manifest.json", Buffer.from(JSON.stringify(hostCatalog())))
  expect(() => assertAutobizPackageAgentResources(source)).not.toThrow()
  const root = materialize(source)
  expect(() => assertAutobizPackageAgentResourcesFromRoot(root)).not.toThrow()
  expect(hasAutobizBoardContext(root)).toBe(false)
  expect(isAutobizLegacyProjectRoot(root)).toBe(false)
})

it.each(["invalid-catalog", "invalid-runtime", "unknown-runtime"])(
  "never uses a Host catalog label to bypass malformed package declarations: %s",
  (kind) => {
    const source = files(undefined)
    source.set(
      "mods/business/manifest.json",
      Buffer.from(
        JSON.stringify(
          kind === "invalid-catalog"
            ? { kernel: { runtime: { adapter: "host-linear-v1" } } }
            : hostCatalog()
        )
      )
    )
    if (kind !== "invalid-catalog")
      source.set(
        "devclaw.project-runtime.json",
        Buffer.from(
          kind === "invalid-runtime"
            ? "{"
            : JSON.stringify({ ...runtime(), apiVersion: "unknown/v99" })
        )
      )
    expect(() => assertAutobizPackageAgentResources(source)).toThrow()
    const root = materialize(source)
    expect(() => hasAutobizBoardContext(root)).toThrow()
    expect(() => isAutobizLegacyProjectRoot(root)).toThrow()
  }
)

it("does not inspect unrelated runtime or oversized stage sidecars when no board exists", () => {
  const source = files(runtime())
  source.delete(boardPath)
  source.set("devclaw.stage-checks.json", Buffer.alloc(2048, 120))
  const root = materialize(source)
  expect(hasAutobizBoardContext(root)).toBe(false)
  expect(() => assertAutobizPackageAgentResourcesFromRoot(root)).not.toThrow()
  expect(isAutobizLegacyProjectRoot(root)).toBe(false)
  writeFileSync(join(root, "devclaw.project-runtime.json"), "{")
  expect(hasAutobizBoardContext(root)).toBe(false)
  expect(() => isAutobizLegacyProjectRoot(root)).toThrow()
})

it("does not impose a legacy board content limit on opaque Host resources", () => {
  const source = files(runtime())
  source.set(boardPath, Buffer.alloc(1024 * 1024 + 1, 120))
  const root = materialize(source)
  expect(hasAutobizBoardContext(root)).toBe(false)
  expect(isAutobizLegacyProjectRoot(root)).toBe(false)
  expect(() => assertAutobizPackageAgentResourcesFromRoot(root)).not.toThrow()
})

it("keeps map and root classification equal for unrelated oversized Host stage sidecars", () => {
  const source = files(runtime())
  source.set("devclaw.stage-checks.json", Buffer.alloc(2048, 120))
  expect(readAutobizPackageSemantics((path) => source.get(path), true)).toEqual({
    legacyProject: false,
    boardContext: false
  })
  expect(() => assertAutobizPackageAgentResources(source)).not.toThrow()
  const root = materialize(source)
  expect(hasAutobizBoardContext(root)).toBe(false)
  expect(isAutobizLegacyProjectRoot(root)).toBe(false)
  expect(() => assertAutobizPackageAgentResourcesFromRoot(root)).not.toThrow()
})

it.each([
  "PROJECT_HOST_FILE_UNSAFE",
  "PROJECT_HOST_FILE_SCOPE_CHANGED",
  "PROJECT_HOST_FILE_CHANGED",
  "EACCES"
])("does not hide optional stage source/access failures: %s", (message) => {
  const source = files(runtime())
  expect(() =>
    readAutobizPackageSemantics((path) => {
      if (path === "devclaw.stage-checks.json") throw Error(message)
      return source.get(path)
    }, true)
  ).toThrow(message)
})

it("keeps legacy board context on secondary flow entrances using only supplied bytes", () => {
  const source = files(runtime())
  source.set(
    "secondary.json",
    Buffer.from(JSON.stringify({ ...runtime(), mode: "legacy", stateOwner: "plugin" }))
  )
  source.set(
    "devclaw.capabilities.json",
    Buffer.from(
      JSON.stringify({
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
    )
  )
  expect(readAutobizPackageSemantics((path) => source.get(path), true)).toEqual({
    legacyProject: true,
    boardContext: true
  })
  expect(() => assertAutobizPackageAgentResources(source)).toThrow("PROJECT_AGENT_RESOURCE_MISSING")
  expect(isAutobizLegacyProjectRoot(materialize(source))).toBe(true)
})
