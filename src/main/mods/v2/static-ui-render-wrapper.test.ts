import { build } from "esbuild"
import {
  parse,
  type AnyNode,
  type ArrayExpression,
  type ObjectExpression,
  type Property
} from "acorn"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { ClawComponentExport } from "../../../shared/mods/claw-components"
import { compileFunctionPlugin } from "./loader"
import { assembleFunctionComponents } from "./component-projection"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionDisplayRouting } from "./display-routing"
import { functionPreparedDisplayProof } from "./display-preparation"
import { analyzeStaticUiRenderSummary, bindStaticUiRenderSummary } from "./static-ui-render-summary"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function nativeBundle(two = false) {
  const root = await mkdtemp(join(tmpdir(), "display-wrapper-native-"))
  roots.push(root)
  await mkdir(join(root, "hooks"))
  await writeFile(join(root, "plugin.json"), JSON.stringify({ name: "display-wrapper" }))
  await writeFile(
    join(root, "hooks/hooks.json"),
    JSON.stringify({
      modules: two ? ["./first.ts", "./second.ts"] : ["./first.ts"]
    })
  )
  await writeFile(
    join(root, "hooks/first.ts"),
    `export function register(on) {
    on("ui.render", {component:"AbovePrompt"}, ($,e,next)=>next(e))
  }`
  )
  if (two)
    await writeFile(
      join(root, "hooks/second.ts"),
      `export function register(on) {
    on("ui.render", {component:"AssistantMessage"}, ($,e)=>
      ({type:"Text",props:{},children:[e.props.text]}))
  }`
    )
  return (await compileFunctionPlugin(root)).code
}
async function legacyBundle(globalName: string, component = "AbovePrompt") {
  const result = await build({
    stdin: {
      contents: `export function register(on) {
    on("ui.render", {component:${JSON.stringify(component)}}, ($,e,next)=>next(e))
  }`
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName,
    target: "es2016",
    platform: "neutral",
    logLevel: "silent"
  })
  return result.outputFiles[0].text
}
function requireNode<T extends AnyNode["type"]>(
  node: AnyNode | null | undefined,
  type: T
): Extract<AnyNode, { type: T }> {
  if (!node || node.type !== type) throw Error(`Expected actual AST ${type}`)
  return node as Extract<AnyNode, { type: T }>
}
function requiredProperty(node: ObjectExpression, name: string): Property {
  const property = node.properties.find(
    (value): value is Property =>
      value.type === "Property" && value.key.type === "Identifier" && value.key.name === name
  )
  if (!property) throw Error(`Missing actual AST property ${name}`)
  return property
}
function directMetadata(code: string): ArrayExpression {
  const program = parse(code, { ecmaVersion: "latest" })
  const bundle = requireNode(program.body[0], "VariableDeclaration")
  const factory = requireNode(
    requireNode(bundle.declarations[0]?.init, "CallExpression").callee,
    "ArrowFunctionExpression"
  )
  const body = requireNode(factory.body, "BlockStatement").body
  const exported = requireNode(
    body.find(
      (node) =>
        node.type === "ExpressionStatement" &&
        node.expression.type === "CallExpression" &&
        node.expression.callee.type === "Identifier" &&
        node.expression.callee.name === "__export"
    ),
    "ExpressionStatement"
  )
  const property = requiredProperty(
    requireNode(
      requireNode(exported.expression, "CallExpression").arguments[1],
      "ObjectExpression"
    ),
    "hookModules"
  )
  const name = requireNode(
    requireNode(property.value, "ArrowFunctionExpression").body,
    "Identifier"
  ).name
  const declaration = requireNode(
    body.find(
      (node) =>
        node.type === "VariableDeclaration" &&
        node.declarations[0]?.id.type === "Identifier" &&
        node.declarations[0].id.name === name
    ),
    "VariableDeclaration"
  )
  return requireNode(declaration.declarations[0]?.init, "ArrayExpression")
}
const replace = (code: string, node: AnyNode, text: string) =>
  code.slice(0, node.start) + text + code.slice(node.end)
async function expectNativeProof(code: string, expected: string[]) {
  const summary = analyzeStaticUiRenderSummary(code)
  expect(summary.kind, JSON.stringify(summary)).toBe("static")
  const guest = await FunctionGuestRuntime.create(code)
  try {
    expect(bindStaticUiRenderSummary(summary, code, guest.registrations)?.components).toEqual(
      expected
    )
  } finally {
    await guest.dispose()
  }
}

it("proves actual loader hookModules and binds actual native registrations", async () => {
  await expectNativeProof(await nativeBundle(), ["AbovePrompt"])
  await expectNativeProof(await nativeBundle(true), ["AbovePrompt", "AssistantMessage"])
})
it("keeps the old register-only compiler scaffold compatible", async () => {
  await expectNativeProof(await legacyBundle("__cmbFunctionMod"), ["AbovePrompt"])
})
it("fences module-only mutation in binding and both preparation/routing caches", async () => {
  const code = await nativeBundle(true)
  const guest = await FunctionGuestRuntime.create(code)
  try {
    const summary = analyzeStaticUiRenderSummary(code)
    expect(bindStaticUiRenderSummary(summary, code, guest.registrations)).toBeDefined()
    expect(guest.registrations[0].module).toBe("hooks/first.ts")
    const routing = new FunctionDisplayRouting()
    expect(routing.qualify([{ guest, code }], "AbovePrompt")).toBeDefined()
    expect(functionPreparedDisplayProof(guest, code)).not.toBeNull()
    guest.registrations[0].module = "hooks/second.ts"
    expect(bindStaticUiRenderSummary(summary, code, guest.registrations)).toBeUndefined()
    expect(functionPreparedDisplayProof(guest, code)).toBeNull()
    expect(routing.qualify([{ guest, code }], "AbovePrompt")).toBeUndefined()
  } finally {
    await guest.dispose()
  }
})
it("rejects metadata arrays whose callable order differs from the fallback wrapper", async () => {
  const code = await nativeBundle(true),
    metadata = directMetadata(code)
  const first = requireNode(metadata.elements[0], "ObjectExpression")
  const second = requireNode(metadata.elements[1], "ObjectExpression")
  const reversed = `[${code.slice(second.start, second.end)},${code.slice(first.start, first.end)}]`
  expect(analyzeStaticUiRenderSummary(replace(code, metadata, reversed)).kind).toBe("unknown")
  const register = requiredProperty(first, "register").value
  expect(analyzeStaticUiRenderSummary(replace(code, register, "(()=>{})")).kind).toBe("unknown")
  expect(analyzeStaticUiRenderSummary(replace(code, metadata, "[,...[]]")).kind).toBe("unknown")
  const duplicate = `[${code.slice(first.start, first.end)},${code.slice(first.start, first.end)}]`
  expect(analyzeStaticUiRenderSummary(replace(code, metadata, duplicate)).kind).toBe("unknown")
})
it("rejects extra executable metadata keys and altered export surfaces", async () => {
  const code = await nativeBundle(),
    metadata = directMetadata(code)
  const first = requireNode(metadata.elements[0], "ObjectExpression")
  const original = code.slice(first.start, first.end)
  for (const field of ["extra:1", "get options(){return {}}", '["options"]:{}', "...{}"])
    expect(
      analyzeStaticUiRenderSummary(replace(code, first, original.slice(0, -1) + "," + field + "}"))
        .kind
    ).toBe("unknown")
  expect(
    analyzeStaticUiRenderSummary(code.replace("hookModules: () =>", "anotherExport: () =>")).kind
  ).toBe("unknown")
})
it("proves exact aggregate metadata configuration and keeps its legacy wrapper", async () => {
  const entries: ClawComponentExport[] = [
    {
      id: "first",
      name: "First",
      kind: "module",
      entry: "first.js",
      dependsOn: [],
      actionIds: []
    },
    {
      id: "second",
      name: "Second",
      kind: "module",
      entry: "second.js",
      dependsOn: ["first"],
      actionIds: []
    }
  ]
  const modules = {
    first: {
      code: await legacyBundle("__cmbComponent0"),
      globalName: "__cmbComponent0",
      clients: {},
      environment: { read: [], write: [] }
    },
    second: {
      code: await legacyBundle("__cmbComponent1", "AssistantMessage"),
      globalName: "__cmbComponent1",
      clients: {},
      environment: { read: [], write: [] }
    }
  }
  const code = assembleFunctionComponents(entries, modules, {
    first: { nested: { number: -1, list: [true, null, "safe"] } }
  })
  await expectNativeProof(code, ["AbovePrompt", "AssistantMessage"])
  const program = parse(code, { ecmaVersion: "latest" })
  const wrapper = requireNode(program.body[program.body.length - 1], "VariableDeclaration")
  const metadata = requireNode(
    requiredProperty(requireNode(wrapper.declarations[0]?.init, "ObjectExpression"), "hookModules")
      .value,
    "ArrayExpression"
  )
  const first = requireNode(metadata.elements[0], "ObjectExpression")
  const options = requiredProperty(first, "options").value
  for (const text of [
    '{"nested":{"number":2}}',
    '{"__proto__":{}}',
    '{"nested":{"__proto__":{}}}',
    '{"n":1e999}',
    '{"n":Infinity}',
    '{"a":1,"a":1}',
    '{"a":[,]}',
    '{"a":[...[]]}',
    "{get a(){return 1}}",
    '{["a"]:1}',
    '{"a":JSON.parse("{}")}'
  ])
    expect(analyzeStaticUiRenderSummary(replace(code, options, text)).kind).toBe("unknown")
  const register = requiredProperty(first, "register").value
  expect(
    analyzeStaticUiRenderSummary(replace(code, register, "__cmbComponent1.register")).kind
  ).toBe("unknown")
  const legacy =
    code.slice(0, metadata.start - "hookModules: ".length) +
    code.slice(metadata.end).replace(/^,\s*/, "")
  await expectNativeProof(legacy, ["AbovePrompt", "AssistantMessage"])
})
