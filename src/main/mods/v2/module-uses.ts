import { parse, type AnyNode } from "acorn"
import type { FunctionPluginRegisterUses } from "../../../shared/mods/v2/plugin-register"

export interface FunctionModuleScan {
  uses: FunctionPluginRegisterUses
  /** Only a real admission gate requires a complete, statically trustworthy declaration. */
  unknown?: string
}

type Ref = { plugin: string; key: string }
const property = (node: AnyNode | undefined): string | undefined =>
  node?.type === "MemberExpression"
    ? !node.computed && node.property.type === "Identifier"
      ? node.property.name
      : node.computed && node.property.type === "Literal" && typeof node.property.value === "string"
        ? node.property.value
        : undefined
    : undefined
const literal = (node: AnyNode | undefined): string | undefined =>
  node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined

/** A conservative declaration, never an execution or an inferred permission grant. */
export function scanFunctionModuleUses(code: string): FunctionModuleScan {
  const tree = parse(code, { ecmaVersion: "latest", sourceType: "module" })
  const entries: Array<{ node: AnyNode; parent?: AnyNode }> = []
  const parents = new Map<AnyNode, AnyNode | undefined>()
  const walk = (value: unknown, parent?: AnyNode): void => {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, parent)
      return
    }
    const node = value as AnyNode
    if (typeof node.type === "string") {
      entries.push({ node, parent })
      parents.set(node, parent)
    }
    for (const item of Object.values(value)) walk(item, node)
  }
  walk(tree)
  const events = new Set<string>(),
    calls = new Set<string>()
  const env = { reads: new Set<string>(), writes: new Set<string>() }
  const state = { reads: new Map<string, Ref>(), writes: new Map<string, Ref>() }
  const helpers = new Map<string, string>()
  const variables = new Map<string, AnyNode>()
  const bindings = new Map<string, number>()
  let unknown: string | undefined
  const uncertain = (reason: string) => {
    unknown ??= reason
  }
  const binding = (node: AnyNode | undefined): void => {
    if (!node) return
    if (node.type === "Identifier") bindings.set(node.name, (bindings.get(node.name) ?? 0) + 1)
    else if (node.type === "AssignmentPattern") binding(node.left)
    else if (node.type === "RestElement") binding(node.argument)
    else if (node.type === "ArrayPattern")
      node.elements.forEach((item) => binding(item ?? undefined))
    else if (node.type === "ObjectPattern")
      node.properties.forEach((item) =>
        binding(item.type === "Property" ? item.value : item.argument)
      )
  }
  for (const { node, parent } of entries) {
    if (
      node.type === "ImportSpecifier" ||
      node.type === "ImportDefaultSpecifier" ||
      node.type === "ImportNamespaceSpecifier"
    )
      binding(node.local)
    if (node.type === "VariableDeclarator") binding(node.id)
    // A declaration ceases to be a trustworthy lookup after replacement, including
    // destructuring/logical assignment and loop targets. Only looked-up SDK helpers,
    // handlers and state references consult these counts; normal data writes stay valid.
    if (node.type === "AssignmentExpression") binding(node.left)
    if (node.type === "UpdateExpression") binding(node.argument)
    if (
      (node.type === "ForOfStatement" || node.type === "ForInStatement") &&
      node.left.type !== "VariableDeclaration"
    )
      binding(node.left)
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      if (node.type !== "ArrowFunctionExpression") binding(node.id ?? undefined)
      node.params.forEach(binding)
    }
    if (node.type === "CatchClause") binding(node.param ?? undefined)
    if (
      node.type === "ImportDeclaration" &&
      typeof node.source.value === "string" &&
      ["devclaw-mods", "claude-code"].includes(node.source.value)
    )
      for (const item of node.specifiers)
        if (item.type === "ImportSpecifier")
          helpers.set(
            item.local.name,
            item.imported.type === "Identifier" ? item.imported.name : String(item.imported.value)
          )
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init &&
      parent?.type === "VariableDeclaration" &&
      parent.kind === "const"
    )
      variables.set(node.id.name, node.init)
    if (node.type === "FunctionDeclaration" && node.id) variables.set(node.id.name, node)
  }
  for (const name of helpers.keys())
    if ((bindings.get(name) ?? 0) > 1) uncertain(`shadowed binding cannot be inspected: ${name}`)
  const textConstants = new Map<string, string | undefined>()
  const constantText = (
    node: AnyNode | undefined,
    seen = new Set<string>()
  ): string | undefined => {
    if (node?.type === "Literal" && typeof node.value === "string")
      return node.value.length <= 128 ? node.value : undefined
    if (node?.type === "Identifier" && !seen.has(node.name)) {
      if ((bindings.get(node.name) ?? 0) > 1) return undefined
      if (textConstants.has(node.name)) return textConstants.get(node.name)
      const value = constantText(variables.get(node.name), new Set(seen).add(node.name))
      textConstants.set(node.name, value)
      return value
    }
    if (node?.type === "BinaryExpression" && node.operator === "+") {
      const left = constantText(node.left, seen)
      if (left === undefined) return undefined
      const right = constantText(node.right, seen)
      return right !== undefined && left.length + right.length <= 128 ? left + right : undefined
    }
    if (node?.type === "TemplateLiteral" && !node.expressions.length)
      return node.quasis[0]?.value.cooked ?? undefined
    return undefined
  }
  const namedProperty = (node: AnyNode): string | undefined =>
    node.type === "MemberExpression"
      ? node.computed
        ? constantText(node.property)
        : property(node)
      : undefined
  const references = (node: AnyNode | undefined, seen = new Set<string>()): Ref[] | undefined => {
    if (!node) return undefined
    if (node.type === "ObjectExpression") {
      if (
        node.properties.some(
          (item) => item.type !== "Property" || item.computed || item.kind !== "init"
        )
      )
        return undefined
      const fields = new Map<string, AnyNode>()
      for (const item of node.properties) {
        if (item.type !== "Property" || item.computed) continue
        const key =
          item.key.type === "Identifier"
            ? item.key.name
            : item.key.type === "Literal"
              ? String(item.key.value)
              : undefined
        if (key !== undefined) fields.set(key, item.value)
      }
      const plugin = literal(fields.get("plugin")),
        key = literal(fields.get("key"))
      return plugin !== undefined && key !== undefined ? [{ plugin, key }] : undefined
    }
    if (node.type === "Identifier" && !seen.has(node.name)) {
      if ((bindings.get(node.name) ?? 0) > 1) return undefined
      const next = new Set(seen).add(node.name)
      const initial = variables.get(node.name)
      // Plain object/array aliases can be mutated through another reference. The trusted
      // state helpers freeze their references; inline literal SDK arguments are also exact.
      return initial?.type === "CallExpression" ? references(initial, next) : undefined
    }
    if (node.type === "ArrayExpression") {
      const result = node.elements.map((item) => references(item ?? undefined, seen))
      return result.every((item) => item !== undefined) ? (result.flat() as Ref[]) : undefined
    }
    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      const helper = helpers.get(node.callee.name)
      if (["atom", "derive", "memberOf"].includes(helper ?? ""))
        return references(node.arguments[0], seen)
    }
    return undefined
  }
  const addState = (kind: "reads" | "writes", node: AnyNode | undefined) => {
    const refs = references(node)
    if (!refs) {
      uncertain("state references must have a statically known plugin/key")
      return
    }
    for (const ref of refs) state[kind].set(JSON.stringify(ref), ref)
  }
  const sdk = (node: AnyNode): string | undefined => {
    if (
      node.type !== "MemberExpression" ||
      node.object.type !== "MemberExpression" ||
      node.object.object.type !== "Identifier" ||
      node.object.object.name !== "$"
    )
      return undefined
    const noun = property(node.object),
      method = property(node)
    return noun && method ? `${noun}.${method}` : undefined
  }
  const handler = (source: AnyNode | undefined, seen = new Set<string>()): void => {
    const node = source
    if (node?.type === "Identifier" && !seen.has(node.name)) {
      if ((bindings.get(node.name) ?? 0) > 1) {
        uncertain(`shadowed handler binding cannot be inspected: ${node.name}`)
        return
      }
      return handler(variables.get(node.name), new Set(seen).add(node.name))
    }
    if (
      node?.type !== "FunctionExpression" &&
      node?.type !== "ArrowFunctionExpression" &&
      node?.type !== "FunctionDeclaration"
    ) {
      uncertain("handler source must be statically known")
      return
    }
    const first = node.params[0]
    if (!first) return
    if (first.type !== "Identifier") {
      uncertain("SDK parameters must be literal identifiers")
      return
    }
    if (
      first.name !== "$" &&
      entries.some(
        (item) =>
          item.node.type === "Identifier" &&
          item.node.name === first.name &&
          item.node.start >= node.body.start &&
          item.node.end <= node.body.end
      )
    )
      uncertain("SDK handler aliases are not statically declared")
  }
  const registrationCall = (node: AnyNode | undefined): boolean =>
    node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "on"
  // Only the on-returned handle carries an SDK recovery callback. Track its literal
  // bindings separately from immutable state references, so stable let handles remain
  // valid without treating ordinary Promise.catch callbacks as SDK handlers.
  const handles = new Set<string>()
  const handleAliases = new Map<string, string[]>()
  const pendingHandles: string[] = []
  const addHandle = (name: string) => {
    if (!handles.has(name)) {
      handles.add(name)
      pendingHandles.push(name)
    }
  }
  for (const { node } of entries) {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") continue
    if (registrationCall(node.init ?? undefined)) addHandle(node.id.name)
    else if (node.init?.type === "Identifier") {
      const aliases = handleAliases.get(node.init.name) ?? []
      aliases.push(node.id.name)
      handleAliases.set(node.init.name, aliases)
    }
  }
  for (let index = 0; index < pendingHandles.length; index++)
    for (const alias of handleAliases.get(pendingHandles[index]) ?? []) addHandle(alias)
  for (const name of handles)
    if ((bindings.get(name) ?? 0) > 1)
      uncertain(`registration handle binding cannot be inspected: ${name}`)
  const registration = (node: AnyNode | undefined): boolean =>
    registrationCall(node) || (node?.type === "Identifier" && handles.has(node.name))
  for (const { node, parent } of entries) {
    if (registration(node)) {
      const binding =
        parent?.type === "VariableDeclarator" &&
        parent.id.type === "Identifier" &&
        handles.has(parent.id.name) &&
        (parent.init === node || parent.id === node)
      const key =
        (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) ||
        (parent?.type === "Property" &&
          parent.key === node &&
          !parent.computed &&
          !parent.shorthand)
      const caller = parent && parents.get(parent)
      const caught =
        parent?.type === "MemberExpression" &&
        parent.object === node &&
        property(parent) === "catch" &&
        caller?.type === "CallExpression" &&
        caller.callee === parent
      if (!binding && !key && !caught && parent?.type !== "ExpressionStatement")
        uncertain("registration handles may only call catch with a statically known handler")
    }
    if (
      (node.type === "Identifier" && ["eval", "Function"].includes(node.name)) ||
      (node.type === "MemberExpression" && namedProperty(node) === "constructor") ||
      (node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        node.callee.object.type === "Identifier" &&
        ["Object", "Reflect"].includes(node.callee.object.name) &&
        ["get", "getOwnPropertyDescriptor"].includes(namedProperty(node.callee) ?? "") &&
        constantText(node.arguments[1]) === "constructor") ||
      (node.type === "Property" &&
        parent?.type === "ObjectPattern" &&
        (node.key.type === "Identifier" ? node.key.name : literal(node.key)) === "constructor")
    )
      // Runtime code-generation guards remain independent. Recognizable generation sources
      // cannot claim an empty declaration. Ordinary data indexing/reflection stays valid;
      // uncertain SDK-property access is handled separately below.
      uncertain("dynamic code or reflective access cannot be statically inspected")
    if (
      node.type === "ThisExpression" ||
      (node.type === "Identifier" &&
        (node.name === "globalThis" ||
          node.name === "arguments" ||
          /^__(?:function|cmb)/.test(node.name)))
    )
      uncertain("private/global registration access cannot be admitted")
    if (node.type === "Identifier" && ["on", "$"].includes(node.name)) {
      const parameter =
        parent &&
        (parent.type === "FunctionDeclaration" ||
          parent.type === "FunctionExpression" ||
          parent.type === "ArrowFunctionExpression") &&
        parent.params.includes(node)
      const object = parent?.type === "MemberExpression" && parent.object === node
      const hook = node.name === "on" && parent?.type === "CallExpression" && parent.callee === node
      const helper =
        node.name === "$" &&
        parent?.type === "CallExpression" &&
        parent.arguments[0] === node &&
        parent.callee.type === "Identifier" &&
        ["read", "update"].includes(helpers.get(parent.callee.name) ?? "")
      const key =
        parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand
      if (!parameter && !object && !hook && !helper && !key)
        uncertain(`${node.name} aliases are not statically declared`)
    }
    if (
      node.type === "MemberExpression" &&
      node.object.type === "Identifier" &&
      node.object.name === "$"
    ) {
      if (parent?.type !== "MemberExpression" || parent.object !== node || !sdk(parent))
        uncertain("SDK noun aliases are not statically declared")
    }
    if (
      node.type === "MemberExpression" &&
      sdk(node) &&
      (parent?.type !== "CallExpression" || parent.callee !== node)
    )
      uncertain("SDK method aliases are not statically declared")
    if (node.type !== "CallExpression") continue
    if (node.callee.type === "Identifier" && node.callee.name === "on") {
      const event = literal(node.arguments[0])
      if (event === undefined) uncertain("event patterns must be literal")
      else events.add(event)
      handler(node.arguments.at(-1))
    }
    if (
      node.callee.type === "MemberExpression" &&
      node.callee.object.type === "Identifier" &&
      node.callee.object.name === "on"
    ) {
      if (property(node.callee) === "capability") {
        events.add("platform.action")
        const handlers = node.arguments[1]
        if (handlers?.type !== "ObjectExpression")
          uncertain("capability handlers must be statically known")
        else {
          const act = handlers.properties.find(
            (item) =>
              item.type === "Property" &&
              !item.computed &&
              (item.key.type === "Identifier" ? item.key.name : literal(item.key)) === "act"
          )
          handler(act?.type === "Property" ? act.value : undefined)
        }
      } else uncertain("unknown registration method")
    }
    if (
      node.callee.type === "MemberExpression" &&
      property(node.callee) === "catch" &&
      registration(node.callee.object)
    )
      handler(node.arguments[0])
    const method = sdk(node.callee)
    if (method) {
      calls.add(method)
      if (method === "env.get" || method === "env.set") {
        const name = literal(node.arguments[0])
        if (name === undefined) uncertain("environment names must be literal")
        else env[method === "env.get" ? "reads" : "writes"].add(name)
      }
      if (method === "state.get" || method === "state.set")
        addState(method === "state.get" ? "reads" : "writes", node.arguments[0])
    }
    if (
      node.callee.type === "Identifier" &&
      node.arguments[0]?.type === "Identifier" &&
      node.arguments[0].name === "$"
    ) {
      const helper = helpers.get(node.callee.name)
      if (helper === "read" || helper === "update") {
        calls.add("state.get")
        addState("reads", node.arguments[1])
        if (helper === "update") {
          calls.add("state.set")
          addState("writes", node.arguments[1])
        }
      }
    }
  }
  const refs = (kind: "reads" | "writes") =>
    [...state[kind].values()].sort(
      (a, b) => a.plugin.localeCompare(b.plugin) || a.key.localeCompare(b.key)
    )
  return {
    uses: {
      events: [...events],
      calls: [...calls].sort(),
      ...(env.reads.size || env.writes.size
        ? { env: { reads: [...env.reads].sort(), writes: [...env.writes].sort() } }
        : {}),
      ...(state.reads.size || state.writes.size
        ? { state: { reads: refs("reads"), writes: refs("writes") } }
        : {})
    },
    ...(unknown ? { unknown } : {})
  }
}

export function combineFunctionModuleUses(
  scans: readonly FunctionModuleScan[]
): FunctionModuleScan {
  const events = new Set<string>(),
    calls = new Set<string>(),
    reads = new Set<string>(),
    writes = new Set<string>()
  const stateReads = new Map<string, Ref>(),
    stateWrites = new Map<string, Ref>()
  for (const { uses } of scans) {
    uses.events.forEach((item) => events.add(item))
    uses.calls.forEach((item) => calls.add(item))
    uses.env?.reads.forEach((item) => reads.add(item))
    uses.env?.writes.forEach((item) => writes.add(item))
    uses.state?.reads.forEach((item) => stateReads.set(JSON.stringify(item), item))
    uses.state?.writes.forEach((item) => stateWrites.set(JSON.stringify(item), item))
  }
  const sortRefs = (items: Map<string, Ref>) =>
    [...items.values()].sort(
      (a, b) => a.plugin.localeCompare(b.plugin) || a.key.localeCompare(b.key)
    )
  return {
    uses: {
      events: [...events],
      calls: [...calls].sort(),
      ...(reads.size || writes.size
        ? { env: { reads: [...reads].sort(), writes: [...writes].sort() } }
        : {}),
      ...(stateReads.size || stateWrites.size
        ? { state: { reads: sortRefs(stateReads), writes: sortRefs(stateWrites) } }
        : {})
    },
    ...(scans.some((item) => item.unknown)
      ? { unknown: scans.find((item) => item.unknown)!.unknown }
      : {})
  }
}
