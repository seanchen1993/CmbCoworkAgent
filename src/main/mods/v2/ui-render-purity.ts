import type { AnyNode } from "acorn"

type ValueKind = "primitive" | "json" | "state-record"
export interface StaticNamedStateRead {
  readonly plugin: string
  readonly key: string
  readonly id?: string
}
export interface UiCallbackAnalysis {
  readonly environmentSafe: boolean
  readonly reusable: boolean
  readonly readsNamedState: readonly StaticNamedStateRead[]
}
interface CallbackProofContext {
  readonly compilerAsyncHelperVerified: boolean
  readonly namedState: boolean
  readonly render: boolean
}

function literalStateReference(node: AnyNode): StaticNamedStateRead | undefined {
  if (node.type !== "ObjectExpression") return
  const fields = new Map<string, string>()
  for (const field of node.properties) {
    if (
      field.type !== "Property" ||
      field.kind !== "init" ||
      field.computed ||
      field.method ||
      field.shorthand
    )
      return
    const key =
      field.key.type === "Identifier"
        ? field.key.name
        : field.key.type === "Literal"
          ? field.key.value
          : undefined
    if (
      typeof key !== "string" ||
      !["plugin", "key", "id"].includes(key) ||
      fields.has(key) ||
      field.value.type !== "Literal" ||
      typeof field.value.value !== "string" ||
      field.value.value.includes("\0") ||
      Buffer.byteLength(field.value.value) > 4096
    )
      return
    fields.set(key, field.value.value)
  }
  const plugin = fields.get("plugin"),
    key = fields.get("key"),
    id = fields.get("id")
  if (!plugin || !key) return
  return Object.freeze({ plugin, key, ...(id === undefined ? {} : { id }) })
}

function stateOperation(node: AnyNode, sdk: string | undefined) {
  if (
    node.type !== "CallExpression" ||
    node.optional ||
    node.callee.type !== "MemberExpression" ||
    node.callee.computed ||
    node.callee.optional ||
    node.callee.property.type !== "Identifier" ||
    !["get", "set"].includes(node.callee.property.name)
  )
    return
  const noun = node.callee.object
  if (
    noun.type !== "MemberExpression" ||
    noun.computed ||
    noun.optional ||
    noun.object.type !== "Identifier" ||
    noun.object.name !== sdk ||
    noun.property.type !== "Identifier" ||
    noun.property.name !== "state"
  )
    return
  const reference = node.arguments[0] && literalStateReference(node.arguments[0])
  if (!reference) return
  return { method: node.callee.property.name, reference, args: node.arguments }
}
const passiveTypes = new Set(["engine", "fragment", "Box", "Text", "Code", "Svg", "Markdown"])
const forbiddenKeys = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "owner",
  "generation",
  "handle",
  "press",
  "client",
  "clients",
  "markdownLinks",
  "callback",
  "action",
  "authority"
])
const forbiddenReads = new Set([
  ...forbiddenKeys,
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "caller",
  "callee",
  "arguments"
])

/**
 * Prove a small expression language, never execute a callback. This is not a
 * general JavaScript purity detector. The caller must also prove that every
 * other callback sharing this VM is environment-safe: a mutable Object.prototype could
 * otherwise change even a frozen JSON property's lookup or serialization.
 * Named-state reads are conditional candidates only. Main must exclude all
 * state.get middleware and bind actual native dependency coverage/currentness.
 */
export function analyzeUiCallback(
  callback: AnyNode,
  context: CallbackProofContext
): UiCallbackAnalysis {
  const reads: StaticNamedStateRead[] = []
  let writes = false
  const safe = (): boolean => {
    if (
      (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression") ||
      callback.async ||
      callback.generator ||
      callback.params.length > 3 ||
      callback.params.some((parameter: AnyNode) => parameter.type !== "Identifier")
    )
      return false
    const parameters = callback.params.map((parameter) =>
      parameter.type === "Identifier" ? parameter.name : ""
    )
    if (new Set(parameters).size !== parameters.length) return false
    const [sdk, event, next] = parameters
    let callbackBody: AnyNode = callback.body
    let loweredAsync = false
    const possibleAsync =
      callback.body.type === "BlockStatement" &&
      callback.body.body.length === 1 &&
      callback.body.body[0].type === "ReturnStatement"
        ? callback.body.body[0].argument
        : callback.body
    if (
      possibleAsync?.type === "CallExpression" &&
      possibleAsync.callee.type === "Identifier" &&
      possibleAsync.callee.name === "__async"
    ) {
      const [receiver, args, generator] = possibleAsync.arguments
      if (
        !context.compilerAsyncHelperVerified ||
        parameters.includes("__async") ||
        (callback.type === "FunctionExpression" && callback.id?.name === "__async") ||
        possibleAsync.optional ||
        possibleAsync.arguments.length !== 3 ||
        !(
          (receiver.type === "Literal" && receiver.value === null) ||
          receiver.type === "ThisExpression"
        ) ||
        args.type !== "Literal" ||
        args.value !== null ||
        generator.type !== "FunctionExpression" ||
        !generator.generator ||
        generator.async ||
        generator.id ||
        generator.params.length
      )
        return false
      callbackBody = generator.body
      loweredAsync = true
    }
    const locals = new Map<string, ValueKind>()
    const memberRead = (node: AnyNode): ValueKind | undefined => {
      if (
        node.type !== "MemberExpression" ||
        node.computed ||
        node.optional ||
        node.property.type !== "Identifier" ||
        forbiddenReads.has(node.property.name)
      )
        return
      if (node.object.type === "Identifier") {
        if (node.object.name === event && node.property.name === "props") return "json"
        const kind = locals.get(node.object.name)
        if (kind === "state-record")
          return node.property.name === "version"
            ? "primitive"
            : node.property.name === "value"
              ? "json"
              : undefined
        return kind === "json" ? "json" : undefined
      }
      return memberRead(node.object) ? "json" : undefined
    }
    const expression = (node: AnyNode): ValueKind | undefined => {
      if (node.type === "Literal") {
        if (
          node.regex ||
          !["string", "number", "boolean", "object"].includes(typeof node.value) ||
          (typeof node.value === "object" && node.value !== null) ||
          (typeof node.value === "number" && !Number.isFinite(node.value))
        )
          return
        return "primitive"
      }
      if (node.type === "Identifier") {
        const kind = locals.get(node.name)
        return kind === "state-record" ? undefined : kind
      }
      if (node.type === "MemberExpression") return memberRead(node)
      if (node.type === "ObjectExpression") {
        const keys = new Set<string>()
        for (const field of node.properties as AnyNode[]) {
          if (field.type !== "Property" || field.kind !== "init" || field.method || field.computed)
            return
          const key =
            field.key.type === "Identifier"
              ? field.key.name
              : field.key.type === "Literal"
                ? field.key.value
                : undefined
          if (
            typeof key !== "string" ||
            keys.has(key) ||
            forbiddenKeys.has(key) ||
            /^on[A-Z]/.test(key)
          )
            return
          keys.add(key)
          if (
            key === "type" &&
            (field.value.type !== "Literal" ||
              typeof field.value.value !== "string" ||
              !passiveTypes.has(field.value.value))
          )
            return
          if (!expression(field.value)) return
        }
        return "json"
      }
      if (node.type === "ArrayExpression") {
        return node.elements.every((item: AnyNode | null) => item && expression(item))
          ? "json"
          : undefined
      }
      if (node.type === "UnaryExpression") {
        const kind = expression(node.argument)
        if (
          !kind ||
          !["!", "typeof", "+", "-", "~"].includes(node.operator) ||
          (!["!", "typeof"].includes(node.operator) && kind !== "primitive")
        )
          return
        return "primitive"
      }
      if (node.type === "BinaryExpression") {
        const left = expression(node.left),
          right = expression(node.right)
        if (!left || !right) return
        if (["===", "!=="].includes(node.operator)) return "primitive"
        if (
          left !== "primitive" ||
          right !== "primitive" ||
          ![
            "+",
            "-",
            "*",
            "/",
            "%",
            "**",
            "<",
            "<=",
            ">",
            ">=",
            "&",
            "|",
            "^",
            "<<",
            ">>",
            ">>>"
          ].includes(node.operator)
        )
          return
        return "primitive"
      }
      if (node.type === "LogicalExpression") {
        const left = expression(node.left),
          right = expression(node.right)
        return left && right
          ? left === "primitive" && right === "primitive"
            ? "primitive"
            : "json"
          : undefined
      }
      if (node.type === "ConditionalExpression") {
        if (!expression(node.test)) return
        const left = expression(node.consequent),
          right = expression(node.alternate)
        return left && right
          ? left === "primitive" && right === "primitive"
            ? "primitive"
            : "json"
          : undefined
      }
      if (node.type === "TemplateLiteral") {
        return node.expressions.every((item: AnyNode) => expression(item) === "primitive")
          ? "primitive"
          : undefined
      }
      return undefined
    }
    const returned = (node: AnyNode | null | undefined): boolean => {
      if (!node) return false
      // Only an exact tail call can delegate to the lower frozen event. A local
      // alias, modified event or next call embedded in a tree is not this proof.
      if (node.type === "CallExpression")
        return (
          !node.optional &&
          node.callee.type === "Identifier" &&
          node.callee.name === next &&
          node.arguments.length === 1 &&
          node.arguments[0].type === "Identifier" &&
          node.arguments[0].name === event
        )
      return Boolean(expression(node))
    }
    if (callbackBody.type !== "BlockStatement") return returned(callbackBody)
    const body = callbackBody.body as AnyNode[]
    for (let index = 0; index < body.length; index++) {
      const statement = body[index]
      if (statement.type === "ReturnStatement")
        return index === body.length - 1 && returned(statement.argument)
      if (
        statement.type === "ExpressionStatement" &&
        statement.expression.type === "YieldExpression"
      ) {
        const yielded = statement.expression
        const operation = yielded.argument && stateOperation(yielded.argument, sdk)
        if (
          !context.namedState ||
          context.render ||
          !loweredAsync ||
          yielded.delegate ||
          !operation ||
          operation.method !== "set" ||
          operation.args.length !== 2 ||
          !expression(operation.args[1])
        )
          return false
        writes = true
        continue
      }
      if (statement.type !== "VariableDeclaration" || statement.kind !== "const") return false
      for (const declaration of statement.declarations) {
        if (
          declaration.id.type !== "Identifier" ||
          parameters.includes(declaration.id.name) ||
          locals.has(declaration.id.name) ||
          !declaration.init
        )
          return false
        if (declaration.init.type === "YieldExpression") {
          const yielded = declaration.init
          const operation = yielded.argument && stateOperation(yielded.argument, sdk)
          if (
            !context.namedState ||
            !loweredAsync ||
            yielded.delegate ||
            !operation ||
            operation.method !== "get" ||
            operation.args.length !== 1 ||
            reads.length >= 64
          )
            return false
          reads.push(operation.reference)
          locals.set(declaration.id.name, "state-record")
          continue
        }
        const kind = expression(declaration.init)
        if (!kind) return false
        locals.set(declaration.id.name, kind)
      }
    }
    return false
  }
  const environmentSafe = safe()
  return Object.freeze({
    environmentSafe,
    reusable: environmentSafe && !writes,
    readsNamedState: Object.freeze(environmentSafe ? reads : [])
  })
}

/** The original synchronous-only proof remains intentionally unchanged. */
export function isReusableUiCallback(callback: AnyNode): boolean {
  return analyzeUiCallback(callback, {
    compilerAsyncHelperVerified: false,
    namedState: false,
    render: true
  }).reusable
}
