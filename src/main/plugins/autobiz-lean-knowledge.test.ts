import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { expect, it } from "vitest"
import { build, buildSync } from "esbuild"
import { readFileSync } from "node:fs"
import { selectStageKnowledge } from "../../../resources/native-compositions/autobiz-lean/providers/knowledge/mods/stage-selection"
import { compileFunctionPlugin } from "../mods/v2/loader"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { analyzeAuthoringPreview } from "../mods/devtools/authoring-preflight"

// Author packages resolve devclaw-mods only in their isolated author compiler. Keep the
// Node test graph separate, while exercising the real bundled implementation below.
interface MaterialInput {
  rootId: string
  path?: string
  offset?: number
  limit?: number
}
interface MaterialResult {
  path?: string
  text?: string
  digest?: string
  entries?: Array<{ kind: string; path: string }>
  nextOffset?: number | null
}
interface MaterialSDK {
  platform: {
    act(request: { action: string; input: MaterialInput }): Promise<{
      status: string
      value: MaterialResult
    }>
  }
}
interface MaterialHelpers {
  knowledgeRoots(value: unknown): string[]
  readKnowledge(
    sdk: MaterialSDK,
    roots: string[],
    executionId: string
  ): Promise<Array<{ path: string; text: string; digest: string }>>
}
const materialBundle = buildSync({
  entryPoints: [
    resolve(
      "resources/native-compositions/autobiz-lean/providers/knowledge/mods/material-selection.ts"
    )
  ],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "neutral"
})
const materialModule = { exports: {} as MaterialHelpers }
new Function("module", "exports", materialBundle.outputFiles[0].text)(
  materialModule,
  materialModule.exports
)
const { knowledgeRoots, readKnowledge } = materialModule.exports

it("loads the real compiled knowledge modules in the supported QuickJS guest", async () => {
  // ES2016-lowered for-of await expressions can parse in Node but fail in QuickJS.
  const compiled = await compileFunctionPlugin(
    resolve("resources/native-compositions/autobiz-lean/providers/knowledge")
  )
  const guest = await FunctionGuestRuntime.create(compiled.code, compiled.options)
  guest.dispose()
})

const materialSdk = (
  call: (action: string, input: MaterialInput) => Promise<MaterialResult>
): MaterialSDK => ({
  platform: {
    act: async ({ action, input }: { action: string; input: MaterialInput }) => ({
      status: "succeeded",
      value: await call(action, input)
    })
  }
})

const selected = [{ deployUnitId: "orders", appType: "backend" as const }]
it("checks the real knowledge provider against the creator SDK before installation", async () => {
  const result = await analyzeAuthoringPreview(
    resolve("resources/native-compositions/autobiz-lean/providers/knowledge")
  )
  expect(result.typecheck.valid, JSON.stringify(result.typecheck)).toBe(true)
  expect(result.typecheck.diagnostics).toEqual([])
  expect(result.sdk.strictCompatible, JSON.stringify(result.sdk)).toBe(true)
  expect(result.sdk.diagnostics).toEqual([])
})
it("preserves every upstream generated parser byte after the documented type-check-only header", () => {
  const original = readFileSync(
    resolve("resources/native-compositions/autobiz-knowledge/mods/frontmatter.cjs")
  )
  const adapted = readFileSync(
    resolve("resources/native-compositions/autobiz-lean/providers/knowledge/mods/frontmatter.cjs")
  )
  expect(adapted.subarray(adapted.indexOf(10) + 1)).toEqual(original)
})
const document = (text = "订单权限") =>
  "---\ntype: Service Knowledge\ndeploy_unit: orders\n---\n" + text
function materials() {
  const files = new Map([
    ["AGENTS.md", "根约束"],
    ["orders/AGENTS.md", "订单边界"],
    ["orders/domain.md", document()],
    ["other/private.md", "unrelated-body"]
  ])
  const reads: string[] = []
  const lists: string[] = []
  const call = async (action: string, input: { path?: string }) => {
    const path = input.path ?? ""
    if (action === "read") {
      reads.push(path)
      const text = files.get(path)
      if (text === undefined) throw Error("missing:" + path)
      return { path, text, digest: createHash("sha256").update(text).digest("hex") }
    }
    lists.push(path)
    const prefix = path ? path + "/" : ""
    const entries = new Map<string, { path: string; kind: string }>()
    for (const name of files.keys()) {
      if (!name.startsWith(prefix)) continue
      const relative = name.slice(prefix.length)
      entries.set(relative.split("/")[0], {
        path: prefix + relative.split("/")[0],
        kind: relative.includes("/") ? "directory" : "file"
      })
    }
    return { entries: [...entries.values()], nextOffset: null }
  }
  return { files, reads, lists, call }
}

it("uses explicit arbitrary stage tags while retaining unannotated knowledge and nearest AGENTS", async () => {
  const f = materials()
  f.files.set(
    "orders/e2e.md",
    document().replace("---\ntype:", "---\nautobiz_stages: [external-e2e]\ntype:")
  )
  f.files.set(
    "orders/design.md",
    document().replace("---\ntype:", "---\nautobiz_stages: [design]\ntype:")
  )
  const documents = await readKnowledge(materialSdk(f.call), ["orders"], "test")
  const mapping = { final: ["external-e2e"], solution: ["design"] }
  const result = selectStageKnowledge(documents, selected, "final", mapping)
  expect(result.documents.map((item) => item.path).sort()).toEqual([
    "orders/AGENTS.md",
    "orders/domain.md",
    "orders/e2e.md"
  ])
  expect(result.omitted).toEqual(["orders/design.md"])
  expect(() => selectStageKnowledge(documents, selected, "new-stage", mapping)).toThrow(
    "AUTOBIZ_KNOWLEDGE_STAGE_MAPPING_REQUIRED:new-stage"
  )
  expect(() => selectStageKnowledge(documents, selected, "final", { final: [] })).toThrow(
    "AUTOBIZ_KNOWLEDGE_STAGE_MAPPING_INVALID"
  )
})

it("reads live explicit subtrees and ancestor instructions without reading unrelated document bodies", async () => {
  const f = materials()
  const first = await readKnowledge(materialSdk(f.call), knowledgeRoots(["orders"]), "test")
  expect(first.map((item) => item.path)).toContain("AGENTS.md")
  expect(f.reads).not.toContain("other/private.md")
  expect(f.lists).not.toContain("other")
  f.files.set("orders/new.md", document("新加入的全阶段约束"))
  const second = await readKnowledge(materialSdk(f.call), ["orders"], "test")
  expect(
    selectStageKnowledge(second, selected, "review", { review: ["review"] }).documents.map(
      (item) => item.path
    )
  ).toContain("orders/new.md")
  expect(() => knowledgeRoots(["orders", "orders/sub"])).toThrow("ROOTS_OVERLAP")
  for (const roots of [["../orders"], ["/orders"], ["C:/orders"], ["orders\\sub"], []])
    expect(() => knowledgeRoots(roots)).toThrow("ROOTS_INVALID")
})

it("keeps full-root behavior without explicit roots and reports missing deployment coverage", async () => {
  const f = materials()
  await readKnowledge(materialSdk(f.call), knowledgeRoots(undefined), "test")
  expect(f.reads).toContain("other/private.md")
  const documents = await readKnowledge(materialSdk(f.call), ["other"], "test")
  expect(() => selectStageKnowledge(documents, selected, "draft", { draft: ["draft"] })).toThrow(
    "DEPLOYMENT_MISSING:orders"
  )
})

it("rejects escaped listing entries rather than reading outside explicit coverage", async () => {
  const f = materials()
  await expect(
    readKnowledge(
      materialSdk(async (action, input) => {
        if (action === "list" && input.path === "orders")
          return { entries: [{ kind: "file", path: "other/private.md" }], nextOffset: null }
        return f.call(action, input)
      }),
      ["orders"],
      "test"
    )
  ).rejects.toThrow("LIST_INVALID")
  expect(f.reads).not.toContain("other/private.md")
})

it("passes locked configuration through the real provider callback and reports bounded coverage", async () => {
  const f = materials()
  let act: (
    sdk: unknown,
    event: unknown
  ) => Promise<{ status: string; output: { coverage: unknown } }>
  const built = await build({
    entryPoints: [
      resolve("resources/native-compositions/autobiz-lean/providers/knowledge/mods/main.ts")
    ],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "neutral"
  })
  const module = { exports: {} as { register(on: object): void } }
  new Function("module", "exports", built.outputFiles[0].text)(module, module.exports)
  module.exports.register({
    capability: (_descriptor: unknown, handlers: { act: typeof act }) => {
      act = handlers.act
    }
  })
  const sdk = {
    platform: {
      read: async () => ({
        value: {
          stageId: "finish",
          roots: [{ id: "knowledge" }, { id: "package" }],
          configuration: { selectedDeployUnits: JSON.stringify(selected) }
        }
      }),
      act: async ({
        action,
        input
      }: {
        action: string
        input: { rootId: string; path?: string }
      }) => ({
        status: "succeeded",
        value:
          input.rootId === "package"
            ? { text: "method", digest: "a".repeat(64) }
            : await f.call(action, input)
      })
    }
  }
  await expect(act!(sdk, { input: { executionId: "missing", config: {} } })).rejects.toThrow(
    "STAGE_MAPPING_REQUIRED:finish"
  )
  expect(f.reads).toEqual([])
  const result = await act!(sdk, {
    input: {
      executionId: "mapped",
      config: {
        stageTags: { finish: ["finish"] },
        knowledgeRoots: ["orders"]
      }
    }
  })
  expect(result.status).toBe("succeeded")
  expect(result.output.coverage).toMatchObject({ roots: ["orders"], mode: "live-subtree-listing" })
  expect(f.reads).not.toContain("other/private.md")
})
