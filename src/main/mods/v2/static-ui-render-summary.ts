import { createHash } from "node:crypto"
import {
  parse,
  type AnyNode,
  type Identifier,
  type Literal,
  type FunctionDeclaration,
  type VariableDeclaration
} from "acorn"
import type { FunctionRegistration } from "../../../shared/mods/v2/contracts"
import { FUNCTION_UI_SITES } from "../../../shared/mods/v2/sites"
import { analyzeUiCallback, type StaticNamedStateRead } from "./ui-render-purity"

export type StaticNamedStateReads = Readonly<Record<string, readonly StaticNamedStateRead[]>>

interface StaticRegistration {
  readonly pattern: string
  readonly hasMatcher: boolean
}

export type StaticUiRenderSummary =
  | {
      readonly kind: "static"
      readonly codeDigest: string
      readonly registrations: readonly StaticRegistration[]
      readonly components: readonly string[]
      readonly reusableComponents: readonly string[]
      readonly readsNamedState: StaticNamedStateReads
    }
  | { readonly kind: "unknown"; readonly reason: string }

const issued = new WeakSet<object>()
const reusableGuests = new WeakMap<object, boolean>()
declare const proofBrand: unique symbol
export interface StaticUiRenderProof {
  readonly [proofBrand]: true
  readonly codeDigest: string
  readonly components: readonly string[]
  readonly reusableComponents: readonly string[]
  readonly readsNamedState: StaticNamedStateReads
}
const components = new Set<string>(["Pane", ...FUNCTION_UI_SITES])
const digest = (code: string): string => createHash("sha256").update(code).digest("hex")

// These are the current compiler's helpers, not arbitrary guest initializers.
// Exact AST comparison deliberately makes a compiler upgrade fall back to unknown.
const SCAFFOLD = `
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => { try { step(generator.next(value)); } catch (e) { reject(e); } };
    var rejected = (value) => { try { step(generator.throw(value)); } catch (e) { reject(e); } };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};`

function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["start", "end", "raw"].includes(key))
      .map(([key, item]) => [key, shape(item)])
  )
}

const signature = (node: AnyNode): string => JSON.stringify(shape(node))
const helperNodes = parse(SCAFFOLD, { ecmaVersion: "latest" }).body as VariableDeclaration[]
const helpers = new Map(
  helperNodes.map((node) => [named(node.declarations[0].id), signature(node)])
)

function identifier(node: AnyNode | null | undefined, name?: string): node is Identifier {
  return node?.type === "Identifier" && (name === undefined || node.name === name)
}

function scalar(
  node: AnyNode | null | undefined
): node is Literal & { value: string | number | boolean | null } {
  return (
    node?.type === "Literal" &&
    (node.value === null || ["string", "boolean", "number"].includes(typeof node.value)) &&
    !node.regex &&
    (typeof node.value !== "number" || Number.isFinite(node.value))
  )
}

function containsIdentifier(value: unknown, names: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some((item) => containsIdentifier(item, names))
  if (!value || typeof value !== "object") return false
  const node = value as AnyNode
  if (node.type === "Identifier" && names.has(node.name)) return true
  return Object.values(value).some((item) => containsIdentifier(item, names))
}

const matcherEscapeNames = new Set([
  "Object",
  "Reflect",
  "String",
  "Array",
  "Proxy",
  "globalThis",
  "eval",
  "Function",
  "constructor",
  "prototype",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "caller",
  "callee",
  "arguments"
])
function hasMatcherEscape(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasMatcherEscape)
  if (!value || typeof value !== "object") return false
  const node = value as AnyNode
  if (
    (node.type === "Identifier" && matcherEscapeNames.has(node.name)) ||
    (node.type === "MemberExpression" && node.computed) ||
    node.type === "WithStatement" ||
    node.type === "ImportExpression"
  )
    return true
  if (
    node.type === "Property" &&
    node.key.type === "Literal" &&
    typeof node.key.value === "string" &&
    matcherEscapeNames.has(node.key.value)
  )
    return true
  return Object.values(value).some(hasMatcherEscape)
}

class StaticProofUnknown extends Error {}
function fail(reason: string): never {
  throw new StaticProofUnknown(reason)
}

function named(node: AnyNode | null | undefined): string {
  if (!identifier(node)) return fail("non-identifier-binding")
  return node!.name
}

function literalMatcher(node: AnyNode): string | undefined {
  if (node.type !== "ObjectExpression") return fail("dynamic-matcher")
  const keys = new Set<string>()
  let component: string | undefined
  for (const property of node.properties as AnyNode[]) {
    if (
      property.type !== "Property" ||
      property.kind !== "init" ||
      property.method ||
      property.computed ||
      property.shorthand ||
      !scalar(property.value)
    )
      return fail("dynamic-matcher-field")
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "Literal"
          ? property.key.value
          : undefined
    if (typeof key !== "string" || keys.has(key) || key === "__proto__")
      return fail("ambiguous-matcher-field")
    keys.add(key)
    if (key === "component") {
      if (typeof property.value.value !== "string" || !components.has(property.value.value))
        return fail("unknown-component")
      component = property.value.value
    }
  }
  return component
}

function summary(
  code: string,
  rows: readonly StaticRegistration[],
  sites: ReadonlySet<string>,
  reusable: boolean,
  reusableSites: ReadonlySet<string> = sites,
  stateReads: StaticNamedStateReads = {}
): StaticUiRenderSummary {
  const result: StaticUiRenderSummary = Object.freeze({
    kind: "static",
    codeDigest: digest(code),
    registrations: Object.freeze([...rows]),
    components: Object.freeze([...sites]),
    reusableComponents: Object.freeze(reusable ? [...reusableSites] : []),
    readsNamedState: Object.freeze(
      Object.fromEntries(
        Object.entries(stateReads)
          .filter(([component, reads]) => reusable && reusableSites.has(component) && reads.length)
          .map(([component, reads]) => [component, Object.freeze([...reads])])
      )
    )
  })
  issued.add(result)
  reusableGuests.set(result, reusable)
  return result
}

/** Only the existing assembleFunctionComponents wrapper is accepted, byte AST exact. */
function aggregateSummary(
  code: string,
  body: AnyNode[],
  globalName: string
): StaticUiRenderSummary {
  if (globalName !== "__cmbFunctionMod" || body.length < 2 || body.length > 129)
    return fail("aggregate-shape")
  const names: string[] = []
  const parts: StaticUiRenderSummary[] = []
  for (const node of body.slice(0, -1)) {
    if (node.type !== "VariableDeclaration" || node.declarations.length !== 1)
      return fail("aggregate-module-shape")
    const name = named(node.declarations[0].id)
    if (!/^__cmbComponent\d+$/.test(name) || names.includes(name))
      return fail("aggregate-module-name")
    names.push(name)
    const part = analyzeStaticUiRenderSummary(code.slice(node.start, node.end), name)
    if (part.kind !== "static") return fail("aggregate-module-unknown")
    parts.push(part)
  }
  const configs: string[] = []
  const collectConfig = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collectConfig(item)
    } else if (value && typeof value === "object") {
      const node = value as AnyNode
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        identifier(node.callee.object, "JSON") &&
        identifier(node.callee.property, "parse")
      ) {
        const input = node.arguments[0]
        if (
          node.arguments.length !== 1 ||
          input.type !== "Literal" ||
          typeof input.value !== "string"
        )
          return fail("aggregate-config")
        const decoded: unknown = JSON.parse(input.value)
        if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
          return fail("aggregate-config")
        configs.push(input.value)
      }
      for (const item of Object.values(value)) collectConfig(item)
    }
  }
  const wrapper = body[body.length - 1]
  collectConfig(wrapper)
  if (configs.length !== names.length) return fail("aggregate-config-count")
  const expected = parse(
    `var __cmbFunctionMod = { register: function(on, options) {
    ${names.map((name, index) => `var r${index} = ${name}.register(on, Object.assign({}, options, JSON.parse(${JSON.stringify(configs[index])}))); if (r${index} && typeof r${index}.then === "function") throw Error("MODS_ASYNC_REGISTER");`).join("\n")}
  } };`,
    { ecmaVersion: "latest" }
  ).body[0] as AnyNode
  if (signature(wrapper) !== signature(expected)) return fail("aggregate-wrapper-changed")
  const rows: StaticRegistration[] = []
  const sites = new Set<string>()
  const blocked = new Set<string>()
  const stateReads: Record<string, StaticNamedStateRead[]> = {}
  for (const part of parts) {
    if (part.kind !== "static") return fail("aggregate-module-unknown")
    rows.push(...part.registrations)
    part.components.forEach((site) => sites.add(site))
    for (const site of part.components)
      if (!part.reusableComponents.includes(site)) blocked.add(site)
    for (const [site, reads] of Object.entries(part.readsNamedState)) {
      const combined = (stateReads[site] ??= [])
      for (const ref of reads)
        if (!combined.some((item) => JSON.stringify(item) === JSON.stringify(ref)))
          combined.push(ref)
    }
  }
  if (rows.length > 128) return fail("registration-limit")
  return summary(
    code,
    rows,
    sites,
    parts.every((part) => reusableGuests.get(part) === true),
    new Set([...sites].filter((site) => !blocked.has(site))),
    stateReads
  )
}

/**
 * A host-only, deliberately narrow proof over the compiled program. It never
 * invokes guest code or inspects guest matchers (including their getters/Proxy).
 * Unknown syntax retains the existing remote matcher path unchanged.
 */
export function analyzeStaticUiRenderSummary(
  code: string,
  globalName = "__cmbFunctionMod"
): StaticUiRenderSummary {
  try {
    if (code.length > 2 * 1024 * 1024) return fail("source-limit")
    const program = parse(code, { ecmaVersion: "latest", sourceType: "script" })
    if (program.body.length !== 1)
      return aggregateSummary(code, program.body as AnyNode[], globalName)
    const statement = program.body[0] as AnyNode
    if (statement.type !== "VariableDeclaration" || statement.declarations.length !== 1)
      return fail("bundle-shape")
    const bundle = statement.declarations[0]
    if (
      !identifier(bundle.id, globalName) ||
      bundle.init?.type !== "CallExpression" ||
      bundle.init.arguments.length ||
      bundle.init.optional
    )
      return fail("bundle-shape")
    const factory = bundle.init.callee
    if (
      factory.type !== "ArrowFunctionExpression" ||
      factory.async ||
      factory.params.length ||
      factory.body.type !== "BlockStatement"
    )
      return fail("bundle-factory")
    const body = factory.body.body as AnyNode[]
    const functions = new Map<string, FunctionDeclaration>()
    const bindings = new Set<string>()
    let exportsName: string | undefined
    let registerName: string | undefined
    let returned = false
    const declare = (name: string): void => {
      if (
        bindings.has(name) ||
        ["Object", "Promise", "globalThis", "eval", "Function"].includes(name)
      )
        fail("shadowed-binding")
      bindings.add(name)
    }
    for (const node of body) {
      if (returned) return fail("after-return")
      if (node.type === "FunctionDeclaration") {
        if (!node.id) return fail("anonymous-registration-helper")
        const name = named(node.id)
        declare(name)
        if (node.async || node.generator) return fail("async-registration-helper")
        functions.set(name, node as FunctionDeclaration)
      } else if (node.type === "VariableDeclaration" && node.declarations.length === 1) {
        const variable = node.declarations[0]
        const name = named(variable.id)
        declare(name)
        if (helpers.has(name)) {
          if (signature(node) !== helpers.get(name)) return fail("compiler-helper-changed")
        } else if (
          variable.init?.type === "ObjectExpression" &&
          !variable.init.properties.length &&
          !exportsName
        ) {
          exportsName = name
        } else if (!scalar(variable.init) && variable.init !== null) {
          return fail("top-level-initializer")
        }
      } else if (node.type === "ExpressionStatement") {
        const call = node.expression
        if (
          registerName ||
          !exportsName ||
          call.type !== "CallExpression" ||
          !identifier(call.callee, "__export") ||
          call.arguments.length !== 2 ||
          !identifier(call.arguments[0], exportsName)
        )
          return fail("top-level-effect")
        const exportObject = call.arguments[1]
        if (exportObject?.type !== "ObjectExpression") return fail("exports-shape")
        const properties = exportObject.properties
        const property = properties[0]
        if (
          properties.length !== 1 ||
          property?.type !== "Property" ||
          property.computed ||
          property.kind !== "init" ||
          !identifier(property.key, "register") ||
          property.value.type !== "ArrowFunctionExpression" ||
          property.value.async ||
          property.value.params.length ||
          !identifier(property.value.body)
        )
          return fail("exports-shape")
        registerName = property.value.body.name
      } else if (node.type === "ReturnStatement") {
        const call = node.argument
        if (
          !exportsName ||
          call?.type !== "CallExpression" ||
          !identifier(call.callee, "__toCommonJS") ||
          call.arguments.length !== 1 ||
          !identifier(call.arguments[0], exportsName)
        )
          return fail("return-shape")
        returned = true
      } else return fail("top-level-statement")
    }
    if (
      !returned ||
      !registerName ||
      !functions.has(registerName) ||
      ![
        "__defProp",
        "__getOwnPropDesc",
        "__getOwnPropNames",
        "__hasOwnProp",
        "__export",
        "__copyProps",
        "__toCommonJS"
      ].every((name) => bindings.has(name))
    )
      return fail("missing-compiler-scaffold")
    const rows: StaticRegistration[] = []
    const sites = new Set<string>()
    let callbacksReusable = true
    const blocked = new Set<string>()
    const stateReads: Record<string, StaticNamedStateRead[]> = {}
    const visited = new Set<string>()
    const forbiddenCallbackNames = new Set([
      ...functions.keys(),
      ...[...helpers.keys()].filter((name) => name !== "__async"),
      globalName,
      exportsName!,
      "eval",
      "Function"
    ])
    const visit = (name: string, depth: number): void => {
      if (depth > 16 || visited.has(name)) return fail("registration-cycle")
      visited.add(name)
      const fn = functions.get(name)
      if (!fn || fn.params.length < 1 || fn.params.length > 2) return fail("registration-signature")
      const onName = named(fn.params[0])
      const optionName = fn.params[1] ? named(fn.params[1]) : undefined
      const callbackForbidden = new Set([...forbiddenCallbackNames, onName])
      const locals = new Set<string>([onName, ...(optionName ? [optionName] : [])])
      const statements = fn.body.body
      for (let index = 0; index < statements.length; index++) {
        const node = statements[index]
        if (node.type === "VariableDeclaration") {
          for (const variable of node.declarations) {
            const local = named(variable.id)
            if (locals.has(local) || forbiddenCallbackNames.has(local)) return fail("local-shadow")
            locals.add(local)
            if (variable.init?.type === "CallExpression") {
              const call = variable.init
              const target = named(call.callee)
              if (
                call.optional ||
                call.arguments.length !== 2 ||
                !identifier(call.arguments[0], onName) ||
                !optionName ||
                !identifier(call.arguments[1], optionName)
              )
                return fail("registration-forwarding")
              const next = statements[++index]
              const expected = parse(
                `if (${local} && typeof ${local}.then === "function") throw Error("MODS_ASYNC_REGISTER");`,
                { ecmaVersion: "latest" }
              ).body[0] as AnyNode
              if (!next || signature(next) !== signature(expected))
                return fail("registration-wrapper")
              visit(target, depth + 1)
            } else if (variable.init !== null && !scalar(variable.init))
              return fail("local-initializer")
          }
        } else if (node.type === "ExpressionStatement") {
          const call = node.expression
          if (
            call.type !== "CallExpression" ||
            call.optional ||
            !identifier(call.callee, onName) ||
            ![2, 3].includes(call.arguments.length)
          )
            return fail("registration-statement")
          const [event, second, third] = call.arguments as AnyNode[]
          if (
            event.type !== "Literal" ||
            typeof event.value !== "string" ||
            /[*!]/.test(event.value) ||
            event.value === "ui.resolve"
          )
            return fail("dynamic-event")
          const handler = third ?? second
          if (
            !["ArrowFunctionExpression", "FunctionExpression"].includes(handler.type) ||
            containsIdentifier(handler, callbackForbidden) ||
            hasMatcherEscape(handler)
          )
            return fail("escaping-handler")
          const component = third ? literalMatcher(second) : undefined
          const callback = analyzeUiCallback(handler, {
            compilerAsyncHelperVerified: bindings.has("__async"),
            namedState: true,
            render: event.value === "ui.render"
          })
          callbacksReusable &&= callback.environmentSafe
          if (event.value === "ui.render") {
            if (!component) return fail("unqualified-render")
            sites.add(component)
            if (!callback.reusable) blocked.add(component)
            const refs = (stateReads[component] ??= [])
            for (const ref of callback.readsNamedState)
              if (!refs.some((item) => JSON.stringify(item) === JSON.stringify(ref))) refs.push(ref)
          }
          if (rows.length >= 128) return fail("registration-limit")
          rows.push(Object.freeze({ pattern: event.value, hasMatcher: third !== undefined }))
        } else return fail("registration-control-flow")
      }
    }
    visit(registerName, 0)
    return summary(
      code,
      rows,
      sites,
      callbacksReusable,
      new Set([...sites].filter((site) => !blocked.has(site))),
      stateReads
    )
  } catch (error) {
    return {
      kind: "unknown",
      reason: error instanceof StaticProofUnknown ? error.message : "parse-failed"
    }
  }
}

/** Match real registration metadata and exact compiled bytes before using a proof. */
export function bindStaticUiRenderSummary(
  summary: StaticUiRenderSummary,
  code: string,
  registrations: readonly FunctionRegistration[]
): StaticUiRenderProof | undefined {
  if (
    summary.kind !== "static" ||
    !issued.has(summary) ||
    summary.codeDigest !== digest(code) ||
    summary.registrations.length !== registrations.length
  )
    return
  for (let index = 0; index < registrations.length; index++) {
    const expected = summary.registrations[index]
    const actual = registrations[index]
    if (
      actual.id !== String(index) ||
      actual.pattern !== expected.pattern ||
      actual.hasMatcher !== expected.hasMatcher ||
      actual.hasCatch ||
      actual.platformCapability
    )
      return
  }
  return Object.freeze({
    codeDigest: summary.codeDigest,
    components: summary.components,
    reusableComponents: summary.reusableComponents,
    readsNamedState: summary.readsNamedState
  }) as StaticUiRenderProof
}
