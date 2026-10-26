import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { posix, resolve } from "node:path"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"
import { build } from "esbuild"
import { expect, it } from "vitest"
const legacy = resolve("tests/fixtures/native-compositions/legacy-reference")
interface Document {
  path: string
  text: string
}
const md = (type: string, unit = "") =>
  `---\ntype: ${type}\ndeploy_unit: ${unit}\ntitle: 测试知识\ndescription: 必须保持原筛选规则\ntags: [orders, boundary]\n---\n正文\n`
const documents: Document[] = [
  { path: "AGENTS.md", text: "root instructions" },
  { path: "orders/AGENTS.md", text: "orders instructions" },
  { path: "orders/a-service.md", text: md("Service Knowledge", "orders-api") },
  { path: "orders/b-front.md", text: md("Service Knowledge", "orders-ui") },
  { path: "orders/common.md", text: md("Product Knowledge", "other") },
  { path: "orders/backend.md", text: md("Reference", "orders-api") },
  { path: "orders/component.md", text: md("Component Reference", "orders-ui") },
  { path: "orders/foreign.md", text: md("Service Knowledge", "other") },
  { path: "other/AGENTS.md", text: "other instructions" },
  { path: "other/product.md", text: md("Product Knowledge") }
]
async function selector() {
  const bundled = await build({
    entryPoints: [resolve("resources/native-compositions/autobiz-knowledge/mods/selector.ts")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "cjs"
  })
  const exports: {
    selectKnowledge?: (docs: Document[], units: unknown) => Array<Document & { type: string }>
  } = {}
  const module = { exports }
  runInNewContext(bundled.outputFiles[0].text, { module, exports })
  return module.exports.selectKnowledge!
}
async function original(unit: string, appType: string) {
  const files = new Map(documents.map((doc) => ["/knowledge/" + doc.path, doc.text]))
  const sourceBytes = readFileSync(resolve(legacy, "collect-knowledge.js"))
  expect(createHash("sha256").update(sourceBytes).digest("hex")).toBe(
    "405c948b60ea7c79d255c9795697255dbe5f5c4ac1290a2a135fcba5e39d840f"
  )
  const source = sourceBytes.toString("utf8")
  let result: { fileLists: string[] } | undefined
  const entry = { run: undefined as undefined | (() => Promise<void>) }
  const fs = {
    existsSync: (path: string) =>
      files.has(path) || [...files.keys()].some((file) => file.startsWith(path + "/")),
    statSync: (path: string) => ({ isFile: () => files.has(path) }),
    readFileSync: (path: string) => {
      const bytes = files.get(path)
      if (bytes === undefined) throw Error("READ_OUTSIDE_FIXTURE")
      return bytes
    },
    readdirSync: (path: string) =>
      [
        ...new Set(
          [...files.keys()]
            .filter((file) => file.startsWith(path + "/"))
            .map((file) => file.slice(path.length + 1).split("/")[0])
        )
      ]
        .sort()
        .map((name) => ({
          name,
          isFile: () => files.has(path + "/" + name),
          isDirectory: () => !files.has(path + "/" + name)
        }))
  }
  const requireOriginal = createRequire(import.meta.url)
  const parserPath = resolve("resources/mods/autobiz-knowledge/collector-gray-matter.cjs")
  expect(createHash("sha256").update(readFileSync(parserPath)).digest("hex")).toBe(
    "a18fe1c53ab582a75ca3818a5eddf4109efa787594e571324ffe41cd899aceb1"
  )
  const parser = requireOriginal(parserPath)
  runInNewContext(
    source.slice(0, source.indexOf("const args = parseArgs(process.argv")) +
      `\ngetAppTypeInfo=async()=>({success:true,appType:${JSON.stringify(appType)}}); entry.run=()=>main({deployUnit:${JSON.stringify(unit)},knowledgePath:"/knowledge"});`,
    {
      entry,
      require: (name: string) => {
        if (name === "fs") return fs
        if (name === "path") return posix
        if (name === "gray-matter") return parser
        if (name === "http")
          return {
            request: () => {
              throw Error("NETWORK_NOT_PERMITTED")
            }
          }
        throw Error("UNEXPECTED_IMPORT")
      },
      console: {
        log: (text: string) => {
          result = JSON.parse(text)
        },
        error: () => {}
      },
      process: {
        exit: () => {
          throw Error("LEGACY_EXIT")
        }
      }
    }
  )
  await entry.run!()
  return result!.fileLists.map((path) => path.slice("/knowledge/".length)).sort()
}
it("retains original deploy-unit, nearest AGENTS, common/product and frontend/backend selection without filesystem or network", async () => {
  const select = await selector()
  for (const [deployUnitId, appType] of [
    ["orders-api", "backend"],
    ["orders-ui", "frontend"]
  ]) {
    const selected = select(documents, [{ deployUnitId, appType }])
    expect(selected.map((file) => file.path).sort()).toEqual(await original(deployUnitId, appType))
    expect(selected.some((file) => file.path === "orders/common.md")).toBe(true)
    expect(
      selected.some((file) => file.path.startsWith("other/") || file.path === "orders/foreign.md")
    ).toBe(false)
  }
  expect(
    select(documents, [
      { deployUnitId: "orders-api", appType: "backend" },
      { deployUnitId: "orders-ui", appType: "frontend" }
    ]).filter((file) => file.path === "orders/common.md")
  ).toHaveLength(1)
})
it("rejects missing deployment knowledge, ambiguous paths and metadata engines instead of reporting partial success", async () => {
  const select = await selector(),
    selected = [{ deployUnitId: "orders-api", appType: "backend" }]
  for (const invalid of [
    null,
    [],
    [{ deployUnitId: 42, appType: "backend" }],
    [{ deployUnitId: "orders-api", appType: "backend", secret: "not-a-declared-field" }]
  ])
    expect(() => select(documents, invalid)).toThrow("SELECTION_INVALID")
  expect(() => select(documents, [{ deployUnitId: "missing", appType: "backend" }])).toThrow(
    "DEPLOYMENT_MISSING"
  )
  expect(() =>
    select(
      documents.filter((doc) => !doc.path.endsWith("AGENTS.md")),
      selected
    )
  ).toThrow("ANCESTOR_AGENTS_MISSING")
  expect(() => select([...documents, { path: "../outside.md", text: "secret" }], selected)).toThrow(
    "PATH_INVALID"
  )
  expect(() =>
    select([...documents, { path: "ORDERS/common.md", text: "duplicate" }], selected)
  ).toThrow("PATH_COLLISION")
  expect(
    select(
      [...documents, { path: "orders/attack.md", text: "---js\nthrow Error('EXECUTED')\n---\n" }],
      selected
    ).some((doc) => doc.path.endsWith("attack.md"))
  ).toBe(false)
})
